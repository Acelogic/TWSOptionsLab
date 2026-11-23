use anyhow::{Context, Result, anyhow, ensure};
use chrono::{DateTime, NaiveDate, Utc};
use chrono_tz::America::New_York;
use hmac::{Hmac, Mac};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{collections::HashSet, path::Path, sync::Mutex};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ClosedLot {
    pub opening_transaction_id: String,
    pub opened_at: i64,
    pub qty: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realized_pnl: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_basis: Option<f64>,
}
// Closed lots can have identical opening IDs, timestamps and quantities.
// Preserve multiplicity. A later export may supply optional financial columns,
// but a contradictory or ambiguous allocation must not silently replace one.
fn covers_lots(richer: &[ClosedLot], thinner: &[ClosedLot]) -> bool {
    if richer.len() != thinner.len() {
        return false;
    }
    let mut ordered = thinner.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|lot| {
        std::cmp::Reverse(
            usize::from(lot.cost_basis.is_some()) + usize::from(lot.realized_pnl.is_some()),
        )
    });
    let mut used = vec![false; richer.len()];
    for prior in ordered {
        let Some(index) = richer.iter().enumerate().position(|(index, new)| {
            !used[index]
                && prior.opening_transaction_id == new.opening_transaction_id
                && prior.opened_at == new.opened_at
                && prior.qty == new.qty
                && prior
                    .realized_pnl
                    .is_none_or(|v| new.realized_pnl == Some(v))
                && prior.cost_basis.is_none_or(|v| new.cost_basis == Some(v))
        }) else {
            return false;
        };
        used[index] = true;
    }
    true
}
fn meaningful_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|b| b.is_ascii_graphic())
        && !matches!(
            id.to_ascii_uppercase().as_str(),
            "0" | "-" | "-1" | "NA" | "N/A" | "NONE"
        )
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BrokerRecord<P> {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_close: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brokerage_order_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ib_order_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tws_perm_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tws_order_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tws_client_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub combo_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underlying_con_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trade_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realized_pnl: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proceeds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub net_cash: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_basis: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realized_currency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realized_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_lots: Option<Vec<ClosedLot>>,
    pub id: String,
    pub at: i64,
    pub con_id: i32,
    pub symbol: String,
    #[serde(default)]
    pub local_symbol: String,
    pub sec_type: String,
    pub currency: String,
    pub expiry: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_trading_date: Option<String>,
    pub strike: f64,
    pub right: String,
    pub side: String,
    pub qty: f64,
    pub price: P,
    pub multiplier: f64,
    pub commission: Option<f64>,
    pub commission_currency: Option<String>,
}
pub(super) type Fill = BrokerRecord<f64>;
pub(super) type LedgerRow = BrokerRecord<Option<f64>>;
const LIFECYCLE_ID: &str = "IBKR-FLEX-LIFECYCLE/";
fn currency(code: &str) -> bool {
    code.len() == 3 && code.bytes().all(|b| b.is_ascii_uppercase())
}
impl<P> BrokerRecord<P> {
    fn enrich(&mut self, other: &Self) -> Result<()> {
        // Optional metadata from a shorter export cannot erase the fuller report.
        // Contradictory permanent identities or broker lot allocations need a
        // corrected export. Flex FIFO overrides the separate live TWS P&L field.
        fn merge<T: PartialEq + Clone>(dest: &mut Option<T>, src: &Option<T>) -> Result<()> {
            match (&dest, src) {
                (Some(a), Some(b)) => ensure!(
                    a == b,
                    "Conflicting broker order or lot metadata for one transaction."
                ),
                (None, Some(b)) => *dest = Some(b.clone()),
                _ => {}
            }
            Ok(())
        }
        merge(&mut self.open_close, &other.open_close)?;
        merge(&mut self.proceeds, &other.proceeds)?;
        merge(&mut self.net_cash, &other.net_cash)?;
        merge(&mut self.cost_basis, &other.cost_basis)?;
        merge(&mut self.brokerage_order_id, &other.brokerage_order_id)?;
        merge(&mut self.ib_order_id, &other.ib_order_id)?;
        merge(&mut self.tws_perm_id, &other.tws_perm_id)?;
        merge(&mut self.combo_id, &other.combo_id)?;
        merge(&mut self.order_at, &other.order_at)?;
        merge(&mut self.underlying_con_id, &other.underlying_con_id)?;
        merge(&mut self.transaction_id, &other.transaction_id)?;
        merge(&mut self.trade_id, &other.trade_id)?;
        if let Some(incoming) = &other.closed_lots {
            match &self.closed_lots {
                None => self.closed_lots = Some(incoming.clone()),
                Some(current) if current == incoming || covers_lots(current, incoming) => {}
                Some(current) if covers_lots(incoming, current) => {
                    self.closed_lots = Some(incoming.clone())
                }
                _ => anyhow::bail!(
                    "Conflicting broker closed lots for the same closing transaction."
                ),
            }
        }
        // Local API order numbers can change when TWS binds an order to a client.
        self.tws_order_id = self.tws_order_id.or(other.tws_order_id);
        self.tws_client_id = self.tws_client_id.or(other.tws_client_id);
        if self.realized_pnl.is_none()
            || (other.realized_source.as_deref() == Some("IBKR Flex FIFO")
                && self.realized_source.as_deref() != Some("IBKR Flex FIFO"))
        {
            self.realized_pnl = other.realized_pnl;
            self.realized_source = other.realized_source.clone();
            self.realized_currency = other.realized_currency.clone();
        } else if self.realized_source.as_deref() == Some("IBKR Flex FIFO")
            && self.realized_source == other.realized_source
        {
            merge(&mut self.realized_pnl, &other.realized_pnl)?;
            merge(&mut self.realized_currency, &other.realized_currency)?;
        }
        Ok(())
    }
    fn validate_fields(&self) -> Result<()> {
        ensure!(
            !self.id.is_empty()
                && self.id.len() <= 150
                && self.id.bytes().all(|b| b.is_ascii_graphic()),
            "Missing or invalid broker execution ID."
        );
        ensure!(
            self.at > 0 && self.at <= Utc::now().timestamp_millis() + 300_000,
            "Invalid broker execution timestamp."
        );
        ensure!(
            self.con_id > 0
                && matches!(self.sec_type.as_str(), "OPT" | "FOP")
                && !self.symbol.trim().is_empty()
                && self.symbol.len() <= 100
                && self.local_symbol.len() <= 180,
            "Incomplete option contract identity."
        );
        ensure!(
            self.last_trading_date
                .as_deref()
                .is_none_or(|d| d.len() == 8 && NaiveDate::parse_from_str(d, "%Y%m%d").is_ok()),
            "Invalid last trading date."
        );
        ensure!(
            self.expiry.len() == 8
                && NaiveDate::parse_from_str(&self.expiry, "%Y%m%d").is_ok()
                && matches!(self.right.as_str(), "C" | "P"),
            "Invalid option expiration or right."
        );
        ensure!(
            currency(&self.currency)
                && self.strike.is_finite()
                && self.multiplier.is_finite()
                && self.multiplier > 0.0,
            "Invalid option currency, strike or multiplier."
        );
        ensure!(
            matches!(self.side.as_str(), "BUY" | "SELL") && self.qty.is_finite() && self.qty > 0.0,
            "Invalid broker side or quantity."
        );
        ensure!(
            self.commission
                .is_none_or(|n| n.is_finite() && n.abs() < 1e14)
                && self.commission_currency.as_deref().is_none_or(currency),
            "Invalid broker commission."
        );
        for id in [
            &self.brokerage_order_id,
            &self.ib_order_id,
            &self.tws_perm_id,
            &self.combo_id,
            &self.transaction_id,
            &self.trade_id,
        ]
        .into_iter()
        .flatten()
        {
            ensure!(meaningful_id(id), "Invalid broker linkage identifier.");
        }
        ensure!(
            self.open_close
                .as_deref()
                .is_none_or(|v| matches!(v, "OPEN" | "CLOSE" | "MIXED"))
                && self.underlying_con_id.is_none_or(|n| n > 0)
                && self.order_at.is_none_or(|t| t > 0),
            "Invalid broker position or order metadata."
        );
        ensure!(
            (self.realized_pnl.is_none()
                && self.realized_currency.is_none()
                && self.realized_source.is_none())
                || (self.realized_pnl.is_some_and(f64::is_finite)
                    && self.realized_currency.as_deref().is_some_and(currency)
                    && matches!(
                        self.realized_source.as_deref(),
                        Some("IBKR Flex FIFO" | "TWS commission report")
                    )),
            "Broker realized P&L needs a finite amount, currency and named source."
        );
        ensure!(
            [self.net_cash, self.cost_basis, self.proceeds]
                .into_iter()
                .flatten()
                .all(f64::is_finite),
            "Invalid broker cash or cost basis amount."
        );
        if let Some(lots) = &self.closed_lots {
            let closed_qty: f64 = lots.iter().map(|lot| lot.qty).sum();
            let matches_effect = match self.open_close.as_deref() {
                Some("CLOSE") => (closed_qty - self.qty).abs() < 1e-7,
                Some("MIXED") => closed_qty > 0.0 && closed_qty < self.qty,
                _ => false,
            };
            ensure!(
                matches_effect
                    && !lots.is_empty()
                    && lots.iter().all(|l| meaningful_id(&l.opening_transaction_id)
                        && l.opened_at > 0
                        && l.opened_at <= self.at
                        && l.qty.is_finite()
                        && l.qty > 0.0
                        && l.qty.fract().abs() < 1e-7
                        && l.realized_pnl.is_none_or(f64::is_finite)
                        && l.cost_basis.is_none_or(f64::is_finite)),
                "Closed lots do not match this broker closing transaction."
            );
        }
        Ok(())
    }
}
impl Fill {
    pub fn validate(&self) -> Result<()> {
        self.validate_fields()?;
        ensure!(
            self.event_type.is_none()
                && !self.id.starts_with(LIFECYCLE_ID)
                && self.id.len() <= 128
                && !matches!(
                    self.id.to_ascii_uppercase().as_str(),
                    "N/A" | "NONE" | "0" | "-"
                ),
            "Invalid broker execution ID."
        );
        ensure!(
            self.price.is_finite() && self.price >= 0.0,
            "Invalid execution fill price."
        );
        Ok(())
    }
    fn same_trade(&self, other: &Self) -> bool {
        self.con_id == other.con_id
            && self.side == other.side
            && self.qty == other.qty
            && self.price == other.price
            && self.currency == other.currency
            && self.multiplier == other.multiplier
            && self.right == other.right
            && self.strike == other.strike
            && self.expiry == other.expiry
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Statement {
    account_id: String,
    from: i64,
    to: i64,
    executions: Vec<Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Import {
    source: String,
    accounts: Vec<Statement>,
}

pub(super) struct Archive {
    db: Mutex<Connection>,
    key: Vec<u8>,
}
pub(super) fn day(at: i64) -> Option<String> {
    Some(
        DateTime::from_timestamp_millis(at)?
            .with_timezone(&New_York)
            .date_naive()
            .to_string(),
    )
}
pub(super) fn revision(id: &str) -> (&str, u32) {
    match id.rsplit_once('.') {
        Some((base, last))
            if !base.is_empty() && last.len() >= 2 && last.bytes().all(|b| b.is_ascii_digit()) =>
        {
            last.parse().map(|rev| (base, rev)).unwrap_or((id, 0))
        }
        _ => (id, 0),
    }
}

impl Archive {
    pub fn new(folder: &Path) -> Result<Self> {
        std::fs::create_dir_all(folder)?;
        let path = folder.join("options-history.sqlite");
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            if folder == Path::new(env!("CARGO_MANIFEST_DIR")).join(".data") {
                std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o700))?;
            }
            let file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .open(&path)?;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            for suffix in ["-wal", "-shm"] {
                let auxiliary = folder.join(format!("options-history.sqlite{suffix}"));
                if auxiliary.exists() {
                    std::fs::set_permissions(auxiliary, std::fs::Permissions::from_mode(0o600))?;
                }
            }
        }
        let db = Connection::open(path)?;
        db.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value BLOB NOT NULL);
            INSERT OR IGNORE INTO settings VALUES('scope-key',randomblob(32));
            CREATE TABLE IF NOT EXISTS executions(scope TEXT NOT NULL,base TEXT NOT NULL,revision INTEGER NOT NULL,official INTEGER NOT NULL,fill TEXT NOT NULL,PRIMARY KEY(scope,base));
            CREATE INDEX IF NOT EXISTS execution_contract_time ON executions(scope,json_extract(fill,'$.conId'),json_extract(fill,'$.at'));
            CREATE TABLE IF NOT EXISTS prior_execution_versions(scope TEXT NOT NULL,base TEXT NOT NULL,fill TEXT NOT NULL,PRIMARY KEY(scope,base,fill));
            CREATE INDEX IF NOT EXISTS prior_execution_contract_time ON prior_execution_versions(scope,json_extract(fill,'$.conId'),json_extract(fill,'$.at'));
            CREATE TRIGGER IF NOT EXISTS retain_prior_execution AFTER UPDATE OF fill ON executions WHEN OLD.fill<>NEW.fill
              BEGIN INSERT OR IGNORE INTO prior_execution_versions(scope,base,fill) VALUES(OLD.scope,OLD.base,OLD.fill); END;
            CREATE TABLE IF NOT EXISTS lifecycle_events(scope TEXT NOT NULL,event_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,event_id));
            CREATE TABLE IF NOT EXISTS ranges(scope TEXT PRIMARY KEY, first_ms INTEGER NOT NULL,last_ms INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS active_scopes(scope TEXT PRIMARY KEY,confirmed_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS manual_spreads(scope TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,token TEXT NOT NULL,members TEXT NOT NULL,PRIMARY KEY(scope,id));")?;
        let key = db.query_row(
            "SELECT value FROM settings WHERE key='scope-key'",
            [],
            |r| r.get::<_, Vec<u8>>(0),
        )?;
        ensure!(key.len() == 32, "Local account scope key unavailable.");
        Ok(Self {
            db: Mutex::new(db),
            key,
        })
    }
    pub(super) fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| anyhow!("Options archive unavailable."))
    }
    pub fn scope(&self, id: &str) -> Result<String> {
        let id = id.trim().to_ascii_uppercase();
        ensure!(
            (2..=64).contains(&id.len())
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "Invalid IBKR account identifier."
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key)?;
        mac.update(id.as_bytes());
        Ok(format!("{:x}", mac.finalize().into_bytes()))
    }
    pub fn last_scopes(&self) -> Result<(Vec<String>, Option<i64>)> {
        let db = self.lock()?;
        let mut q = db.prepare("SELECT scope,confirmed_at FROM active_scopes ORDER BY scope")?;
        let mut scopes = Vec::new();
        let mut at = None;
        for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (scope, t) = row?;
            scopes.push(scope);
            at = Some(t);
        }
        Ok((scopes, at))
    }
    pub fn set_scopes(&self, scopes: &[String], at: i64) -> Result<()> {
        let mut db = self.lock()?;
        let tx = db.transaction()?;
        tx.execute("DELETE FROM active_scopes", [])?;
        for scope in scopes {
            tx.execute("INSERT INTO active_scopes VALUES(?,?)", params![scope, at])?;
        }
        tx.commit()?;
        Ok(())
    }
    fn put(tx: &Transaction<'_>, scope: &str, fill: &Fill, official: bool) -> Result<bool> {
        fill.validate()?;
        let (base, rev) = revision(&fill.id);
        let previous = tx
            .query_row(
                "SELECT revision,official,fill FROM executions WHERE scope=? AND base=?",
                params![scope, base],
                |r| {
                    Ok((
                        r.get::<_, u32>(0)?,
                        r.get::<_, bool>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        let mut record = fill.clone();
        let mut authority = official;
        if let Some((prior_rev, was_official, old)) = previous {
            if prior_rev > rev {
                return Ok(false);
            }
            if prior_rev == rev {
                let prior: Fill = serde_json::from_str(&old)?;
                ensure!(
                    prior.id == fill.id && prior.same_trade(fill),
                    "Conflicting broker executions share a revision. The archive was left intact."
                );
                // Flex settlement can enrich TWS metadata and fees. An older
                // replay and a missing fee must never erase a known fee.
                if was_official && !official {
                    record = prior.clone();
                }
                record.enrich(&prior)?;
                record.enrich(fill)?;
                if record.commission.is_none() {
                    let fee = if prior.commission.is_some() {
                        &prior
                    } else {
                        fill
                    };
                    record.commission = fee.commission;
                    record.commission_currency = fee.commission_currency.clone();
                }
                if record.last_trading_date.is_none() {
                    record.last_trading_date = prior
                        .last_trading_date
                        .clone()
                        .or_else(|| fill.last_trading_date.clone());
                }
                if record.local_symbol.is_empty() {
                    record.local_symbol = prior.local_symbol.clone();
                }
                authority |= was_official;
                if record == prior && authority == was_official {
                    return Ok(false);
                }
            }
        }
        tx.execute("INSERT INTO executions VALUES(?1,?2,?3,?4,?5) ON CONFLICT(scope,base) DO UPDATE SET revision=excluded.revision,official=excluded.official,fill=excluded.fill",
            params![scope,base,rev,authority,serde_json::to_string(&record)?])?;
        Ok(true)
    }
    fn put_lifecycle(tx: &Transaction<'_>, scope: &str, item: &LedgerRow) -> Result<bool> {
        item.validate_fields()?;
        let transaction_id = item
            .id
            .strip_prefix(LIFECYCLE_ID)
            .context("A Flex lifecycle event requires its broker transaction ID.")?;
        ensure!(
            !transaction_id.is_empty()
                && transaction_id.len() <= 128
                && transaction_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
                && !matches!(
                    transaction_id.to_ascii_uppercase().as_str(),
                    "NONE" | "0" | "-"
                ),
            "Invalid Flex lifecycle transaction ID."
        );
        ensure!(
            matches!(
                item.event_type.as_deref(),
                Some("expiration" | "assignment" | "exercise")
            ) && item.price.is_none_or(|p| p.is_finite() && p >= 0.0),
            "Invalid broker lifecycle action or price."
        );
        let payload = serde_json::to_string(item)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT payload FROM lifecycle_events WHERE scope=? AND event_id=?",
                params![scope, item.id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(previous) = existing {
            let prior: LedgerRow = serde_json::from_str(&previous)?;
            // Broker transaction IDs are identities, not correction revisions.
            // Repeated statements may fill in a previously absent price or fee.
            let mut incoming = item.clone();
            incoming.enrich(&prior)?;
            incoming.price = incoming.price.or(prior.price);
            if incoming.commission.is_none() {
                incoming.commission = prior.commission;
                incoming.commission_currency = prior.commission_currency.clone();
            }
            if prior == incoming {
                return Ok(false);
            }
            let mut enriched = prior;
            enriched.enrich(&incoming)?;
            if enriched.price.is_none() {
                enriched.price = incoming.price;
            }
            if enriched.commission.is_none() {
                enriched.commission = incoming.commission;
                enriched.commission_currency = incoming.commission_currency.clone();
            }
            ensure!(
                enriched == incoming,
                "Conflicting lifecycle records share the same broker transaction ID."
            );
            tx.execute(
                "UPDATE lifecycle_events SET payload=? WHERE scope=? AND event_id=?",
                params![serde_json::to_string(&incoming)?, scope, item.id],
            )?;
        } else {
            tx.execute(
                "INSERT INTO lifecycle_events VALUES(?,?,?)",
                params![scope, item.id, payload],
            )?;
        }
        Ok(true)
    }
    pub fn ingest(&self, data: Value) -> Result<Value> {
        let import: Import =
            serde_json::from_value(data).context("Invalid official execution batch.")?;
        ensure!(
            import.source == "IBKR Flex" && !import.accounts.is_empty(),
            "Choose an IBKR Flex account statement."
        );
        let mut db = self.lock()?;
        let tx = db.transaction()?;
        let mut changed = 0;
        let mut received = 0;
        let mut execution_count = 0;
        let mut lifecycle_count = 0;
        for statement in &import.accounts {
            let scope = self.scope(&statement.account_id)?;
            ensure!(
                statement.from > 0
                    && statement.to >= statement.from
                    && day(statement.from).is_some()
                    && day(statement.to).is_some()
                    && statement.to <= Utc::now().timestamp_millis() + 86_400_000,
                "Invalid Flex statement date range."
            );
            for raw in &statement.executions {
                ensure!(
                    ["twsPermId", "twsOrderId", "twsClientId", "comboId"]
                        .iter()
                        .all(|field| raw[field].is_null())
                        && raw["realizedSource"]
                            .as_str()
                            .is_none_or(|src| src == "IBKR Flex FIFO"),
                    "A Flex import cannot assert live TWS parent-order or commission-report evidence."
                );
                let at = raw["at"]
                    .as_i64()
                    .context("Missing broker event timestamp.")?;
                ensure!(
                    (statement.from..=statement.to).contains(&at),
                    "Broker activity falls outside its Flex statement."
                );
                if raw["eventType"].is_null() {
                    let fill: Fill = serde_json::from_value(raw.clone())
                        .context("Invalid official exchange execution.")?;
                    changed += Self::put(&tx, &scope, &fill, true)? as usize;
                    execution_count += 1;
                } else {
                    let event: LedgerRow = serde_json::from_value(raw.clone())
                        .context("Invalid official option lifecycle event.")?;
                    changed += Self::put_lifecycle(&tx, &scope, &event)? as usize;
                    lifecycle_count += 1;
                }
                received += 1;
            }
            tx.execute("INSERT INTO ranges VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET first_ms=min(first_ms,excluded.first_ms),last_ms=max(last_ms,excluded.last_ms)",params![scope,statement.from,statement.to])?;
        }
        tx.commit()?;
        Ok(
            json!({"ok":true,"received":received,"executionCount":execution_count,"lifecycleCount":lifecycle_count,"changed":changed,"complete":false}),
        )
    }
    pub fn record(&self, fills: &[(String, Fill)]) -> Result<()> {
        let mut db = self.lock()?;
        let tx = db.transaction()?;
        for (scope, fill) in fills {
            Self::put(&tx, scope, fill, false)?;
        }
        tx.commit()?;
        Ok(())
    }
    pub(super) fn rows_in(
        db: &Connection,
        scopes: &[String],
    ) -> Result<(Vec<(String, LedgerRow)>, Option<i64>, Option<i64>, bool)> {
        let mut all = vec![];
        let mut earliest = None;
        let mut latest = None;
        let mut official = false;
        for scope in scopes.iter().collect::<HashSet<_>>() {
            let mut q = db.prepare("SELECT fill,official FROM executions WHERE scope=?1 UNION ALL SELECT payload,1 FROM lifecycle_events WHERE scope=?1")?;
            for entry in q.query_map([scope], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
            })? {
                let (raw, source) = entry?;
                let fill: LedgerRow = serde_json::from_str(&raw)?;
                earliest = Some(earliest.unwrap_or(fill.at).min(fill.at));
                latest = Some(latest.unwrap_or(fill.at).max(fill.at));
                all.push((scope.clone(), fill));
                official |= source;
            }
            if let Some((start, end)) = db
                .query_row(
                    "SELECT first_ms,last_ms FROM ranges WHERE scope=?",
                    [scope],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
                )
                .optional()?
            {
                earliest = Some(earliest.unwrap_or(start).min(start));
                latest = Some(latest.unwrap_or(end).max(end));
                official = true;
            }
        }
        all.sort_by(|a, b| {
            b.1.at
                .cmp(&a.1.at)
                .then_with(|| a.1.id.cmp(&b.1.id))
                .then_with(|| a.0.cmp(&b.0))
        });
        Ok((all, earliest, latest, official))
    }
}
