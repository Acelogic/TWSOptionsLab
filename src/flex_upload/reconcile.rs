use super::statements::{
    ACTIVITY, ADJUSTMENTS, Parsed, Statement, civil_date, date, decimal, last_ms, number, timestamp,
};
use anyhow::{Context, Result, ensure};
use chrono::{Days, NaiveDate};
use chrono_tz::Tz;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

pub(super) struct Evidence {
    pub records: Vec<(String, Value)>,
    pub skipped: Vec<Value>,
}
type Daily<'a> = HashMap<NaiveDate, &'a Statement>;
struct Contract<'a> {
    id: i32,
    currency: &'a str,
    multiplier: Decimal,
    stock: bool,
}

fn inventory(st: &Statement, contract: &Contract, zone: Tz) -> Result<Decimal> {
    ensure!(
        timestamp(&st.generated, zone)? > last_ms(st.last, zone)?,
        "Use a final daily report generated after the report date ended."
    );
    let token = contract.id.to_string();
    ensure!(
        !st.blocked.contains(&contract.id),
        "A lifecycle event needs reconciliation."
    );
    for name in ACTIVITY {
        let entries = st
            .sections
            .get(name)
            .with_context(|| format!("Daily export is missing the {name} section."))?;
        ensure!(
            !entries.iter().any(|n| matches!(n.get("conid"), "" | "0")
                || n.get("conid") == token
                || n.get("underlyingConid") == token),
            "A lifecycle event, transfer, adjustment or separate charge needs reconciliation."
        );
    }
    for name in ADJUSTMENTS {
        ensure!(
            !st.sections
                .get(name)
                .is_some_and(
                    |rows| rows.iter().any(|n| matches!(n.get("conid"), "" | "0")
                        || n.get("conid") == token
                        || n.get("underlyingConid") == token)
                ),
            "The daily statement includes an unresolved adjustment or transfer."
        );
    }
    let rows = st
        .sections
        .get("OpenPositions")
        .context("Daily export is missing Open Positions at Summary level.")?;
    let mut quantity = None;
    let mut summaries = 0;
    let mut target_lot = false;
    for r in rows {
        ensure!(
            r.tag == "OpenPosition",
            "Unsupported Open Positions section structure."
        );
        ensure!(
            r.get("accountId").is_empty() || r.get("accountId") == st.account,
            "Open Positions combines multiple accounts."
        );
        match r.required("levelOfDetail")?.to_ascii_uppercase().as_str() {
            "LOT" => {
                target_lot |= r.get("conid") == token;
                continue;
            }
            "SUMMARY" => summaries += 1,
            _ => anyhow::bail!("Invalid Open Positions level of detail."),
        }
        let id = r.id()?;
        ensure!(
            date(r.required("reportDate")?)? == st.last,
            "Open Positions includes a different inventory date."
        );
        if id != contract.id {
            continue;
        }
        ensure!(
            quantity.is_none(),
            "More than one summary position maps to this saved contract."
        );
        ensure!(
            !r.allocated(),
            "A modeled account allocation needs separate reconciliation."
        );
        ensure!(
            r.get("currency") == contract.currency
                && r.multiplier(contract.stock)? == contract.multiplier,
            "Statement holdings disagree with model contract currency or multiplier."
        );
        ensure!(
            if contract.stock {
                r.get("assetCategory") == "STK"
            } else {
                matches!(r.get("assetCategory"), "OPT" | "FOP")
            },
            "Position security type disagrees with the saved contract."
        );
        let qty = decimal(r.required("position")?, "position")?;
        quantity = Some(match r.required("side")?.to_ascii_uppercase().as_str() {
            "LONG" if qty >= Decimal::ZERO => qty,
            "SHORT" => -qty.abs(),
            _ => anyhow::bail!("Position side or signed quantity is inconsistent."),
        });
    }
    ensure!(
        rows.is_empty() || summaries > 0,
        "Open Positions contains only lot details. Include Summary."
    );
    ensure!(
        !target_lot || quantity.is_some(),
        "The saved contract has lot details but no account-wide position summary."
    );
    Ok(quantity.unwrap_or(Decimal::ZERO))
}

fn revision(id: &str) -> (&str, u32) {
    if let Some((base, suffix)) = id.rsplit_once('.')
        && suffix.len() >= 2
        && suffix.bytes().all(|c| c.is_ascii_digit())
    {
        return (base, suffix.parse().unwrap_or(u32::MAX));
    }
    (id, 0)
}

