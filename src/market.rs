//! Read-only TWS level-one subscriptions. Requested and delivered data modes
//! are distinct: IB may return live data to a delayed or frozen request.
use crate::session_calendar::RegularCalendar;
use anyhow::{Result, anyhow, ensure};
use futures_util::StreamExt;
use ibapi::{
    Client,
    contracts::{Contract, OptionRight, SecurityType, tick_types::TickType},
    market_data::{MarketDataType, realtime::TickTypes},
    subscriptions::SubscriptionItem,
};
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc, Mutex as SyncMutex, Weak,
        atomic::{AtomicI32, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    sync::{Mutex, RwLock},
    task::JoinHandle,
    time::{sleep_until, timeout},
};

const LIMIT: usize = 60;
const IDLE: Duration = Duration::from_secs(12);
const RETRY: Duration = Duration::from_secs(25);
const REQUEST_INTERVAL: Duration = Duration::from_millis(27);
static CLIENT_SERIAL: AtomicI32 = AtomicI32::new(0);
type Lines = HashMap<(u8, i32), Line>;
type History = Arc<SyncMutex<VecDeque<Value>>>;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn finite(n: f64) -> Option<f64> {
    (n.is_finite() && n.abs() < 1e30).then_some(n)
}
fn nonnegative(n: f64) -> Option<f64> {
    finite(n).filter(|v| *v >= 0.0)
}
fn data_mode(mode: u8) -> Result<MarketDataType> {
    ensure!(
        (1..=4).contains(&mode),
        "Choose a valid market data mode (1–4)."
    );
    Ok(MarketDataType::from(i32::from(mode)))
}
fn label(mode: Option<MarketDataType>) -> &'static str {
    match mode {
        Some(MarketDataType::Realtime) => "Live",
        Some(MarketDataType::Frozen) => "Frozen",
        Some(MarketDataType::Delayed) => "Delayed",
        Some(MarketDataType::DelayedFrozen) => "Delayed frozen",
        _ => "Waiting",
    }
}

#[derive(Default)]
struct Quote {
    mode: Option<MarketDataType>,
    bid: Option<f64>,
    ask: Option<f64>,
    last: Option<f64>,
    close: Option<f64>,
    last_at: Option<i64>,
    last_trade_time: Option<i64>,
    close_at: Option<i64>,
    bid_size: Option<f64>,
    ask_size: Option<f64>,
    volume: Option<f64>,
    oi: Option<f64>,
    iv: Option<f64>,
    delta: Option<f64>,
    gamma: Option<f64>,
    theta: Option<f64>,
    vega: Option<f64>,
    underlying: Option<f64>,
    at: Option<i64>,
    error: Option<String>,
    ended: Option<Instant>,
}

impl Quote {
    fn json(&self) -> Value {
        let bid = self.bid.filter(|_| self.bid_size.is_some_and(|s| s > 0.));
        let ask = self.ask.filter(|_| self.ask_size.is_some_and(|s| s > 0.));
        let mid = bid
            .zip(ask)
            .filter(|(b, a)| a >= b)
            .map(|(b, a)| (a + b) / 2.);
        json!({"feed":label(self.mode),"bid":bid,"ask":ask,"mid":mid,"last":self.last,
            "close":self.close,"lastAt":self.last_at,"lastTradeTime":self.last_trade_time,"closeAt":self.close_at,"sizeBid":self.bid_size,"sizeAsk":self.ask_size,"volume":self.volume,
            "oi":self.oi,"iv":self.iv,"delta":self.delta,"gamma":self.gamma,"theta":self.theta,
            "vega":self.vega,"modelUnderlying":self.underlying,"at":self.at,"error":self.error})
    }

