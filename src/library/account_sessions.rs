//! Separate, version-bound account evidence. Saving a modeled strategy never
//! changes a broker observation, and ordinary strategy exports omit account data.
use super::Library;
use crate::position::Position;
use anyhow::{Context, Result, ensure};
use chrono::{NaiveDate, TimeZone, Utc};
use chrono_tz::{America::New_York, Tz};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub(super) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS account_sessions(
        strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, session_date TEXT NOT NULL, account_scope TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(strategy_id,version,session_date,account_scope)
    );
    CREATE INDEX IF NOT EXISTS account_sessions_scope_date
        ON account_sessions(account_scope,session_date);
    CREATE TABLE IF NOT EXISTS account_session_disputes(
        strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, session_date TEXT NOT NULL, account_scope TEXT NOT NULL,
        observed INTEGER NOT NULL, alternate_payload TEXT NOT NULL,
        PRIMARY KEY(strategy_id,version,session_date,account_scope,alternate_payload)
    );
    CREATE TABLE IF NOT EXISTS account_session_executions(
        account_scope TEXT NOT NULL, execution_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
        session_date TEXT NOT NULL, con_id INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(account_scope,execution_id)
    );";

pub(super) fn install(tx: &Transaction<'_>) -> Result<()> {
    let old:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('account_sessions')) AND NOT EXISTS(SELECT 1 FROM pragma_table_info('account_sessions') WHERE name='account_scope')",[],|r|r.get(0))?;
    if old {
        tx.execute_batch(
            "DROP INDEX IF EXISTS account_sessions_scope_date;
                ALTER TABLE account_sessions RENAME TO account_sessions_legacy;",
        )?;
    }
    tx.execute_batch(SCHEMA)?;
    if old {
        tx.execute_batch("INSERT INTO account_sessions(strategy_id,version,session_date,account_scope,payload)
            SELECT strategy_id,version,session_date,json_extract(payload,'$.accountScope'),payload FROM account_sessions_legacy;
            DROP TABLE account_sessions_legacy;")?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    records: Vec<Evidence>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Evidence {
    strategy_id: String,
    version: i64,
    prior_date: String,
    date: String,
    source: String,
    account_scope: String,
    inventory_method: String,
    complete: bool,
    legs: Vec<EvidenceLeg>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvidenceLeg {
    con_id: i32,
    multiplier: f64,
    currency: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    zone: Option<String>,
    prior_end: i64,
    end: i64,
    prior_qty: f64,
    end_qty: f64,
    fills: Vec<Fill>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fill {
    id: String,
    at: i64,
    qty: f64,
    price: f64,
    commission: f64,
    currency: String,
}

fn is_label(s: &str, max: usize) -> bool {
    !s.is_empty() && s.trim() == s && s.len() <= max && !s.chars().any(char::is_control)
}
fn date(s: &str) -> Result<NaiveDate> {
    let day =
        NaiveDate::parse_from_str(s, "%Y-%m-%d").context("Use ISO YYYY-MM-DD session dates.")?;
    ensure!(
        day.format("%Y-%m-%d").to_string() == s,
        "Use ISO YYYY-MM-DD session dates."
    );
    Ok(day)
}

fn omittable(l: &Value, prior_date: NaiveDate, prior_end: i64) -> Result<bool> {
    if l["kind"] != "option" {
        return Ok(false);
    }
    let expired = l["expiry"]
        .as_str()
        .and_then(|e| NaiveDate::parse_from_str(e, "%Y%m%d").ok())
        .is_some_and(|e| e < prior_date);
    Ok(expired && Position::read(l, 0.)?.exposure(prior_end).0 == 0.)
}
fn checked_qty(q: f64, option: bool) -> bool {
    q.is_finite() && q.abs() <= 9_007_199_254_740_991. && (!option || q.fract() == 0.)
}

fn same_session_cashflows(a: &Value, b: &Value) -> bool {
    let facts = |record: &Value| {
        let mut legs = record["legs"].clone();
        for leg in legs.as_array_mut().into_iter().flatten() {
            if let Some(fields) = leg.as_object_mut() {
                fields.remove("zone");
            }
            if let Some(fills) = leg["fills"].as_array_mut() {
                for f in fills.iter_mut() {
                    if let Some(fields) = f.as_object_mut() {
                        fields.remove("id");
                    }
                }
                fills.sort_by_cached_key(|f| f.to_string());
            }
        }
        legs
    };
    a["priorDate"] == b["priorDate"] && facts(a) == facts(b)
}

impl Evidence {
    fn canonical_order(&mut self) {
        self.legs.sort_by_key(|l| l.con_id);
        for leg in &mut self.legs {
            leg.fills
                .sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.id.cmp(&b.id)));
        }
    }
    fn validate(&self, tx: &Transaction<'_>) -> Result<()> {
        ensure!(
            is_label(&self.strategy_id, 100) && self.version > 0,
            "Choose a saved trade and its current version."
        );
        ensure!(
            self.complete
                && matches!(
                    self.inventory_method.as_str(),
                    "datedStatement" | "completeReplay"
                ),
            "Confirm complete execution coverage and provide the verified cutoff inventory method."
        );
        let source = self.source.to_ascii_lowercase();
        ensure!(
            is_label(&self.source, 240)
                && (source.contains("ibkr")
                    || source.contains("interactive brokers")
                    || source.starts_with("tws ")),
            "Identify the broker evidence source."
        );
        ensure!(
            self.account_scope.len() == 64
                && self
                    .account_scope
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "Use a 64-character lowercase salted account digest."
        );
        ensure!(
            (1..=16).contains(&self.legs.len()),
            "Provide between one and sixteen qualified evidence contracts."
        );
        let prior_date = date(&self.prior_date)?;
        let session_date = date(&self.date)?;
        ensure!(
            prior_date < session_date,
            "Prior session date must precede the current session date."
        );
        let now = Utc::now().timestamp_millis();
        let (version, doc): (i64, String) = tx
            .query_row(
                "SELECT version,document FROM strategies WHERE id=?1",
                [&self.strategy_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .context("The saved strategy no longer exists.")?;
        ensure!(
            version == self.version,
            "The saved strategy version has changed. Reconcile against its current version."
        );
        let doc: Value = serde_json::from_str(&doc)?;
        let legs = doc["legs"]
            .as_array()
            .context("The saved strategy has no leg list.")?;
        let earliest = self.legs.iter().map(|l| l.prior_end).min().unwrap();
        let mut expected: BTreeMap<i32, Vec<&Value>> = BTreeMap::new();
        let required_ids: BTreeSet<i32> = self.legs.iter().map(|l| l.con_id).collect();
        ensure!(
            required_ids.len() == self.legs.len(),
            "Supply each qualified contract once."
        );
        for l in legs.iter().filter(|l| l["excluded"] != true) {
            let id = l["conId"]
                .as_i64()
                .and_then(|n| i32::try_from(n).ok())
                .filter(|n| *n > 0);
            if omittable(l, prior_date, earliest)? && id.is_none_or(|n| !required_ids.contains(&n))
            {
                continue;
            }
            expected
                .entry(id.context("A contributing saved leg has no qualified TWS contract ID.")?)
                .or_default()
                .push(l);
        }
        ensure!(
            expected.keys().copied().collect::<BTreeSet<_>>() == required_ids,
            "Provide exact coverage of included contract IDs, including verified zero positions."
        );
        let mut fill_ids = BTreeSet::new();
        for e in &self.legs {
            let saved = &expected[&e.con_id];
            let l = saved[0];
            let option = l["kind"] == "option";
            ensure!(
                e.multiplier.is_finite()
                    && e.multiplier > 0.
                    && e.currency.len() == 3
                    && e.currency.bytes().all(|c| c.is_ascii_uppercase())
                    && saved
                        .iter()
                        .all(|l| l["multiplier"].as_f64() == Some(e.multiplier)
                            && l["currency"].as_str().or(doc["currency"].as_str())
                                == Some(&e.currency)),
                "Currency or multiplier disagrees with the saved contract {}.",
                e.con_id
            );
            let zone: Tz = match e.zone.as_deref() {
                Some(z) => z
                    .parse()
                    .map_err(|_| anyhow::anyhow!("Unknown venue timezone {z}."))?,
                None if e.currency == "USD" => New_York,
                None => anyhow::bail!("Specify the venue timezone for {}.", e.con_id),
            };
            ensure!(
                e.prior_end > 0
                    && e.prior_end < e.end
                    && e.end <= now
                    && zone
                        .timestamp_millis_opt(e.prior_end)
                        .single()
                        .is_some_and(|v| v.date_naive() == prior_date)
                    && zone
                        .timestamp_millis_opt(e.end)
                        .single()
                        .is_some_and(|v| v.date_naive() == session_date),
                "The observed cutoffs must match the two completed venue dates for {}.",
                e.con_id
            );
            ensure!(
                checked_qty(e.prior_qty, option) && checked_qty(e.end_qty, option),
                "Invalid cutoff quantity for {}.",
                e.con_id
            );
            ensure!(
                e.fills.len() <= 2048,
                "Too many executions for one contract."
            );
            for fill in &e.fills {
                ensure!(
                    is_label(&fill.id, 128) && fill_ids.insert(fill.id.clone()),
                    "Execution identifiers must be present and unique."
                );
                ensure!(
                    e.prior_end < fill.at && fill.at <= e.end,
                    "Execution {} is outside the closing cutoffs.",
                    fill.id
                );
                ensure!(
                    fill.currency == e.currency
                        && fill.price.is_finite()
                        && fill.price >= 0.
                        && fill.commission.is_finite()
                        && checked_qty(fill.qty, option)
                        && fill.qty != 0.,
                    "Invalid execution units, price, currency or fee for {}.",
                    fill.id
                );
            }
            // Options must reconcile to an exact number of contracts. Shares may be fractional.
            let reconciled = if option {
                let filled: i128 = e.fills.iter().map(|f| f.qty as i128).sum();
                e.prior_qty as i128 + filled == e.end_qty as i128
            } else {
                let net = e.fills.iter().fold(e.prior_qty, |net, f| net + f.qty);
                (net - e.end_qty).abs() <= 1e-9
            };
            ensure!(
                reconciled,
                "Starting inventory plus the signed executions does not match ending inventory for {}.",
                e.con_id
            );
            if e.prior_qty != 0. || e.end_qty != 0. || !e.fills.is_empty() {
                ensure!(
                    saved.len() == 1,
                    "Multiple included legs claim the same broker inventory for {}.",
                    e.con_id
                );
                let shared:bool=tx.query_row("SELECT EXISTS(
                    SELECT 1 FROM strategies s,json_each(s.document,'$.legs') l WHERE s.id<>?1
                    AND COALESCE(json_extract(l.value,'$.excluded'),0)=0 AND json_extract(l.value,'$.conId')=?2)",
                    params![self.strategy_id,e.con_id],|r|r.get(0))?;
                ensure!(
                    !shared,
                    "Contract {} appears in another included saved trade. Account attribution is ambiguous.",
                    e.con_id
                );
            }
        }
        Ok(())
    }
    fn store(&self, tx: &Transaction<'_>) -> Result<bool> {
        let text = serde_json::to_string(self)?;
        let existing:Option<String>=tx.query_row("SELECT a.payload FROM account_sessions a JOIN strategies s ON s.id=a.strategy_id AND s.version=a.version
            WHERE a.strategy_id=?1 AND a.version=?2 AND a.session_date=?3 AND a.account_scope=?4",
            params![self.strategy_id,self.version,self.date,self.account_scope],|r|r.get(0)).optional()?;
        if let Some(previous) = existing {
            ensure!(
                previous == text,
                "Conflicting evidence already exists for this saved version and session date."
            );
            let disputed: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM account_session_disputes
                WHERE strategy_id=?1 AND version=?2 AND session_date=?3 AND account_scope=?4)",
                params![
                    self.strategy_id,
                    self.version,
                    self.date,
                    self.account_scope
                ],
                |r| r.get(0),
            )?;
            ensure!(
                !disputed,
                "Different dated records have already been retained for reconciliation for this saved session."
            );
            return Ok(false);
        }
        self.validate(tx)?;
        for l in &self.legs {
            let contradictory:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM account_sessions a,json_each(a.payload,'$.legs') leg
                WHERE a.account_scope=?1 AND a.session_date=?2 AND json_extract(leg.value,'$.conId')=?3
                AND (json_extract(leg.value,'$.priorQty')<>?4 OR json_extract(leg.value,'$.endQty')<>?5
                  OR json_extract(leg.value,'$.priorEnd')<>?6 OR json_extract(leg.value,'$.end')<>?7
                  OR json_extract(leg.value,'$.currency')<>?8 OR json_extract(leg.value,'$.multiplier')<>?9
                  OR json_extract(leg.value,'$.fills')<>json(?10)))",
                params![self.account_scope,self.date,l.con_id,l.prior_qty,l.end_qty,l.prior_end,l.end,l.currency,l.multiplier,serde_json::to_string(&l.fills)?],|r|r.get(0))?;
            ensure!(
                !contradictory,
                "The broker records contradict existing contract evidence for {} in this account session.",
                l.con_id
            );
            for f in &l.fills {
                let fill_text = serde_json::to_string(f)?;
                let written=tx.execute("INSERT OR IGNORE INTO account_session_executions(account_scope,execution_id,strategy_id,session_date,con_id,payload) VALUES(?1,?2,?3,?4,?5,?6)",
                    params![self.account_scope,f.id,self.strategy_id,self.date,l.con_id,fill_text])?;
                if written == 0 {
                    let identical:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM account_session_executions WHERE account_scope=?1 AND execution_id=?2
                        AND strategy_id=?3 AND session_date=?4 AND con_id=?5 AND payload=?6)",
                        params![self.account_scope,f.id,self.strategy_id,self.date,l.con_id,fill_text],|r|r.get(0))?;
                    ensure!(
                        identical,
                        "Broker execution {} was already attributed to a different trade, contract, date or payload.",
                        f.id
                    );
                }
            }
        }
        tx.execute("INSERT INTO account_sessions(strategy_id,version,session_date,account_scope,payload) VALUES(?1,?2,?3,?4,?5)",
            params![self.strategy_id,self.version,self.date,self.account_scope,text])?;
        Ok(true)
    }
}

