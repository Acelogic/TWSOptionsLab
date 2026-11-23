//! Read-only portfolio marks shared across Saved Trades viewers and the recorder.
mod broker;
mod completed;
use crate::session_calendar::us_trading_day;
use crate::{
    App, Shared,
    position::{Position, commission_rate},
};
use anyhow::{Result, ensure};
use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::{America::New_York, Tz};
use futures_util::{StreamExt, stream};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, RwLock};

#[derive(Default, Clone)]
struct Item {
    listing: Value,
    quote: Value,
    checked: i64,
    retry_after: i64,
}
#[derive(Default, Clone)]
pub(crate) struct Book {
    items: BTreeMap<i32, Item>,
    universe: BTreeSet<i32>,
    updated: Option<Instant>,
    error: Option<String>,
}
#[derive(Default)]
struct Feed {
    book: RwLock<Book>,
    refresh: Arc<Mutex<()>>,
}
#[derive(Default)]
pub(crate) struct Snapshots {
    feeds: [Feed; 4],
    history: completed::Store,
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}
fn number(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}
fn id(l: &Value) -> Option<i32> {
    l["conId"]
        .as_i64()
        .and_then(|n| i32::try_from(n).ok())
        .filter(|&n| n > 0)
}
pub(crate) fn expired(l: &Value, now: i64) -> bool {
    if l["kind"] != "option" {
        return false;
    }
    if let Some(end) = l["expiresAt"].as_i64().filter(|&e| e > 0) {
        return now >= end;
    }
    let today = Utc
        .timestamp_millis_opt(now)
        .single()
        .unwrap()
        .with_timezone(&New_York)
        .format("%Y%m%d")
        .to_string();
    l["expiry"].as_str().is_some_and(|e| e < today.as_str())
}
fn needed(saved: &[Value], now: i64) -> BTreeSet<i32> {
    let model_ids = saved
        .iter()
        .filter_map(|s| s["document"]["legs"].as_array())
        .flatten()
        .filter_map(|l| {
            let p = Position::read(l, 0.).ok()?;
            if p.excluded || expired(l, now) {
                return None;
            }
            let open = p.exposure(now).0 != 0.;
            let recent = p
                .last_confirmed_cashflow(now)
                .is_some_and(|t| now - t <= 10 * 86_400_000);
            (open || recent).then(|| id(l)).flatten()
        });
    // Include still-listed contracts in a recent broker reconciliation even
    // if the original model's closing fills would retire its subscription.
    let observed_ids = saved
        .iter()
        .filter_map(|s| s["accountSessions"].as_array())
        .flatten()
        .filter_map(|r| r["legs"].as_array())
        .flatten()
        .filter(|l| {
            l["end"]
                .as_i64()
                .is_some_and(|end| end <= now && now - end < 21 * 86_400_000)
        })
        .filter_map(id);
    model_ids.chain(observed_ids).collect()
}

