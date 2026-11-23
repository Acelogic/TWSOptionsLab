use crate::position::{Position, commission_rate};
use anyhow::{Result, anyhow, ensure};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use std::{path::Path, sync::Mutex};
use uuid::Uuid;
mod account_sessions;

pub struct Library(Mutex<Connection>);

fn validated(item: &Value) -> Result<(&str, &Value)> {
    let name = item["name"].as_str().unwrap_or("").trim();
    ensure!(
        !name.is_empty() && name.chars().count() <= 100,
        "Give the strategy a name of up to 100 characters."
    );
    let doc = &item["document"];
    ensure!(
        doc["symbol"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 90),
        "Choose an underlying."
    );
    let legs = doc["legs"]
        .as_array()
        .ok_or_else(|| anyhow!("Strategy legs are missing."))?;
    ensure!(
        (1..=16).contains(&legs.len()),
        "A saved strategy needs one to sixteen legs."
    );
    let commission = commission_rate(doc)?;
    for l in legs {
        let position = Position::read(l, commission)?;
        ensure!(
            l["conId"]
                .as_i64()
                .is_some_and(|id| id > 0 && id <= i32::MAX as i64)
                || position.is_unqualified_archive(l, Utc::now()),
            "A qualified TWS contract is required unless this option has expired and its entire quantity was closed."
        );
        ensure!(
            l["entry"]
                .as_f64()
                .is_some_and(|v| v.is_finite() && v >= 0.0)
                && l["multiplier"]
                    .as_f64()
                    .is_some_and(|v| v.is_finite() && v > 0.0),
            "Every leg needs an entry price and a positive multiplier."
        );
        match l["kind"].as_str() {
            Some("stock") => ensure!(
                l["multiplier"].as_f64() == Some(1.0),
                "Shares have a multiplier of one."
            ),
            Some("option") => {
                ensure!(
                    matches!(l["right"].as_str(), Some("C" | "P"))
                        && l["strike"].as_f64().is_some_and(f64::is_finite),
                    "Invalid option right or strike."
                );
                ensure!(l["root"].as_str().is_some_and(|s|!s.is_empty()) && l["expiry"].as_str().is_some_and(|s|chrono::NaiveDate::parse_from_str(s,"%Y%m%d").is_ok()), "Invalid option class or expiration.");
            }
            _ => anyhow::bail!("Unknown strategy leg type."),
        }
    }
    Ok((name, doc))
}