    fn price(&mut self, field: TickType, value: f64, contract: &Contract, size: Option<f64>) {
        use TickType::*;
        // Signed prices are possible for futures, spreads and rates. A -1
        // price with no executable size is the TWS missing-price sentinel.
        let signed = matches!(
            contract.security_type,
            SecurityType::Future
                | SecurityType::ContinuousFuture
                | SecurityType::Spread
                | SecurityType::Index
                | SecurityType::Commodity
                | SecurityType::Other(_)
        );
        let valid = finite(value)
            .filter(|p| (*p >= 0. || signed) && (*p != -1. || size.is_some_and(|s| s > 0.)));
        match field {
            Bid | DelayedBid => {
                self.bid = valid;
                self.at = Some(now_ms())
            }
            Ask | DelayedAsk => {
                self.ask = valid;
                self.at = Some(now_ms())
            }
            Last | DelayedLast => {
                self.last = valid;
                self.last_at = valid.map(|_| now_ms());
            }
            Close | DelayedClose => {
                self.close = valid;
                self.close_at = valid.map(|_| now_ms());
            }
            _ => {}
        }
    }

    fn size(&mut self, field: TickType, value: f64, right: Option<OptionRight>) {
        use TickType::*;
        let n = nonnegative(value);
        match field {
            BidSize | DelayedBidSize => {
                self.bid_size = n;
                self.at = Some(now_ms())
            }
            AskSize | DelayedAskSize => {
                self.ask_size = n;
                self.at = Some(now_ms())
            }
            Volume | DelayedVolume => self.volume = n,
            FuturesOpenInterest | OpenInterest => self.oi = n,
            OptionCallOpenInterest if right == Some(OptionRight::Call) => self.oi = n,
            OptionPutOpenInterest if right == Some(OptionRight::Put) => self.oi = n,
            _ => {}
        }
    }

    // Only classify a quote after a per-subscription MarketDataType callback.
    // Match delayed fields to their callback family; a delayed tick arriving
    // during a feed transition must never acquire a live label.
    fn matches(&self, field: TickType) -> bool {
        let delayed = matches!(field as i32,66..=76|80..=83|88|90);
        match self.mode {
            Some(MarketDataType::Realtime | MarketDataType::Frozen) => !delayed,
            Some(MarketDataType::Delayed | MarketDataType::DelayedFrozen) => delayed,
            _ => false,
        }
    }

    fn tick(&mut self, event: TickTypes, c: &Contract, include_activity: bool) -> Option<Value> {
        match event {
            TickTypes::Price(p) if self.matches(p.tick_type) => {
                self.price(p.tick_type, p.price, c, None)
            }
            TickTypes::Size(s) if self.matches(s.tick_type) => {
                self.size(s.tick_type, s.size, c.right)
            }
            TickTypes::Generic(g) if self.matches(g.tick_type) => {
                self.size(g.tick_type, g.value, c.right)
            }
            TickTypes::String(t)
                if self.matches(t.tick_type)
                    && matches!(
                        t.tick_type,
                        TickType::LastTimestamp | TickType::DelayedLastTimestamp
                    ) =>
            {
                self.last_trade_time = t
                    .value
                    .parse::<i64>()
                    .ok()
                    .filter(|&s| s > 0)
                    .and_then(|s| s.checked_mul(1000));
            }
            TickTypes::PriceSize(p) if self.matches(p.price_tick_type) => {
                self.price(p.price_tick_type, p.price, c, Some(p.size));
                self.size(p.size_tick_type, p.size, c.right);
                if include_activity
                    && self.mode == Some(MarketDataType::Realtime)
                    && matches!(
                        c.security_type,
                        SecurityType::Option | SecurityType::FuturesOption
                    )
                    && p.price_tick_type == TickType::Last
                    && self.last.is_some()
                    && nonnegative(p.size).is_some_and(|s| s > 0.)
                {
                    return Some(
                        json!({"time":now_ms(),"conId":c.contract_id,"symbol":c.local_symbol.trim(),
                        "price":self.last,"size":p.size,"bid":self.bid.filter(|_|self.bid_size.is_some_and(|s|s>0.)),
                        "ask":self.ask.filter(|_|self.ask_size.is_some_and(|s|s>0.))}),
                    );
                }
            }
            TickTypes::OptionComputation(g)
                if self.matches(g.field)
                    && matches!(
                        g.field,
                        TickType::ModelOption | TickType::DelayedModelOption
                    ) =>
            {
                self.iv = g.implied_volatility.and_then(nonnegative);
                self.delta = g.delta.and_then(finite).filter(|d| d.abs() <= 1.00001);
                self.gamma = g.gamma.and_then(nonnegative);
                self.vega = g.vega.and_then(nonnegative);
                self.theta = g.theta.and_then(finite);
                self.underlying = g.underlying_price.and_then(finite);
            }
            _ => {}
        }
        None
    }

