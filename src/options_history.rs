mod archive;
mod manual;
mod reconcile;
mod trades;
use crate::{library::Library, market::Market};
use anyhow::{Context, Result, anyhow, ensure};
use archive::{Archive, Fill, day};
use chrono::{NaiveDateTime, TimeZone, Utc};
use chrono_tz::{America::New_York, Tz};
use futures_util::StreamExt;
use ibapi::{
    Client,
    accounts::PositionUpdate,
    contracts::SecurityType,
    orders::{ExecutionData, ExecutionFilter, ExecutionSide, Executions},
    subscriptions::{SubscriptionItem, SubscriptionItemStreamExt},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Weak},
    time::{Duration, Instant},
};
use time_tz::TimeZone as _;
use tokio::{
    sync::{Mutex, watch},
    task::JoinHandle,
    time::timeout,
};

type Inventory = HashMap<(String, i32), f64>;
#[derive(Clone, Default)]
struct Progress {
    positions: Option<Arc<Inventory>>,
    positions_done: bool,
    executions_done: bool,
    skipped: usize,
    issue: Option<String>,
    next: Option<Instant>,
}
struct Snapshot {
    client: Weak<Client>,
    scopes: Vec<String>,
    at: i64,
    progress: watch::Receiver<Progress>,
    worker: JoinHandle<()>,
}
impl Drop for Snapshot {
    fn drop(&mut self) {
        self.worker.abort();
    }
}
pub struct OptionsHistory {
    identity: Mutex<()>,
    archive: Arc<Archive>,
    cached: Mutex<Option<Snapshot>>,
}

