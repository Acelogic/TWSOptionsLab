//! Optional read-only TWS services for the analysis workbench.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail, ensure};
use chrono::{TimeZone, Utc};
use chrono_tz::America::New_York;
use futures_util::StreamExt;
use ibapi::Client;
use ibapi::contracts::{Contract, SecurityType};
use ibapi::market_data::TradingHours;
use ibapi::market_data::historical::{BarSize, BarTimestamp, Duration as BarSpan, WhatToShow};
use ibapi::news::ArticleType;
use ibapi::scanner::ScannerSubscription;
use ibapi::subscriptions::SubscriptionItemStreamExt;
use serde_json::{Value, json};
use time::{Date, OffsetDateTime};
use tokio::sync::{Mutex, Semaphore};
use tokio::time::timeout;

use crate::market::Market;

type CacheSlot<T> = Arc<Mutex<Option<(Instant, Result<T, String>)>>>;

struct Cache<T> {
    slots: Mutex<HashMap<String, CacheSlot<T>>>,
}

impl<T: Clone> Cache<T> {
    fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
        }
    }

    async fn fetch<F: Future<Output = Result<T>>>(
        &self,
        key: String,
        ttl: u64,
        fetch: F,
    ) -> Result<T> {
        self.fetch_with_ttl(
            key,
            |value| if value.is_ok() { ttl } else { ttl.min(15) },
            fetch,
        )
        .await
    }

    async fn fetch_with_ttl<F: Future<Output = Result<T>>>(
        &self,
        key: String,
        ttl: impl Fn(&Result<T, String>) -> u64,
        fetch: F,
    ) -> Result<T> {
        let slot = {
            let mut slots = self.slots.lock().await;
            if slots.len() > 128 {
                slots.retain(|_, slot| {
                    Arc::strong_count(slot) > 1
                        || slot.try_lock().map_or(true, |data| {
                            data.as_ref()
                                .is_some_and(|(at, _)| at.elapsed() < Duration::from_secs(900))
                        })
                });
            }
            slots
                .entry(key)
                .or_insert_with(|| Arc::new(Mutex::new(None)))
                .clone()
        };
        let mut state = slot.lock().await;
        if let Some((when, value)) = state.as_ref()
            && when.elapsed() < Duration::from_secs(ttl(value))
        {
            return value.clone().map_err(anyhow::Error::msg);
        }
        let value = fetch.await;
        *state = Some((
            Instant::now(),
            value.as_ref().cloned().map_err(|e| e.to_string()),
        ));
        value
    }
}

#[derive(Clone, serde::Serialize)]
pub struct PriceBar {
    pub time: i64,
    pub close: f64,
    pub ohl: Option<[f64; 3]>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum SessionSide {
    Bid,
    Ask,
    Midpoint,
    Trades,
}

impl SessionSide {
    pub fn candidates(self) -> &'static [Self] {
        match self {
            Self::Bid => &[Self::Bid, Self::Midpoint, Self::Trades],
            Self::Ask => &[Self::Ask, Self::Midpoint, Self::Trades],
            Self::Midpoint => &[Self::Midpoint, Self::Trades],
            Self::Trades => &[Self::Trades],
        }
    }

    fn series(self) -> WhatToShow {
        match self {
            Self::Bid => WhatToShow::Bid,
            Self::Ask => WhatToShow::Ask,
            Self::Midpoint => WhatToShow::MidPoint,
            Self::Trades => WhatToShow::Trades,
        }
    }
}

pub(crate) fn session_transport_error(reason: &str) -> bool {
    let reason = reason.to_ascii_lowercase();
    [
        "timed out",
        "timeout",
        "did not respond",
        "disconnected",
        "shutdown",
        "connection reset",
        "connectionreset",
        "connection refused",
        "connection failed",
        "connectionfailed",
        "connection lost",
        "connection closed",
        "connection aborted",
        "network is unreachable",
        "broken pipe",
        "unexpected eof",
    ]
    .iter()
    .any(|pattern| reason.contains(pattern))
}