    fn stop(&mut self, message: String) {
        *self = Self {
            error: Some(message),
            ended: Some(Instant::now()),
            ..Self::default()
        };
    }
}

struct Line {
    owner: Weak<Client>,
    used: Instant,
    quote: Arc<SyncMutex<Quote>>,
    worker: JoinHandle<()>,
}
impl Drop for Line {
    fn drop(&mut self) {
        // Dropping ibapi's owned Subscription sends the protocol cancellation.
        self.worker.abort();
    }
}

pub struct Market {
    port: Option<u16>,
    pub contracts: RwLock<HashMap<i32, Contract>>,
    calendars: RwLock<HashMap<i32, Arc<RegularCalendar>>>,
    clients: Mutex<HashMap<u8, (u16, Arc<Client>)>>,
    lines: Arc<Mutex<Lines>>,
    events: History,
    last_error: Arc<SyncMutex<String>>,
    next_request: Arc<Mutex<Instant>>,
}

impl Market {
    pub fn new(port: Option<u16>) -> Self {
        Self {
            port,
            contracts: RwLock::new(HashMap::new()),
            calendars: RwLock::new(HashMap::new()),
            clients: Mutex::new(HashMap::new()),
            lines: Arc::new(Mutex::new(HashMap::new())),
            events: Arc::new(SyncMutex::new(VecDeque::new())),
            last_error: Arc::new(SyncMutex::new(String::new())),
            next_request: Arc::new(Mutex::new(Instant::now())),
        }
    }

    pub async fn client(&self, mode: u8) -> Result<Arc<Client>> {
        let kind = data_mode(mode)?;
        let mut clients = self.clients.lock().await;
        if let Some((_, c)) = clients.get(&mode).filter(|(_, c)| c.is_connected()) {
            return Ok(c.clone());
        }
        if let Some((_, old)) = clients.remove(&mode) {
            self.lines.lock().await.retain(|(m, _), _| *m != mode);
            let _ = timeout(Duration::from_secs(3), old.disconnect()).await;
        }
        let ports = self
            .port
            .map(|p| vec![p])
            .unwrap_or_else(|| vec![7497, 7496]);
        let mut error = String::new();
        let mut all_refused = true;
        for port in ports {
            let id = ((std::process::id() % 1_000_000) as i32) * 1000
                + CLIENT_SERIAL
                    .fetch_add(1, Ordering::Relaxed)
                    .rem_euclid(1000);
            let connect = Client::builder()
                .address(format!("127.0.0.1:{port}"))
                .client_id(id)
                .max_reconnect_attempts(0)
                .connect();
            let client = match timeout(Duration::from_secs(6), connect).await {
                Ok(Ok(c)) => Arc::new(c),
                Ok(Err(e)) => {
                    all_refused &= matches!(&e, ibapi::Error::Io(io) if io.kind()==std::io::ErrorKind::ConnectionRefused);
                    error = format!("TWS port {port}: {e}");
                    continue;
                }
                Err(_) => {
                    all_refused = false;
                    error = format!("TWS port {port} timed out");
                    continue;
                }
            };
            if let Err(e) = client.switch_market_data_type(kind).await {
                all_refused = false;
                error = format!("TWS data mode: {e}");
                client.disconnect().await;
                continue;
            }
            let mut notices = client.notice_stream()?;
            let weak = Arc::downgrade(&client);
            let lines = Arc::downgrade(&self.lines);
            let issue = self.last_error.clone();
            tokio::spawn(async move {
                while let Some(n) = notices.next().await {
                    if matches!(
                        n.code,
                        1100 | 1101 | 1102 | 1300 | ibapi::TRANSPORT_RECONNECT_CODE
                    ) {
                        *issue.lock().unwrap() = format!("IBKR {} · {}", n.code, n.message);
                        if let Some(lines) = lines.upgrade() {
                            lines
                                .lock()
                                .await
                                .retain(|_, line| !line.owner.ptr_eq(&weak));
                        }
                        if let Some(c) = weak.upgrade() {
                            c.disconnect().await;
                        }
                        break;
                    }
                }
            });
            clients.insert(mode, (port, client.clone()));
            self.last_error.lock().unwrap().clear();
            return Ok(client);
        }
        *self.last_error.lock().unwrap() = error.clone();
        if all_refused {
            return Err(std::io::Error::new(std::io::ErrorKind::ConnectionRefused, error).into());
        }
        Err(anyhow!(error))
    }