fn timestamp(raw: &str, connection_zone: Option<&str>) -> Option<i64> {
    let parts = raw.split_whitespace().collect::<Vec<_>>();
    let (date_time, zone) = if parts.first()?.contains('-') && parts[0].len() == 17 {
        (
            NaiveDateTime::parse_from_str(parts[0], "%Y%m%d-%H:%M:%S").ok()?,
            parts.get(1).copied().unwrap_or("UTC"),
        )
    } else {
        (
            NaiveDateTime::parse_from_str(
                &format!("{} {}", parts.first()?, parts.get(1)?),
                "%Y%m%d %H:%M:%S",
            )
            .ok()?,
            parts.get(2).copied().or(connection_zone)?,
        )
    };
    match zone {
        "EST" | "EDT" | "Eastern" => New_York.from_local_datetime(&date_time).single(),
        _ => zone
            .parse::<Tz>()
            .ok()?
            .from_local_datetime(&date_time)
            .single(),
    }
    .map(|t| t.timestamp_millis())
}
fn broker_fill(d: ExecutionData, zone: Option<&str>) -> Result<Fill> {
    let c = d.contract;
    let e = d.execution;
    let last_trading_date = c.last_trade_date.map(|d| d.to_string().replace('-', ""));
    let contract_date = c
        .last_trade_date_or_contract_month
        .split_whitespace()
        .next()
        .unwrap_or("");
    let expiry = if contract_date.len() == 8 {
        contract_date.to_owned()
    } else {
        last_trading_date
            .clone()
            .context("Missing option expiration.")?
    };
    let f = Fill {
        open_close: None,
        brokerage_order_id: None,
        ib_order_id: None,
        tws_perm_id: (e.perm_id > 0).then(|| e.perm_id.to_string()),
        tws_order_id: (e.order_id > 0).then_some(e.order_id),
        tws_client_id: (e.client_id >= 0 && e.order_id > 0).then_some(e.client_id),
        combo_id: None,
        order_at: None,
        underlying_con_id: None,
        transaction_id: None,
        trade_id: None,
        realized_pnl: None,
        proceeds: None,
        net_cash: None,
        cost_basis: None,
        realized_currency: None,
        realized_source: None,
        closed_lots: None,
        event_type: None,
        id: e.execution_id,
        at: timestamp(&e.time, zone).context("Unresolved broker execution time.")?,
        con_id: c.contract_id,
        symbol: c.symbol.to_string(),
        local_symbol: c.local_symbol,
        sec_type: c.security_type.to_string(),
        currency: c.currency.to_string(),
        expiry,
        last_trading_date,
        strike: c.strike,
        right: c.right.context("Missing option right.")?.to_string(),
        side: match e.side {
            ExecutionSide::Bought => "BUY",
            ExecutionSide::Sold => "SELL",
        }
        .into(),
        qty: e.shares,
        price: e.price,
        multiplier: c.multiplier.parse()?,
        commission: None,
        commission_currency: None,
    };
    f.validate()?;
    Ok(f)
}
async fn read_executions(
    archive: &Archive,
    client: &Client,
    scopes: &HashMap<String, String>,
) -> Result<(Vec<(String, Fill)>, usize, Option<String>)> {
    let mut feed = client
        .executions(ExecutionFilter {
            account_code: if scopes.len() == 1 {
                scopes.keys().next().cloned().unwrap_or_default()
            } else {
                String::new()
            },
            last_n_days: 7,
            ..Default::default()
        })
        .await?;
    let mut rows = vec![];
    let mut commissions = HashMap::new();
    let mut combo_parents: HashMap<(String, i64), HashSet<i32>> = HashMap::new();
    let mut owners = HashMap::new();
    let mut ambiguous_fees = HashSet::new();
    let mut skipped = 0;
    let zone = client.time_zone().map(|z| z.name());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(150);
    let mut issue = None;
    loop {
        let item = match tokio::time::timeout_at(deadline, feed.next()).await {
            Ok(Some(Ok(SubscriptionItem::Data(item)))) => item,
            Ok(Some(Ok(SubscriptionItem::Notice(n))))
                if [2104, 2106, 2107, 2108, 2158].contains(&n.code) =>
            {
                continue;
            }
            Ok(Some(Ok(SubscriptionItem::Notice(n)))) => {
                issue = Some(format!("TWS reported execution request code {}.", n.code));
                break;
            }
            Ok(None) => break,
            Ok(Some(Err(_))) => {
                issue = Some("The execution stream was interrupted.".into());
                break;
            }
            Err(_) => {
                issue = Some(
                    "TWS did not finish the seven-day execution request within 150 seconds.".into(),
                );
                break;
            }
        };
        match item {
            Executions::ExecutionData(d) => {
                // The commission message has no account field. Only attach a
                // fee when its broker ID was unique across the returned accounts.
                let id = &d.execution.execution_id;
                let owner = &d.execution.account_number;
                if owners
                    .insert(id.clone(), owner.clone())
                    .is_some_and(|old| old != *owner)
                {
                    ambiguous_fees.insert(id.clone());
                }
                if d.contract.security_type == SecurityType::Spread
                    && d.execution.perm_id > 0
                    && !d.contract.combo_legs.is_empty()
                {
                    if let Some(scope) = scopes.get(owner) {
                        combo_parents
                            .entry((scope.clone(), d.execution.perm_id))
                            .or_default()
                            .extend(d.contract.combo_legs.iter().map(|leg| leg.contract_id));
                    }
                }
                if !matches!(
                    d.contract.security_type,
                    SecurityType::Option | SecurityType::FuturesOption
                ) {
                    continue;
                }
                let Some(scope) = scopes.get(&d.execution.account_number) else {
                    continue;
                };
                match broker_fill(d, zone) {
                    Ok(fill) => {
                        let item = (scope.clone(), fill);
                        archive.record(std::slice::from_ref(&item))?;
                        rows.push(item);
                    }
                    Err(_) => skipped += 1,
                }
            }
            Executions::CommissionReport(f) => {
                if f.commission.is_finite()
                    && f.commission.abs() < 1e14
                    && f.currency.len() == 3
                    && f.currency.bytes().all(|b| b.is_ascii_uppercase())
                {
                    commissions.insert(
                        f.execution_id,
                        (
                            f.commission,
                            f.currency,
                            f.realized_pnl.filter(|p| p.is_finite() && p.abs() < 1e14),
                        ),
                    );
                }
            }
        }
    }
    for (scope, fill) in &mut rows {
        if let Some(id) = fill
            .tws_perm_id
            .as_deref()
            .and_then(|s| s.parse::<i64>().ok())
            && combo_parents
                .get(&(scope.clone(), id))
                .is_some_and(|legs| legs.contains(&fill.con_id))
        {
            fill.combo_id = Some(format!("TWS-PERM/{id}"));
        }

        if !ambiguous_fees.contains(&fill.id)
            && let Some((fee, currency, realized)) = commissions.get(&fill.id)
        {
            fill.commission = Some(*fee);
            fill.commission_currency = Some(currency.clone());
            if let Some(pnl) = realized
                && currency == &fill.currency
            {
                fill.realized_pnl = Some(*pnl);
                fill.realized_source = Some("TWS commission report".into());
                fill.realized_currency = Some(currency.clone());
            }
        }
    }
    Ok((rows, skipped, issue))
}
async fn account_executions(
    archive: &Archive,
    port: u16,
    scopes: &HashMap<String, String>,
) -> Result<(Vec<(String, Fill)>, usize, Option<String>)> {
    // TWS exposes fills placed outside this app through its master client.
    // This socket is short lived. It never binds, requests or modifies orders.
    let broker = timeout(
        Duration::from_secs(8),
        Client::builder()
            .address(format!("127.0.0.1:{port}"))
            .client_id(0)
            .max_reconnect_attempts(0)
            .connect(),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .context(
        "TWS client 0 is busy or unavailable. Its existing connection has been left in place.",
    )?;
    let result = async {
        let authorized = timeout(Duration::from_secs(5), broker.managed_accounts())
            .await
            .context("The execution connection did not identify its accounts.")?
            .map_err(|_| anyhow!("The execution connection could not confirm its accounts."))?;
        ensure!(
            authorized.iter().collect::<HashSet<_>>() == scopes.keys().collect::<HashSet<_>>(),
            "The execution connection identified a different set of accounts."
        );
        read_executions(archive, &broker, scopes)
            .await
            .map_err(|_| anyhow!("TWS could not start the execution request."))
    }
    .await;
    let _ = timeout(Duration::from_secs(2), broker.disconnect()).await;
    result
}
async fn positions(client: &Client, scopes: &HashMap<String, String>) -> Result<Inventory> {
    let mut feed = client.positions().await?.filter_data();
    let mut held = HashMap::new();
    while let Some(item) = feed.next().await {
        match item? {
            PositionUpdate::PositionEnd => return Ok(held),
            PositionUpdate::Position(p) => {
                if let Some(scope) = scopes.get(&p.account)
                    && matches!(
                        p.contract.security_type,
                        SecurityType::Option | SecurityType::FuturesOption
                    )
                {
                    ensure!(
                        p.contract.contract_id > 0 && p.position.is_finite(),
                        "Incomplete broker position."
                    );
                    held.insert((scope.clone(), p.contract.contract_id), p.position);
                }
            }
        }
    }
    Err(anyhow!(
        "Broker positions ended before inventory was complete."
    ))
}
async fn confirmed_offline(market: &Market, mode: u8, e: &anyhow::Error) -> bool {
    !market.connection_state(mode).await.0
        && e.downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::ConnectionRefused)
}
impl OptionsHistory {
    pub fn new(folder: &Path) -> Result<Self> {
        Ok(Self {
            identity: Mutex::new(()),
            archive: Arc::new(Archive::new(folder)?),
            cached: Mutex::new(None),
        })
    }
    pub fn scope(&self, account: &str) -> Result<String> {
        self.archive.scope(account)
    }
    pub(crate) fn review_session_evidence(&self, rows: &mut [Value], scope: Option<&str>) {
        let Some(scope) = scope else { return };
        for record in rows
            .iter_mut()
            .filter_map(|r| r["accountSessions"].as_array_mut())
            .flatten()
        {
            if self.archive.authoritative_session(record, scope).is_err() {
                record["_review"] =
                    json!("The latest account execution evidence could not be checked.");
            }
        }
    }
    pub fn import(&self, data: Value) -> Result<Value> {
        self.archive.ingest(data)
    }
    /// TWS's managed-accounts reply is a shared message. Serialize lookups
    /// across the Saved and Options History views on the same connection.
    async fn identify(&self, client: &Client) -> Result<Option<HashMap<String, String>>> {
        let _guard = self.identity.lock().await;
        let accounts = timeout(Duration::from_secs(5), client.managed_accounts())
            .await
            .ok()
            .and_then(Result::ok);
        let verified = accounts
            .filter(|ids| !ids.is_empty() && client.is_connected())
            .and_then(|ids| {
                ids.into_iter()
                    .map(|id| self.scope(&id).map(|scope| (id, scope)))
                    .collect::<Result<HashMap<_, _>>>()
                    .ok()
            });
        let Some(accounts) = verified else {
            self.archive
                .set_scopes(&[], Utc::now().timestamp_millis())?;
            return Ok(None);
        };
        let mut scopes = accounts.values().cloned().collect::<Vec<_>>();
        scopes.sort();
        scopes.dedup();
        let now = Utc::now().timestamp_millis();
        let (last, at) = self.archive.last_scopes()?;
        if last != scopes || at.is_none_or(|at| now - at >= 30000) {
            self.archive.set_scopes(&scopes, now)?;
        }
        Ok(Some(accounts))
    }

