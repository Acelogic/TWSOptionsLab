use crate::{market::Market, session_calendar::RegularCalendar};
use anyhow::{Context, Result, anyhow, bail, ensure};
use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use futures_util::StreamExt;
use ibapi::subscriptions::SubscriptionItemStreamExt;
use ibapi::{
    Client,
    contracts::{Contract, ContractDetails, OptionChain, SecurityType},
};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    sync::Mutex,
    time::{sleep, timeout},
};

type Slot = Arc<Mutex<Option<(Instant, Value)>>>;
#[derive(Default)]
struct Cache(Mutex<HashMap<String, Slot>>);
impl Cache {
    async fn get(
        &self,
        key: &str,
        ttl: Duration,
        load: impl Future<Output = Result<Value>>,
    ) -> Result<Value> {
        let slot = {
            let mut map = self.0.lock().await;
            map.retain(|_, s| {
                Arc::strong_count(s) > 1
                    || s.try_lock()
                        .map_or(true, |v| v.as_ref().is_some_and(|(t, _)| t.elapsed() < ttl))
            });
            map.entry(key.into()).or_default().clone()
        };
        let mut state = slot.lock().await;
        if let Some((at, v)) = state.as_ref() {
            if at.elapsed() < ttl {
                return Ok(v.clone());
            }
        }
        let value = load.await?;
        if value.get("chainError").is_none_or(Value::is_null) {
            *state = Some((Instant::now(), value.clone()));
        }
        Ok(value)
    }
}

#[derive(Default)]
pub struct Catalog {
    instruments: Cache,
    books: Cache,
    searches: Cache,
    saved_contracts: Cache,
    next_search: Mutex<Option<Instant>>,
    hints: Mutex<HashMap<i32, Contract>>,
}

fn clean(v: &str) -> Result<String> {
    let v = v.trim().to_uppercase();
    ensure!(
        !v.is_empty() && v.chars().count() <= 96 && !v.chars().any(char::is_control),
        "Enter a valid ticker, contract ID or search term."
    );
    Ok(v)
}
fn bare() -> Contract {
    Contract {
        security_type: SecurityType::Other(String::new()),
        currency: "".into(),
        exchange: "".into(),
        ..Contract::default()
    }
}
fn today() -> String {
    Utc::now()
        .with_timezone(&chrono_tz::America::New_York)
        .format("%Y%m%d")
        .to_string()
}
fn exchange_today(time_zone: &str) -> String {
    zone(time_zone).map_or_else(today, |tz| {
        Utc::now().with_timezone(&tz).format("%Y%m%d").to_string()
    })
}