impl Snapshots {
    /// First view returns promptly. A single background job per requested data
    /// mode qualifies IDs and touches the shared, paced TWS quote subscriptions.
    pub(crate) async fn book(&self, app: &Shared, mode: u8, rows: &[Value]) -> Result<Book> {
        ensure!((1..=4).contains(&mode), "Choose market data mode 1–4.");
        let universe = needed(rows, now_ms());
        let feed = &self.feeds[usize::from(mode - 1)];
        let cached = feed.book.read().await.clone();
        if !universe.is_empty()
            && (cached.universe != universe
                || cached.updated.is_none_or(|t| {
                    t.elapsed()
                        >= Duration::from_millis(if cached.error.is_some() { 6000 } else { 600 })
                }))
            && let Ok(guard) = feed.refresh.clone().try_lock_owned()
        {
            let app = app.clone();
            tokio::spawn(async move {
                let _guard = guard;
                let feed = &app.snapshots.feeds[usize::from(mode - 1)];
                let mut next = feed.book.read().await.clone();
                next.items.retain(|id, _| universe.contains(id));
                next.universe = universe;
                next.error = refresh(&app, mode, &mut next)
                    .await
                    .err()
                    .map(|e| e.to_string());
                next.updated = Some(Instant::now());
                *feed.book.write().await = next;
            });
        }
        Ok(cached)
    }
}
async fn refresh(app: &App, mode: u8, book: &mut Book) -> Result<()> {
    let client = app.market.client(mode).await?;
    // Rotate over large libraries so a few hundred imported options cannot
    // monopolize line capacity. Inactive windows keep clearly labelled cached marks.
    const WINDOW: usize = 36;
    let now = now_ms();
    let groups = book.universe.len().div_ceil(WINDOW).max(1);
    let offset = ((now as usize / 18000) % groups) * WINDOW;
    let ids: Vec<_> = book
        .universe
        .iter()
        .copied()
        .skip(offset)
        .take(WINDOW)
        .collect();
    let consult: Vec<_> = ids
        .iter()
        .copied()
        .filter(|id| book.items.get(id).is_none_or(|i| now >= i.retry_after))
        .collect();
    let mut details = stream::iter(consult)
        .map(|id| {
            let client = client.clone();
            async move {
                (
                    id,
                    tokio::time::timeout(
                        Duration::from_secs(5),
                        app.catalog.saved_contract(&app.market, &client, id),
                    )
                    .await,
                )
            }
        })
        .buffer_unordered(6);
    while let Some((id, reply)) = details.next().await {
        let item = book.items.entry(id).or_default();
        match reply {
            Ok(Ok(meta)) => {
                item.listing = meta;
                item.retry_after = now + 900000
            }
            _ => {
                item.retry_after = now + 25000;
            }
        }
    }
    let fetched = app.market.saved_quotes(&ids, mode).await?;
    for id in ids {
        let item = book.items.entry(id).or_default();
        if let Some(q) = fetched["quotes"].get(id.to_string()) {
            item.quote = q.clone();
            item.checked = now;
        }
    }
    Ok(())
}
impl Book {
    pub(crate) fn recording_quotes(&self) -> Value {
        if self.error.is_some() {
            return json!({});
        }
        let now = now_ms();
        let quotes: Map<_, _> = self
            .items
            .iter()
            .filter(|(_, i)| now - i.checked < 12000)
            .map(|(id, i)| (id.to_string(), i.quote.clone()))
            .collect();
        Value::Object(quotes)
    }
}

struct Mark {
    price: Option<f64>,
    source: String,
    feed: String,
    method: String,
    at: Option<i64>,
    reason: String,
}
fn mark(l: &Value, units: f64, natural: bool, item: Option<&Item>, book: &Book, now: i64) -> Mark {
    let input = item.map(|i| &i.quote).unwrap_or(&Value::Null);
    let feed = input["feed"].as_str().unwrap_or("Waiting");
    let unavailable = |reason: String, source: &str| Mark {
        price: None,
        source: source.into(),
        method: "Unavailable".into(),
        feed: feed.into(),
        at: None,
        reason,
    };
    if expired(l, now) {
        return unavailable(
            "Expired open quantity needs a settlement or closing fill.".into(),
            "Expired",
        );
    }
    if let Some(error) = &book.error {
        return unavailable(error.clone(), "Unavailable");
    }
    let bid = number(&input["bid"]);
    let ask = number(&input["ask"]);
    let crossed = bid.zip(ask).is_some_and(|(b, a)| b > a);
    let side = if units > 0. { "Bid" } else { "Ask" };
    let price = if crossed {
        None
    } else if natural {
        if units > 0. { bid } else { ask }
    } else {
        number(&input["mid"])
    };
    let method = if natural { side } else { "Midpoint" };
    let candidates = [
        (price, method, "at"),
        (number(&input["last"]), "Last trade", "lastAt"),
        (number(&input["close"]), "Previous close", "closeAt"),
    ];
    if matches!(feed, "Live" | "Frozen" | "Delayed" | "Delayed frozen") {
        for (val, method, field) in candidates {
            if let Some(price) = val {
                let at = input[field].as_i64();
                let cached = item.is_some_and(|i| now - i.checked > 12000);
                let quiet = feed == "Live" && at.is_none_or(|t| now - t > 120000);
                let source = if method == "Previous close" {
                    if cached {
                        "Cached previous close".into()
                    } else {
                        "Previous close".into()
                    }
                } else if method == "Last trade" {
                    if cached {
                        "Cached last trade".into()
                    } else if feed == "Live" {
                        "Last trade".into()
                    } else {
                        format!("{feed} · Last trade")
                    }
                } else if cached {
                    format!("Cached {feed} · {method}")
                } else if quiet {
                    format!("Quiet {feed} · {method}")
                } else {
                    format!("{feed} · {method}")
                };
                return Mark {
                    price: Some(price),
                    source,
                    feed: feed.into(),
                    method: method.into(),
                    at,
                    reason: input["error"].as_str().unwrap_or("").into(),
                };
            }
        }
    }
    let error = input["error"].as_str().unwrap_or("");
    unavailable(
        if error.is_empty() {
            "Waiting for executable quotes, last trade or previous close.".into()
        } else {
            error.into()
        },
        if error.is_empty() {
            "Waiting"
        } else {
            "Unavailable"
        },
    )
}