pub(crate) fn session_retry_secs(reason: &str) -> u64 {
    if session_transport_error(reason) {
        30
    } else {
        120
    }
}

pub(crate) fn session_success_secs(now_ms: i64, request_end_ms: i64, settled_ttl: u64) -> u64 {
    if now_ms - request_end_ms < 15 * 60_000 {
        45
    } else {
        settled_ttl
    }
}

#[derive(Clone, Debug)]
pub struct SessionClose {
    pub price: f64,
    /// End of the broker's five-minute bar, not a fabricated tick timestamp.
    pub at: i64,
    pub source: String,
    pub method: SessionSide,
}

pub struct Sources {
    cached: Cache<Value>,
    bar_cache: Cache<Vec<PriceBar>>,
    close_bars: Cache<Arc<Vec<(i64, f64)>>>,
    close_request_start: Mutex<Option<Instant>>,
    historical: Semaphore,
    /// WSH allows one request at a time. Metadata belongs to one socket session.
    wsh: Mutex<Option<(Weak<Client>, Instant, Option<String>)>>,
}

impl Default for Sources {
    fn default() -> Self {
        Self {
            cached: Cache::new(),
            bar_cache: Cache::new(),
            close_bars: Cache::new(),
            close_request_start: Mutex::new(None),
            historical: Semaphore::new(2),
            wsh: Mutex::new(None),
        }
    }
}

async fn loaded(market: &Market, id: i32) -> Result<Contract> {
    market
        .contracts
        .read()
        .await
        .get(&id)
        .cloned()
        .context("Load this contract in the workbench first.")
}

fn report(id: i32, source: &str, status: &str, message: &str, rows: Vec<Value>) -> Value {
    json!({"id":id,"source":source,"status":status,"message":message,"asOf":Utc::now().timestamp_millis(),"rows":rows})
}

async fn limited<T, E: Into<anyhow::Error>>(
    secs: u64,
    request: impl Future<Output = Result<T, E>>,
) -> Result<T> {
    timeout(Duration::from_secs(secs), request)
        .await
        .context("TWS request timed out")?
        .map_err(Into::into)
}

