//! Position episodes from broker opening executions, closing lots and order identities.
use super::archive::LedgerRow;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
const EPS: f64 = 1e-8;
fn number(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn identifier(v: &Value, key: &str) -> Option<String> {
    let s = v[key]
        .as_str()
        .map(str::to_owned)
        .or_else(|| v[key].as_i64().map(|n| n.to_string()))?;
    let s = s.trim();
    (!s.is_empty()
        && !matches!(
            s.to_ascii_uppercase().as_str(),
            "0" | "-1" | "N/A" | "NONE" | "NULL" | "-"
        ))
    .then(|| s.to_owned())
}
fn add(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    a.zip(b).map(|(x, y)| x + y).filter(|x| x.is_finite())
}
fn present_fee(v: &Value) -> Option<f64> {
    let n = number(&v["commission"])?;
    (n.abs() < EPS || v["commissionCurrency"] == v["currency"]).then_some(n)
}
fn reported(v: &Value) -> Option<f64> {
    (v["realizedCurrency"] == v["currency"])
        .then(|| number(&v["realizedPnl"]))
        .flatten()
}
fn side(v: &Value) -> f64 {
    if v["side"] == "BUY" { 1. } else { -1. }
}
fn role(v: &Value) -> &'static str {
    match text(v, "openClose") {
        "O" | "OPEN" => "open",
        "C" | "CLOSE" => "close",
        "MIXED" | "O;C" | "C;O" => "mixed",
        _ if v["eventType"].is_string()
            || v["closedLots"].as_array().is_some_and(|a| !a.is_empty()) =>
        {
            "close"
        }
        _ => "unclassified",
    }
}
fn verified_lot_fifo(close: &Value, entry: &Value, quantity: f64) -> Option<f64> {
    let lots = close["closedLots"].as_array()?;
    let total = lots
        .iter()
        .try_fold(0., |sum, l| number(&l["realizedPnl"]).map(|v| sum + v))?;
    if (total - reported(close)?).abs() > 0.005 {
        return None;
    }
    let mut matching = lots.iter().filter(|l| {
        l["openingTransactionId"] == entry["transactionId"]
            && l["openedAt"] == entry["at"]
            && number(&l["qty"]).is_some_and(|q| (q - quantity).abs() < EPS)
    });
    let value = number(&matching.next()?["realizedPnl"])?;
    matching.next().is_none().then_some(value)
}
fn order(v: &Value) -> Option<String> {
    let under = identifier(v, "underlyingConId").unwrap_or_else(|| text(v, "symbol").to_owned());
    let key =
        if let (Some(id), Some(at)) = (identifier(v, "brokerageOrderId"), v["orderAt"].as_i64()) {
            format!("broker:{id}:{at}")
        } else if let Some(id) = identifier(v, "comboId") {
            format!("confirmed-bag:{id}")
        } else if let Some(id) = identifier(v, "twsPermId") {
            format!("perm:{id}:{}", v["conId"])
        } else if let (Some(id), Some(at)) = (identifier(v, "ibOrderId"), v["orderAt"].as_i64()) {
            format!("client:{id}:{at}:{}", v["conId"])
        } else {
            return None;
        };
    Some(format!(
        "{}|{}|{}|{key}",
        text(v, "symbol"),
        text(v, "currency"),
        under
    ))
}
fn admitted_amount(n: Option<f64>, v: &Value, qty: f64) -> Option<f64> {
    n.map(|n| n * qty / number(&v["qty"]).unwrap_or(1.))
}
#[derive(Default)]
struct Packet {
    first_at: i64,
    ids: BTreeSet<i64>,
    opening_shape: BTreeMap<i64, f64>,
    has_other_effect: bool,
    opens: BTreeSet<usize>,
    closes: BTreeSet<usize>,
}
struct Lot {
    idx: usize,
    group: usize,
    remain: f64,
    sign: f64,
}
struct Part {
    event: usize,
    group: usize,
    qty: f64,
    role: &'static str,
    cash: Option<f64>,
    broker: Option<f64>,
    opening: Option<usize>,
    lineage: &'static str,
    assigned: bool,
}
struct Allocation {
    lot: Option<usize>,
    qty: f64,
    fifo: Option<f64>,
    declared: bool,
}
struct Group {
    parent: usize,
    reason: &'static str,
    uncertain: bool,
    opening_shape: BTreeMap<i64, f64>,
}
#[derive(Default)]
struct Totals {
    cash: f64,
    unknown: usize,
    broker: f64,
    broker_unknown: usize,
    closes: usize,
}
struct Engine<'a> {
    scope: &'a str,
    events: Vec<Value>,
    groups: Vec<Group>,
    lots: Vec<Lot>,
    parts: Vec<Part>,
    packets: BTreeMap<String, Packet>,
    inventory: HashMap<i64, Vec<usize>>,
    open_ids: HashMap<String, Option<usize>>,
    cross_seconds: BTreeSet<(i64, i64)>,
    combo_open: HashMap<String, usize>,
    unknown_exit: HashMap<String, usize>,
    totals: BTreeMap<String, Totals>,
}
impl<'a> Engine<'a> {
    fn new(scope: &'a str, mut events: Vec<Value>) -> Self {
        events.sort_by(|a, b| {
            a["at"]
                .as_i64()
                .cmp(&b["at"].as_i64())
                .then_with(|| {
                    // An intrasecond closing lot can refer to an opening from the same second.
                    let rank = |v: &Value| if role(v) == "open" { 0 } else { 1 };
                    rank(a).cmp(&rank(b))
                })
                .then_with(|| text(a, "id").cmp(text(b, "id")))
        });
        let mut packets = BTreeMap::<String, Packet>::new();
        for v in &events {
            if let Some(k) = order(v) {
                let packet = packets.entry(k).or_insert_with(|| Packet {
                    first_at: v["at"].as_i64().unwrap_or_default(),
                    ..Packet::default()
                });
                let id = v["conId"].as_i64().unwrap_or_default();
                packet.ids.insert(id);
                if role(v) == "open" {
                    *packet.opening_shape.entry(id).or_default() +=
                        side(v) * number(&v["qty"]).unwrap_or(0.);
                } else {
                    packet.has_other_effect = true;
                }
            }
        }
        let cross_seconds = events
            .iter()
            .filter(|v| role(v) != "open")
            .map(|v| {
                (
                    v["at"].as_i64().unwrap_or(0),
                    v["conId"].as_i64().unwrap_or(0),
                )
            })
            .collect();
        Self {
            scope,
            events,
            groups: vec![],
            lots: vec![],
            parts: vec![],
            packets,
            inventory: HashMap::new(),
            open_ids: HashMap::new(),
            cross_seconds,
            combo_open: HashMap::new(),
            unknown_exit: HashMap::new(),
            totals: BTreeMap::new(),
        }
    }
    fn group(&mut self, reason: &'static str) -> usize {
        let i = self.groups.len();
        self.groups.push(Group {
            parent: i,
            reason,
            uncertain: false,
            opening_shape: BTreeMap::new(),
        });
        i
    }
    fn root(&self, mut g: usize) -> usize {
        while self.groups[g].parent != g {
            g = self.groups[g].parent;
        }
        g
    }
    fn join(&mut self, a: usize, b: usize, reason: &'static str) {
        let a = self.root(a);
        let b = self.root(b);
        self.groups[a].reason = reason;
        if a != b {
            self.groups[a].uncertain |= self.groups[b].uncertain;
            self.groups[b].parent = a;
        }
    }
    fn scale_target(&self, shape: &BTreeMap<i64, f64>, at: i64) -> Option<usize> {
        if shape.len() < 2 || shape.values().any(|q| q.abs() < EPS) {
            return None;
        }
        let mut groups = BTreeSet::new();
        let mut held = BTreeMap::<i64, f64>::new();
        for (&cid, &qty) in shape {
            if self.cross_seconds.contains(&(at, cid)) {
                return None;
            }
            for n in self.inventory.get(&cid)?.iter().copied() {
                let lot = &self.lots[n];
                if lot.remain <= EPS {
                    continue;
                }
                if lot.sign != qty.signum() {
                    return None;
                }
                groups.insert(self.root(lot.group));
                *held.entry(cid).or_default() += lot.sign * lot.remain;
            }
        }
        if groups.len() != 1 {
            return None;
        }
        let g = *groups.first()?;
        let proportional = |a: &BTreeMap<i64, f64>, b: &BTreeMap<i64, f64>| {
            if a.len() != b.len() || a.is_empty() {
                return false;
            }
            let (&first, &value) = a.first_key_value().unwrap();
            let ratio = b.get(&first).copied().unwrap_or(0.) / value;
            ratio > 0.
                && a.iter()
                    .all(|(k, n)| b.get(k).is_some_and(|v| (v - ratio * n).abs() < EPS))
        };
        (!self.groups[g].uncertain
            && proportional(shape, &self.groups[g].opening_shape)
            && proportional(shape, &held))
        .then_some(g)
    }
    fn open(&mut self, i: usize, qty: f64) {
        if qty <= EPS {
            return;
        }
        let v = &self.events[i];
        let cid = v["conId"].as_i64().unwrap_or(0);
        let sign = side(v);
        let key = order(v);
        let combo = key
            .as_ref()
            .filter(|k| self.packets.get(*k).is_some_and(|p| p.ids.len() > 1));
        let active: BTreeSet<_> = self
            .inventory
            .get(&cid)
            .into_iter()
            .flatten()
            .map(|&n| &self.lots[n])
            .filter(|l| l.remain > EPS && l.sign == sign)
            .map(|l| self.root(l.group))
            .collect();
        let group = if let Some(k) = combo {
            if let Some(&g) = self.combo_open.get(k) {
                g
            } else {
                let shape = self.packets[k].opening_shape.clone();
                let prior = (!self.packets[k].has_other_effect)
                    .then(|| self.scale_target(&shape, v["at"].as_i64().unwrap_or(0)))
                    .flatten();
                let g = if let Some(g) = prior {
                    self.groups[g].reason =
                        "Broker combination orders · scaled into the same live spread";
                    g
                } else {
                    let g = self.group("Broker combination order");
                    if !self.packets[k].has_other_effect {
                        self.groups[g].opening_shape = shape;
                    }
                    g
                };
                self.combo_open.insert(k.clone(), g);
                g
            }
        } else if active.len() == 1
            && !self
                .cross_seconds
                .contains(&(v["at"].as_i64().unwrap_or(0), cid))
            && self.groups[*active.first().unwrap()].reason == "Single-contract position"
        {
            *active.first().unwrap()
        } else {
            self.group("Single-contract position")
        };
        let n = self.lots.len();
        self.lots.push(Lot {
            idx: i,
            group,
            remain: qty,
            sign,
        });
        self.inventory.entry(cid).or_default().push(n);
        if let Some(id) = identifier(&self.events[i], "transactionId") {
            self.open_ids
                .entry(id)
                .and_modify(|v| *v = None)
                .or_insert(Some(n));
        }
        if let Some(k) = key {
            self.packets.get_mut(&k).unwrap().opens.insert(group);
        }
        self.parts.push(Part {
            event: i,
            group,
            qty,
            role: "open",
            cash: Some(0.),
            broker: Some(0.),
            opening: None,
            lineage: "Broker opening execution",
            assigned: false,
        });
    }
    fn missing(&mut self, i: usize) -> usize {
        let key = order(&self.events[i])
            .unwrap_or_else(|| format!("fill:{}", text(&self.events[i], "id")));
        if let Some(&g) = self.unknown_exit.get(&key) {
            g
        } else {
            let g = self.group("Broker closing order · opening coverage incomplete");
            self.unknown_exit.insert(key, g);
            g
        }
    }
    fn allocations(&self, i: usize, closing: f64) -> Option<Vec<Allocation>> {
        let v = &self.events[i];
        let sign = side(v);
        let cid = v["conId"].as_i64()?;
        let declared = v["closedLots"].as_array();
        if let Some(refs) = declared.filter(|r| !r.is_empty()) {
            let mut allocation = vec![];
            let mut sum = 0.;
            let mut used = HashMap::<usize, f64>::new();
            for r in refs {
                let qty = number(&r["qty"])?.abs();
                if qty <= EPS {
                    return None;
                }
                sum += qty;
                let lot = identifier(r, "openingTransactionId")
                    .and_then(|id| self.open_ids.get(&id).copied().flatten());
                if let Some(n) = lot {
                    let l = &self.lots[n];
                    let original = &self.events[l.idx];
                    let here = used.entry(n).or_default();
                    *here += qty;
                    if l.sign == sign
                        || original["conId"] != cid
                        || original["currency"] != v["currency"]
                        || original["multiplier"] != v["multiplier"]
                        || r["openedAt"]
                            .as_i64()
                            .is_some_and(|at| original["at"].as_i64() != Some(at))
                        || *here > l.remain + EPS
                    {
                        return None;
                    }
                }
                allocation.push(Allocation {
                    lot,
                    qty,
                    fifo: number(&r["realizedPnl"]),
                    declared: true,
                });
            }
            return ((sum - closing).abs() <= EPS).then_some(allocation);
        }
        // Without a broker lot reference, only a single compatible, observed
        // opening group is eligible. Cash attribution still needs evidence that
        // this was the same opening lot (verified basis or unique broker reference).
        let eligible = self
            .inventory
            .get(&cid)
            .into_iter()
            .flatten()
            .copied()
            .filter(|&n| self.lots[n].remain > EPS && self.lots[n].sign != sign)
            .collect::<Vec<_>>();
        let roots = eligible
            .iter()
            .map(|&n| self.root(self.lots[n].group))
            .collect::<BTreeSet<_>>();
        let complete = eligible.iter().map(|&n| self.lots[n].remain).sum::<f64>() + EPS >= closing;
        if roots.len() != 1 || !complete {
            return Some(vec![Allocation {
                lot: None,
                qty: closing,
                fifo: None,
                declared: false,
            }]);
        }
        let mut remaining = closing;
        let mut alloc = vec![];
        for n in eligible {
            let q = remaining.min(self.lots[n].remain);
            remaining -= q;
            alloc.push(Allocation {
                lot: Some(n),
                qty: q,
                fifo: None,
                declared: false,
            });
            if remaining <= EPS {
                break;
            }
        }
        // A single group does not prove complete position coverage. Confirm its
        // historical cash basis independently against the broker's exit result.
        let expected = reported(v)?;
        let reconstructed = alloc
            .iter()
            .try_fold(0., |total, a| Some(total + self.cash(i, a.lot?, a.qty)?))?;
        ((expected - reconstructed).abs() <= 0.005).then_some(alloc)
    }
    fn cash(&self, i: usize, n: usize, qty: f64) -> Option<f64> {
        let c = &self.events[i];
        let l = &self.lots[n];
        let o = &self.events[l.idx];
        let open_fee = admitted_amount(present_fee(o), o, qty)?;
        let close_fee = admitted_amount(present_fee(c), c, qty)?;
        Some(
            (number(&c["price"])? - number(&o["price"])?)
                * l.sign
                * qty
                * number(&o["multiplier"])?
                - open_fee
                - close_fee,
        )
    }
    fn close(&mut self, i: usize, closing: f64) {
        let cid = self.events[i]["conId"].as_i64().unwrap_or(0);
        let key = order(&self.events[i]);
        let allocations = self.allocations(i, closing).unwrap_or_else(|| {
            vec![Allocation {
                lot: None,
                qty: closing,
                fifo: None,
                declared: false,
            }]
        });
        let detached = allocations
            .iter()
            .any(|a| a.lot.is_none())
            .then(|| self.missing(i));
        if allocations.iter().any(|a| a.lot.is_none() && !a.declared) {
            for &n in self.inventory.get(&cid).into_iter().flatten() {
                if self.lots[n].remain > EPS && self.lots[n].sign != side(&self.events[i]) {
                    let g = self.root(self.lots[n].group);
                    self.groups[g].uncertain = true;
                }
            }
        }
        let groups: Vec<_> = allocations
            .iter()
            .map(|a| a.lot.map(|n| self.lots[n].group).or(detached).unwrap())
            .collect();
        let single = groups
            .iter()
            .map(|&g| self.root(g))
            .collect::<BTreeSet<_>>()
            .len()
            == 1;
        let authoritative = reported(&self.events[i]);
        let lot_total = allocations
            .iter()
            .try_fold(0., |n, a| a.fifo.map(|v| n + v));
        let breakable = lot_total
            .zip(authoritative)
            .is_some_and(|(a, b)| (a - b).abs() <= 0.005);
        let assigned = matches!(
            text(&self.events[i], "eventType"),
            "assignment" | "exercise"
        );
        for (a, g) in allocations.into_iter().zip(groups) {
            let n = a.lot;
            let broker = if single {
                None
            } else if breakable {
                a.fifo
            } else {
                None
            };
            let cash = if assigned {
                broker
            } else {
                n.and_then(|l| self.cash(i, l, a.qty))
            };
            self.parts.push(Part {
                event: i,
                group: g,
                qty: a.qty,
                role: "close",
                cash,
                broker,
                opening: n.map(|l| self.lots[l].idx),
                lineage: if a.declared && n.is_some() {
                    "IBKR matched opening lot"
                } else if n.is_some() {
                    "Single group · broker-confirmed cash basis"
                } else {
                    "Opening execution unavailable"
                },
                assigned,
            });
            if let Some(l) = n {
                self.lots[l].remain = (self.lots[l].remain - a.qty).max(0.);
            }
            if let Some(k) = &key {
                self.packets.get_mut(k).unwrap().closes.insert(g);
            }
        }
        // Preserve the authoritative execution-level FIFO figure, including
        // wash adjustments. Never prorate that number between distinct groups.
        if single {
            let mut indices = self
                .parts
                .iter_mut()
                .rev()
                .take_while(|p| p.event == i && p.role == "close");
            if let Some(first) = indices.next() {
                first.broker = authoritative;
                if assigned {
                    first.cash = authoritative;
                }
            }
            for p in indices {
                p.broker = authoritative.map(|_| 0.);
                if assigned {
                    p.cash = authoritative.map(|_| 0.);
                }
            }
        }
        let t = self
            .totals
            .entry(text(&self.events[i], "currency").to_owned())
            .or_default();
        t.closes += 1;
        if let Some(v) = authoritative {
            t.broker += v
        } else {
            t.broker_unknown += 1;
        }
    }
    fn classify(&mut self, i: usize) {
        let qty = number(&self.events[i]["qty"]).unwrap_or(0.);
        match role(&self.events[i]) {
            "open" => self.open(i, qty),
            "close" => self.close(i, qty),
            "mixed" => {
                let closing = self.events[i]["closedLots"].as_array().and_then(|s| {
                    s.iter()
                        .try_fold(0., |n, f| number(&f["qty"]).map(|q| n + q.abs()))
                });
                if let Some(c) = closing.filter(|&q| q > 0. && q <= qty + EPS) {
                    self.close(i, c);
                    self.open(i, (qty - c).max(0.));
                } else {
                    self.unclassified(i, qty);
                }
            }
            _ => self.unclassified(i, qty),
        }
    }
    fn unclassified(&mut self, i: usize, qty: f64) {
        let k = order(&self.events[i]).map(|key| format!("unclassified:{key}"));
        let g = if let Some(key) = k {
            if let Some(&g) = self.unknown_exit.get(&key) {
                g
            } else {
                let combo = order(&self.events[i]).is_some_and(|k| self.packets[&k].ids.len() > 1);
                let g = self.group(if combo {
                    "Broker combination order · position effect unconfirmed"
                } else {
                    "Broker order · position effect unconfirmed"
                });
                self.unknown_exit.insert(key, g);
                g
            }
        } else {
            self.group("Unclassified broker execution")
        };
        let authoritative = reported(&self.events[i]);
        self.groups[g].uncertain = true;
        self.parts.push(Part {
            event: i,
            group: g,
            qty,
            role: "unclassified",
            cash: None,
            broker: authoritative,
            opening: None,
            lineage: "Opening or closing effect is unknown",
            assigned: false,
        });
        let totals = self
            .totals
            .entry(text(&self.events[i], "currency").to_owned())
            .or_default();
        if let Some(amount) = authoritative {
            totals.broker += amount;
        } else {
            totals.broker_unknown += 1;
        }
    }
    fn link_orders(&mut self) {
        // A combination exit can establish a single spread even when the legs
        // opened independently. Preserve already distinct multileg strategies.
        let mut packets = std::mem::take(&mut self.packets)
            .into_iter()
            .collect::<Vec<_>>();
        packets.sort_by_key(|(_, p)| p.first_at);
        for (key, p) in packets {
            if p.ids.len() < 2 {
                continue;
            }
            let opens = p
                .opens
                .iter()
                .map(|&g| self.root(g))
                .collect::<BTreeSet<_>>();
            let closes = p
                .closes
                .iter()
                .map(|&g| self.root(g))
                .collect::<BTreeSet<_>>();
            if !opens.is_empty() && !closes.is_empty() {
                if closes.len() == 1 {
                    let old = *closes.first().unwrap();
                    for new in opens {
                        self.join(old, new, "Broker combination order and linked roll");
                    }
                }
                continue;
            }
            if opens.is_empty() && closes.len() > 1 {
                let joinable = closes.iter().all(|&g| {
                    self.groups[g].reason == "Single-contract position"
                        && !self
                            .lots
                            .iter()
                            .any(|l| self.root(l.group) == g && l.remain > EPS)
                        && self
                            .parts
                            .iter()
                            .filter(|part| part.role == "close" && self.root(part.group) == g)
                            .all(|part| order(&self.events[part.event]).as_ref() == Some(&key))
                });
                if joinable {
                    let g = *closes.first().unwrap();
                    for leg in closes {
                        self.join(g, leg, "Broker combination closing order");
                    }
                }
            }
        }
    }
}