fn fills(
    st: &Statement,
    contract: &Contract,
    zone: Tz,
    cutoff: i64,
) -> Result<Vec<(Decimal, Value)>> {
    let mut seen = HashSet::new();
    let mut matches = Vec::new();
    ensure!(
        !st.blocked.contains(&contract.id),
        "A non-exchange option lifecycle event needs reconciliation."
    );
    for r in &st.sections["Trades"] {
        let kind = r.required("assetCategory")?.to_ascii_uppercase();
        if !matches!(kind.as_str(), "STK" | "OPT" | "FOP") {
            continue;
        }
        let id = r
            .id()
            .context("Missing contract identifier in the unfiltered daily execution section.")?;
        if id != contract.id {
            continue;
        }
        ensure!(
            (kind == "STK") == contract.stock,
            "Execution security type disagrees with the saved contract."
        );
        ensure!(
            r.exchange() && !r.canceled(),
            "An execution type or cancellation requires independent reconciliation."
        );
        ensure!(
            matches!(r.get("origTradeID"), "" | "0") && !r.has_note("CO"),
            "A corrected or prior-period execution needs separate reconciliation."
        );
        ensure!(
            !r.allocated(),
            "A model allocation requires separate account reconciliation."
        );
        let e = r.execution(zone)?;
        ensure!(
            e["currency"] == contract.currency
                && r.multiplier(contract.stock)? == contract.multiplier
                && !e["commission"].is_null()
                && e["commissionCurrency"] == contract.currency,
            "Unconfirmed fill multiplier, commission or currency."
        );
        ensure!(
            !r.get("taxes").is_empty() && decimal(r.get("taxes"), "taxes")?.is_zero(),
            "Include Taxes in the daily trade fields. Additional transaction taxes require separate reconciliation."
        );
        let at = e["at"].as_i64().context("Missing execution date.")?;
        ensure!(
            civil_date(at, zone)? == st.last && at <= cutoff,
            "After-close or other-date activity prevents using end-of-day holdings at this contract’s regular close."
        );
        let (base, ver) = revision(r.exec_id());
        ensure!(
            ver <= 1 && seen.insert(base),
            "Corrected or duplicate executions require reconciliation."
        );
        let qty = r.signed_qty()?;
        matches.push((qty,json!({"id":r.exec_id(),"at":at,"qty":number(qty)?,"price":e["price"],"commission":e["commission"],"currency":contract.currency})));
    }
    Ok(matches)
}

struct Dates<'a> {
    daily: &'a Daily<'a>,
    prior: NaiveDate,
    requested: NaiveDate,
    zone: Tz,
}

impl Dates<'_> {
    fn leg(&self, model: &Value, snap: &Value, row: &Value) -> Result<Value> {
        let id = model["conId"]
            .as_i64()
            .and_then(|n| i32::try_from(n).ok())
            .filter(|n| *n > 0)
            .context("An included contract has no broker contract identity.")?;
        let leg = snap["legs"]
            .as_array()
            .and_then(|legs| {
                legs.iter()
                    .find(|l| l["conId"].as_i64() == Some(i64::from(id)))
            })
            .context("This leg’s two venue endpoints are unavailable.")?;
        let p = &leg["dayPrior"];
        let q = &leg["dayCurrent"];
        ensure!(
            p["date"] == self.prior.to_string() && q["date"] == self.requested.to_string(),
            "This leg’s two venue endpoints are unavailable."
        );
        let begin = p["sessionEnd"]
            .as_i64()
            .context("Prior venue cutoff is unavailable.")?;
        let end = q["sessionEnd"]
            .as_i64()
            .context("Current venue cutoff is unavailable.")?;
        ensure!(
            begin < end
                && civil_date(begin, self.zone)? == self.prior
                && civil_date(end, self.zone)? == self.requested,
            "The statement timezone and venue cutoffs do not align."
        );
        let currency = [
            &model["currency"],
            &row["document"]["currency"],
            &snap["currency"],
        ]
        .into_iter()
        .filter_map(Value::as_str)
        .find(|s| !s.is_empty())
        .context("Saved currency is unknown.")?;
        let contract = Contract {
            id,
            stock: model["kind"] == "stock",
            currency,
            multiplier: decimal(&model["multiplier"].to_string(), "saved multiplier")?,
        };
        let first = self.daily[&self.prior];
        let start_qty = inventory(first, &contract, self.zone)?;
        fills(first, &contract, self.zone, begin)?;
        let mut held = start_qty;
        let mut all = Vec::new();
        let mut ids = HashSet::new();
        let mut day = self.prior;
        while day < self.requested {
            day = day.succ_opt().context("Invalid reporting date.")?;
            let report = self.daily[&day];
            let cutoff = if day == self.requested {
                end
            } else {
                last_ms(day, self.zone)?
            };
            for (qty, event) in fills(report, &contract, self.zone, cutoff)? {
                let at = event["at"].as_i64().context("Missing execution date.")?;
                ensure!(
                    begin < at && at <= end,
                    "Dated holdings and signed executions do not balance."
                );
                ensure!(
                    ids.insert(
                        event["id"]
                            .as_str()
                            .context("Missing execution ID.")?
                            .to_owned()
                    ),
                    "An execution appears on more than one reporting date."
                );
                held = held
                    .checked_add(qty)
                    .context("Execution quantities exceed supported precision.")?;
                all.push(event);
            }
            ensure!(
                held == inventory(report, &contract, self.zone)?,
                "Dated holdings and signed executions do not balance."
            );
        }
        Ok(
            json!({"conId":id,"currency":currency,"multiplier":model["multiplier"],"priorEnd":begin,"end":end,"priorQty":number(start_qty)?,"endQty":number(held)?,"fills":all,"zone":leg["timeZone"].as_str().unwrap_or(self.zone.name())}),
        )
    }
}

