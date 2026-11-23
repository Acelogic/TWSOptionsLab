//! Compare a complete dated account statement with independently observed fills.
//! The execution archive may be partial, so absence from it never disproves a statement.
use super::archive::{Archive, Fill, revision};
use anyhow::{Context, Result};
use rusqlite::params;
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn compatible(fill: &Fill, leg: &Value, expected: &Value) -> bool {
    let qty = if fill.side == "BUY" {
        fill.qty
    } else {
        -fill.qty
    };
    let close = |a: f64, b: Option<f64>| b.is_some_and(|n| (a - n).abs() < 1e-7);
    Some(i64::from(fill.con_id)) == leg["conId"].as_i64()
        && expected["at"].as_i64() == Some(fill.at)
        && close(qty, expected["qty"].as_f64())
        && close(fill.price, expected["price"].as_f64())
        && close(fill.multiplier, leg["multiplier"].as_f64())
        && expected["currency"] == fill.currency
        && fill.commission.is_none_or(|fee| {
            fill.commission_currency
                .as_ref()
                .is_some_and(|c| c == &fill.currency)
                && close(fee, expected["commission"].as_f64())
        })
}

impl Archive {
    pub(super) fn authoritative_session(&self, record: &mut Value, scope: &str) -> Result<()> {
        let alternates = record
            .as_object_mut()
            .and_then(|o| o.remove("_alternates"))
            .unwrap_or(Value::Null);
        let multiple = alternates.as_array().is_some_and(|a| !a.is_empty());
        let mut db = self.lock()?;
        let read = db.transaction()?;
        let mut selected = None;
        for candidate in
            std::iter::once(&*record).chain(alternates.as_array().into_iter().flatten())
        {
            if Self::session_matches(&read, candidate, scope)? {
                if selected.is_some() {
                    record["_review"] = json!(
                        "Conflicting dated holdings or fills require independent reconciliation."
                    );
                    return Ok(());
                }
                selected = Some(candidate.clone());
            }
        }
        read.commit()?;
        if let Some(mut selected) = selected {
            if multiple {
                selected["_resolved"] = json!(true);
            }
            *record = selected;
        } else {
            record["_review"] = json!(
                "Recorded account activity conflicts with the latest broker executions or lifecycle events; this session requires reconciliation."
            );
        }
        Ok(())
    }
    fn session_matches(db: &rusqlite::Connection, record: &Value, scope: &str) -> Result<bool> {
        let mut select=db.prepare_cached("SELECT e.base,e.fill FROM executions e WHERE e.scope=?1 AND e.base IN (
            SELECT value FROM json_each(?2)
            UNION SELECT base FROM executions WHERE scope=?1 AND json_extract(fill,'$.conId')=?3 AND json_extract(fill,'$.at')>?4 AND json_extract(fill,'$.at')<=?5
            UNION SELECT base FROM prior_execution_versions WHERE scope=?1 AND json_extract(fill,'$.conId')=?3 AND json_extract(fill,'$.at')>?4 AND json_extract(fill,'$.at')<=?5)")?;
        let has_lifecycle:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='lifecycle_events')",[],|r|r.get(0))?;
        for leg in record["legs"]
            .as_array()
            .context("Broker legs unavailable")?
        {
            let listed = leg["fills"]
                .as_array()
                .context("Broker fills unavailable")?;
            let identifiers = listed
                .iter()
                .map(|f| revision(f["id"].as_str().unwrap_or("")).0)
                .collect::<Vec<_>>();
            let (start, end) = (
                leg["priorEnd"]
                    .as_i64()
                    .context("Prior close unavailable")?,
                leg["end"].as_i64().context("Session close unavailable")?,
            );
            let cid = leg["conId"]
                .as_i64()
                .context("Broker contract unavailable")?;
            if has_lifecycle {
                let has_units =
                    leg["priorQty"].as_f64() != Some(0.) || leg["endQty"].as_f64() != Some(0.);
                // These account records carry ordinary signed fills, not an
                // assignment's delivered asset or an option settlement.
                let lifecycle:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM lifecycle_events
                    WHERE scope=?1 AND json_extract(payload,'$.conId')=?2 AND
                    ((json_extract(payload,'$.at')>?3 AND json_extract(payload,'$.at')<=?4)
                      OR (?5 AND json_extract(payload,'$.eventType')='expiration' AND json_extract(payload,'$.at')<=?3)))",
                    params![scope,cid,start,end,has_units],|r|r.get(0))?;
                if lifecycle {
                    return Ok(false);
                }
            }
            let mut used = BTreeSet::new();
            // First match broker execution IDs. Statement exports can use other
            // identifiers; reserve the native matches before checking those.
            let mut others = vec![];
            for observed in select.query_map(
                params![scope, json!(identifiers).to_string(), cid, start, end],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )? {
                let (base, raw) = observed?;
                let fill: Fill = serde_json::from_str(&raw)?;
                if let Some(idx) = identifiers.iter().position(|s| *s == base) {
                    // A partial historical archive can still carry an older
                    // revision than the complete statement being verified.
                    let expected_rev = revision(listed[idx]["id"].as_str().unwrap_or("")).1;
                    if revision(&fill.id).1 >= expected_rev && !compatible(&fill, leg, &listed[idx])
                    {
                        return Ok(false);
                    }
                    if !used.insert(idx) {
                        return Ok(false);
                    }
                } else {
                    others.push(fill);
                }
            }
            for fill in others {
                let in_interval =
                    i64::from(fill.con_id) == cid && start < fill.at && fill.at <= end;
                if !in_interval {
                    // This fill used to be in the statement interval and moved
                    // to another date/contract. An old alternate-ID statement
                    // referring to its prior economics needs a fresh reconciliation.
                    let mut old=db.prepare_cached("SELECT fill FROM prior_execution_versions WHERE scope=?1 AND base=?2 AND json_extract(fill,'$.conId')=?3 AND json_extract(fill,'$.at')>?4 AND json_extract(fill,'$.at')<=?5")?;
                    for previous in old
                        .query_map(params![scope, revision(&fill.id).0, cid, start, end], |r| {
                            r.get::<_, String>(0)
                        })?
                    {
                        let prior: Fill = serde_json::from_str(&previous?)?;
                        if listed.iter().any(|f| compatible(&prior, leg, f)) {
                            return Ok(false);
                        }
                    }
                    continue;
                }
                let same = listed
                    .iter()
                    .enumerate()
                    .find(|(i, f)| !used.contains(i) && compatible(&fill, leg, f));
                let Some((idx, _)) = same else {
                    return Ok(false);
                };
                used.insert(idx);
            }
        }
        Ok(true)
    }
}