    pub async fn port_for(&self, client: &Arc<Client>) -> Option<u16> {
        self.clients
            .lock()
            .await
            .values()
            .find_map(|(port, connected)| Arc::ptr_eq(client, connected).then_some(*port))
    }
    pub async fn cleanup(&self) {
        self.lines
            .lock()
            .await
            .retain(|_, l| l.used.elapsed() <= IDLE);
    }
    pub async fn status(&self) -> Value {
        let connected = self
            .clients
            .lock()
            .await
            .values()
            .any(|(_, c)| c.is_connected());
        let lines = self.lines.lock().await.len();
        json!({"app":"TWSOptionsLab","backend":"Rust","connected":connected,"time":now_ms(),
            "lines":lines,"limit":LIMIT,"lastError":*self.last_error.lock().unwrap()})
    }
    pub async fn connection_state(&self, mode: u8) -> (bool, bool) {
        let clients = self.clients.lock().await;
        (
            clients.values().any(|(_, c)| c.is_connected()),
            clients.get(&mode).is_some_and(|(_, c)| c.is_connected()),
        )
    }
    pub async fn activity(&self) -> Value {
        json!(*self.events.lock().unwrap())
    }

    pub(crate) async fn register_calendars(
        &self,
        entries: impl IntoIterator<Item = (i32, Option<Arc<RegularCalendar>>)>,
    ) {
        let mut schedules = self.calendars.write().await;
        for (id, calendar) in entries {
            if let Some(calendar) = calendar {
                schedules.insert(id, calendar);
            } else {
                schedules.remove(&id);
            }
        }
    }
    pub async fn quotes(&self, ids: &[i32], mode: u8) -> Result<Value> {
        self.quote_window(ids, mode, LIMIT).await
    }
    pub async fn saved_quotes(&self, ids: &[i32], mode: u8) -> Result<Value> {
        self.quote_window(ids, mode, LIMIT - 12).await
    }
    async fn quote_window(&self, ids: &[i32], mode: u8, line_limit: usize) -> Result<Value> {
        data_mode(mode)?;
        let unique: HashSet<_> = ids.iter().copied().collect();
        ensure!(
            unique.len() <= 54,
            "Choose fewer contracts for this quote window."
        );
        ensure!(unique.iter().all(|id| *id > 0), "Invalid contract id.");
        let client = self.client(mode).await?;
        let owner = Arc::downgrade(&client);
        let catalog = self.contracts.read().await;
        let calendars = self.calendars.read().await;
        let mut lines = self.lines.lock().await;
        ensure!(
            client.is_connected(),
            "TWS connection changed. Retry the quote window."
        );
        lines.retain(|_, l| l.used.elapsed() <= IDLE);
        let mut result = Map::new();
        let now = now_ms();
        for id in unique {
            let Some(contract) = catalog.get(&id) else {
                result.insert(
                    id.to_string(),
                    json!({"feed":"Waiting","error":"Contract has not been loaded."}),
                );
                continue;
            };
            let key = (mode, id);
            if lines.get(&key).is_some_and(|l| {
                !l.owner.ptr_eq(&owner)
                    || l.quote
                        .lock()
                        .unwrap()
                        .ended
                        .is_some_and(|end| end.elapsed() >= RETRY)
            }) {
                lines.remove(&key);
            }
            if !lines.contains_key(&key) {
                if lines.len() >= line_limit {
                    result.insert(id.to_string(),json!({"feed":"Line budget","error":"Waiting for idle lines to be released."}));
                    continue;
                }
                let quote = Arc::new(SyncMutex::new(Quote::default()));
                let worker = tokio::spawn(run_line(
                    client.clone(),
                    contract.clone(),
                    mode,
                    quote.clone(),
                    self.events.clone(),
                    self.last_error.clone(),
                    self.next_request.clone(),
                ));
                lines.insert(
                    key,
                    Line {
                        owner: owner.clone(),
                        used: Instant::now(),
                        quote,
                        worker,
                    },
                );
            }
            let line = lines.get_mut(&key).unwrap();
            line.used = Instant::now();
            let quote = line.quote.lock().unwrap();
            let mut item = quote.json();
            let close = quote
                .close_at
                .and_then(|received| calendars.get(&id)?.close_for_quote(received, now));
            item["closeSessionDate"] = json!(close.map(|(date, _)| date));
            item["closeSessionEnd"] = json!(close.map(|(_, end)| end));
            result.insert(id.to_string(), item);
        }
        Ok(
            json!({"time":now_ms(),"quotes":result,"lines":lines.len(),"issue":*self.last_error.lock().unwrap()}),
        )
    }
}