fn row_evidence(
    row: &Value,
    snap: &Value,
    requested: NaiveDate,
    daily: &Daily,
    zone: Tz,
    scope: &str,
) -> Result<Value> {
    ensure!(
        row["version"] == snap["version"],
        "The saved snapshot or version is unavailable."
    );
    let period = &snap["dayPeriod"];
    ensure!(
        period["mode"] == "closed" && period["date"] == requested.to_string(),
        "The requested completed session is unavailable on this saved row."
    );
    let prior = date(
        period["priorDate"]
            .as_str()
            .context("The prior session date is missing.")?,
    )?;
    ensure!(
        daily.contains_key(&prior),
        "A matching prior-date, single-day Flex report is missing."
    );
    let gap = (requested - prior).num_days();
    ensure!(
        (1..=21).contains(&gap)
            && (1..gap).all(|i| prior
                .checked_add_days(Days::new(i as u64))
                .is_some_and(|d| daily.contains_key(&d))),
        "One or more intervening daily activity reports are missing."
    );
    let dates = Dates {
        daily,
        requested,
        prior,
        zone,
    };
    let mut legs = Vec::new();
    let mut ids = HashSet::new();
    for model in row["document"]["legs"]
        .as_array()
        .context("Required dated saved-contract fields are missing.")?
    {
        if model["excluded"] == true {
            continue;
        }
        if model["kind"] == "option"
            && date(
                model["expiry"]
                    .as_str()
                    .context("Saved option expiration is missing.")?,
            )? < prior
        {
            let closed = model["closes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| c["qty"].as_f64())
                .sum::<f64>();
            if model["qty"].as_f64().is_some_and(|q| q.abs() == closed) {
                continue;
            }
        }
        let l = dates.leg(model, snap, row)?;
        ensure!(
            ids.insert(l["conId"].as_i64()),
            "Several saved legs share this contract. Allocation is ambiguous."
        );
        legs.push(l);
    }
    ensure!(!legs.is_empty(), "No eligible saved contracts.");
    Ok(
        json!({"strategyId":row["id"],"version":row["version"],"priorDate":prior,"date":requested,"source":"IBKR Activity Flex XML","accountScope":scope,"inventoryMethod":"datedStatement","complete":true,"legs":legs}),
    )
}

pub(super) fn daily<'a>(parsed: &'a Parsed, requested: NaiveDate) -> Result<Daily<'a>> {
    ensure!(
        parsed.accounts.len() == 1,
        "To verify with multiple accounts, separate the account exports."
    );
    let mut daily = HashMap::new();
    for st in &parsed.statements {
        if st.first == st.last {
            ensure!(
                daily.insert(st.last, st).is_none(),
                "Provide just one full daily statement per account and date."
            );
        }
    }
    ensure!(
        daily.contains_key(&requested),
        "The requested verification date needs an account-specific single-day Flex report."
    );
    Ok(daily)
}

pub(super) fn evaluate(
    daily: &Daily,
    rows: &[Value],
    snapshots: &Value,
    requested: NaiveDate,
    zone: Tz,
    scope: &str,
) -> Evidence {
    let mut owners: HashMap<i64, HashSet<&str>> = HashMap::new();
    for r in rows {
        for l in r["document"]["legs"].as_array().into_iter().flatten() {
            if l["excluded"] != true
                && let (Some(cid), Some(id)) = (l["conId"].as_i64(), r["id"].as_str())
            {
                owners.entry(cid).or_default().insert(id);
            }
        }
    }
    let mut result = Evidence {
        records: Vec::new(),
        skipped: Vec::new(),
    };
    for row in rows {
        let name = row["name"].as_str().unwrap_or("").to_owned();
        let id = row["id"].as_str().unwrap_or("");
        match row_evidence(row, &snapshots["rows"][id], requested, daily, zone, scope) {
            Ok(record) => {
                let overlap = record["legs"].as_array().into_iter().flatten().any(|l| {
                    l["conId"]
                        .as_i64()
                        .and_then(|id| owners.get(&id))
                        .is_some_and(|ids| ids.len() > 1)
                        && (l["priorQty"].as_f64() != Some(0.0)
                            || l["endQty"].as_f64() != Some(0.0)
                            || l["fills"].as_array().is_some_and(|f| !f.is_empty()))
                });
                if overlap {
                    result.skipped.push(json!({"name":name,"reason":"More than one saved strategy refers to a nonzero account contract."}));
                } else {
                    result.records.push((name, record));
                }
            }
            Err(e) => result
                .skipped
                .push(json!({"name":name,"reason":e.to_string()})),
        }
    }
    result
}
