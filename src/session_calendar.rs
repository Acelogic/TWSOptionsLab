//! Exchange-local regular-session cutoffs. TWS close ticks have prices and receipt
//! times but no trade timestamps (IBKR TWS tick types 9 and 75).
use chrono::{Datelike, NaiveDate, NaiveTime, TimeZone, Weekday};
use chrono_tz::{America::New_York, Tz};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub(crate) fn us_trading_day(d: NaiveDate) -> Option<bool> {
    // Published NYSE dates, https://www.nyse.com/trade/hours-calendars.
    // Outside this period only the broker's actual contract schedule is used.
    let holidays: &[u32] = match d.year() {
        2026 => &[101, 119, 216, 403, 525, 619, 703, 907, 1126, 1225],
        2027 => &[101, 118, 215, 326, 531, 618, 705, 906, 1125, 1224],
        2028 => &[117, 221, 414, 529, 619, 704, 904, 1123, 1225],
        _ => return None,
    };
    Some(
        !matches!(d.weekday(), Weekday::Sat | Weekday::Sun)
            && !holidays.contains(&(d.month() * 100 + d.day())),
    )
}
pub(crate) fn intervals<'a>(meta: &'a Value, field: &str) -> impl Iterator<Item = (i64, i64)> + 'a {
    meta[field]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let start = s[0].as_i64()?;
            let end = s[1].as_i64()?;
            (start < end).then_some((start, end))
        })
}
fn short_us_session(date: NaiveDate) -> bool {
    // NYSE published early closes: 1pm equities / 1:15pm eligible options.
    matches!(
        (date.year(), date.month(), date.day()),
        (2026, 11, 27) | (2026, 12, 24) | (2027, 11, 26) | (2028, 7, 3) | (2028, 11, 24)
    )
}
pub(crate) fn us_hours(meta: &Value) -> Option<(NaiveTime, NaiveTime)> {
    let hour = |h, m| NaiveTime::from_hms_opt(h, m, 0).unwrap();
    let mut templates = BTreeMap::new();
    for (s, e) in intervals(meta, "sessions") {
        let start = New_York.timestamp_millis_opt(s).single()?;
        let end = New_York.timestamp_millis_opt(e).single()?;
        if start.date_naive() == end.date_naive()
            && start.time() == hour(9, 30)
            && matches!(end.time(),v if v==hour(16,0)||v==hour(16,15))
            && !short_us_session(end.date_naive())
        {
            *templates
                .entry((start.time(), end.time()))
                .or_insert(0usize) += 1;
        }
    }
    templates
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(times, _)| times)
        .or_else(|| (meta["secType"] == "STK").then_some((hour(9, 30), hour(16, 0))))
}

pub(crate) fn us_session_window(
    date: NaiveDate,
    hours: (NaiveTime, NaiveTime),
) -> Option<(i64, i64)> {
    let (open, mut close) = hours;
    if short_us_session(date) {
        close -= chrono::Duration::hours(3);
    }
    let stamp = |t| {
        New_York
            .from_local_datetime(&date.and_time(t))
            .single()
            .map(|d| d.timestamp_millis())
    };
    Some((stamp(open)?, stamp(close)?))
}

pub(crate) struct RegularCalendar {
    zone: Tz,
    native: BTreeMap<NaiveDate, (i64, i64)>,
    closed: BTreeSet<NaiveDate>,
    us_equity: bool,
    template: Option<(NaiveTime, NaiveTime)>,
}
impl RegularCalendar {
    pub fn from_listing(meta: &Value) -> Option<Self> {
        let us_equity = meta["usEquitySession"] == true;
        let zone = if us_equity {
            New_York
        } else {
            meta["zone"].as_str()?.parse().ok()?
        };
        let mut native = BTreeMap::new();
        for (start, end) in intervals(meta, "sessions") {
            let date = zone.timestamp_millis_opt(end).single()?.date_naive();
            native
                .entry(date)
                .and_modify(|window: &mut (i64, i64)| {
                    window.0 = window.0.min(start);
                    window.1 = window.1.max(end);
                })
                .or_insert((start, end));
        }
        let closed = meta["closedSessionDates"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|d| d.as_str()?.parse().ok())
            .collect();
        let template = us_equity.then(|| us_hours(meta)).flatten();
        Some(Self {
            zone,
            native,
            closed,
            us_equity,
            template,
        })
    }
    fn previous_close(&self, at: i64) -> Option<(NaiveDate, i64)> {
        let civil = self.zone.timestamp_millis_opt(at).single()?.date_naive();
        // An overnight regular session is named for the civil date of its end.
        let session_date = self
            .native
            .range(civil..)
            .take(2)
            .find(|(_, (start, end))| *start <= at && at < *end)
            .map(|(d, _)| *d)
            .unwrap_or(civil);
        let mut date = session_date;
        for _ in 0..18 {
            date = date.pred_opt()?;
            if let Some((_, end)) = self.native.get(&date) {
                return (*end <= at).then_some((date, *end));
            }
            if self.closed.contains(&date) {
                continue;
            }
            if !self.us_equity {
                return None;
            }
            if us_trading_day(date)? {
                let (_, end) = us_session_window(date, self.template?)?;
                return (end <= at).then_some((date, end));
            }
        }
        None
    }
    pub fn close_for_quote(&self, received_at: i64, now: i64) -> Option<(NaiveDate, i64)> {
        if received_at > now {
            return None;
        }
        let observed = self.previous_close(received_at)?;
        // A new trading day must receive its own close tick; polling a cached price
        // must not attach a newer calibration date to the previous callback.
        (self.previous_close(now)? == observed).then_some(observed)
    }
}