async fn run_line(
    client: Arc<Client>,
    contract: Contract,
    mode: u8,
    shared: Arc<SyncMutex<Quote>>,
    events: History,
    issue: Arc<SyncMutex<String>>,
    gate: Arc<Mutex<Instant>>,
) {
    let outcome: Result<()> = async {
        {
            let mut next = gate.lock().await;
            sleep_until((*next).into()).await;
            *next = Instant::now() + REQUEST_INTERVAL;
        }
        let mut builder = client.market_data(&contract);
        if mode == 1 {
            if contract.security_type == SecurityType::Option {
                builder = builder.generic_ticks(&["101"]);
            } else if contract.security_type == SecurityType::Future {
                builder = builder.generic_ticks(&["588"]);
            }
        }
        let mut subscription = builder.subscribe().await?;
        let mut pending = VecDeque::with_capacity(64);
        while let Some(item) = subscription.next().await {
            let mut q = shared.lock().unwrap();
            match item? {
                SubscriptionItem::Notice(n) => {
                    let message = format!("IBKR {} · {}", n.code, n.message);
                    if matches!(
                        n.code,
                        ibapi::TRANSPORT_RECONNECT_CODE
                            | ibapi::SUBSCRIPTION_LAG_CODE
                            | 1100
                            | 1101
                            | 1102
                            | 1300
                    ) {
                        return Err(anyhow!(message));
                    }
                    q.error = Some(message.clone());
                    *issue.lock().unwrap() = message;
                }
                SubscriptionItem::Data(TickTypes::MarketDataType(kind)) => {
                    if q.mode != Some(kind) {
                        *q = Quote {
                            mode: Some(kind),
                            ..Quote::default()
                        };
                    }
                    for event in pending.drain(..) {
                        if let Some(trade) = q.tick(event, &contract, mode == 1) {
                            push_trade(&events, trade)
                        }
                    }
                }
                SubscriptionItem::Data(event) => {
                    if q.mode.is_none() {
                        if pending.len() == 64 {
                            pending.pop_front();
                        }
                        pending.push_back(event);
                    } else if let Some(trade) = q.tick(event, &contract, mode == 1) {
                        push_trade(&events, trade)
                    }
                }
            }
        }
        Err(anyhow!("TWS market data subscription ended."))
    }
    .await;
    if let Err(e) = outcome {
        let msg = e.to_string();
        shared.lock().unwrap().stop(msg.clone());
        *issue.lock().unwrap() = msg;
    }
}

fn push_trade(events: &History, trade: Value) {
    let mut rows = events.lock().unwrap();
    rows.push_front(trade);
    rows.truncate(400);
}