fn et_time(text: &str) -> Option<i64> {
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(text) {
        return Some(t.timestamp_millis());
    }
    let naive = NaiveDateTime::parse_from_str(text, "%b %e, %Y, %l:%M %p").ok()?;
    New_York
        .from_local_datetime(&naive)
        .single()
        .map(|t| t.timestamp_millis())
}
fn prior_window(meta: &Value, now: i64) -> Option<(i64, i64)> {
    let us_equity = meta["usEquitySession"] == true;
    let zone: Tz = meta["zone"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .or_else(|| us_equity.then_some(New_York))?;
    let current = zone.timestamp_millis_opt(now).single()?;
    let today = current.date_naive();
    let midnight = zone
        .from_local_datetime(&today.and_hms_opt(0, 0, 0)?)
        .single()?
        .timestamp_millis();
    let sessions = meta["sessions"].as_array();
    let mut prior = BTreeSet::new();
    let mut in_session = false;
    for times in sessions.into_iter().flatten() {
        let (Some(start), Some(end)) = (times[0].as_i64(), times[1].as_i64()) else {
            continue;
        };
        if start <= now && now <= end {
            in_session = true
        }
        // For overnight instruments the active session may have started on the prior civil date.
        if end < midnight && end < now {
            prior.insert(end);
        }
    }
    if let Some(&latest) = prior.last() {
        if in_session {
            return Some((latest, latest));
        }
        if let Some(&earlier) = prior.iter().rev().nth(1) {
            return Some((earlier, latest));
        }
    }
    if !us_equity {
        return None;
    }
    let today = New_York.timestamp_millis_opt(now).single()?.date_naive();
    let mut prior_days = vec![];
    let mut date = today;
    while prior_days.len() < 2 {
        date = date.pred_opt()?;
        if us_trading_day(date)? {
            prior_days.push(date)
        }
    }
    // A frozen/weekend snapshot can belong to the last trading day. Keep both
    // candidate dates and a broad close-time interval (early/late option closes).
    // If a fill crosses that interval, the day calculation is intentionally absent.
    let earlier = if us_trading_day(today)? {
        prior_days[0]
    } else {
        prior_days[1]
    };
    let at = |d: NaiveDate, h, m| {
        New_York
            .from_local_datetime(&d.and_hms_opt(h, m, 0)?)
            .single()
            .map(|t| t.timestamp_millis())
    };
    Some((at(earlier, 13, 0)?, at(prior_days[0], 16, 15)?))
}

fn day_result(
    saved: &Value,
    l: &Value,
    p: &Position,
    item: Option<&Item>,
    now: i64,
    mark: &Mark,
    total: Option<f64>,
) -> (Option<f64>, &'static str) {
    let Some(total) = total else {
        return (None, "Current leg P&L unavailable");
    };
    let flat = p.exposure(now).0 == 0.;
    let settled = p.last_confirmed_cashflow(now);
    if flat && settled.is_some_and(|t| t < now - 10 * 86400000) {
        return (Some(0.), "Already closed before today");
    }
    if !flat && mark.method == "Previous close" {
        return (None, "No current mark beyond the previous close");
    }
    let doc = &saved["document"];
    let meta = item.map(|i| &i.listing).unwrap_or(&Value::Null);
    let precise = l["openedAt"]
        .as_i64()
        .or_else(|| doc["openedAt"].as_i64())
        .filter(|&t| t > 0 && t <= now);
    if let (Some(opened), Some(closed)) = (precise, settled)
        && closed < opened
    {
        return (None, "Inconsistent opening and closing dates");
    }
    let Some((earliest, latest)) = prior_window(meta, now) else {
        return (None, "Previous trading-session boundary is unavailable");
    };
    if !flat
        && mark.method == "Last trade"
        && !item
            .and_then(|i| i.quote["lastTradeTime"].as_i64())
            .is_some_and(|t| t > latest && t <= now)
    {
        return (
            None,
            "Last trade has no verified timestamp after the previous close",
        );
    }
    if !flat
        && (mark.at.is_none_or(|t| t <= latest)
            || mark.feed.contains("Frozen")
            || mark.feed.contains("frozen"))
    {
        return (None, "Quote has no confirmed current-session time");
    }
    if flat && settled.is_some_and(|t| t <= earliest) {
        return (Some(0.), "Already closed before the previous close");
    }
    if precise.is_some_and(|t| t > latest) {
        return (Some(total), "Opened after the previous close · entry basis");
    }
    // The time a strategy was saved proves it already existed by then. A recent
    // save or import cannot prove a recent execution (entries may be backdated).
    let source = &doc["source"];
    let existed_by = precise
        .or_else(|| source["createdAtText"].as_str().and_then(et_time))
        .or_else(|| saved["created"].as_i64());
    let has_early_fill = l["closes"].as_array().into_iter().flatten().any(|c| {
        c["at"]
            .as_i64()
            .or_else(|| c["confirmedClosedBy"].as_i64())
            .is_some_and(|t| t <= earliest)
    });
    if !existed_by.is_some_and(|t| t <= earliest) && !has_early_fill {
        return (
            None,
            "Opening chronology against the previous session is uncertain",
        );
    }
    let previous = item.and_then(|i| number(&i.quote["close"]));
    let base = |at| p.pnl(at, previous).map(|v| v.0);
    match (base(earliest), base(latest)) {
        (Some(a), Some(b)) if (a - b).abs() < 1e-8 => (
            Some(total - a),
            "IBKR previous close · recorded fills and fees",
        ),
        (None, _) | (_, None) if previous.is_none() => (None, "IBKR previous close unavailable"),
        _ => (
            None,
            "Closing chronology against the previous session is uncertain",
        ),
    }
}
fn combine(s: &BTreeSet<String>, empty: &str) -> String {
    match s.len() {
        0 => empty.into(),
        1 => s.first().unwrap().clone(),
        _ => format!(
            "Mixed · {}",
            s.iter().cloned().collect::<Vec<_>>().join(" / ")
        ),
    }
}
fn add(total: Option<f64>, value: Option<f64>) -> Option<f64> {
    total
        .zip(value)
        .map(|(a, b)| a + b)
        .filter(|v| v.is_finite())
}
fn valuation(
    s: &Value,
    book: &Book,
    now: i64,
    history: &completed::History,
    wanted: &mut BTreeSet<completed::Key>,
) -> Value {
    let doc = &s["document"];
    let fee = commission_rate(doc).unwrap_or(0.);
    let natural = doc["pricing"] == "natural";
    let mut total = Some(0.);
    let mut day = Some(0.);
    let mut value = Some(0.);
    let mut premium = 0.;
    let mut sources = BTreeSet::new();
    let mut methods = BTreeSet::new();
    let mut feeds = BTreeSet::new();
    let mut days = BTreeSet::new();
    let mut periods = BTreeSet::new();
    let mut day_methods = BTreeSet::new();
    let mut estimated = false;
    let mut loading = false;
    let mut errors = BTreeSet::new();
    let mut currencies = BTreeSet::new();
    let mut stamps = vec![];
    let mut legs = vec![];
    let mut open = 0;
    let mut overdue = 0;
    let mut unknown_currency = false;
    let mut only_worthless_expirations = true;
    for l in doc["legs"].as_array().into_iter().flatten() {
        let Ok(p) = Position::read(l, fee) else {
            total = None;
            value = None;
            day = None;
            errors.insert("Invalid saved position.".to_owned());
            continue;
        };
        if p.excluded {
            continue;
        }
        only_worthless_expirations &= l["kind"] == "option"
            && l["closes"].as_array().is_some_and(|fills| {
                !fills.is_empty() && fills.iter().all(|f| f["reason"] == "expiredWorthless")
            });
        premium += l["qty"].as_f64().unwrap_or(0.)
            * l["multiplier"].as_f64().unwrap_or(0.)
            * l["entry"].as_f64().unwrap_or(0.);
        let position_id = id(l);
        let item = position_id.and_then(|id| book.items.get(&id));
        let units = p.exposure(now).0;
        if let Some(currency) = l["currency"]
            .as_str()
            .or_else(|| doc["currency"].as_str())
            .or_else(|| item.and_then(|i| i.listing["currency"].as_str()))
        {
            if currency.is_empty() {
                unknown_currency = true
            } else {
                currencies.insert(currency.to_owned());
            }
        } else {
            unknown_currency = true;
        }
        let mark = if units == 0. {
            Mark {
                price: None,
                source: "Realized".into(),
                feed: "Realized".into(),
                method: "Closing fills".into(),
                at: None,
                reason: String::new(),
            }
        } else {
            open += 1;
            if expired(l, now) {
                overdue += 1
            }
            let m = mark(l, units, natural, item, book, now);
            sources.insert(m.source.clone());
            methods.insert(m.method.clone());
            feeds.insert(m.feed.clone());
            if let Some(at) = m.at {
                stamps.push(at)
            }
            m
        };
        if !mark.reason.is_empty() {
            errors.insert(mark.reason.clone());
        }
        let calculated = p.pnl(now, mark.price);
        let leg_pnl = calculated.map(|v| v.0);
        // Cash already settled long before the requested period is independent
        // of its retired contract's calendar and never requires a broker lookup.
        let long_settled = units == 0.
            && p.last_confirmed_cashflow(now)
                .is_some_and(|t| t < now - 10 * 86400000);
        let clock = completed::clock(item, now);
        let (mode, d) = match clock {
            completed::Clock::Closed(Some(period))
                if overdue > 0 && units != 0. && expired(l, period.current.end) =>
            {
                let mut d = completed::Day::empty(
                    None,
                    "An expired open quantity needs a recorded settlement to value this session.",
                );
                d.period = Some(period);
                ("closed", d)
            }
            completed::Clock::Closed(Some(period)) => (
                "closed",
                completed::value(s, l, &p, period, now, history, wanted),
            ),
            completed::Clock::Live => {
                let (n, reason) = day_result(s, l, &p, item, now, &mark, leg_pnl);
                let mut d = completed::Day::empty(n, reason);
                d.method = "Current session vs IBKR previous close".into();
                ("live", d)
            }
            _ if long_settled => (
                "settled",
                completed::Day::empty(Some(0.), "Already closed before today"),
            ),
            completed::Clock::Closed(None) => (
                "closed",
                completed::Day::empty(
                    None,
                    "Two verified completed trading sessions are unavailable.",
                ),
            ),
            completed::Clock::Unknown => (
                "unknown",
                completed::Day::empty(None, "TWS contract session schedule unavailable."),
            ),
        };
        let leg_day = d.pnl;
        let current_date = d.period.map(|p| p.current.date.to_string());
        let prior_date = d.period.map(|p| p.prior.date.to_string());
        if !long_settled {
            periods.insert((mode, current_date.clone(), prior_date.clone()));
        }
        estimated |= d.estimated;
        loading |= d.note.starts_with("Loading TWS session closes");
        day_methods.insert(d.method.clone());
        total = add(total, leg_pnl);
        value = add(value, calculated.map(|v| v.1));
        day = add(day, leg_day);
        days.insert(d.note.clone());
        legs.push(json!({
            "conId":position_id, "markPrice":mark.price, "source":mark.source, "feed":mark.feed,
            "markSource":mark.method, "receivedAt":mark.at,
            "timeZone":item.and_then(|i|i.listing["zone"].as_str()), "exchange":item.and_then(|i|i.listing["exchange"].as_str()),
            "lastTradeTime":item.and_then(|i|i.quote["lastTradeTime"].as_i64()),
            "previousClose":item.and_then(|i|number(&i.quote["close"])),
            "totalPnl":leg_pnl, "dayPnl":leg_day, "daySource":d.note, "openUnits":units,
            "dayPeriod":{"mode":mode,"date":current_date,"priorDate":prior_date,"estimated":d.estimated,"method":d.method},
            "dayCurrent":d.current,"dayPrior":d.prior
        }));
    }
    let period = if periods.len() > 1 {
        day = None;
        days.insert("Included positions have different or unconfirmed market sessions.".into());
        json!({"mode":"mixed","date":null,"priorDate":null})
    } else if let Some((mode, date, prior)) = periods.first() {
        json!({"mode":mode,"date":date,"priorDate":prior})
    } else {
        json!({"mode":"settled","date":null,"priorDate":null})
    };
    let mut day_period = period;
    day_period["estimated"] = json!(estimated);
    day_period["method"] = json!(combine(&day_methods, "Unavailable"));
    day_period["loading"] = json!(loading);
    let status = if legs.is_empty() {
        "excluded"
    } else if (open > 0 && open == overdue)
        || (open == 0
            && (doc["source"]["status"]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("expired"))
                || only_worthless_expirations))
    {
        "expired"
    } else if open == 0 {
        "closed"
    } else {
        "open"
    };
    let incompatible_currency =
        currencies.len() > 1 || (unknown_currency && !currencies.is_empty());
    if legs.is_empty() || incompatible_currency {
        total = None;
        day = None;
        value = None;
    }
    if incompatible_currency {
        errors.insert("Included legs have different or unconfirmed currencies; aggregate returns are unavailable.".to_owned());
    } else if unknown_currency {
        errors.insert("Strategy currency is unconfirmed.".to_owned());
    }
    let basis = (!incompatible_currency && !legs.is_empty()).then_some(premium.abs());
    let pct = |p: Option<f64>| {
        p.zip(basis.filter(|&b| b > 1e-9))
            .map(|(p, b)| 100. * p / b)
    };
    let default_source = if legs.is_empty() {
        "Excluded"
    } else {
        "Realized"
    };
    let mut row = json!({
        "id":s["id"], "version":s["version"], "status":status,
        "totalPnl":total, "totalPct":pct(total), "dayPnl":day, "dayPct":pct(day),
        "basis":basis, "marketValue":value,
        "currency":if currencies.len()==1&&!unknown_currency{currencies.first()}else{None},
        "source":combine(&sources,default_source), "feed":combine(&feeds,default_source),
        "markSource":combine(&methods,if legs.is_empty(){"Unavailable"}else{"Closing fills"}),
        "receivedAt":stamps.into_iter().min(), "daySource":combine(&days,"Unavailable"), "dayPeriod":day_period,
        "detail":errors.into_iter().collect::<Vec<_>>().join(" "), "legs":legs
    });
    broker::apply(&mut row, s, book, now, history, wanted);
    row
}