struct LegView {
    first: Value,
    sign: f64,
    opened: f64,
    closed: f64,
    balance: f64,
    cash: Option<f64>,
    fifo: Option<f64>,
}
impl LegView {
    fn new(v: &Value, sign: f64) -> Self {
        Self {
            first: v.clone(),
            sign,
            opened: 0.,
            closed: 0.,
            balance: 0.,
            cash: Some(0.),
            fifo: Some(0.),
        }
    }
    fn json(&self, uncertain: bool) -> Value {
        let v = &self.first;
        let remaining = (self.opened + EPS >= self.closed && self.opened > EPS && !uncertain)
            .then_some(if self.balance.abs() < EPS {
                0.0
            } else {
                self.balance
            });
        json!({"conId":v["conId"],"symbol":v["symbol"],"localSymbol":v["localSymbol"],"secType":v["secType"],"underlyingConId":v["underlyingConId"],
            "right":v["right"],"strike":v["strike"],"expiry":v["expiry"],"multiplier":v["multiplier"],"currency":v["currency"],
            "direction":if self.sign>0.{"long"}else if self.sign<0.{"short"}else{"unknown"},"openedQty":self.opened,
            "closedQty":self.closed,"remainingQty":remaining,"netRealizedPnl":self.cash,"brokerRealizedPnl":self.fifo})
    }
}