    pub(crate) async fn saved_scope(
        &self,
        market: &Market,
        mode: u8,
    ) -> Result<(Option<String>, &'static str, Option<i64>)> {
        let (scopes, state, at) = match market.client(mode).await {
            Ok(client) => {
                let Some(accounts) = self.identify(&client).await? else {
                    return Ok((None, "unconfirmed", None));
                };
                (
                    accounts.into_values().collect::<Vec<_>>(),
                    "current",
                    Some(Utc::now().timestamp_millis()),
                )
            }
            Err(e) => {
                // A responsive TWS with an unverified login is not evidence
                // that the prior account is still active. Only cold refusals
                // with no connected mode permit explicitly offline reporting.
                if !confirmed_offline(market, mode, &e).await {
                    return Ok((None, "unconfirmed", None));
                }
                let (scopes, at) = self.archive.last_scopes()?;
                (scopes, "lastVerifiedOffline", at)
            }
        };
        Ok(match scopes.as_slice() {
            [one] => (Some(one.clone()), state, at),
            [] => (None, "unconfirmed", None),
            _ => (None, "multipleAccounts", at),
        })
    }

    pub async fn response(&self, market: &Market, library: &Library) -> Result<Value> {
        let mut cache = self.cached.lock().await;
        let client = match market.client(1).await {
            Ok(client) => client,
            Err(e) => {
                *cache = None;
                if !confirmed_offline(market, 1, &e).await {
                    return self.render(
                        library,
                        &[],
                        None,
                        false,
                        None,
                        "The available broker connection could not confirm its current accounts.",
                        false,
                    );
                }
                let (scopes, as_of) = self.archive.last_scopes()?;
                let message = if scopes.is_empty() {
                    "Connect TWS to identify the account whose executions should be shown."
                } else {
                    "TWS is offline. Showing the local archive for the last verified account connection. Current open or closed inventory is unavailable."
                };
                return self.render(library, &scopes, None, false, as_of, message, false);
            }
        };
        let Some(accounts) = self.identify(&client).await? else {
            *cache = None;
            return self.render(
                library,
                &[],
                None,
                false,
                None,
                "The current TWS connection has not confirmed its managed accounts.",
                false,
            );
        };
        let mut scopes = accounts.values().cloned().collect::<Vec<_>>();
        scopes.sort();
        scopes.dedup();
        let reusable = cache.as_ref().is_some_and(|snap| {
            snap.client.ptr_eq(&Arc::downgrade(&client))
                && snap.scopes == scopes
                && snap
                    .progress
                    .borrow()
                    .next
                    .is_none_or(|next| next > Instant::now())
        });
        if !reusable {
            *cache = None;
            let port = market
                .port_for(&client)
                .await
                .context("The primary TWS connection changed.")?;
            let (send, receive) = watch::channel(Progress::default());
            let archive = self.archive.clone();
            let broker = client.clone();
            let worker = tokio::spawn(async move {
                let exec = async {
                    let result = account_executions(&archive, port, &accounts).await;
                    let (skipped,issue)=match result {
                        Ok((fills,skipped,issue))=>match archive.record(&fills) {
                            Ok(())=>(skipped,issue),
                            Err(_)=>(skipped,Some("Received executions could not be reconciled with the local archive.".into()))
                        },
                        Err(e)=>(0,Some(e.to_string()))
                    };
                    send.send_modify(|progress| {
                        progress.executions_done = true;
                        progress.skipped = skipped;
                        progress.issue = issue;
                    });
                };
                let inventory = async {
                    let held = timeout(Duration::from_secs(9), positions(&broker, &accounts))
                        .await
                        .ok()
                        .and_then(Result::ok);
                    send.send_modify(|progress| {
                        progress.positions = held.map(Arc::new);
                        progress.positions_done = true;
                    });
                };
                tokio::join!(exec, inventory);
                send.send_modify(|progress| {
                    let retry = if progress.issue.is_some() { 300 } else { 120 };
                    progress.next = Some(Instant::now() + Duration::from_secs(retry));
                });
            });
            *cache = Some(Snapshot {
                client: Arc::downgrade(&client),
                scopes: scopes.clone(),
                at: Utc::now().timestamp_millis(),
                progress: receive,
                worker,
            });
        }
        let snap = cache.as_ref().context("Options history unavailable.")?;
        let at = snap.at;
        let mut receiver = snap.progress.clone();
        drop(cache);
        // A healthy local TWS often finishes immediately. A stalled historical
        // date or a missing end packet must not hold the HTTP response open.
        let _ = timeout(
            Duration::from_millis(500),
            receiver.wait_for(|p| p.executions_done && p.positions_done),
        )
        .await;
        let progress = receiver.borrow().clone();
        let refreshing = !progress.executions_done || !progress.positions_done;
        let mut message=if !progress.executions_done{"TWS is refreshing its seven-day execution window. Confirmed fills appear as they arrive."}
            else if progress.issue.is_some(){"Showing the verified account’s local archive."}
            else{"TWS was asked for the last seven days. Availability depends on its trade history settings and client permissions."}.to_owned();
        if let Some(issue) = &progress.issue {
            message.push(' ');
            message.push_str(issue);
        }
        if progress.positions.is_none() {
            message.push_str(if progress.positions_done {
                " Current open or closed inventory is unavailable."
            } else {
                " Current open or closed inventory is refreshing."
            });
        }
        if progress.skipped > 0 {
            message.push_str(&format!(
                " {} reported option execution(s) lacked a usable identity, date or price.",
                progress.skipped
            ));
        }
        let mut result = self.render(
            library,
            &scopes,
            progress.positions.as_deref(),
            progress.issue.is_none(),
            Some(at),
            &message,
            true,
        )?;
        result["refreshing"] = json!(refreshing);
        Ok(result)
    }
    fn render(
        &self,
        library: &Library,
        scopes: &[String],
        positions: Option<&Inventory>,
        ok: bool,
        at: Option<i64>,
        message: &str,
        live_scope: bool,
    ) -> Result<Value> {
        let mut matches: HashMap<i32, Vec<Value>> = HashMap::new();
        for item in library.list()? {
            let mut ids = HashSet::new();
            for leg in item["document"]["legs"].as_array().into_iter().flatten() {
                if leg["kind"] == "option"
                    && leg["excluded"] != true
                    && let Some(id) = leg["conId"].as_i64().and_then(|v| i32::try_from(v).ok())
                    && id > 0
                    && ids.insert(id)
                {
                    matches
                        .entry(id)
                        .or_default()
                        .push(json!({"id":item["id"],"name":item["name"]}));
                }
            }
        }
        let today = Utc::now()
            .with_timezone(&New_York)
            .format("%Y%m%d")
            .to_string();
        let ((fills, first, last, official), stored) = {
            let mut db = self.archive.lock()?;
            let tx = db.transaction()?;
            let rows = Archive::rows_in(&tx, scopes)?;
            let groups = manual::read(&tx, scopes)?;
            tx.commit()?;
            (rows, groups)
        };
        let (base_trades, mut trade_summary) = trades::grouped(&fills, &matches, positions);
        let (trades, manual_groups) = manual::overlay(base_trades, stored);
        trade_summary["count"] = json!(trades.len());
        let lifecycle_count = fills
            .iter()
            .filter(|(_, row)| row.event_type.is_some())
            .count();
        let execution_count = fills.len() - lifecycle_count;
        let mut rows = Vec::with_capacity(fills.len());
        let scope_tokens: HashMap<_, _> = scopes
            .iter()
            .map(|scope| (scope.as_str(), manual::scope_token(scope)))
            .collect();
        for (scope, fill) in fills {
            let selection_scope = scope_tokens.get(scope.as_str());
            let last_trading_day = fill.last_trading_date.as_deref().unwrap_or(&fill.expiry);
            let status = if last_trading_day < today.as_str() {
                "expired"
            } else if let Some(p) = positions {
                if p.get(&(scope, fill.con_id)).is_some_and(|qty| *qty != 0.0) {
                    "open"
                } else {
                    "closed"
                }
            } else {
                "unknown"
            };
            let links = matches.get(&fill.con_id).map(Vec::as_slice).unwrap_or(&[]);
            let lifecycle = fill.event_type.is_some();
            let mut row = serde_json::to_value(fill)?;
            row["selectionScope"] = json!(selection_scope);
            if lifecycle {
                row["source"] = json!("IBKR Activity Flex");
            }
            row["positionStatus"] = json!(status);
            row["matchStatus"] = json!(match links.len() {
                0 => "unmatched",
                1 => "matched",
                _ => "ambiguous",
            });
            row["matches"] = json!(links);
            rows.push(row);
        }
        let source = if official {
            "IBKR TWS and local Flex archive"
        } else if live_scope {
            "IBKR TWS and local execution archive"
        } else {
            "Local IBKR execution archive"
        };
        Ok(
            json!({"trades":trades,"manualGroups":manual_groups,"tradeSummary":trade_summary,"status":if ok{"ok"}else{"unavailable"},"accountVerified":!scopes.is_empty(),"liveAccountVerified":live_scope,"executionCount":execution_count,"lifecycleCount":lifecycle_count,"rows":rows,
            "coverage":{"source":source,"complete":false,"from":first.and_then(day),"to":last.and_then(day),"asOf":at,"message":message}}),
        )
    }
}