/// Reopen a torn-down session once. An unresponsive HMDS farm or entitlement
/// refusal should not trigger an identical immediate historical request.
async fn historical_request<T, F>(market: &Market, request: impl Fn(Arc<Client>) -> F) -> Result<T>
where
    F: Future<Output = Result<T, ibapi::Error>>,
{
    for attempt in 0..=1 {
        let client = market.client(1).await?;
        let reply = timeout(Duration::from_secs(20), request(client))
            .await
            .context("IBKR historical data service did not respond within 20 seconds.")?;
        match reply {
            Err(e)
                if attempt == 0
                    && (e.is_connection_lost()
                        || matches!(
                            e,
                            ibapi::Error::Shutdown | ibapi::Error::ConnectionFailed
                        )) =>
            {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            other => return Ok(other?),
        }
    }
    unreachable!()
}

impl Sources {
    /// A quote requires a bar ending at the supplied venue close. For a trade
    /// use the last bar with actual executions, which can precede the cutoff.
    /// Adjacent completed sessions usually share a single cached HMDS request.
    pub async fn session_close_exact(
        &self,
        market: &Market,
        id: i32,
        close_ms: i64,
        session_start_ms: i64,
        common_request_end_ms: i64,
        side: SessionSide,
    ) -> Result<Option<SessionClose>> {
        const DAY: i64 = 86_400_000;
        const WIDTH: i64 = 300_000;
        let now = Utc::now().timestamp_millis();
        ensure!(
            session_start_ms > 0
                && session_start_ms < close_ms
                && close_ms <= common_request_end_ms
                && common_request_end_ms <= now,
            "A completed, dated broker session is required."
        );
        let c = loaded(market, id).await?;
        let route = c.exchange.as_str().to_owned();
        let end = if common_request_end_ms - session_start_ms <= 5 * DAY {
            common_request_end_ms
        } else {
            close_ms
        };
        let series = side.series();
        let key = format!("{id}/{route}/{series}/{end}");
        // The just-completed bar can still be published or corrected by HMDS.
        let observation = |bars: &[(i64, f64)]| {
            bars.iter()
                .filter_map(|&(start, price)| {
                    let end = start + WIDTH;
                    (start >= session_start_ms
                        && end <= close_ms
                        && (side == SessionSide::Trades || end == close_ms))
                        .then_some((end, price))
                })
                .max_by_key(|&(at, _)| at)
        };
        let bars = self
            .close_bars
            .fetch_with_ttl(
                key,
                |value| match value {
                    Err(reason) => session_retry_secs(reason),
                    Ok(rows) if observation(rows).is_none() => 120,
                    Ok(_) => session_success_secs(now, end, 86_400),
                },
                async {
                    let _permit = self.historical.acquire().await?;
                    {
                        let mut last = self.close_request_start.lock().await;
                        if let Some(at) = *last {
                            tokio::time::sleep(
                                Duration::from_millis(300).saturating_sub(at.elapsed()),
                            )
                            .await;
                        }
                        *last = Some(Instant::now());
                    }
                    let until = OffsetDateTime::from_unix_timestamp(end / 1000)?;
                    let history = historical_request(market, |client| {
                        let contract = c.clone();
                        async move {
                            client
                                .historical_data(&contract, BarSize::Min5)
                                .ending(until)
                                .duration(BarSpan::days(5))
                                .what_to_show(series)
                                .trading_hours(TradingHours::Regular)
                                .fetch()
                                .await
                        }
                    })
                    .await?;
                    let rows = history
                        .bars
                        .into_iter()
                        .filter_map(|b| {
                            let BarTimestamp::DateTime(start) = b.date else {
                                return None;
                            };
                            if !b.close.is_finite()
                                || b.close < 0.0
                                || b.close == 0.0 && side != SessionSide::Bid
                            {
                                return None;
                            }
                            if side == SessionSide::Trades && b.count <= 0 && b.volume <= 0.0 {
                                return None;
                            }
                            Some((start.unix_timestamp() * 1000, b.close))
                        })
                        .collect();
                    Ok(Arc::new(rows))
                },
            )
            .await?;
        Ok(observation(&bars).map(|(at, price)| SessionClose {
            price,
            at,
            method: side,
            source: if at < close_ms {
                format!("TWS {route} last regular-session {series} bar before close (5 min)")
            } else {
                format!("TWS {route} regular-session closing {series} bar (5 min)")
            },
        }))
    }

    pub async fn bars(&self, market: &Market, id: i32, window: &str) -> Result<Vec<PriceBar>> {
        let (duration, size) = match window {
            "1D" => (BarSpan::days(1), BarSize::Min5),
            "5D" => (BarSpan::days(5), BarSize::Min30),
            "1M" => (BarSpan::months(1), BarSize::Hour),
            "3M" => (BarSpan::months(3), BarSize::Day),
            _ => bail!("Choose a supported history window."),
        };
        self.bar_cache
            .fetch(format!("{id}/{window}"), 90, async {
                let c = loaded(market, id).await?;
                let _permit = self.historical.acquire().await?;
                let kind = if c.security_type == SecurityType::Index {
                    WhatToShow::Trades
                } else {
                    WhatToShow::MidPoint
                };
                let history = historical_request(market, |client| {
                    let contract = c.clone();
                    async move {
                        client
                            .historical_data(&contract, size)
                            .duration(duration)
                            .what_to_show(kind)
                            .trading_hours(TradingHours::Extended)
                            .fetch()
                            .await
                    }
                })
                .await?;
                let mut rows = Vec::with_capacity(history.bars.len());
                for b in history.bars {
                    if !b.close.is_finite() || b.close < 0.0 {
                        continue;
                    }
                    let ms = match b.date {
                        BarTimestamp::DateTime(t) => t.unix_timestamp() * 1000,
                        BarTimestamp::Date(d) => New_York
                            .with_ymd_and_hms(
                                d.year(),
                                u8::from(d.month()) as u32,
                                d.day() as u32,
                                0,
                                0,
                                0,
                            )
                            .single()
                            .context("Invalid trading date")?
                            .timestamp_millis(),
                    };
                    let ohl = [b.open, b.high, b.low];
                    let complete = ohl.iter().all(|p| p.is_finite() && *p >= 0.0)
                        && b.low <= b.open.min(b.close)
                        && b.high >= b.open.max(b.close);
                    rows.push(PriceBar {
                        time: ms,
                        close: b.close,
                        ohl: complete.then_some(ohl),
                    });
                }
                Ok(rows)
            })
            .await
    }

    pub async fn scanner(&self, market: &Market, code: &str) -> Result<Value> {
        ensure!(
            matches!(
                code,
                "HOT_BY_OPT_VOLUME" | "HIGH_OPT_IMP_VOLAT" | "TOP_OPT_IMP_VOLAT_GAIN"
            ),
            "Unknown scanner."
        );
        self.cached
            .fetch(format!("scanner/{code}"), 90, async {
                let client = market.client(1).await?;
                let request = ScannerSubscription {
                    number_of_rows: 30,
                    instrument: Some("STK".into()),
                    location_code: Some("STK.US.MAJOR".into()),
                    scan_code: Some(code.into()),
                    ..Default::default()
                };
                limited(15, async {
                    let sub = client.scanner_subscription(&request, &[]).await?;
                    let mut stream = sub.filter_data();
                    let rows = stream
                        .next()
                        .await
                        .transpose()?
                        .context("Scanner ended without a ranking.")?;
                    Ok::<_,anyhow::Error>(Value::Array(rows.into_iter().map(|r| json!({
                    "rank":r.rank+1,"symbol":r.contract_details.contract.symbol.to_string(),
                    "exchange":r.contract_details.contract.primary_exchange.to_string()
                })).collect()))
                })
                .await
            })
            .await
    }

    pub async fn news(&self, market: &Market, id: i32) -> Result<Value> {
        loaded(market, id).await?;
        self.cached.fetch(format!("news/{id}"), 120, async {
            let client = market.client(1).await?;
            let providers = limited(8, client.news_providers()).await?;
            let codes: Vec<&str> = providers.iter().map(|p| p.code.as_str()).collect();
            if codes.is_empty() { return Ok(json!({"providers":[],"items":[]})); }
            let end = OffsetDateTime::now_utc();
            let start = end - time::Duration::days(30);
            let items = limited(15, async {
                let mut stream = client.historical_news(id, &codes, start, end, 20).await?.filter_data();
                let mut rows = Vec::new();
                while let Some(article) = stream.next().await {
                    let a = article?;
                    let headline = a.headline.strip_prefix('{')
                        .and_then(|s| s.split_once('}').map(|(_, text)| text)).unwrap_or(&a.headline);
                    let et = chrono::DateTime::from_timestamp(a.time.unix_timestamp(),0).context("Invalid news timestamp")?.with_timezone(&New_York);
                    rows.push(json!({"time":et.format("%Y-%m-%d %H:%M %Z").to_string(),"provider":a.provider_code,
                                     "headline":headline,"id":a.article_id}));
                }
                Ok::<_,anyhow::Error>(rows)
            }).await?;
            Ok(json!({"providers":codes,"items":items}))
        }).await
    }

    pub async fn article(&self, market: &Market, provider: &str, id: &str) -> Result<Value> {
        ensure!(
            !provider.is_empty()
                && provider.len() <= 20
                && provider
                    .bytes()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'-')
                && !id.is_empty()
                && id.len() <= 180,
            "Invalid article identifier."
        );
        let client = market.client(1).await?;
        let a = limited(12, client.news_article(provider, id)).await?;
        ensure!(
            a.article_type == ArticleType::Text,
            "Text unavailable for this article."
        );
        Ok(json!({"text":article_text(&a.article_text)}))
    }

    pub async fn tape(&self, market: &Market, id: i32) -> Result<Value> {
        const SOURCE: &str = "TWS historical time and sales";
        let contract = match loaded(market, id).await {
            Ok(c) => c,
            Err(e) => return Ok(report(id, SOURCE, "unavailable", &e.to_string(), vec![])),
        };
        self.cached.fetch(format!("tape/{id}"), 30, async {
            let _permit = self.historical.acquire().await?;
            let mut rows = Vec::with_capacity(200);
            let mut cursor = OffsetDateTime::now_utc();
            let mut message = "Latest historical trade prints, newest first.".to_string();
            // TWS returns at most one trading session per call. It fills the
            // boundary second, so step back a second without deduplicating prints.
            for _ in 0..3 {
                let count = (200 - rows.len()) as i32;
                let page = historical_request(market, |client| {
                    let contract = contract.clone();
                    async move {
                        let mut s = client.historical_ticks(&contract, count)
                            .ending(cursor).trading_hours(TradingHours::Extended).trade().await?.filter_data();
                        let mut batch = Vec::new();
                        while let Some(item) = s.next().await { batch.push(item?); }
                        Ok(batch)
                    }
                }).await;
                let mut page = match page {
                    Ok(p) => p,
                    Err(e) => {
                        message = e.to_string();
                        if rows.is_empty() {
                            let lower = message.to_ascii_lowercase();
                            let status = if lower.contains("no data") && !lower.contains("permission") { "empty" } else { "unavailable" };
                            return Ok(report(id,SOURCE,status,&message,vec![]));
                        }
                        message = format!("Partial history. {message}");
                        break;
                    }
                };
                page.retain(|p| p.timestamp <= cursor);
                page.sort_by_key(|p| p.timestamp);
                let Some(first) = page.first() else { break };
                cursor = first.timestamp - time::Duration::seconds(1);
                for p in page.into_iter().rev() {
                    if !p.price.is_finite() || p.size.is_some_and(|s| !s.is_finite() || s <= 0.0) { continue; }
                    rows.push(json!({"time":p.timestamp.unix_timestamp()*1000,"price":p.price,"size":p.size,
                                     "exchange":p.exchange,"conditions":p.special_conditions,
                                     "pastLimit":p.tick_attribute_last.past_limit,"unreported":p.tick_attribute_last.unreported}));
                    if rows.len() == 200 { break; }
                }
                if rows.len() == 200 { break; }
            }
            if rows.is_empty() { return Ok(report(id,SOURCE,"empty","TWS returned no trades for this request.",rows)); }
            Ok(report(id,SOURCE,"ok",&message,rows))
        }).await
    }

    pub async fn events(&self, market: &Market, id: i32) -> Result<Value> {
        const SOURCE: &str = "Wall Street Horizon";
        let contract = match loaded(market, id).await {
            Ok(c) => c,
            Err(e) => return Ok(report(id, SOURCE, "unavailable", &e.to_string(), vec![])),
        };
        if contract.security_type != SecurityType::Stock {
            return Ok(report(
                id,
                SOURCE,
                "unavailable",
                "Select a stock or ETF underlying for corporate events.",
                vec![],
            ));
        }
        self.cached.fetch(format!("events/{id}"), 120, async {
            let client = match market.client(1).await {
                Ok(c) => c, Err(e) => return Ok(report(id,SOURCE,"unavailable",&e.to_string(),vec![]))
            };
            let mut state = self.wsh.lock().await;
            let owner = Arc::downgrade(&client);
            if !state.as_ref().is_some_and(|(c,t,err)| c.ptr_eq(&owner) && (err.is_none() || t.elapsed()<Duration::from_secs(120))) {
                let checked = limited(15, client.wsh_metadata()).await.and_then(|m| {
                    let parsed:Value = serde_json::from_str(&m.data_json)?;
                    if let Some(e) = parsed.get("error").or(parsed.get("errorMessage")) { bail!("{e}"); }
                    ensure!(parsed.as_object().is_some_and(|x| !x.is_empty()) || parsed.as_array().is_some_and(|x| !x.is_empty()),
                            "WSH metadata is unavailable. An API-enabled WSH subscription is required.");
                    Ok(())
                });
                *state = Some((owner, Instant::now(), checked.err().map(|e| e.to_string())));
            }
            if let Some((_,_,Some(issue))) = state.as_ref() { return Ok(report(id,SOURCE,"unavailable",issue,vec![])); }
            let today = Utc::now().with_timezone(&New_York).date_naive().to_string();
            let start = Date::parse(&today, time::macros::format_description!("[year]-[month]-[day]"))?;
            let events = limited(15, client.wsh_event_data_by_contract(id).starting(start)
                .ending(start + time::Duration::days(90)).limit(100).fetch()).await.and_then(|r| events_json(&r.data_json));
            Ok(match events {
                Ok(rows) if rows.is_empty() => report(id,SOURCE,"empty","WSH returned no events in the next 90 days.",rows),
                Ok(rows) => report(id,SOURCE,"ok","Upcoming events over 90 days.",rows),
                Err(e) => report(id,SOURCE,"unavailable",&e.to_string(),vec![]),
            })
        }).await
    }
}

