//! A manual group records allocated opening/closing pairs. Broker rows remain authoritative.
use super::{Archive, Market, OptionsHistory, confirmed_offline, trades};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};

fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
pub(super) fn scope_token(scope: &str) -> String {
    digest(format!("manual-spread-scope:{scope}").as_bytes())
}
fn field<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn array<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v[k].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn quantity(v: &Value) -> Option<i64> {
    let n = v["qty"].as_f64()?;
    (n.is_finite() && n > 0. && n < 1e12 && n.fract() == 0.).then_some(n as i64)
}
fn sum<'a>(iter: impl IntoIterator<Item = &'a Value>, key: &str) -> Option<f64> {
    iter.into_iter()
        .try_fold(0., |n, v| v[key].as_f64().map(|v| n + v))
}
#[derive(Ord, PartialOrd, Eq, PartialEq, Clone, Serialize, Deserialize)]
struct Pair {
    trade: String,
    contract: i64,
    opening: String,
    closing: String,
    qty: i64,
}
struct Source {
    index: usize,
    pairs: BTreeSet<Pair>,
}
impl Source {
    fn inspect(index: usize, trade: &Value) -> Option<Self> {
        let legs = array(trade, "legs");
        if legs.len() != 1
            || trade["status"] != "closed"
            || !matches!(field(&legs[0], "secType"), "OPT" | "FOP")
        {
            return None;
        }
        let contract = legs[0]["conId"].as_i64()?;
        let mut opens = BTreeMap::new();
        let mut linked = BTreeMap::<String, i64>::new();
        let mut pairs = BTreeSet::new();
        let mut close_ids = BTreeSet::new();
        for f in array(trade, "fills") {
            if f["conId"].as_i64()? != contract {
                return None;
            }
            let id = f["id"].as_str()?;
            let qty = quantity(f)?;
            match field(f, "role") {
                "open" => {
                    if opens.insert(id.to_owned(), qty).is_some() {
                        return None;
                    }
                }
                "close" => {
                    if !close_ids.insert(id) {
                        return None;
                    }
                    let mut parts = BTreeMap::<String, i64>::new();
                    for lot in array(f, "lots") {
                        let op = lot["openingExecutionId"].as_str()?.to_owned();
                        let qty = quantity(lot)?;
                        *parts.entry(op.clone()).or_default() += qty;
                        *linked.entry(op).or_default() += qty;
                    }
                    if parts.values().sum::<i64>() != qty {
                        return None;
                    }
                    for (opening, qty) in parts {
                        pairs.insert(Pair {
                            trade: field(trade, "id").to_owned(),
                            contract,
                            opening,
                            closing: id.to_owned(),
                            qty,
                        });
                    }
                }
                _ => return None,
            }
        }
        (!pairs.is_empty() && opens == linked).then_some(Self { index, pairs })
    }
}
type Sources = HashMap<String, Source>;
fn sources(trades: &[Value]) -> Sources {
    trades
        .iter()
        .enumerate()
        .filter_map(|(i, t)| Source::inspect(i, t).map(|s| (field(t, "id").to_owned(), s)))
        .collect()
}
pub(super) struct Stored {
    scope: String,
    id: String,
    name: String,
    token: String,
    pairs: BTreeSet<Pair>,
}
pub(super) fn read(db: &Connection, scopes: &[String]) -> Result<Vec<Stored>> {
    let mut query =
        db.prepare("SELECT id,name,token,members FROM manual_spreads WHERE scope=? ORDER BY id")?;
    let mut rows = Vec::new();
    for scope in scopes {
        for row in query.query_map([scope], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })? {
            let (id, name, token, members) = row?;
            rows.push(Stored {
                scope: scope_token(scope),
                id,
                name,
                token,
                pairs: serde_json::from_str(&members)?,
            });
        }
    }
    Ok(rows)
}
fn slice(trade: &Value, selected: &BTreeSet<Pair>) -> Result<Value> {
    ensure!(
        !selected.is_empty(),
        "Select at least one matched opening and closing quantity."
    );
    // A FIFO-compatible cash amount identifies the position's economics but
    // cannot distinguish two opening executions at the same price. Only
    // explicitly matched broker lots support selecting within that position.
    let total_qty = trade["legs"][0]["openedQty"]
        .as_f64()
        .context("Missing original quantity.")?;
    if (selected.iter().map(|p| p.qty).sum::<i64>() as f64) < total_qty {
        ensure!(
            array(trade, "fills")
                .iter()
                .filter(|f| f["role"] == "close")
                .all(|f| field(f, "allocationSource") == "IBKR matched opening lot"),
            "Select the complete position. The statement does not identify every original opening lot."
        );
    }
    let mut fills = Vec::new();
    for f in array(trade, "fills") {
        let open = f["role"] == "open";
        let id = field(f, "id");
        let pairs = selected
            .iter()
            .filter(|p| {
                if open {
                    p.opening == id
                } else {
                    p.closing == id
                }
            })
            .collect::<Vec<_>>();
        if pairs.is_empty() {
            continue;
        }
        let qty = pairs.iter().map(|p| p.qty).sum::<i64>();
        let original = quantity(f).context("Invalid broker fill quantity.")?;
        ensure!(
            qty <= original,
            "Selected quantity exceeds the broker fill."
        );
        let mut fill = f.clone();
        fill["sourceTradeId"] = trade["id"].clone();
        fill["qty"] = json!(qty);
        if qty < original {
            fill["commission"] = json!(
                f["commission"]
                    .as_f64()
                    .map(|fee| fee * (qty as f64) / (original as f64))
            );
            if !open {
                ensure!(
                    field(f, "allocationSource") == "IBKR matched opening lot",
                    "Select this whole closing fill. Its individual lot allocation is unconfirmed."
                );
                let selected_ids = pairs
                    .iter()
                    .map(|p| p.opening.as_str())
                    .collect::<BTreeSet<_>>();
                let lots = array(f, "lots")
                    .iter()
                    .filter(|l| selected_ids.contains(field(l, "openingExecutionId")))
                    .cloned()
                    .collect::<Vec<_>>();
                let broker = sum(&lots, "brokerRealizedPnl");
                let economic = if matches!(field(f, "eventType"), "assignment" | "exercise") {
                    broker
                } else {
                    sum(&lots, "netRealizedPnl")
                };
                ensure!(
                    economic.is_some() || f["netRealizedPnl"].is_null(),
                    "Select this whole exercise or assignment. IBKR supplied its option-leg amount at the closing execution level."
                );
                fill["lots"] = json!(lots);
                fill["netRealizedPnl"] = json!(economic);
                fill["brokerRealizedPnl"] = json!(broker);
            }
        }
        fills.push(fill);
    }
    let mut result = trade.clone();
    let mut leg = trade["legs"][0].clone();
    let closes = fills
        .iter()
        .filter(|f| f["role"] == "close")
        .collect::<Vec<_>>();
    let opens = fills
        .iter()
        .filter(|f| f["role"] == "open")
        .collect::<Vec<_>>();
    let opened = opens.iter().filter_map(|f| quantity(f)).sum::<i64>();
    let closed = closes.iter().filter_map(|f| quantity(f)).sum::<i64>();
    ensure!(
        opened == closed && opened > 0,
        "The selected opening and closing quantities must balance."
    );
    let cash = sum(&fills, "netRealizedPnl");
    let broker = sum(&fills, "brokerRealizedPnl");
    leg["openedQty"] = json!(opened);
    leg["closedQty"] = json!(closed);
    leg["remainingQty"] = json!(0);
    leg["netRealizedPnl"] = json!(cash);
    leg["brokerRealizedPnl"] = json!(broker);
    result["openedAt"] = json!(opens.iter().filter_map(|f| f["at"].as_i64()).min());
    result["closedAt"] = json!(closes.iter().filter_map(|f| f["at"].as_i64()).max());
    result["lastAt"] = result["closedAt"].clone();
    result["netRealizedPnl"] = json!(cash);
    result["brokerRealizedPnl"] = json!(broker);
    if cash.is_some() {
        result["pnlReason"] = json!("");
    }
    result["fills"] = json!(fills);
    result["legs"] = json!([leg]);
    result["manualEligible"] = json!(true);
    Ok(result)
}
fn chronology(parts: &[Value]) -> Result<&'static str> {
    // Sweep the actual matched lot intervals. Partial exits can produce gaps
    // inside the apparent interval between a leg's first and last execution.
    let mut changes = BTreeMap::<i64, Vec<(usize, i64)>>::new();
    let mut contracts = HashMap::new();
    for part in parts {
        let contract = part["legs"][0]["conId"]
            .as_i64()
            .context("Missing option contract.")?;
        let next = contracts.len();
        let index = *contracts.entry(contract).or_insert(next);
        for f in array(part, "fills").iter().filter(|f| f["role"] == "close") {
            let end = f["at"]
                .as_i64()
                .context("Missing closing execution time.")?;
            for lot in array(f, "lots") {
                let start = lot["openedAt"]
                    .as_i64()
                    .context("Missing opening execution time.")?;
                let qty = quantity(lot).context("Missing matched option quantity.")?;
                if start < end {
                    changes.entry(start).or_default().push((index, qty));
                    changes.entry(end).or_default().push((index, -qty));
                }
            }
        }
    }
    let mut held = vec![0i64; contracts.len()];
    for change in changes.values() {
        for &(index, qty) in change {
            held[index] += qty;
        }
        if held.iter().all(|q| *q > 0) {
            return Ok("");
        }
    }
    Ok(
        "The executions do not confirm a period when every selected leg was held simultaneously. The grouping reflects your selection.",
    )
}
fn build(parts: &[Value], scope: &str, id: &str, name: &str) -> Result<Value> {
    ensure!(
        parts.len() >= 2,
        "Select between two and sixteen distinct closed option contracts."
    );
    let first = &parts[0];
    let mut ids = BTreeSet::new();
    let mut under = BTreeSet::new();
    let mut buckets = BTreeMap::<(i64, String), Vec<&Value>>::new();
    let mut fills = Vec::new();
    let mut matches = BTreeMap::new();
    let mut all_matched = true;
    let sec = field(&first["legs"][0], "secType");
    for t in parts {
        let leg = &t["legs"][0];
        ensure!(
            t["selectionScope"] == scope,
            "Choose trades from one verified account."
        );
        ensure!(
            t["currency"] == first["currency"]
                && t["symbol"] == first["symbol"]
                && field(leg, "secType") == sec,
            "Choose options with the same underlying and currency."
        );
        let cid = leg["conId"]
            .as_i64()
            .context("Missing broker option contract.")?;
        ids.insert(cid);
        if let Some(id) = leg["underlyingConId"].as_i64() {
            under.insert(id);
        } else if sec == "FOP" {
            bail!("A matching broker underlying futures contract is required.");
        }
        for m in array(t, "matches") {
            matches.insert(field(m, "id").to_owned(), m.clone());
        }
        all_matched &= t["matchStatus"] == "matched";
        buckets
            .entry((cid, field(leg, "direction").to_owned()))
            .or_default()
            .push(t);
        fills.extend_from_slice(array(t, "fills"));
    }
    ensure!(
        under.len() <= 1,
        "These options have distinct broker underlying contracts."
    );
    ensure!(
        (2..=16).contains(&ids.len()),
        "Select between two and sixteen distinct closed option contracts."
    );
    let repeated = ids.len() < parts.len();
    let legs = buckets
        .into_values()
        .map(|episodes| {
            let mut leg = episodes[0]["legs"][0].clone();
            let originals = episodes.iter().map(|t| &t["legs"][0]).collect::<Vec<_>>();
            for field in [
                "openedQty",
                "closedQty",
                "netRealizedPnl",
                "brokerRealizedPnl",
            ] {
                leg[field] = json!(sum(originals.iter().copied(), field));
            }
            leg["sourceTradeIds"] = json!(episodes.iter().map(|t| &t["id"]).collect::<Vec<_>>());
            leg
        })
        .collect::<Vec<_>>();
    let chronology_note = chronology(parts)?;
    let label = if repeated {
        format!("{} spread with reopened legs", field(first, "symbol"))
    } else {
        trades::group_label(field(first, "symbol"), &legs, "Manually grouped spread")
    };
    fills.sort_by(|a, b| {
        a["at"]
            .as_i64()
            .cmp(&b["at"].as_i64())
            .then_with(|| field(a, "id").cmp(field(b, "id")))
    });
    let opening = parts.iter().filter_map(|t| t["openedAt"].as_i64()).min();
    let closing = parts.iter().filter_map(|t| t["closedAt"].as_i64()).max();
    let economic = sum(parts, "netRealizedPnl");
    let broker = sum(parts, "brokerRealizedPnl");
    let fees = fills.iter().try_fold(0., |n, f| {
        let fee = f["commission"].as_f64()?;
        (fee == 0. || f["commissionCurrency"] == first["currency"]).then_some(n + fee)
    });
    let assigned = fills
        .iter()
        .any(|f| matches!(field(f, "eventType"), "assignment" | "exercise"));
    let status = if matches.len() > 1 {
        "ambiguous"
    } else if matches.len() == 1 && all_matched {
        "matched"
    } else {
        "unmatched"
    };
    Ok(
        json!({"id":id,"manualGroupId":id,"manualName":name,"label":if name.is_empty(){label.as_str()}else{name},"strategyLabel":label,
        "selectionScope":scope,"manualEligible":false,"groupSource":"Manually grouped spread","chronologyNote":chronology_note,"symbol":first["symbol"],"currency":first["currency"],
        "openedAt":opening,"closedAt":closing,"lastAt":closing,"status":"closed","netRealizedPnl":economic,"brokerRealizedPnl":broker,
        "totalCommission":fees,"pnlSource":if assigned{"Matched option premiums after commissions. Assignments and exercises use IBKR’s option-leg allocation and exclude delivered shares."}else{"Matched option premiums after opening and closing commissions."},
        "pnlReason":if economic.is_none(){"A selected option allocation is missing economic or commission evidence."}else{""},
        "brokerPnlSource":first["brokerPnlSource"],"inventorySource":"Matched broker opening and closing quantities",
        "matchStatus":status,"matches":matches.into_values().collect::<Vec<_>>(),"sourceTradeIds":parts.iter().map(|t|&t["id"]).collect::<Vec<_>>(),
        "legs":legs,"fills":fills}),
    )
}
type Selections = BTreeSet<Pair>;
fn by_trade(pairs: &Selections) -> BTreeMap<&str, Selections> {
    let mut out = BTreeMap::new();
    for p in pairs {
        out.entry(p.trade.as_str())
            .or_insert_with(BTreeSet::new)
            .insert(p.clone());
    }
    out
}
fn components(trades: &[Value], sources: &Sources, pairs: &Selections) -> Result<Vec<Value>> {
    by_trade(pairs)
        .into_iter()
        .map(|(id, subset)| {
            let s = sources
                .get(id)
                .context("The original broker position changed or is unavailable.")?;
            ensure!(
                subset.is_subset(&s.pairs),
                "A matched fill or its quantity changed since the grouping was saved."
            );
            slice(&trades[s.index], &subset)
        })
        .collect()
}
// Reconstruct both sides of every split. A corrected/enriched ledger can make
// a formerly valid split unattributable; in that case leave its sources visible.
fn project(
    trades: &[Value],
    sources: &Sources,
    group: &Stored,
    used: &Selections,
) -> Result<(Value, HashMap<String, Option<Value>>)> {
    ensure!(
        used.is_disjoint(&group.pairs),
        "Another group uses this matched quantity."
    );
    let parts = components(trades, sources, &group.pairs)?;
    let aggregate = build(&parts, &group.scope, &group.id, &group.name)?;
    let mut leftovers = HashMap::new();
    for (id, selected) in by_trade(&group.pairs) {
        let source = sources
            .get(id)
            .context("The original broker position is unavailable.")?;
        let rest = source
            .pairs
            .difference(used)
            .filter(|p| !selected.contains(*p))
            .cloned()
            .collect::<Selections>();
        let remaining = if rest.is_empty() {
            None
        } else {
            Some(slice(&trades[source.index], &rest)?)
        };
        leftovers.insert(id.to_owned(), remaining);
    }
    Ok((aggregate, leftovers))
}
pub(super) fn overlay(mut trades: Vec<Value>, stored: Vec<Stored>) -> (Vec<Value>, Vec<Value>) {
    let sources = sources(&trades);
    let mut used = Selections::new();
    let mut manual = Vec::new();
    let mut status = Vec::new();
    let mut residuals = HashMap::new();
    for group in stored {
        let (state, reason) = match project(&trades, &sources, &group, &used) {
            Ok((trade, leftovers)) => {
                used.extend(group.pairs);
                manual.push(trade);
                residuals.extend(leftovers);
                ("active", String::new())
            }
            Err(error) => ("needsReview", error.to_string()),
        };
        status.push(json!({"id":group.id,"scope":group.scope,"name":group.name,"status":state,"reason":reason}));
    }
    let mut display = Vec::new();
    for mut trade in trades.drain(..) {
        let id = field(&trade, "id");
        if let Some(residual) = residuals.remove(id) {
            display.extend(residual);
        } else {
            trade["manualEligible"] = json!(sources.contains_key(id));
            display.push(trade);
        }
    }
    display.extend(manual);
    display.sort_by(|a, b| {
        b["lastAt"]
            .as_i64()
            .cmp(&a["lastAt"].as_i64())
            .then_with(|| field(a, "id").cmp(field(b, "id")))
    });
    (display, status)
}
impl OptionsHistory {
    pub(crate) async fn manual_spread(&self, market: &Market, data: &Value) -> Result<Value> {
        let requested = data["scope"]
            .as_str()
            .context("Choose a verified account history scope.")?;
        let scopes = match market.client(1).await {
            Ok(client) => self
                .identify(&client)
                .await?
                .context("TWS has not confirmed the current accounts.")?
                .into_values()
                .collect::<Vec<_>>(),
            Err(e) => {
                ensure!(
                    confirmed_offline(market, 1, &e).await,
                    "The current account connection is unconfirmed."
                );
                self.archive.last_scopes()?.0
            }
        };
        let scope = scopes
            .into_iter()
            .find(|s| scope_token(s) == requested)
            .context("The selected history belongs to a different or unconfirmed account.")?;
        let archive = self.archive.clone();
        let data = data.clone();
        tokio::task::spawn_blocking(move || mutation(&archive, &scope, &data)).await?
    }
}
fn mutation(archive: &Archive, scope: &str, data: &Value) -> Result<Value> {
    let action = field(data, "action");
    ensure!(
        matches!(action, "preview" | "save" | "ungroup"),
        "Choose preview, save or ungroup."
    );
    let mut db = archive.lock()?;
    let tx = db.transaction_with_behavior(if action == "preview" {
        TransactionBehavior::Deferred
    } else {
        TransactionBehavior::Immediate
    })?;
    let active = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM active_scopes WHERE scope=?1)",
        [scope],
        |r| r.get::<_, bool>(0),
    )?;
    ensure!(
        active,
        "The verified account scope changed. Refresh Options History."
    );
    if action == "ungroup" {
        let id = data["id"]
            .as_str()
            .filter(|v| v.starts_with("manual-") && v.len() == 71)
            .context("Choose a saved manual group.")?;
        tx.execute(
            "DELETE FROM manual_spreads WHERE scope=?1 AND id=?2",
            params![scope, id],
        )?;
        tx.commit()?;
        return Ok(json!({"ok":true,"id":id}));
    }
    let name = match data.get("name") {
        Some(Value::String(v)) => v.trim(),
        None | Some(Value::Null) => "",
        _ => bail!("Supply a text name for the spread."),
    };
    ensure!(
        name.chars().count() <= 96 && !name.chars().any(char::is_control),
        "Use a spread name of up to 96 printable characters."
    );
    let requested = data["selections"]
        .as_array()
        .context("Choose source trades or fills.")?;
    ensure!(
        (2..=128).contains(&requested.len()),
        "Choose between two and 128 source positions or fills."
    );
    let scopes = [scope.to_owned()];
    let (fills, _, _, _) = Archive::rows_in(&tx, &scopes)?;
    let (trades, _) = trades::grouped(&fills, &HashMap::new(), None);
    let sources = sources(&trades);
    let stored = read(&tx, &scopes)?;
    let token = field(data, "previewToken");
    let own = if action == "save" {
        stored.iter().find(|g| g.token == token)
    } else {
        None
    };
    let mut used = Selections::new();
    let mut reserved = Selections::new();
    for g in &stored {
        if own.is_some_and(|own| own.id == g.id) {
            continue;
        }
        let current = project(&trades, &sources, g, &used);
        if current.is_ok() {
            used.extend(g.pairs.iter().cloned());
        } else {
            reserved.extend(g.pairs.iter().cloned());
        }
    }
    let mut selected = Selections::new();
    for s in requested {
        let trade = s["tradeId"]
            .as_str()
            .and_then(|id| sources.get(id))
            .context("Choose an eligible, closed single-contract position in this account.")?;
        let role = match s.get("role") {
            None | Some(Value::Null) => "",
            Some(Value::String(r)) if matches!(r.as_str(), "open" | "close") => r,
            _ => bail!("Choose an opening or closing execution."),
        };
        let id = match s.get("fillId") {
            None | Some(Value::Null) => None,
            Some(Value::String(id)) if !id.is_empty() => Some(id.as_str()),
            _ => bail!("Invalid execution identifier."),
        };
        ensure!(
            role.is_empty() || id.is_some(),
            "A selected execution role requires its fill ID."
        );
        if let Some(id) = id {
            let directions = array(&trades[trade.index], "fills")
                .iter()
                .filter(|f| f["id"] == id)
                .map(|f| field(f, "role"))
                .collect::<BTreeSet<_>>();
            ensure!(
                !directions.is_empty() && (directions.len() == 1 || !role.is_empty()),
                "Choose the position effect of this shared execution."
            );
        }
        let mut count = 0;
        for p in &trade.pairs {
            let matched = id.is_none_or(|id| {
                (role != "close" && p.opening == id) || (role != "open" && p.closing == id)
            });
            if !matched || used.contains(p) {
                continue;
            }
            ensure!(
                !reserved.contains(p),
                "Remove the earlier grouping marked for review before reusing its allocations."
            );
            selected.insert(p.clone());
            count += 1;
        }
        ensure!(
            count > 0,
            "This fill is already grouped, unavailable, or has no remaining matched quantity."
        );
    }
    let summary=by_trade(&selected).into_iter().map(|(id,subset)|{
        let source=&sources[id];
        let chosen=slice(&trades[source.index],&subset)?;
        let left=source.pairs.difference(&used).filter(|p|!subset.contains(*p)).cloned().collect::<Selections>();
        if !left.is_empty(){slice(&trades[source.index],&left)?;}
        Ok(json!({"tradeId":id,"conId":chosen["legs"][0]["conId"],"openedQty":chosen["legs"][0]["openedQty"],"closedQty":chosen["legs"][0]["closedQty"],"fillCount":array(&chosen,"fills").len(),"wholeTrade":subset==source.pairs}))
    }).collect::<Result<Vec<_>>>()?;
    let membership = serde_json::to_string(&selected)?;
    let key = scope_token(scope);
    let id = format!(
        "manual-{}",
        digest(format!("{key}|{membership}").as_bytes())
    );
    let parts = components(&trades, &sources, &selected)?;
    let trade = build(&parts, &key, &id, name)?;
    let current = digest(&serde_json::to_vec(&json!([
        &id,
        name,
        &trade["legs"],
        &trade["fills"]
    ]))?);
    let mut result = json!({"ok":true,"previewToken":current,"trade":trade,"sourceTradeCount":parts.len(),"selectionSummary":summary});
    if action == "save" {
        ensure!(
            current == token,
            "The preview changed. Preview the current allocations before saving."
        );
        if let Some(existing) = own {
            ensure!(
                existing.id == id && existing.pairs == selected,
                "This preview belongs to another group."
            );
        } else {
            tx.execute(
                "INSERT INTO manual_spreads(scope,id,name,token,members) VALUES(?1,?2,?3,?4,?5)",
                params![scope, id, name, current, membership],
            )?;
        }
        result["id"] = json!(id);
    }
    tx.commit()?;
    Ok(result)
}