pub(super) fn group_label(symbol: &str, legs: &[Value], reason: &str) -> String {
    if reason.contains("linked roll") {
        return format!("{symbol} rolled position");
    }
    if legs.len() == 1 {
        return format!(
            "{} {}{}",
            symbol,
            legs[0]["strike"].as_f64().unwrap_or(0.),
            text(&legs[0], "right")
        );
    }
    if legs.len() == 2
        && legs[0]["right"] == legs[1]["right"]
        && matches!(
            (text(&legs[0], "direction"), text(&legs[1], "direction")),
            ("short", "long") | ("long", "short")
        )
    {
        let key = if legs[0]["expiry"] != legs[1]["expiry"] {
            if legs[0]["strike"] == legs[1]["strike"] {
                "calendar spread"
            } else {
                "diagonal spread"
            }
        } else {
            let size = |l: &Value| {
                number(&l["openedQty"])
                    .unwrap_or(0.)
                    .max(number(&l["closedQty"]).unwrap_or(0.))
            };
            let call = legs[0]["right"] == "C";
            if (size(&legs[0]) - size(&legs[1])).abs() > EPS {
                if call {
                    "call ratio spread"
                } else {
                    "put ratio spread"
                }
            } else {
                let lower = if number(&legs[0]["strike"]) < number(&legs[1]["strike"]) {
                    &legs[0]
                } else {
                    &legs[1]
                };
                match (call, text(lower, "direction")) {
                    (true, "long") => "bull call spread",
                    (true, "short") => "bear call spread",
                    (false, "long") => "bull put spread",
                    (false, "short") => "bear put spread",
                    (true, _) => "call spread",
                    (false, _) => "put spread",
                }
            }
        };
        return format!("{symbol} {key}");
    }
    format!("{symbol} multi-leg position")
}
impl Engine<'_> {
    fn finish(
        &mut self,
        links: &HashMap<i32, Vec<Value>>,
        held: Option<&super::Inventory>,
    ) -> Vec<Value> {
        for i in 0..self.events.len() {
            self.classify(i);
        }
        self.link_orders();
        // Rolls can bring lots formerly belonging to two positions together.
        // Reconcile exit-level attribution after resolving these verified links.
        let mut by_exit = BTreeMap::<usize, Vec<usize>>::new();
        let mut members = BTreeMap::<usize, Vec<usize>>::new();
        for (j, p) in self.parts.iter().enumerate() {
            members.entry(self.root(p.group)).or_default().push(j);
            if p.role == "close" {
                by_exit.entry(p.event).or_default().push(j);
            }
        }
        for (i, idxs) in by_exit {
            let root = self.root(self.parts[idxs[0]].group);
            if idxs.iter().all(|&j| self.root(self.parts[j].group) == root) {
                let authoritative = reported(&self.events[i]);
                for (index, j) in idxs.into_iter().enumerate() {
                    let p = &mut self.parts[j];
                    p.broker = authoritative.map(|n| if index == 0 { n } else { 0. });
                    if p.assigned {
                        p.cash = p.broker;
                    }
                }
            }
        }
        let mut live_quantity = HashMap::<i32, f64>::new();
        for l in &self.lots {
            let cid = self.events[l.idx]["conId"].as_i64().unwrap_or(0) as i32;
            *live_quantity.entry(cid).or_default() += l.sign * l.remain;
        }
        let mut out = vec![];
        for (root, list) in members {
            let first = &self.events[self.parts[list[0]].event];
            let currency = text(first, "currency");
            let symbol = text(first, "symbol");
            let mut actual = Some(0.);
            let mut fifo = Some(0.);
            let mut opening = None;
            let mut latest = 0i64;
            let mut last_exit = None;
            let mut legs = BTreeMap::<i32, LegView>::new();
            let mut pieces = BTreeMap::<(usize, &str), Vec<usize>>::new();
            let mut assigned = false;
            let mut unresolved = false;
            let mut has_closes = false;
            let mut missing_fee = false;
            let mut missing_open = false;
            let mut match_links = BTreeMap::<String, Value>::new();
            let mut every_leg_matches = true;
            let mut ambiguous = false;
            for &j in &list {
                let p = &self.parts[j];
                let v = &self.events[p.event];
                let cid = v["conId"].as_i64().unwrap_or(0) as i32;
                let at = v["at"].as_i64().unwrap_or(0);
                latest = latest.max(at);
                let direction = if p.role == "open" {
                    side(v)
                } else if p.role == "close" {
                    -side(v)
                } else {
                    0.
                };
                let leg = legs
                    .entry(cid)
                    .or_insert_with(|| LegView::new(v, direction));
                if leg.sign != direction {
                    leg.sign = 0.;
                }
                if p.role != "unclassified" {
                    leg.balance += side(v) * p.qty;
                }
                if p.role == "open" {
                    leg.opened += p.qty;
                    opening = Some(opening.map_or(at, |t: i64| t.min(at)));
                } else if p.role == "close" {
                    leg.closed += p.qty;
                    last_exit = Some(at);
                    has_closes = true;
                    assigned |= p.assigned;
                    if p.cash.is_none() {
                        missing_fee |= present_fee(v).is_none()
                            || p.opening
                                .is_some_and(|i| present_fee(&self.events[i]).is_none());
                        missing_open |= p.opening.is_none();
                    }
                } else {
                    unresolved = true;
                }
                leg.cash = add(leg.cash, p.cash);
                leg.fifo = add(leg.fifo, p.broker);
                actual = add(actual, p.cash);
                fifo = add(fifo, p.broker);
                pieces.entry((p.event, p.role)).or_default().push(j);
            }
            let open_balance = legs.values().any(|l| l.opened > l.closed + EPS);
            let missing_inventory = open_balance
                && held.is_some_and(|inventory| {
                    legs.iter().any(|(&id, l)| {
                        l.opened > l.closed + EPS
                            && (inventory
                                .get(&(self.scope.to_owned(), id))
                                .copied()
                                .unwrap_or(0.)
                                - live_quantity.get(&id).copied().unwrap_or(0.))
                            .abs()
                                > EPS
                    })
                });
            let uncertain = unresolved || self.groups[root].uncertain || missing_inventory;
            let status = if uncertain {
                "incomplete"
            } else if open_balance {
                "open"
            } else if has_closes {
                "closed"
            } else {
                "incomplete"
            };
            let legs = legs
                .into_iter()
                .map(|(cid, l)| {
                    let matches = links.get(&cid).map(Vec::as_slice).unwrap_or(&[]);
                    every_leg_matches &= !matches.is_empty();
                    ambiguous |= matches.len() > 1;
                    for m in matches {
                        match_links.insert(text(m, "id").to_owned(), m.clone());
                    }
                    l.json(uncertain)
                })
                .collect::<Vec<_>>();
            let mut fills = vec![];
            for ((i, r), parts) in pieces {
                let v = &self.events[i];
                let mut q = 0.;
                let mut val = Some(0.);
                let mut broker = Some(0.);
                let mut lots = vec![];
                let mut why = BTreeSet::new();
                for j in parts {
                    let p = &self.parts[j];
                    q += p.qty;
                    val = add(val, p.cash);
                    broker = add(broker, p.broker);
                    why.insert(p.lineage);
                    if let Some(o) = p.opening {
                        let entry = &self.events[o];
                        let official_lot = verified_lot_fifo(v, entry, p.qty);
                        lots.push(json!({"brokerRealizedPnl":official_lot,"openingExecutionId":entry["id"],"openingTransactionId":entry["transactionId"],"openedAt":entry["at"],
                            "openingPrice":entry["price"],"qty":p.qty,"openingCommission":admitted_amount(present_fee(entry),entry,p.qty),
                            "closingCommission":admitted_amount(present_fee(v),v,p.qty),"netRealizedPnl":if p.assigned{None}else{p.cash}}));
                    }
                }
                fills.push(json!({"id":v["id"],"at":v["at"],"conId":v["conId"],"side":v["side"],"eventType":v["eventType"],
                    "qty":q,"sourceQty":v["qty"],"sourceBrokerRealizedPnl":v["realizedPnl"],"price":v["price"],"currency":v["currency"],"commissionCurrency":v["commissionCurrency"],
                    "commission":admitted_amount(number(&v["commission"]),v,q),"role":r,"netRealizedPnl":val,"brokerRealizedPnl":broker,
                    "brokerageOrderId":v["brokerageOrderId"],"orderAt":v["orderAt"],"transactionId":v["transactionId"],
                    "allocationSource":why.into_iter().collect::<Vec<_>>().join(" / "),"lots":lots}));
            }
            let reason = if actual.is_some() {
                ""
            } else if missing_open {
                "Original opening executions or verified lot allocations are unavailable."
            } else if missing_fee {
                "An opening or closing commission is missing or denominated in a different currency."
            } else if unresolved {
                "The available broker record does not establish an opening or closing quantity."
            } else {
                "The exit price or option-leg settlement allocation is unavailable."
            };
            let method = if unresolved {
                "Opening or closing effect unconfirmed"
            } else if !has_closes {
                "No realized closing quantities"
            } else if assigned {
                "Matched option premiums after commissions. Assignments and exercises use IBKR’s option-leg allocation and exclude delivered shares."
            } else {
                "Matched option premiums after opening and closing commissions."
            };
            let first_role = self.parts[list[0]].role;
            let group_id = format!(
                "trade-{:x}",
                Sha256::digest(
                    format!("{}|{}|{}", self.scope, text(first, "id"), first_role).as_bytes()
                )
            );
            let match_status = if ambiguous || match_links.len() > 1 {
                "ambiguous"
            } else if match_links.len() == 1 && every_leg_matches {
                "matched"
            } else {
                "unmatched"
            };
            out.push(json!({"id":group_id,"label":group_label(symbol,&legs,self.groups[root].reason),"symbol":symbol,"currency":currency,"status":status,
                "openedAt":opening,"closedAt":if status=="closed"{last_exit}else{None},"lastAt":latest,"netRealizedPnl":actual,"brokerRealizedPnl":fifo,
                "groupSource":self.groups[root].reason,"pnlSource":method,"pnlReason":reason,"legs":legs,"fills":fills,
                "matches":match_links.into_values().collect::<Vec<_>>(),"matchStatus":match_status,
                "inventorySource":if uncertain{"Inventory is incomplete or ambiguous"}else if held.is_some(){ "Broker inventory available" }else{"Recorded broker executions"},
                "brokerPnlSource":"IBKR reported realized P&L (may include tax-lot adjustments)"}));
        }
        out
    }
}
pub(super) fn grouped(
    fills: &[(String, LedgerRow)],
    links: &HashMap<i32, Vec<Value>>,
    held: Option<&super::Inventory>,
) -> (Vec<Value>, Value) {
    let mut by_account = BTreeMap::<&str, Vec<Value>>::new();
    for (scope, fill) in fills {
        if let Ok(v) = serde_json::to_value(fill) {
            by_account.entry(scope).or_default().push(v);
        }
    }
    let mut all = vec![];
    let mut sums = BTreeMap::<String, Totals>::new();
    for (scope, events) in by_account {
        let mut engine = Engine::new(scope, events);
        let scope_token = super::manual::scope_token(scope);
        let mut output = engine.finish(links, held);
        for trade in &mut output {
            trade["selectionScope"] = json!(scope_token);
        }
        all.extend(output);
        for (ccy, t) in engine.totals {
            let sum = sums.entry(ccy).or_default();
            sum.closes += t.closes;
            sum.broker += t.broker;
            sum.broker_unknown += t.broker_unknown;
        }
    }
    for t in &all {
        let cc = text(t, "currency").to_owned();
        let sum = sums.entry(cc).or_default();
        for f in t["fills"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|f| f["role"] != "open")
        {
            if let Some(cash) = number(&f["netRealizedPnl"]) {
                sum.cash += cash
            } else {
                sum.unknown += 1;
            }
        }
    }
    all.sort_by(|a, b| {
        b["lastAt"]
            .as_i64()
            .cmp(&a["lastAt"].as_i64())
            .then_with(|| text(a, "id").cmp(text(b, "id")))
    });
    let amounts=sums.into_iter().map(|(currency,t)|json!({"currency":currency,"closingExecutions":t.closes,"netRealizedPnl":(t.unknown==0).then_some(t.cash),
        "knownNetRealizedPnl":t.cash,"unknownAllocations":t.unknown,"brokerRealizedPnl":(t.broker_unknown==0).then_some(t.broker),"knownBrokerRealizedPnl":t.broker})).collect::<Vec<_>>();
    let summary = json!({"count":all.len(),"byCurrency":amounts});
    (all, summary)
}