fn events_json(payload: &str) -> Result<Vec<Value>> {
    let root: Value = serde_json::from_str(payload)?;
    if let Some(e) = root.get("error").or(root.get("errorMessage")) {
        bail!("{e}");
    }
    let list = root
        .as_array()
        .or_else(|| {
            ["events", "data", "results"]
                .iter()
                .find_map(|k| root.get(*k)?.as_array())
        })
        .context("TWS returned event data in an unrecognized format.")?;
    list.iter().map(|row| {
        let fields=row.as_object().ok_or_else(|| anyhow!("Invalid WSH event record."))?;
        let field=|names:&[&str]| names.iter().find_map(|key| {
            let v=fields.get(*key)?;
            if let Some(s)=v.as_str().filter(|s| !s.is_empty()) { Some(s.to_owned()) }
            else if v.is_number() { Some(v.to_string()) } else { None }
        }).unwrap_or_default();
        Ok(json!({"date":field(&["event_date","eventDate","date","start_date","startDate"]),
            "title":field(&["event_name","eventName","event_type","eventType","name","title"]),
            "detail":field(&["description","event_description","eventDescription","details"]),"fields":row}))
    }).collect()
}

// Article responses may contain publisher HTML. Deliver only text to the UI.
fn article_text(input: &str) -> String {
    let mut out = String::new();
    let mut remaining = input;
    while let Some(tag) = remaining.find('<') {
        out.push_str(&remaining[..tag]);
        let Some(end) = remaining[tag..].find('>') else {
            out.push_str(&remaining[tag..]);
            remaining = "";
            break;
        };
        let name = remaining[tag + 1..tag + end]
            .trim()
            .trim_end_matches('/')
            .to_ascii_lowercase();
        if matches!(name.as_str(), "br" | "/p" | "/div" | "/li") {
            out.push('\n');
        }
        remaining = &remaining[tag + end + 1..];
    }
    out.push_str(remaining);
    let mut decoded = String::new();
    let mut chars = out.as_str();
    while let Some(start) = chars.find('&') {
        decoded.push_str(&chars[..start]);
        chars = &chars[start + 1..];
        let Some(end) = chars.bytes().take(13).position(|b| b == b';') else {
            decoded.push('&');
            continue;
        };
        let entity = &chars[..end];
        let scalar = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            other => other
                .strip_prefix("#x")
                .and_then(|v| u32::from_str_radix(v, 16).ok())
                .or_else(|| other.strip_prefix('#').and_then(|v| v.parse().ok()))
                .and_then(char::from_u32),
        };
        if let Some(c) = scalar {
            decoded.push(c);
            chars = &chars[end + 1..];
        } else {
            decoded.push('&');
        }
    }
    decoded.push_str(chars);
    decoded.chars().take(60_000).collect()
}
