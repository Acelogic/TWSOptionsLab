//! Completed-session attribution to independently reconciled brokerage records.
use super::{
    Book,
    completed::{self, Clock, History, Key, Period, Window},
};
use crate::{
    position::Position,
    sources::{SessionClose, SessionSide},
};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    strategy_id: String,
    version: i64,
    date: String,
    prior_date: String,
    source: String,
    account_scope: String,
    complete: bool,
    inventory_method: String,
    legs: Vec<BrokerLeg>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrokerLeg {
    con_id: i32,
    multiplier: f64,
    currency: String,
    prior_end: i64,
    end: i64,
    prior_qty: f64,
    end_qty: f64,
    fills: Vec<Fill>,
}
#[derive(Deserialize)]
struct Fill {
    id: String,
    at: i64,
    qty: f64,
    price: f64,
    commission: f64,
    currency: String,
}

struct Cash {
    fills: f64,
    commissions: f64,
}
impl BrokerLeg {
    fn cash(&self, model: &Value, period: Period, ids: &mut BTreeSet<String>) -> Result<Cash> {
        ensure!(
            self.end == period.current.end && self.prior_end == period.prior.end,
            "Account inventory cutoffs differ from the contract’s trading sessions."
        );
        ensure!(
            model["multiplier"].as_f64() == Some(self.multiplier)
                && self.multiplier > 0.
                && self.multiplier.is_finite(),
            "The broker contract multiplier differs from the saved contract."
        );
        let stock = model["kind"] == "stock";
        let quantity = |n: f64| n.is_finite() && (stock || n.fract() == 0.);
        ensure!(
            quantity(self.prior_qty) && quantity(self.end_qty),
            "Invalid broker endpoint quantity."
        );
        let mut end = self.prior_qty;
        let mut cash = Cash {
            fills: 0.,
            commissions: 0.,
        };
        for fill in &self.fills {
            ensure!(
                !fill.id.is_empty() && ids.insert(fill.id.clone()),
                "Broker execution is duplicated or unidentified."
            );
            ensure!(
                self.prior_end < fill.at && fill.at <= self.end,
                "Broker execution lies outside the closing interval."
            );
            ensure!(
                quantity(fill.qty)
                    && fill.qty != 0.
                    && fill.price.is_finite()
                    && fill.price >= 0.
                    && fill.commission.is_finite()
                    && fill.currency == self.currency,
                "Execution amount, commission or currency could not be verified."
            );
            end += fill.qty;
            cash.fills += fill.qty * self.multiplier * fill.price;
            cash.commissions += fill.commission;
        }
        ensure!(
            (end - self.end_qty).abs() <= 1e-8
                && cash.fills.is_finite()
                && cash.commissions.is_finite(),
            "Broker executions do not reconcile the two endpoint holdings."
        );
        Ok(cash)
    }
}

