use anyhow::{Context, Result, ensure};
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::Value;

pub fn commission_rate(document: &Value) -> Result<f64> {
    let Some(value) = document.get("commissionPerContract") else {
        return Ok(0.0);
    };
    let rate = value.as_f64().context("Commission must be a number.")?;
    ensure!(
        (0.0..=9_007_199_254_740_991.0).contains(&rate),
        "Enter a valid nonnegative commission per contract."
    );
    Ok(rate)
}

#[derive(Deserialize)]
struct Close {
    qty: u32,
    price: f64,
    at: Option<i64>,
    #[serde(rename = "confirmedClosedBy")]
    confirmed_closed_by: Option<i64>,
}

impl Close {
    /// Latest instant by which this cash flow is known to have occurred.
    fn known_by(&self) -> i64 {
        self.at
            .or(self.confirmed_closed_by)
            .expect("validated closing fill")
    }
}

#[derive(Deserialize)]
pub struct Position {
    qty: i64,
    entry: f64,
    multiplier: f64,
    #[serde(default)]
    pub excluded: bool,
    #[serde(default)]
    closes: Vec<Close>,
    #[serde(skip)]
    fee_per_contract: f64,
}

impl Position {
    pub fn read(leg: &Value, commission: f64) -> Result<Self> {
        let mut p: Self = serde_json::from_value(leg.clone())?;
        if leg["kind"] == "option" {
            p.fee_per_contract = commission;
        }
        ensure!(
            p.qty != 0 && p.qty.unsigned_abs() <= 100_000,
            "Invalid opening quantity."
        );
        ensure!(
            p.entry.is_finite() && p.entry >= 0.0 && p.multiplier.is_finite() && p.multiplier > 0.0,
            "Invalid entry or multiplier."
        );
        let mut filled = 0u64;
        let now = Utc::now().timestamp_millis();
        for close in &p.closes {
            ensure!(
                close.qty > 0 && close.price.is_finite() && close.price >= 0.0,
                "Invalid closing fill."
            );
            ensure!(
                matches!((close.at, close.confirmed_closed_by), (Some(at), None) if at > 0)
                    || matches!((close.at, close.confirmed_closed_by), (None, Some(by)) if by > 0 && by <= now),
                "Each closing fill needs an execution timestamp or a positive confirmedClosedBy timestamp in the past."
            );
            filled += u64::from(close.qty);
        }
        ensure!(
            filled <= p.qty.unsigned_abs(),
            "Closing quantity exceeds opening quantity."
        );
        Ok(p)
    }

    pub fn is_unqualified_archive(&self, leg: &Value, now: DateTime<Utc>) -> bool {
        if leg["kind"] != "option" || !leg["conId"].is_null() {
            return false;
        }
        let Some(date) = leg["expiry"]
            .as_str()
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y%m%d").ok())
        else {
            return false;
        };
        let today = now
            .with_timezone(&chrono_tz::America::New_York)
            .date_naive();
        let ms = now.timestamp_millis();
        let expired = match leg["expiresAt"].as_i64() {
            Some(end) => date <= today && end > 0 && end <= ms,
            None => date < today,
        };
        let closed: u64 = self
            .closes
            .iter()
            .filter(|c| c.known_by() <= ms)
            .map(|c| u64::from(c.qty))
            .sum();
        expired && closed == self.qty.unsigned_abs()
    }

    pub fn has_uncertain_close_time(&self) -> bool {
        self.closes.iter().any(|c| c.confirmed_closed_by.is_some())
    }

    /// Signed open exposure and fixed cash P&L, including opening fees and
    /// closing fees for fills completed as of the requested instant.
    pub fn exposure(&self, time: i64) -> (f64, f64) {
        if self.excluded {
            return (0.0, 0.0);
        }
        let mut open_qty = self.qty;
        let mut cash_pnl = -(self.qty.unsigned_abs() as f64) * self.fee_per_contract;
        for close in self.closes.iter().filter(|c| c.known_by() <= time) {
            let closed_qty = self.qty.signum() * i64::from(close.qty);
            let closed = closed_qty as f64 * self.multiplier;
            cash_pnl +=
                (close.price - self.entry) * closed - f64::from(close.qty) * self.fee_per_contract;
            open_qty -= closed_qty;
        }
        (open_qty as f64 * self.multiplier, cash_pnl)
    }

    pub fn last_confirmed_cashflow(&self, time: i64) -> Option<i64> {
        self.closes
            .iter()
            .map(Close::known_by)
            .filter(|&t| t <= time)
            .max()
    }

    pub fn pnl(&self, time: i64, mid: Option<f64>) -> Option<(f64, f64)> {
        if !self.excluded
            && self
                .closes
                .iter()
                .any(|c| c.confirmed_closed_by.is_some_and(|by| time < by))
        {
            return None;
        }
        let (units, cash_pnl) = self.exposure(time);
        if units == 0.0 {
            return Some((cash_pnl, 0.0));
        }
        let mark = mid?;
        Some((cash_pnl + units * (mark - self.entry), units * mark))
    }
}
