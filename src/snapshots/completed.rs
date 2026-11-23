//! Completed regular-session returns. All endpoint times are exchange times in UTC milliseconds.
use super::{Item, add, number, us_trading_day};
use crate::session_calendar::{intervals, us_hours, us_session_window};
use crate::{
    Shared,
    position::Position,
    sources::{SessionClose, SessionSide},
};
use chrono::{NaiveDate, TimeZone};
use chrono_tz::{America::New_York, Tz};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(super) struct Window {
    pub date: NaiveDate,
    pub start: i64,
    pub end: i64,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(super) struct Period {
    pub current: Window,
    pub prior: Window,
}
#[derive(Clone, Copy, Debug)]
pub(super) enum Clock {
    Live,
    Closed(Option<Period>),
    Unknown,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(super) struct Key {
    pub id: i32,
    pub period: Period,
    pub side: SessionSide,
    pub need_current: bool,
    pub need_prior: bool,
}
#[derive(Clone, Debug)]
pub(super) struct Prices {
    pub current: Option<SessionClose>,
    pub prior: Option<SessionClose>,
    pub method: SessionSide,
    pub error: Option<String>,
    pub updated: Instant,
}
pub(super) type History = BTreeMap<Key, Prices>;

pub(super) fn clock(item: Option<&Item>, now: i64) -> Clock {
    let Some(item) = item else {
        return Clock::Unknown;
    };
    let meta = &item.listing;
    let us = meta["usEquitySession"] == true;
    let Some(tz) = meta["zone"]
        .as_str()
        .and_then(|z| z.parse::<Tz>().ok())
        .or_else(|| us.then_some(New_York))
    else {
        return Clock::Unknown;
    };
    if intervals(meta, "sessions").any(|(s, e)| s <= now && now < e) {
        return Clock::Live;
    }
    if item.quote["feed"] == "Live"
        && let Some((start, _)) =
            intervals(meta, "tradingSessions").find(|(s, e)| *s <= now && now < *e)
    {
        let recent = |t: i64| start <= t && t <= now && now - t <= 120000;
        let active_book =
            number(&item.quote["mid"]).is_some() && item.quote["at"].as_i64().is_some_and(recent);
        let active_trade = item.quote["lastTradeTime"].as_i64().is_some_and(recent);
        if active_book || active_trade {
            return Clock::Live;
        }
    }
    let day_zone = if us { New_York } else { tz };
    let mut native: BTreeMap<NaiveDate, Window> = BTreeMap::new();
    for (start, end) in intervals(meta, "sessions") {
        let Some(at) = day_zone.timestamp_millis_opt(end).single() else {
            continue;
        };
        let date = at.date_naive();
        native
            .entry(date)
            .and_modify(|w| {
                w.start = w.start.min(start);
                w.end = w.end.max(end)
            })
            .or_insert(Window { date, start, end });
    }
    let closed: BTreeSet<_> = meta["closedSessionDates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str()?.parse::<NaiveDate>().ok())
        .collect();
    let template = us.then(|| us_hours(meta)).flatten();
    let mut dates = Vec::with_capacity(2);
    let mut date = day_zone
        .timestamp_millis_opt(now)
        .single()
        .unwrap()
        .date_naive();
    for lookback in 0..18 {
        if let Some(&w) = native.get(&date) {
            if w.end <= now {
                dates.push(w);
            }
        } else if !closed.contains(&date) {
            if !us {
                return Clock::Closed(None);
            }
            match us_trading_day(date) {
                Some(false) => {}
                Some(true) => {
                    let Some((start, end)) =
                        template.and_then(|hours| us_session_window(date, hours))
                    else {
                        return Clock::Closed(None);
                    };
                    if lookback == 0 && start <= now && now < end {
                        return Clock::Live;
                    }
                    if end <= now {
                        dates.push(Window { date, start, end });
                    }
                }
                None => return Clock::Closed(None),
            }
        }
        if dates.len() == 2 {
            return Clock::Closed(Some(Period {
                current: dates[0],
                prior: dates[1],
            }));
        }
        let Some(earlier) = date.pred_opt() else {
            break;
        };
        date = earlier;
    }
    Clock::Closed(None)
}

#[derive(Default)]
struct ActiveHistory {
    points: History,
    pending: BTreeSet<Key>,
}
#[derive(Default)]
pub(super) struct Store(Mutex<ActiveHistory>);
impl Store {
    pub(super) async fn read(&self) -> History {
        self.0.lock().await.points.clone()
    }
    pub(super) async fn request(&self, app: &Shared, wanted: BTreeSet<Key>) {
        let mut state = self.0.lock().await;
        state
            .points
            .retain(|k, _| k.period.current.end > super::now_ms() - 21 * 86400000);
        for key in wanted {
            if state.pending.len() >= 4 {
                break;
            }
            if state.points.get(&key).is_some_and(|p| {
                let ttl = p
                    .error
                    .as_deref()
                    .map(crate::sources::session_retry_secs)
                    .unwrap_or_else(|| {
                        crate::sources::session_success_secs(
                            super::now_ms(),
                            key.period.current.end,
                            21600,
                        )
                    });
                p.updated.elapsed() < Duration::from_secs(ttl)
            }) {
                continue;
            }
            if !state.pending.insert(key) {
                continue;
            }
            let app = app.clone();
            tokio::spawn(async move {
                let prices = fetch(&app, key).await;
                let mut state = app.snapshots.history.0.lock().await;
                state.points.insert(key, prices);
                state.pending.remove(&key);
            });
        }
    }
}
pub(super) fn side_name(side: SessionSide) -> &'static str {
    match side {
        SessionSide::Bid => "Bid",
        SessionSide::Ask => "Ask",
        SessionSide::Midpoint => "Midpoint",
        SessionSide::Trades => "Trades",
    }
}
async fn fetch(app: &Shared, key: Key) -> Prices {
    let mut reason = String::from("Matching regular-session closing prices are unavailable.");
    for &side in key.side.candidates() {
        let lookup = |w: Window, need: bool| async move {
            if !need {
                return Ok(None);
            }
            app.sources
                .session_close_exact(
                    &app.market,
                    key.id,
                    w.end,
                    w.start,
                    key.period.current.end,
                    side,
                )
                .await
        };
        let (end, prior) = tokio::join!(
            lookup(key.period.current, key.need_current),
            lookup(key.period.prior, key.need_prior)
        );
        match (end, prior) {
            (Ok(current), Ok(prior)) => {
                let valid = |price: &Option<SessionClose>, window: Window, needed: bool| {
                    !needed
                        || price.as_ref().is_some_and(|p| {
                            p.method == side
                                && p.price.is_finite()
                                && p.price >= 0.
                                && window.start <= p.at
                                && p.at <= window.end
                        })
                };
                if valid(&current, key.period.current, key.need_current)
                    && valid(&prior, key.period.prior, key.need_prior)
                {
                    return Prices {
                        current,
                        prior,
                        method: side,
                        error: None,
                        updated: Instant::now(),
                    };
                }
            }
            (a, b) => {
                reason = a
                    .err()
                    .or_else(|| b.err())
                    .map(|e| e.to_string())
                    .unwrap_or(reason);
                if crate::sources::session_transport_error(&reason) {
                    break;
                }
            }
        }
    }
    Prices {
        current: None,
        prior: None,
        method: key.side,
        error: Some(reason),
        updated: Instant::now(),
    }
}

pub(super) struct Day {
    pub pnl: Option<f64>,
    pub note: String,
    pub estimated: bool,
    pub period: Option<Period>,
    pub method: String,
    pub current: Value,
    pub prior: Value,
}
impl Day {
    pub(super) fn empty(pnl: Option<f64>, note: &str) -> Self {
        Self {
            pnl,
            note: note.into(),
            estimated: false,
            period: None,
            method: "Recorded positions".into(),
            current: Value::Null,
            prior: Value::Null,
        }
    }
}
fn endpoint(window: Window, observed: Option<&SessionClose>, method: SessionSide) -> Value {
    json!({"date":window.date.to_string(),"sessionStart":window.start,"sessionEnd":window.end,
        "price":observed.map(|p|p.price),"at":observed.map(|p|p.at),"source":observed.map(|p|p.source.as_str()),
        "method":side_name(method)})
}
pub(super) fn value(
    saved: &Value,
    leg: &Value,
    p: &Position,
    period: Period,
    now: i64,
    history: &History,
    wanted: &mut BTreeSet<Key>,
) -> Day {
    let doc = &saved["document"];
    let opened = leg["openedAt"]
        .as_i64()
        .or_else(|| doc["openedAt"].as_i64())
        .filter(|&t| t > 0 && t <= now);
    let mut out = Day::empty(None, "Loading TWS session closes.");
    out.period = Some(period);
    let side = if doc["pricing"] == "natural" {
        if leg["qty"].as_i64().unwrap_or(0) > 0 {
            SessionSide::Bid
        } else {
            SessionSide::Ask
        }
    } else {
        SessionSide::Midpoint
    };
    out.current = endpoint(period.current, None, side);
    out.prior = endpoint(period.prior, None, side);
    if opened.is_some_and(|t| t > period.current.end) {
        out.pnl = Some(0.);
        out.note = "Position opened after the latest completed session.".into();
        return out;
    }
    let units_now = p.exposure(now).0;
    if units_now == 0.
        && p.last_confirmed_cashflow(now)
            .is_some_and(|t| t <= period.prior.end)
    {
        out.pnl = Some(0.);
        out.note = "Position was fully closed at both session endpoints.".into();
        return out;
    }
    let early_fill = leg["closes"].as_array().into_iter().flatten().any(|c| {
        c["at"]
            .as_i64()
            .or_else(|| c["confirmedClosedBy"].as_i64())
            .is_some_and(|t| t <= period.prior.end)
    });
    // Library::write forks on changes to opening legs. Its own first-save
    // timestamp proves this modeled lot existed by then. Imported display
    // dates have no such guarantee and are not execution timestamps.
    let established = opened.is_some()
        || early_fill
        || saved["created"]
            .as_i64()
            .is_some_and(|t| t > 0 && t <= period.prior.end);
    let start_pnl = |at, price| {
        if opened.is_some_and(|t| at < t) {
            Some(0.)
        } else {
            p.pnl(at, price).map(|v| v.0)
        }
    };
    let exact = established
        && start_pnl(period.prior.end, Some(0.)).is_some()
        && start_pnl(period.current.end, Some(0.)).is_some();
    out.estimated = !exact;
    if !exact && units_now == 0. {
        out.pnl = Some(0.);
        out.note =
            "Current-position estimate · no remaining exposure; historic fills are not attributed."
                .into();
        out.method = "Current-position estimate".into();
        return out;
    }
    let need_prior = !exact || start_pnl(period.prior.end, None).is_none();
    let need_current = !exact || start_pnl(period.current.end, None).is_none();
    if !need_current && !need_prior {
        out.pnl = add(
            start_pnl(period.current.end, None),
            start_pnl(period.prior.end, None).map(|v| -v),
        );
        out.note = "Recorded opening and closing cash flows, including commissions.".into();
        return out;
    }
    let Some(id) = super::id(leg) else {
        out.note = "This archived contract has no TWS historical price identity.".into();
        return out;
    };
    let key = Key {
        id,
        period,
        side,
        need_current,
        need_prior,
    };
    wanted.insert(key);
    out.method = format!("TWS regular-session {}", side_name(side));
    let Some(prices) = history.get(&key) else {
        return out;
    };
    let method = prices.method;
    let verify = |point: Option<&SessionClose>, w: Window| {
        point
            .filter(|p| {
                p.method == method
                    && p.price.is_finite()
                    && p.price >= 0.
                    && w.start <= p.at
                    && p.at <= w.end
            })
            .map(|p| p.price)
    };
    let current = verify(prices.current.as_ref(), period.current);
    let prior = verify(prices.prior.as_ref(), period.prior);
    out.current = endpoint(period.current, prices.current.as_ref(), method);
    out.prior = endpoint(period.prior, prices.prior.as_ref(), method);
    if let Some(error) = &prices.error {
        out.note = error.clone();
        return out;
    }
    if (need_current && current.is_none()) || (need_prior && prior.is_none()) {
        out.note = "Matching same-session historical endpoints are unavailable.".into();
        return out;
    }
    out.pnl = if exact {
        start_pnl(period.current.end, current)
            .zip(start_pnl(period.prior.end, prior))
            .map(|(a, b)| a - b)
    } else {
        current.zip(prior).map(|(a, b)| units_now * (a - b))
    };
    out.method = if method == side {
        format!("TWS regular-session {}", side_name(method))
    } else {
        format!("TWS {} fallback for {}", side_name(method), side_name(side))
    };
    out.note = if exact {
        format!(
            "{} · recorded exposure, fills and fees at each close.",
            out.method
        )
    } else {
        format!(
            "Current-position estimate · remaining quantity × closing price change ({}).",
            out.method
        )
    };
    out
}