enum Observations<'a> {
    Ready {
        end: Option<&'a SessionClose>,
        prior: Option<&'a SessionClose>,
    },
    Loading,
    Missing(String),
}
fn lookup<'a>(key: Key, history: &'a History, wanted: &mut BTreeSet<Key>) -> Observations<'a> {
    wanted.insert(key);
    let Some(p) = history.get(&key) else {
        return Observations::Loading;
    };
    if let Some(error) = &p.error {
        return Observations::Missing(error.clone());
    }
    let valid = |v: &SessionClose, w: Window| {
        v.price.is_finite()
            && v.price >= 0.
            && v.method == p.method
            && key.side.candidates().contains(&v.method)
            && w.start <= v.at
            && v.at <= w.end
    };
    let end = p.current.as_ref().filter(|v| valid(v, key.period.current));
    let prior = p.prior.as_ref().filter(|v| valid(v, key.period.prior));
    if (key.need_current && end.is_none()) || (key.need_prior && prior.is_none()) {
        return Observations::Missing("Matching TWS closing prices are unavailable.".into());
    }
    Observations::Ready { end, prior }
}
fn observations<'a>(
    leg: &BrokerLeg,
    natural: bool,
    period: Period,
    history: &'a History,
    wanted: &mut BTreeSet<Key>,
) -> Observations<'a> {
    let need_prior = leg.prior_qty != 0.;
    let need_current = leg.end_qty != 0.;
    if !need_prior && !need_current {
        return Observations::Ready {
            end: None,
            prior: None,
        };
    }
    let side = |qty| {
        if !natural {
            SessionSide::Midpoint
        } else if qty < 0. {
            SessionSide::Ask
        } else {
            SessionSide::Bid
        }
    };
    let key = |side, need_prior, need_current| Key {
        id: leg.con_id,
        period,
        side,
        need_current,
        need_prior,
    };
    let old_side = side(leg.prior_qty);
    let new_side = side(leg.end_qty);
    if !need_prior || !need_current || old_side == new_side {
        return lookup(
            key(
                if need_current { new_side } else { old_side },
                need_prior,
                need_current,
            ),
            history,
            wanted,
        );
    }
    // A real reversal should cross holding sides. If one native quote is missing,
    // use a matched midpoint/trades pair for both ends instead of mixing methods.
    let old = lookup(key(old_side, true, false), history, wanted);
    let new = lookup(key(new_side, false, true), history, wanted);
    match (&old, &new) {
        (Observations::Ready { prior: Some(a), .. }, Observations::Ready { end: Some(b), .. })
            if (a.method == old_side && b.method == new_side) || a.method == b.method =>
        {
            Observations::Ready {
                end: Some(*b),
                prior: Some(*a),
            }
        }
        (Observations::Loading, _) | (_, Observations::Loading) => Observations::Loading,
        _ => lookup(key(SessionSide::Midpoint, true, true), history, wanted),
    }
}
fn reconcile(
    row: &Value,
    saved: &Value,
    record: Evidence,
    book: &Book,
    now: i64,
    history: &History,
    wanted: &mut BTreeSet<Key>,
) -> Result<(Value, Vec<Value>)> {
    ensure!(
        saved["id"] == record.strategy_id
            && saved["version"] == record.version
            && record.complete
            && !record.source.trim().is_empty()
            && !record.account_scope.trim().is_empty()
            && matches!(
                record.inventory_method.as_str(),
                "datedStatement" | "completeReplay"
            ),
        "Broker session evidence is incomplete or belongs to a different saved version."
    );
    let currency = row["currency"]
        .as_str()
        .context("Strategy currency is unconfirmed.")?;
    let mut records: BTreeMap<_, _> = record.legs.iter().map(|l| (l.con_id, l)).collect();
    ensure!(
        records.len() == record.legs.len() && !records.is_empty(),
        "Missing or duplicate broker contract mappings."
    );
    let natural = saved["document"]["pricing"] == "natural";
    let mut ids = BTreeSet::new();
    let mut contract_ids = BTreeSet::new();
    let mut breakdown = vec![];
    let mut net_total = Some(0.);
    let mut all_charges = 0.;
    let mut loading = false;
    let mut missing = BTreeSet::new();
    for model in saved["document"]["legs"]
        .as_array()
        .context("No saved positions.")?
        .iter()
        .filter(|l| l["excluded"] != true)
    {
        let id = super::id(model);
        let Some(leg) = id.and_then(|id| records.remove(&id)) else {
            let first_cutoff = record.legs.iter().map(|v| v.prior_end).min().unwrap();
            ensure!(
                super::expired(model, first_cutoff)
                    && Position::read(model, 0.)?.exposure(first_cutoff).0 == 0.,
                "The broker record does not cover every included contract."
            );
            continue;
        };
        ensure!(
            contract_ids.insert(leg.con_id) && leg.currency == currency,
            "Ambiguous broker contract mapping or currency."
        );
        let Clock::Closed(Some(period)) = completed::clock(book.items.get(&leg.con_id), now) else {
            anyhow::bail!("The contract’s completed regular sessions are unavailable.");
        };
        ensure!(
            period.current.date.to_string() == record.date
                && period.prior.date.to_string() == record.prior_date,
            "Broker trading dates differ from the contract’s latest completed session."
        );
        let cash = leg.cash(model, period, &mut ids)?;
        all_charges += cash.commissions;
        let observations = observations(leg, natural, period, history, wanted);
        let (end, prior) = match observations {
            Observations::Ready { end, prior } => (end, prior),
            Observations::Loading => {
                loading = true;
                (None, None)
            }
            Observations::Missing(reason) => {
                missing.insert(reason);
                (None, None)
            }
        };
        let amount = |qty, point: Option<&SessionClose>| {
            if qty == 0. {
                Some(0.)
            } else {
                point.map(|v| qty * leg.multiplier * v.price)
            }
        };
        let net = amount(leg.end_qty, end)
            .zip(amount(leg.prior_qty, prior))
            .map(|(a, b)| a - b - cash.fills - cash.commissions)
            .filter(|v| v.is_finite());
        net_total = super::add(net_total, net);
        let endpoint = |window: Window, p: Option<&SessionClose>| {
            json!({"date":window.date.to_string(),"sessionStart":window.start,
            "sessionEnd":window.end,"price":p.map(|p|p.price),"at":p.map(|p|p.at),"source":p.map(|p|p.source.as_str()),
            "method":p.map(|p|completed::side_name(p.method))})
        };
        breakdown.push(json!({"conId":leg.con_id,"priorQty":leg.prior_qty,"endQty":leg.end_qty,"multiplier":leg.multiplier,
            "fills":leg.fills.iter().map(|f|json!({"at":f.at,"qty":f.qty,"price":f.price,"commission":f.commission})).collect::<Vec<_>>(),
            "fillCashCost":cash.fills,"commissions":cash.commissions,"currency":leg.currency,"dayPnl":net,
            "dayPrior":endpoint(period.prior,prior),"dayCurrent":endpoint(period.current,end)}));
    }
    ensure!(
        records.is_empty() && !breakdown.is_empty(),
        "Broker evidence contains unrelated or unmapped contracts."
    );
    let absent = breakdown.iter().all(|l| {
        l["priorQty"].as_f64() == Some(0.)
            && l["endQty"].as_f64() == Some(0.)
            && l["fills"].as_array().is_some_and(Vec::is_empty)
    });
    let reason = if net_total.is_some() {
        if absent {
            "Broker verified no position or executions during the session.".into()
        } else {
            "Broker endpoint holdings, executions and actual commissions, valued at TWS session closes.".into()
        }
    } else if loading {
        "Loading TWS session closes for verified broker holdings.".into()
    } else {
        super::combine(
            &missing,
            "TWS historical prices for verified broker holdings are unavailable.",
        )
    };
    let status = if net_total.is_some() {
        "verified"
    } else if loading {
        "loading"
    } else {
        "pricesUnavailable"
    };
    Ok((
        json!({"dayPnl":net_total,"status":status,"source":reason,"loading":loading,"inventoryMethod":record.inventory_method,
        "evidenceSource":record.source,"absent":absent,"commissions":all_charges}),
        breakdown,
    ))
}