impl Library {
    pub fn import_account_sessions(&self, data: Value) -> Result<Value> {
        let batch: Batch =
            serde_json::from_value(data).context("Invalid broker-session evidence payload.")?;
        ensure!(
            (1..=100).contains(&batch.records.len()),
            "Import between one and 100 broker-session records."
        );
        let mut c = self.conn()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut records = batch.records;
        let count = records.len();
        let mut disputes = vec![];
        for record in &mut records {
            record.canonical_order();
            let prior:Option<String>=tx.query_row("SELECT a.payload FROM account_sessions a JOIN strategies s ON s.id=a.strategy_id AND s.version=a.version
                WHERE a.strategy_id=?1 AND a.version=?2 AND a.session_date=?3 AND a.account_scope=?4",
                params![record.strategy_id,record.version,record.date,record.account_scope],|r|r.get(0)).optional()?;
            if let Some(prior) = prior {
                let previous: Value = serde_json::from_str(&prior)?;
                let proposed = serde_json::to_value(&record)?;
                if !same_session_cashflows(&previous, &proposed) {
                    // A malformed or unrelated upload cannot challenge a trusted record.
                    record.validate(&tx)?;
                    disputes.push((
                        record.strategy_id.clone(),
                        record.version,
                        record.date.clone(),
                        record.account_scope.clone(),
                        serde_json::to_string(&record)?,
                    ));
                }
            }
        }
        if !disputes.is_empty() {
            for (id, version, date, scope, alternate) in disputes {
                tx.execute(
                    "INSERT OR IGNORE INTO account_session_disputes VALUES(?1,?2,?3,?4,?5,?6)",
                    params![
                        id,
                        version,
                        date,
                        scope,
                        Utc::now().timestamp_millis(),
                        alternate
                    ],
                )?;
            }
            tx.commit()?;
            anyhow::bail!(
                "Conflicting dated account records. Both dated statements were retained for independent execution reconciliation."
            )
        }
        let mut inserted = 0;
        for record in records {
            if record.store(&tx)? {
                inserted += 1;
            }
        }
        tx.commit()?;
        Ok(json!({"inserted":inserted,"unchanged":count-inserted}))
    }
}