/// The only production path for account-evidence reads. Modeled marks do
/// not require a brokerage identity or a managed-accounts round trip.
pub(crate) async fn scoped_saved(
    app: &Shared,
    mode: u8,
) -> Result<(Vec<Value>, &'static str, Option<i64>)> {
    if !app.library.has_current_account_evidence()? {
        return Ok((app.library.list()?, "noEvidence", None));
    }
    let (scope, state, at) = app.options_history.saved_scope(&app.market, mode).await?;
    let mut rows = app.library.list_for_valuation(scope.as_deref())?;
    app.options_history
        .review_session_evidence(&mut rows, scope.as_deref());
    Ok((rows, state, at))
}

pub(crate) async fn response(app: &Shared, mode: u8) -> Result<Value> {
    let (saved, scope_state, scope_at) = scoped_saved(app, mode).await?;
    let mut book = app.snapshots.book(app, mode, &saved).await?;
    let (connected, mode_connected) = app.market.connection_state(mode).await;
    if !mode_connected && book.items.values().any(|i| i.checked > 0) {
        book.error = Some("TWS data connection is unavailable.".into());
    }
    let now = now_ms();
    let history = app.snapshots.history.read().await;
    let mut wanted = BTreeSet::new();
    let rows: Map<_, _> = saved
        .iter()
        .filter_map(|s| {
            let mut row=valuation(s, &book, now, &history, &mut wanted);
            row["brokerScopeStatus"]=json!(scope_state);
            match scope_state {
                "lastVerifiedOffline" => {
                    let note=format!("{} Last verified offline TWS account.",row["brokerDaySource"].as_str().unwrap_or(""));
                    row["brokerDaySource"]=json!(note);
                    if row["dayPeriod"]["attribution"]=="broker" {
                        row["daySource"]=row["brokerDaySource"].clone();
                        row["dayPeriod"]["accountStatus"]=json!(scope_state);
                    }
                }
                "multipleAccounts" => row["brokerDaySource"]=json!("Multiple managed accounts are visible; the account for this return is unconfirmed."),
                "unconfirmed" => row["brokerDaySource"]=json!("The TWS account for this return is unconfirmed."),
                _=>{}
            }
            Some((s["id"].as_str()?.to_owned(),row))
        })
        .collect();
    app.snapshots.history.request(app, wanted).await;
    Ok(
        json!({"asOf":now,"mode":mode,"connected":connected,"brokerAccount":{"status":scope_state,"confirmedAt":scope_at},"rows":rows}),
    )
}