fn date8(s: &str) -> Option<&str> {
    let date = s.get(..8)?;
    NaiveDate::parse_from_str(date, "%Y%m%d").ok().map(|_| date)
}
fn maturity(d: &ContractDetails) -> Option<String> {
    date8(&d.real_expiration_date)
        .or_else(|| date8(&d.contract.last_trade_date_or_contract_month))
        .map(str::to_string)
        .or_else(|| {
            d.contract
                .last_trade_date
                .map(|v| v.to_string().replace('-', ""))
        })
}
fn zone(name: &str) -> Option<Tz> {
    match name.trim() {
        "EST (Eastern Standard Time)" | "EST5EDT" | "EST" | "EDT" => "America/New_York",
        "CST6CDT" | "CST (Central Standard Time)" => "America/Chicago",
        "PST8PDT" | "PST" | "PDT" => "America/Los_Angeles",
        "MET" | "CET" => "Europe/Berlin",
        "Hongkong" | "Hong Kong Time" => "Asia/Hong_Kong",
        "JST" => "Asia/Tokyo",
        v => v,
    }
    .parse()
    .ok()
}
fn expires_at(d: &ContractDetails, date: &str, am: bool) -> Option<i64> {
    // AM SPX settles from opening component prices, after the prior evening's last trade.
    if am {
        let dt = NaiveDate::parse_from_str(date, "%Y%m%d")
            .ok()?
            .and_hms_opt(9, 30, 0)?;
        return chrono_tz::America::New_York
            .from_local_datetime(&dt)
            .single()
            .map(|t| t.timestamp_millis());
    }
    let decorated = d
        .contract
        .last_trade_date_or_contract_month
        .replace('-', " ");
    let mut tokens = decorated.split_whitespace();
    let quoted_date = tokens.next();
    let hms = tokens.next();
    let tz = tokens
        .next()
        .and_then(zone)
        .or_else(|| zone(&d.time_zone_id))?;
    let explicit = if !d.last_trade_time.is_empty() {
        Some(d.last_trade_time.as_str())
    } else if quoted_date == Some(date) {
        hms
    } else {
        None
    };
    if let Some(time) = explicit {
        if let Ok(dt) = NaiveDateTime::parse_from_str(&format!("{date} {time}"), "%Y%m%d %H:%M:%S")
        {
            if let Some(local) = tz.from_local_datetime(&dt).single() {
                return Some(local.timestamp_millis());
            }
        }
    }
    // Some protobuf responses have no dedicated last-trade-time field. Use
    // a dated session close only if the supplied venue schedule covers expiration.
    d.liquid_hours
        .iter()
        .flat_map(|day| day.split(','))
        .filter_map(|session| {
            let (open, close) = session.split_once('-')?;
            let (end_date, end_time) = close
                .split_once(':')
                .or_else(|| open.split_once(':').map(|(d, _)| (d, close)))?;
            if end_date != date {
                return None;
            }
            let dt =
                NaiveDateTime::parse_from_str(&format!("{date} {end_time}"), "%Y%m%d %H%M").ok()?;
            tz.from_local_datetime(&dt)
                .single()
                .map(|t| t.timestamp_millis())
        })
        .max()
}

async fn details(ib: &Client, c: &Contract) -> Result<Vec<ContractDetails>> {
    timeout(Duration::from_secs(32), ib.contract_details(c))
        .await
        .context("TWS contract search timed out")?
        .context("TWS contract search failed")
}
fn unique(rows: Vec<ContractDetails>, id: Option<i32>) -> Result<ContractDetails> {
    let mut found = BTreeMap::new();
    for d in rows {
        let cid = d.contract.contract_id;
        if cid > 0 && id.is_none_or(|i| i == cid) {
            found.entry(cid).or_insert(d);
        }
    }
    ensure!(
        !found.is_empty(),
        "No matching TWS contract. Select a listing or use a contract ID."
    );
    ensure!(
        found.len() == 1,
        "Multiple TWS listings match. Select an exchange and currency from search."
    );
    Ok(found.into_values().next().unwrap())
}

fn known_us_equity(d: &ContractDetails) -> bool {
    let c = &d.contract;
    let us_market = |venue: &str| {
        matches!(
            venue,
            "NYSE"
                | "NASDAQ"
                | "AMEX"
                | "ARCA"
                | "CBOE"
                | "CBOE2"
                | "C2"
                | "ISE"
                | "BOX"
                | "PHLX"
                | "BATS"
                | "IEX"
                | "MIAX"
                | "IBUSOPT"
        )
    };
    c.currency.as_str() == "USD"
        && matches!(c.security_type, SecurityType::Stock | SecurityType::Option)
        && (us_market(c.primary_exchange.as_str())
            || us_market(c.exchange.as_str())
            || d.valid_exchanges.iter().any(|e| us_market(e)))
}