pub(super) fn apply(
    row: &mut Value,
    saved: &Value,
    book: &Book,
    now: i64,
    history: &History,
    wanted: &mut BTreeSet<Key>,
) {
    row["modeledDayPnl"] = row["dayPnl"].clone();
    row["modeledDayPct"] = row["dayPct"].clone();
    row["modeledDaySource"] = row["daySource"].clone();
    row["modeledDayPeriod"] = row["dayPeriod"].clone();
    row["brokerDayPnl"] = Value::Null;
    row["brokerDayPct"] = Value::Null;
    row["brokerStatus"] = json!("unverified");
    row["brokerDaySource"] =
        json!("No complete reconciled account record for these saved positions and dates.");
    row["dayPeriod"]["verified"] = json!(false);
    row["dayPeriod"]["attribution"] = json!("model");
    let matches: Vec<_> = saved["accountSessions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            // A modeled position may already be flat while the independently
            // reconciled account still owns this contract.
            r["legs"].as_array().into_iter().flatten().any(|leg| {
                let contract = super::id(leg).and_then(|id|book.items.get(&id));
                matches!(completed::clock(contract, now), Clock::Closed(Some(period))
                    if r["date"] == period.current.date.to_string() && r["priorDate"] == period.prior.date.to_string())
            })
        })
        .collect();
    let [raw] = matches.as_slice() else {
        if matches.len() > 1 {
            row["brokerDaySource"] = json!("Ambiguous account mappings for this session.");
        }
        return;
    };
    if let Some(reason) = raw["_review"].as_str() {
        row["brokerStatus"] = json!("disputed");
        row["brokerDaySource"] = json!(reason);
        if let Some(model_source) = row["daySource"].as_str() {
            row["daySource"] = json!(format!(
                "{model_source} The brokerage return is withheld pending reconciliation."
            ));
        }
        return;
    }
    let result = serde_json::from_value::<Evidence>((*raw).clone())
        .context("Invalid broker evidence.")
        .and_then(|record| reconcile(row, saved, record, book, now, history, wanted));
    let (broker, legs) = match result {
        Ok(v) => v,
        Err(err) => {
            row["brokerDaySource"] = json!(err.to_string());
            return;
        }
    };
    row["brokerStatus"] = broker["status"].clone();
    row["brokerDaySource"] = if raw["_resolved"] == true {
        json!(format!(
            "{} Reconciled to the latest independently observed broker executions.",
            broker["source"].as_str().unwrap_or("")
        ))
    } else {
        broker["source"].clone()
    };
    row["brokerDayPnl"] = broker["dayPnl"].clone();
    row["brokerAbsent"] = broker["absent"].clone();
    row["brokerCommissions"] = broker["commissions"].clone();
    row["brokerEvidenceSource"] = broker["evidenceSource"].clone();
    row["brokerInventoryMethod"] = broker["inventoryMethod"].clone();
    row["brokerLegs"] = json!(legs);
    row["dayPnl"] = row["brokerDayPnl"].clone();
    // The saved model premium is not the actual account's invested capital.
    row["dayPct"] = Value::Null;
    row["daySource"] = row["brokerDaySource"].clone();
    row["dayPeriod"]["estimated"] = json!(false);
    row["dayPeriod"]["attribution"] = json!("broker");
    row["dayPeriod"]["mode"] = json!("closed");
    row["dayPeriod"]["date"] = raw["date"].clone();
    row["dayPeriod"]["priorDate"] = raw["priorDate"].clone();
    row["dayPeriod"]["verified"] = json!(broker["status"] == "verified");
    row["dayPeriod"]["loading"] = broker["loading"].clone();
    row["dayPeriod"]["method"] = json!("Verified broker holdings, fills and commissions");
    for leg in row["legs"].as_array_mut().into_iter().flatten() {
        leg["modeledDayPnl"] = leg["dayPnl"].clone();
        leg["modeledDayPrior"] = leg["dayPrior"].clone();
        leg["modeledDayCurrent"] = leg["dayCurrent"].clone();
        if let Some(actual) = legs.iter().find(|a| a["conId"] == leg["conId"]) {
            leg["dayPnl"] = actual["dayPnl"].clone();
            leg["dayPrior"] = actual["dayPrior"].clone();
            leg["dayCurrent"] = actual["dayCurrent"].clone();
            leg["daySource"] = broker["source"].clone();
            leg["dayPeriod"]["attribution"] = json!("broker");
            leg["dayPeriod"]["mode"] = json!("closed");
            leg["dayPeriod"]["date"] = raw["date"].clone();
            leg["dayPeriod"]["priorDate"] = raw["priorDate"].clone();
            leg["dayPeriod"]["estimated"] = json!(false);
            leg["dayPeriod"]["verified"] = json!(!actual["dayPnl"].is_null());
            leg["dayPeriod"]["method"] = json!("Verified broker holdings, fills and commissions");
        }
    }
}