impl Library {
    pub fn new(folder: &Path) -> Result<Self> {
        std::fs::create_dir_all(folder)?;
        let mut conn = Connection::open(folder.join("library.sqlite"))?;
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS strategies(id TEXT PRIMARY KEY,name TEXT NOT NULL,document TEXT NOT NULL,updated INTEGER NOT NULL,version INTEGER NOT NULL,created INTEGER);
            CREATE TABLE IF NOT EXISTS marks(id TEXT REFERENCES strategies(id) ON DELETE CASCADE,time INTEGER NOT NULL,pnl REAL NOT NULL,value REAL NOT NULL,PRIMARY KEY(id,time));")?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let has_created: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('strategies') WHERE name='created')",
            [],
            |r| r.get(0),
        )?;
        if !has_created {
            tx.execute_batch(
                "ALTER TABLE strategies ADD COLUMN created INTEGER;
                              UPDATE strategies SET created=updated WHERE version=1;",
            )?;
        }
        account_sessions::install(&tx)?;
        tx.commit()?;
        Ok(Self(Mutex::new(conn)))
    }
    fn conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.0
            .lock()
            .map_err(|_| anyhow!("Strategy library unavailable."))
    }
    pub fn list(&self) -> Result<Vec<Value>> {
        self.rows(None)
    }
    pub fn has_current_account_evidence(&self) -> Result<bool> {
        Ok(self.conn()?.query_row("SELECT EXISTS(SELECT 1 FROM account_sessions a JOIN strategies s ON s.id=a.strategy_id AND s.version=a.version)",[],|r|r.get(0))?)
    }
    pub fn list_for_valuation(&self, trusted_scope: Option<&str>) -> Result<Vec<Value>> {
        self.rows(trusted_scope)
    }
    fn rows(&self, trusted_scope: Option<&str>) -> Result<Vec<Value>> {
        let c = self.conn()?;
        let mut stmt = c.prepare("SELECT s.id,s.name,s.document,s.updated,s.version,s.created,
             CASE WHEN ?1 IS NULL THEN '[]' ELSE (SELECT json_group_array(json(json_set(a.payload,'$._alternates',json((
                SELECT json_group_array(json(d.alternate_payload)) FROM account_session_disputes d
                  WHERE d.strategy_id=a.strategy_id AND d.version=a.version AND d.session_date=a.session_date AND d.account_scope=a.account_scope
             ))))) FROM account_sessions a
             WHERE a.strategy_id=s.id AND a.version=s.version AND a.account_scope=?1) END
             FROM strategies s ORDER BY s.updated DESC")?;
        let rows = stmt.query_map([trusted_scope], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<i64>>(5)?,
                r.get::<_, String>(6)?,
            ))
        })?;
        rows.map(|r| {
            let (id,name,text,updated,version,created,records)=r?;
            let mut row=json!({"id":id,"name":name,"document":serde_json::from_str::<Value>(&text)?,"updated":updated,"version":version,"created":created});
            if trusted_scope.is_some() { row["accountSessions"] = serde_json::from_str(&records)?; }
            Ok(row)
        }).collect()
    }
    fn write(tx: &Transaction<'_>, item: &Value, forced_id: Option<String>) -> Result<Value> {
        let (name, doc) = validated(item)?;
        let mut stored_document = doc.clone();
        let mut id = forced_id
            .or_else(|| item["id"].as_str().map(str::to_owned))
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let mut version = 1;
        if let Some((v, d)) = tx
            .query_row(
                "SELECT version,document FROM strategies WHERE id=?",
                [&id],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?
        {
            ensure!(
                item["version"].as_i64() == Some(v),
                "This saved strategy has changed. Reload it before saving."
            );
            // Closing fills belong to the same saved position. Changing its opening
            // contract, size, entry, or exclusion still creates a separate scenario.
            let opening_legs = |document: &Value| {
                let mut legs = document["legs"].clone();
                if let Some(items) = legs.as_array_mut() {
                    for leg in items {
                        if let Some(fields) = leg.as_object_mut() {
                            fields.remove("closes");
                        }
                    }
                }
                legs
            };
            let previous: Value = serde_json::from_str(&d)?;
            if opening_legs(&previous) != opening_legs(doc)
                || commission_rate(&previous)? != commission_rate(doc)?
            {
                id = Uuid::new_v4().to_string()
            } else {
                version = v + 1;
                for key in ["source", "libraryGroup"] {
                    if doc.get(key).is_none()
                        && let Some(value) = previous.get(key)
                    {
                        stored_document[key] = value.clone();
                    }
                }
            }
        }
        tx.execute("INSERT INTO strategies(id,name,document,updated,version,created) VALUES(?1,?2,?3,?4,?5,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,document=excluded.document,updated=excluded.updated,version=excluded.version",
            params![id,name,serde_json::to_string(&stored_document)?,Utc::now().timestamp_millis(),version])?;
        Ok(json!({"id":id,"version":version}))
    }
    pub fn save(&self, item: &Value) -> Result<Value> {
        let mut c = self.conn()?;
        let tx = c.transaction()?;
        let result = Self::write(&tx, item, None)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn import(&self, items: &Value) -> Result<Value> {
        let list = items["strategies"]
            .as_array()
            .ok_or_else(|| anyhow!("Invalid library export."))?;
        ensure!(list.len() <= 100, "Import up to 100 strategies at once.");
        let mut c = self.conn()?;
        let tx = c.transaction()?;
        let mut count = 0;
        for item in list {
            let (name, doc) = validated(item)?;
            let id = Uuid::new_v5(
                &Uuid::NAMESPACE_URL,
                &serde_json::to_vec(&json!({"name":name,"document":doc}))?,
            )
            .to_string();
            let exists = tx
                .query_row("SELECT 1 FROM strategies WHERE id=?", [&id], |_| Ok(()))
                .optional()?
                .is_some();
            if !exists {
                Self::write(&tx, item, Some(id))?;
                count += 1
            }
        }
        tx.commit()?;
        Ok(json!({"count":count}))
    }
    pub fn delete(&self, data: &Value) -> Result<Value> {
        let n = self.conn()?.execute(
            "DELETE FROM strategies WHERE id=? AND version=?",
            params![data["id"].as_str(), data["version"].as_i64()],
        )?;
        ensure!(n == 1, "The saved strategy changed.");
        Ok(json!({"deleted":true}))
    }
    pub fn marks(&self, id: &str) -> Result<Value> {
        let c = self.conn()?;
        // Existing observations can predate a newly supplied close whose exact
        // time is unknown. Keep the stored observations but omit ambiguous P&L.
        let mut stmt = c.prepare(
            "WITH boundary AS (
                SELECT COALESCE(MAX(json_extract(fill.value,'$.confirmedClosedBy')),0) AS known_by
                FROM strategies AS s, json_each(s.document,'$.legs') AS leg,
                     json_each(leg.value,'$.closes') AS fill
                WHERE s.id=?1 AND COALESCE(json_extract(leg.value,'$.excluded'),0)=0
             )
             SELECT time,pnl,value FROM (
                SELECT time,pnl,value FROM marks WHERE id=?1 AND time >= (SELECT known_by FROM boundary)
                ORDER BY time DESC LIMIT 2500
             ) ORDER BY time",
        )?;
        let pts = stmt
            .query_map([id], |r| {
                Ok(json!([
                    r.get::<_, i64>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, f64>(2)?
                ]))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!(pts))
    }
    pub fn record(
        &self,
        id: &str,
        version: i64,
        legs: &[Value],
        quotes: &Value,
        commission: f64,
    ) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let (mut pnl, mut value) = (0.0, 0.0);
        let mut settled = true;
        let mut latest_cashflow = 0;
        for l in legs {
            let position = Position::read(l, commission)?;
            if position.excluded {
                continue;
            }
            let open = position.exposure(now).0 != 0.0;
            if open && crate::snapshots::expired(l, now) {
                return Ok(());
            }
            settled &= !open;
            latest_cashflow =
                latest_cashflow.max(position.last_confirmed_cashflow(now).unwrap_or(0));
            let q = &quotes[l["conId"].to_string()];
            let mid =
                if q["feed"] == "Live" && q["at"].as_i64().is_some_and(|ts| now - ts <= 120000) {
                    q["mid"].as_f64()
                } else {
                    None
                };
            let Some((leg_pnl, leg_value)) = position.pnl(now, mid) else {
                return Ok(());
            };
            pnl += leg_pnl;
            value += leg_value;
        }
        if legs.iter().all(|l| l["excluded"] == true) {
            return Ok(());
        }
        let c = self.conn()?;
        if settled {
            let last = c
                .query_row(
                    "SELECT time,pnl,value FROM marks WHERE id=? ORDER BY time DESC LIMIT 1",
                    [id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, f64>(1)?,
                            row.get::<_, f64>(2)?,
                        ))
                    },
                )
                .optional()?;
            if last.is_some_and(|(time, p, v)| time >= latest_cashflow && (p, v) == (pnl, value)) {
                return Ok(());
            }
        }
        let mark_time = (now / 30000 * 30000).max(latest_cashflow);
        c.execute(
            "INSERT INTO marks SELECT id,?,?,? FROM strategies WHERE id=? AND version=? ON CONFLICT(id,time) DO UPDATE SET pnl=excluded.pnl,value=excluded.value",
            params![mark_time, pnl, value, id, version],
        )?;
        Ok(())
    }
}