fn session_listing(d: &ContractDetails, include_trading: bool) -> Value {
    let c = &d.contract;
    let tz = zone(&d.time_zone_id);
    let intervals = |hours: &[String]| {
        tz.map(|tz| {
            hours
                .iter()
                .flat_map(|day| day.split([',', ';']))
                .filter_map(|session| {
                    let (start, end) = session.split_once('-')?;
                    let (date, _) = start.split_once(':')?;
                    let end = if end.contains(':') {
                        end.to_owned()
                    } else {
                        format!("{date}:{end}")
                    };
                    let parse = |text: &str| {
                        tz.from_local_datetime(
                            &NaiveDateTime::parse_from_str(text, "%Y%m%d:%H%M").ok()?,
                        )
                        .single()
                        .map(|v| v.timestamp_millis())
                    };
                    Some([parse(start)?, parse(&end)?])
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
    };
    let calendar = intervals(&d.liquid_hours);
    let trading = if include_trading {
        intervals(&d.trading_hours)
    } else {
        vec![]
    };
    let closed: Vec<_> = d
        .liquid_hours
        .iter()
        .flat_map(|day| day.split([',', ';']))
        .filter_map(|s| {
            let date = s.strip_suffix(":CLOSED")?;
            NaiveDate::parse_from_str(date, "%Y%m%d")
                .ok()
                .map(|d| d.to_string())
        })
        .collect();
    json!({"zone":tz.map(|t|t.name()),"sessions":calendar,"tradingSessions":trading,"closedSessionDates":closed,"ticker":c.symbol.as_str(),"secType":c.security_type.as_str(),"currency":c.currency.as_str(),
                "exchange":c.exchange.as_str(),"primary":c.primary_exchange.as_str(),"usEquitySession":known_us_equity(d)})
}

fn regular_calendar(d: &ContractDetails) -> Option<Arc<RegularCalendar>> {
    RegularCalendar::from_listing(&session_listing(d, false)).map(Arc::new)
}

fn listing(c: &Contract, label: &str, derivatives: &[String]) -> Value {
    let symbol = c.symbol.as_str();
    let venue = if c.primary_exchange.is_empty() {
        c.exchange.as_str()
    } else {
        c.primary_exchange.as_str()
    };
    let key = if c.contract_id > 0 {
        format!("{symbol}#{}", c.contract_id)
    } else if c.security_type == SecurityType::Future && !venue.is_empty() {
        format!("{symbol}@{venue}")
    } else {
        symbol.to_owned()
    };
    json!({"key":key, "symbol":symbol, "conId":c.contract_id, "secType":c.security_type.as_str(),
        "exchange":c.exchange.as_str(), "primaryExchange":c.primary_exchange.as_str(),
        "currency":c.currency.as_str(), "localSymbol":c.local_symbol,
        "label":if label.is_empty(){symbol}else{label}, "derivatives":derivatives})
}

async fn futures_list(
    ib: &Client,
    ticker: &str,
    exchange: &str,
) -> Result<Vec<(String, ContractDetails)>> {
    ensure!(
        !ticker.is_empty() && !exchange.is_empty(),
        "Enter a futures family as SYMBOL@EXCHANGE."
    );
    let query = Contract {
        security_type: SecurityType::Future,
        symbol: ticker.into(),
        exchange: exchange.into(),
        ..bare()
    };
    let mut active: Vec<_> = details(ib, &query)
        .await?
        .into_iter()
        .filter_map(|d| {
            let date = maturity(&d)?;
            (date >= exchange_today(&d.time_zone_id)
                && d.contract.security_type == SecurityType::Future)
                .then_some((date, d))
        })
        .collect();
    active.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.contract.contract_id.cmp(&b.1.contract.contract_id))
    });
    Ok(active)
}

impl Catalog {
    /// A saved native ID can be qualified directly without loading an entire chain.
    pub async fn saved_contract(&self, market: &Market, client: &Client, id: i32) -> Result<Value> {
        self.saved_contracts
            .get(&id.to_string(), Duration::from_secs(900), async {
                let mut query = bare();
                query.contract_id = id;
                let d = unique(details(client, &query).await?, Some(id))?;
                let mut info = session_listing(&d, true);
                let calendar = RegularCalendar::from_listing(&info).map(Arc::new);
                let mut c = d.contract;
                if let Some(date) = date8(&c.last_trade_date_or_contract_month) {
                    c.last_trade_date_or_contract_month = date.into();
                }
                if matches!(c.security_type, SecurityType::Stock | SecurityType::Option)
                    && d.valid_exchanges.iter().any(|e| e == "SMART")
                {
                    c.exchange = "SMART".into();
                }
                info["exchange"] = json!(c.exchange.as_str());
                market.register_calendars([(id, calendar)]).await;
                // Existing chain qualification may provide a more specific routing venue.
                market.contracts.write().await.entry(id).or_insert(c);
                Ok(info)
            })
            .await
    }
    pub async fn search(&self, market: &Market, pattern: &str) -> Result<Value> {
        let pattern = clean(pattern)?;
        let load = async {
            let ib = market.client(1).await?;
            if let Some((_, raw_id)) = pattern.rsplit_once('#') {
                let row = self
                    .by_id(&ib, raw_id.parse().context("Invalid TWS contract ID")?)
                    .await?;
                return Ok(json!([listing(&row.contract, &row.long_name, &[])]));
            }
            if let Some((ticker, venue)) = pattern.rsplit_once('@') {
                let maturities = futures_list(&ib, ticker, venue).await?;
                let mut hints = self.hints.lock().await;
                let mut rows = Vec::new();
                for (date, detail) in maturities {
                    let c = detail.contract;
                    let mut row = listing(
                        &c,
                        &format!("{} · {} · {}", detail.long_name, c.local_symbol, date),
                        &[],
                    );
                    row["maturity"] = json!(date);
                    row["contractMonth"] = json!(detail.contract_month);
                    rows.push(row);
                    hints.insert(c.contract_id, c);
                }
                return Ok(Value::Array(rows));
            }
            {
                let mut next = self.next_search.lock().await;
                if let Some(t) = *next {
                    sleep(t.saturating_duration_since(Instant::now())).await
                }
                *next = Some(Instant::now() + Duration::from_millis(1050));
            }
            let matches = timeout(Duration::from_secs(16), ib.matching_symbols(&pattern))
                .await
                .context("TWS symbol search timed out")??;
            let mut hints = self.hints.lock().await;
            let mut out = Vec::new();
            for m in matches {
                let c = m.contract;
                let sym = c.symbol.as_str();
                if sym.is_empty() {
                    continue;
                }
                out.push(listing(&c, &c.description, &m.derivative_security_types));
                if c.contract_id > 0 {
                    hints.insert(c.contract_id, c);
                }
            }
            Ok(Value::Array(out))
        };
        self.searches
            .get(&pattern, Duration::from_secs(60), load)
            .await
    }
    async fn by_id(&self, ib: &Client, id: i32) -> Result<ContractDetails> {
        ensure!(id > 0, "Enter a positive contract ID.");
        let hint = self.hints.lock().await.get(&id).cloned();
        let c = Contract {
            contract_id: id,
            ..bare()
        };
        if let Some(h) = hint {
            let query = Contract {
                contract_id: id,
                security_type: h.security_type,
                currency: h.currency,
                exchange: if h.exchange.is_empty() {
                    h.primary_exchange
                } else {
                    h.exchange
                },
                ..bare()
            };
            if let Ok(row) = details(ib, &query)
                .await
                .and_then(|rows| unique(rows, Some(id)))
            {
                return Ok(row);
            }
        }
        unique(details(ib, &c).await?, Some(id))
    }
    async fn resolve(&self, market: &Market, ib: &Client, symbol: &str) -> Result<ContractDetails> {
        if let Some((_, id)) = symbol.rsplit_once('#') {
            return self
                .by_id(ib, id.parse().context("Invalid TWS contract ID")?)
                .await;
        }
        if let Some((ticker, exchange)) = symbol.rsplit_once('@') {
            let mut active = futures_list(ib, ticker, exchange).await?;
            let first = active
                .first()
                .ok_or_else(|| anyhow!("No active futures maturities for {symbol}."))?;
            let c = &first.1.contract;
            let ambiguous = active
                .iter()
                .skip(1)
                .take_while(|(d, _)| d == &first.0)
                .any(|(_, v)| {
                    v.contract.trading_class != c.trading_class
                        || v.contract.currency != c.currency
                        || v.contract.multiplier != c.multiplier
                });
            ensure!(
                !ambiguous,
                "Multiple futures families match. Select a specific contract ID."
            );
            return Ok(active.remove(0).1);
        }
        let results = self.search(market, symbol).await?;
        let exact: Vec<_> = results
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| {
                v["symbol"].as_str() == Some(symbol) && v["conId"].as_i64().is_some_and(|id| id > 0)
            })
            .collect();
        let common_index = matches!(symbol, "SPX" | "XSP" | "VIX" | "NDX" | "RUT");
        let canonical = if common_index {
            exact
                .iter()
                .copied()
                .find(|m| m["secType"] == "IND" && m["currency"] == "USD")
        } else {
            None
        };
        if let Some(m) = canonical.or_else(|| {
            if exact.len() == 1 {
                Some(exact[0])
            } else {
                None
            }
        }) {
            return self.by_id(ib, m["conId"].as_i64().unwrap() as i32).await;
        }
        if exact.len() > 1 {
            bail!(
                "Multiple listings match {symbol}. Select an exchange and currency from symbol search."
            )
        }
        let query = Contract {
            symbol: symbol.into(),
            ..bare()
        };
        unique(details(ib, &query).await?, None)
    }

    pub async fn instrument(&self, market: &Market, symbol: &str) -> Result<Value> {
        let symbol = clean(symbol)?;
        let key = format!("{}:{symbol}", today());
        let load = async {
            let ib = market.client(1).await?;
            let d = self.resolve(market, &ib, &symbol).await?;
            let calendar = regular_calendar(&d);
            let request_date = date8(&d.contract.last_trade_date_or_contract_month)
                .map(str::to_owned)
                .or_else(|| maturity(&d));
            let mut c = d.contract;
            if matches!(
                c.security_type,
                SecurityType::Option | SecurityType::FuturesOption | SecurityType::Future
            ) {
                if let Some(date) = request_date {
                    c.last_trade_date_or_contract_month = date;
                }
            }
            if c.security_type == SecurityType::Stock
                && d.valid_exchanges.iter().any(|e| e == "SMART")
            {
                c.exchange = "SMART".into()
            } else if c.exchange.is_empty() {
                c.exchange = c.primary_exchange.clone()
            }
            let mut roots = Map::new();
            let mut error = None;
            if matches!(
                c.security_type,
                SecurityType::Stock
                    | SecurityType::Index
                    | SecurityType::Future
                    | SecurityType::Commodity
                    | SecurityType::ForexPair
                    | SecurityType::Bond
                    | SecurityType::CFD
            ) {
                let req =
                    ib.option_chain(c.symbol.as_str(), c.security_type.clone(), c.contract_id);
                let req = if c.security_type == SecurityType::Future {
                    req.exchange(c.exchange.as_str())
                } else {
                    req
                };
                let fetched = timeout(Duration::from_secs(20), async {
                    let mut stream = req.subscribe().await?.filter_data();
                    let mut records = Vec::new();
                    while let Some(row) = stream.next().await {
                        records.push(row?);
                    }
                    Ok::<Vec<OptionChain>, ibapi::Error>(records)
                })
                .await;
                match fetched {
                    Ok(Ok(mut records)) => {
                        let preferred = if matches!(
                            c.security_type,
                            SecurityType::Future | SecurityType::Index
                        ) {
                            c.exchange.as_str()
                        } else {
                            "SMART"
                        };
                        records.sort_by_key(|r| {
                            (
                                r.exchange != preferred,
                                r.exchange != "SMART",
                                r.exchange.clone(),
                            )
                        });
                        let cutoff = exchange_today(&d.time_zone_id);
                        for r in records {
                            if r.underlying_contract_id != c.contract_id
                                || r.trading_class.is_empty()
                                || roots.contains_key(&r.trading_class)
                            {
                                continue;
                            }
                            let Some(mult) = r
                                .multiplier
                                .parse::<f64>()
                                .ok()
                                .filter(|n| n.is_finite() && *n > 0.0)
                            else {
                                continue;
                            };
                            let mut dates: Vec<_> = r
                                .expirations
                                .into_iter()
                                .filter(|v| date8(v) == Some(v.as_str()) && v >= &cutoff)
                                .collect();
                            dates.sort();
                            dates.dedup();
                            if !dates.is_empty() {
                                roots.insert(r.trading_class.clone(),json!({"root":r.trading_class,"exchange":r.exchange,"multiplier":mult,"expiries":dates}));
                            }
                        }
                    }
                    Ok(Err(e)) => error = Some(e.to_string()),
                    Err(_) => error = Some("TWS option-chain request timed out".into()),
                }
            }
            let default = [
                if c.symbol.as_str() == "SPX" {
                    "SPXW"
                } else {
                    c.symbol.as_str()
                },
                &c.trading_class,
            ]
            .into_iter()
            .find(|s| roots.contains_key(*s))
            .map(str::to_string)
            .or_else(|| roots.keys().next().cloned());
            let style = match (
                c.security_type.clone(),
                c.symbol.as_str(),
                c.currency.as_str(),
            ) {
                (SecurityType::Index, "SPX" | "XSP" | "VIX" | "RUT" | "NDX", "USD") => "EU",
                (SecurityType::Stock, _, "USD")
                    if matches!(
                        c.primary_exchange.as_str(),
                        "NASDAQ"
                            | "ISLAND"
                            | "NYSE"
                            | "ARCA"
                            | "AMEX"
                            | "BATS"
                            | "IEX"
                            | "NYSEARCA"
                            | "NYSEAMERICAN"
                    ) =>
                {
                    "US"
                }
                _ => "UNKNOWN",
            };
            let mult = c
                .multiplier
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite() && *n > 0.0)
                .unwrap_or(1.0);
            let info = json!({"symbol":symbol,"ticker":c.symbol.as_str(),"conId":c.contract_id,"secType":c.security_type.as_str(),"exchange":c.exchange.as_str(),
                "primaryExchange":c.primary_exchange.as_str(),"currency":c.currency.as_str(),"localSymbol":c.local_symbol,"contractMonth":d.contract_month,"longName":d.long_name,"multiplier":mult,
                "defaultRoot":default,"roots":roots,"style":style,"chainError":error});
            market.register_calendars([(c.contract_id, calendar)]).await;
            market.contracts.write().await.insert(c.contract_id, c);
            Ok(info)
        };
        self.instruments
            .get(&key, Duration::from_secs(600), load)
            .await
    }

    pub async fn book(
        &self,
        market: &Market,
        symbol: &str,
        root: &str,
        expiry: &str,
    ) -> Result<Value> {
        let info = self.instrument(market, symbol).await?;
        let symbol = info["symbol"].as_str().unwrap();
        let spec = info["roots"]
            .get(root)
            .ok_or_else(|| anyhow!("This option trading class is unavailable."))?;
        ensure!(
            spec["expiries"]
                .as_array()
                .is_some_and(|list| list.iter().any(|v| v == expiry)),
            "This option expiration is unavailable."
        );
        let key = format!("{symbol}:{root}:{expiry}");
        let load = async {
            let ib = market.client(1).await?;
            let exchange = spec["exchange"].as_str().unwrap();
            let underlying = info["conId"].as_i64().unwrap() as i32;
            let currency = info["currency"].as_str().unwrap();
            let query = Contract {
                security_type: if info["secType"] == "FUT" {
                    SecurityType::FuturesOption
                } else {
                    SecurityType::Option
                },
                symbol: info["ticker"].as_str().unwrap().into(),
                trading_class: root.into(),
                currency: currency.into(),
                exchange: exchange.into(),
                multiplier: spec["multiplier"].as_f64().unwrap().to_string(),
                last_trade_date_or_contract_month: expiry.into(),
                ..bare()
            };
            let matches = details(&ib, &query).await?;
            let settlement = match (info["ticker"].as_str().unwrap_or(""), root) {
                ("SPX", "SPX" | "SPXO")
                | ("VIX", "VIX" | "VIXW")
                | ("RUT", "RUT")
                | ("NDX", "NDX") => "AM",
                ("SPX", "SPXW") | ("XSP", "XSP") | ("RUT", "RUTW") | ("NDX", "NDXP") => "PM",
                _ if info["secType"] == "STK"
                    && info["currency"] == "USD"
                    && info["style"] == "US" =>
                {
                    "PM"
                }
                _ => "Exchange",
            };
            let am = settlement == "AM";
            let mut expiration = None;
            let mut listed = Vec::new();
            let mut qualified = Vec::new();
            let mut calendars = Vec::new();
            // Contracts of one series normally share the same exchange schedule.
            // Preserve distinct hours if TWS reports an exception for a particular strike.
            let mut schedules: HashMap<(String, Vec<String>, bool), Option<Arc<RegularCalendar>>> =
                HashMap::new();
            for d in matches {
                if d.under_contract_id > 0 && d.under_contract_id != underlying {
                    continue;
                }
                let c = &d.contract;
                if c.trading_class != root
                    || c.contract_id <= 0
                    || !c.strike.is_finite()
                    || c.currency.as_str() != currency
                    || (date8(&c.last_trade_date_or_contract_month) != Some(expiry)
                        && maturity(&d).as_deref() != Some(expiry))
                {
                    continue;
                }
                let Some(right) = c.right else { continue };
                if expiration.is_none() {
                    expiration = expires_at(&d, expiry, am);
                }
                let key = (
                    d.time_zone_id.clone(),
                    d.liquid_hours.clone(),
                    known_us_equity(&d),
                );
                let calendar = schedules
                    .entry(key)
                    .or_insert_with(|| regular_calendar(&d))
                    .clone();
                calendars.push((c.contract_id, calendar));
                listed.push((c.strike, right.as_str(), c.contract_id));
                let mut c = d.contract;
                c.exchange = exchange.into();
                // Returned details can contain "YYYYMMDD HH:MM:SS TZ". Market data and HMDS require a plain date.
                c.last_trade_date_or_contract_month = expiry.into();
                qualified.push(c);
            }
            ensure!(
                !listed.is_empty(),
                "No qualified strikes for {symbol} {root} {expiry}."
            );
            listed.sort_unstable_by(|a, b| {
                a.0.total_cmp(&b.0).then(a.1.cmp(b.1)).then(a.2.cmp(&b.2))
            });
            let mut rows: Vec<Value> = Vec::new();
            let mut previous = None;
            for (strike, right, id) in listed {
                if previous != Some(strike) {
                    rows.push(json!({"strike":strike}));
                    previous = Some(strike);
                }
                let row = rows.last_mut().unwrap();
                if let Some(old) = row.get(right) {
                    ensure!(
                        old.as_i64() == Some(id as i64),
                        "Multiple listed contracts match {root} {expiry} {strike}{right}."
                    );
                }
                row[right] = json!(id);
            }
            market.register_calendars(calendars).await;
            let mut registry = market.contracts.write().await;
            for c in qualified {
                registry.insert(c.contract_id, c);
            }
            Ok(
                json!({"symbol":symbol,"root":root,"expiry":expiry,"currency":currency,"settlement":settlement,"expiresAt":expiration,"strikes":rows}),
            )
        };
        self.books.get(&key, Duration::from_secs(1200), load).await
    }
}
