use anyhow::{Context, Result, ensure};
use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use roxmltree::{Document, Node, ParsingOptions};
use rust_decimal::{Decimal, prelude::ToPrimitive};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

pub(super) const ACTIVITY: [&str; 5] = [
    "OptionEAE",
    "CorporateActions",
    "Transfers",
    "TradeTransfers",
    "TransactionTaxes",
];
pub(super) const ADJUSTMENTS: [&str; 5] = [
    "UnsettledTransfers",
    "Adjustments",
    "UnbookedTrades",
    "PendingExcercises",
    "PendingExercises",
];

pub(super) fn date(s: &str) -> Result<NaiveDate> {
    let format = match s.len() {
        8 => "%Y%m%d",
        10 => "%Y-%m-%d",
        _ => anyhow::bail!("Use yyyyMMdd or yyyy-MM-dd for Flex dates."),
    };
    NaiveDate::parse_from_str(s, format)
        .ok()
        .context("Invalid calendar date in the statement.")
}

fn stamp(s: NaiveDateTime, zone: Tz) -> Result<i64> {
    Ok(zone
        .from_local_datetime(&s)
        .single()
        .context("Ambiguous or missing local time at a daylight-saving transition.")?
        .timestamp_millis())
}

pub(super) fn midnight(day: NaiveDate, zone: Tz) -> Result<i64> {
    stamp(
        day.and_hms_opt(0, 0, 0)
            .context("Invalid statement date.")?,
        zone,
    )
}

pub(super) fn last_ms(day: NaiveDate, zone: Tz) -> Result<i64> {
    Ok(midnight(day.succ_opt().context("Invalid statement end date.")?, zone)? - 1)
}

pub(super) fn civil_date(at: i64, zone: Tz) -> Result<NaiveDate> {
    Ok(DateTime::<Utc>::from_timestamp_millis(at)
        .context("Invalid dated venue cutoff.")?
        .with_timezone(&zone)
        .date_naive())
}

pub(super) fn timestamp(s: &str, zone: Tz) -> Result<i64> {
    for format in [
        "%Y%m%d;%H%M%S%.f",
        "%Y%m%d;%H:%M:%S",
        "%Y%m%d %H:%M:%S",
        "%Y-%m-%d;%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
    ] {
        if let Ok(local) = NaiveDateTime::parse_from_str(s, format) {
            return stamp(local, zone);
        }
    }
    Ok(DateTime::parse_from_rfc3339(s)
        .ok()
        .context("Execution-level Date/Time is required in a supported Flex or ISO 8601 format.")?
        .timestamp_millis())
}

pub(super) fn decimal(s: &str, field: &str) -> Result<Decimal> {
    let value = if s.contains(['e', 'E']) {
        Decimal::from_scientific(s)
    } else {
        Decimal::from_str_exact(s)
    };
    value
        .ok()
        .with_context(|| format!("Invalid numeric Flex field {field}."))
}

pub(super) fn number(dec: Decimal) -> Result<f64> {
    dec.to_f64().context("Numeric Flex field is out of range.")
}

#[derive(Default)]
pub(super) struct Row {
    pub tag: String,
    fields: HashMap<String, String>,
}
impl Row {
    fn read(n: Node) -> Self {
        Self {
            tag: n.tag_name().name().to_owned(),
            fields: n
                .attributes()
                .map(|a| (a.name().to_owned(), a.value().to_owned()))
                .collect(),
        }
    }
    pub fn get(&self, k: &str) -> &str {
        self.fields.get(k).map(String::as_str).unwrap_or("")
    }
    pub fn required(&self, k: &str) -> Result<&str> {
        let v = self.get(k).trim();
        ensure!(
            !v.is_empty(),
            "Required Flex field {k} is missing. Re-export with the field enabled."
        );
        Ok(v)
    }
    pub fn id(&self) -> Result<i32> {
        let token = self.required("conid")?;
        ensure!(
            token.bytes().all(|c| c.is_ascii_digit()),
            "Invalid conid in Flex data."
        );
        token
            .parse::<i32>()
            .ok()
            .filter(|id| *id > 0)
            .context("Invalid conid in Flex data.")
    }
    pub fn has_note(&self, name: &str) -> bool {
        let notes = self.get("notes");
        let notes = if notes.is_empty() {
            self.get("code")
        } else {
            notes
        };
        notes
            .split([';', ',', ' '])
            .any(|n| n.eq_ignore_ascii_case(name))
    }
    pub fn exchange(&self) -> bool {
        matches!(
            self.get("transactionType").to_ascii_uppercase().as_str(),
            "TRADE" | "EXECUTION" | "EXCHTRADE"
        )
    }
    fn lifecycle_type(&self) -> Option<&'static str> {
        if !self
            .get("transactionType")
            .eq_ignore_ascii_case("BookTrade")
        {
            return None;
        }
        let mut matches = [
            ("Ep", "expiration"),
            ("A", "assignment"),
            ("Ex", "exercise"),
        ]
        .into_iter()
        .filter(|(note, _)| self.has_note(note));
        let (_, event) = matches.next()?;
        matches.next().is_none().then_some(event)
    }

    fn transaction_id(&self) -> Option<String> {
        const PREFIX: &str = "IBKR-FLEX-LIFECYCLE/";
        let id = self.get("transactionID").trim();
        let valid = !id.is_empty()
            && PREFIX.len() + id.len() <= 128
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
            && !matches!(id.to_ascii_uppercase().as_str(), "0" | "-" | "NONE" | "N/A");
        valid.then(|| format!("{PREFIX}{id}"))
    }

    pub fn canceled(&self) -> bool {
        let ty = self.get("transactionType").to_ascii_uppercase();
        ty.contains("BUST") || ty.contains("CANCEL") || self.has_note("CA")
    }
    pub fn allocated(&self) -> bool {
        !matches!(
            self.get("model").trim().to_ascii_lowercase().as_str(),
            "" | "independent" | "default"
        )
    }
    pub fn multiplier(&self, stock: bool) -> Result<Decimal> {
        decimal(
            if stock && self.get("multiplier").is_empty() {
                "1"
            } else {
                self.required("multiplier")?
            },
            "multiplier",
        )
    }
    pub fn exec_id(&self) -> &str {
        let id = self.get("ibExecID");
        if id.is_empty() {
            self.get("ibExecId").trim()
        } else {
            id.trim()
        }
    }
    pub fn signed_qty(&self) -> Result<Decimal> {
        let raw = decimal(self.required("quantity")?, "quantity")?;
        ensure!(!raw.is_zero(), "A trade quantity must be nonzero.");
        match self.required("buySell")?.to_ascii_uppercase().as_str() {
            "BUY" if raw > Decimal::ZERO => Ok(raw),
            "SELL" => Ok(-raw.abs()),
            _ => anyhow::bail!("Trade has a missing or conflicting execution side and quantity."),
        }
    }
    pub fn execution(&self, zone: Tz) -> Result<Value> {
        let id = self.exec_id();
        ensure!(
            !id.is_empty()
                && id.len() <= 128
                && id.bytes().all(|b| b.is_ascii_graphic())
                && !id.starts_with("IBKR-FLEX-LIFECYCLE/")
                && !matches!(id.to_ascii_uppercase().as_str(), "0" | "-" | "NONE" | "N/A"),
            "Execution-level IB Execution ID is missing or invalid."
        );
        self.event(zone, id, None)
    }

    fn trade_metadata(&self, ev: &mut Value, zone: Tz) -> Result<()> {
        let identifier = |field: &str| {
            let v = self.get(field).trim();
            (!v.is_empty()
                && v.len() <= 128
                && v.bytes().all(|b| b.is_ascii_graphic())
                && !matches!(
                    v.to_ascii_uppercase().as_str(),
                    "0" | "-" | "-1" | "NA" | "N/A" | "NONE"
                ))
            .then_some(v)
        };
        for (input, output) in [
            ("transactionID", "transactionId"),
            ("tradeID", "tradeId"),
            ("brokerageOrderID", "brokerageOrderId"),
            ("ibOrderID", "ibOrderId"),
        ] {
            if let Some(id) = identifier(input) {
                ev[output] = json!(id);
            }
        }
        if let Some(id) = self
            .get("underlyingConid")
            .parse::<i32>()
            .ok()
            .filter(|n| *n > 0)
        {
            ev["underlyingConId"] = json!(id);
        }
        if !self.get("orderTime").is_empty() {
            ev["orderAt"] = json!(timestamp(self.get("orderTime"), zone)?);
        }
        let indicator = self.get("openCloseIndicator").trim().to_ascii_uppercase();
        let kind = match indicator.as_str() {
            "O" | "OPEN" => Some("OPEN"),
            "C" | "CLOSE" => Some("CLOSE"),
            "O;C" | "C;O" | "O/C" | "C/O" | "OC" | "CO" => Some("MIXED"),
            _ => None,
        };
        if let Some(kind) = kind {
            ev["openClose"] = json!(kind);
        }
        for (field, key) in [
            ("cost", "costBasis"),
            ("netCash", "netCash"),
            ("proceeds", "proceeds"),
        ] {
            if !self.get(field).is_empty() {
                ev[key] = json!(number(decimal(self.get(field), field)?)?);
            }
        }
        if !self.get("fifoPnlRealized").is_empty() {
            ev["realizedPnl"] = json!(number(decimal(
                self.get("fifoPnlRealized"),
                "fifoPnlRealized"
            )?)?);
            ev["realizedCurrency"] = json!(self.required("currency")?);
            ev["realizedSource"] = json!("IBKR Flex FIFO");
        }
        Ok(())
    }
    fn event(&self, zone: Tz, id: &str, event_type: Option<&str>) -> Result<Value> {
        let qty = self.signed_qty()?;
        let sec = self.required("assetCategory")?.to_ascii_uppercase();
        let opt = matches!(sec.as_str(), "OPT" | "FOP");
        let at = if !self.get("dateTime").is_empty() {
            timestamp(self.get("dateTime"), zone)?
        } else {
            timestamp(
                &format!(
                    "{};{}",
                    self.required("tradeDate")?,
                    self.required("tradeTime")?
                ),
                zone,
            )?
        };
        let mult = self.multiplier(sec == "STK")?;
        let price = if event_type.is_some() && self.get("tradePrice").is_empty() {
            None
        } else {
            Some(decimal(self.required("tradePrice")?, "tradePrice")?)
        };
        ensure!(
            price.is_none_or(|v| v >= Decimal::ZERO) && mult > Decimal::ZERO,
            "Invalid contract price or multiplier."
        );
        let commission = (!self.get("ibCommission").is_empty())
            .then(|| decimal(self.get("ibCommission"), "ibCommission").and_then(|v| number(-v)))
            .transpose()?;
        let fee_ccy = self.get("ibCommissionCurrency");
        let symbol = self.required(if opt { "underlyingSymbol" } else { "symbol" })?;
        let local = self.get("localSymbol");
        let mut ev = json!({"id":id,"at":at,"conId":self.id()?,"secType":sec,"symbol":symbol,"localSymbol":if local.is_empty(){self.required("symbol")?}else{local},
            "currency":self.required("currency")?,"multiplier":number(mult)?,"qty":number(qty.abs())?,"side":if qty.is_sign_positive(){"BUY"}else{"SELL"},
            "price":price.map(number).transpose()?,"commission":commission,"commissionCurrency":(!fee_ccy.is_empty()).then_some(fee_ccy)});
        if let Some(value) = event_type {
            ev["eventType"] = json!(value);
        }
        if opt {
            self.trade_metadata(&mut ev, zone)?;
            ensure!(
                qty.fract().is_zero(),
                "An option execution must have a whole contract quantity."
            );
            let right = match self.required("putCall")?.to_ascii_uppercase().as_str() {
                "P" | "PUT" => "P",
                "C" | "CALL" => "C",
                _ => anyhow::bail!("Invalid option right."),
            };
            ev["expiry"] = json!(date(self.required("expiry")?)?.format("%Y%m%d").to_string());
            ev["right"] = json!(right);
            ev["strike"] = json!(number(decimal(self.required("strike")?, "strike")?)?);
        }
        Ok(ev)
    }
}

// Flex groups Lot detail directly behind the closing execution, sometimes
// interleaved with wash-sale rows. The lot's transactionID belongs to its
// opening trade. Never associate lots by price, symbol, or timestamp alone.
fn closing_lots(closing: Node, trade: &Row, zone: Tz, ev: &Value) -> Option<Vec<Value>> {
    if !matches!(ev["openClose"].as_str(), Some("CLOSE" | "MIXED")) {
        return None;
    }
    let mut result = vec![];
    let mut total = Decimal::ZERO;
    let mut next = closing.next_sibling_element();
    while let Some(node) = next {
        next = node.next_sibling_element();
        match node.tag_name().name() {
            "WashSale" => continue,
            "Lot" => {}
            _ => break,
        }
        let lot = Row::read(node);
        if lot.get("levelOfDetail") != "CLOSED_LOT"
            || ["accountId", "conid", "currency", "dateTime", "buySell"]
                .iter()
                .any(|k| lot.get(k) != trade.get(k))
        {
            return None;
        }
        let opening = lot.get("transactionID").trim();
        if opening.is_empty() || matches!(opening, "0" | "-" | "-1" | "N/A") {
            return None;
        }
        let qty = decimal(lot.get("quantity"), "closed lot quantity")
            .ok()?
            .abs();
        let opened = timestamp(lot.get("openDateTime"), zone).ok()?;
        if qty.is_zero() || !qty.fract().is_zero() || opened > ev["at"].as_i64()? {
            return None;
        }
        total += qty;
        let mut value =
            json!({"openingTransactionId":opening,"openedAt":opened,"qty":number(qty).ok()?});
        for (field, name) in [("fifoPnlRealized", "realizedPnl"), ("cost", "costBasis")] {
            if !lot.get(field).is_empty() {
                value[name] = json!(number(decimal(lot.get(field), field).ok()?).ok()?);
            }
        }
        result.push(value);
    }
    let filled = trade.signed_qty().ok()?.abs();
    let consistent = match ev["openClose"].as_str()? {
        "CLOSE" => total == filled,
        "MIXED" => total > Decimal::ZERO && total < filled,
        _ => false,
    };
    if result.is_empty() || !consistent {
        return None;
    }
    result.sort_by_cached_key(|v| {
        (
            v["openedAt"].as_i64(),
            v["openingTransactionId"].as_str().unwrap_or("").to_owned(),
            v.to_string(),
        )
    });
    Some(result)
}
pub(super) struct Statement {
    pub account: String,
    pub first: NaiveDate,
    pub last: NaiveDate,
    pub generated: String,
    pub sections: HashMap<String, Vec<Row>>,
    pub blocked: HashSet<i32>,
}
pub(super) struct Parsed {
    pub statements: Vec<Statement>,
    pub history: Value,
    pub executions: usize,
    pub lifecycle_events: usize,
    pub omitted: bool,
    pub accounts: HashSet<String>,
}
pub(super) fn parse(documents: Vec<String>, zone: Tz, verify: bool) -> Result<Parsed> {
    let mut statements = Vec::new();
    let mut batches = Vec::new();
    let mut seen: HashMap<(String, String), Value> = HashMap::new();
    let mut accounts = HashSet::new();
    let mut omitted = false;
    for xml in documents {
        ensure!(
            !xml.trim().is_empty(),
            "One of the selected XML files is empty."
        );
        ensure!(
            !xml.as_bytes().contains(&0)
                && !["<!DOCTYPE", "<!ENTITY"].iter().any(|p| xml
                    .as_bytes()
                    .windows(p.len())
                    .any(|s| s.eq_ignore_ascii_case(p.as_bytes()))),
            "Use UTF-8 Activity XML without DTD or entity declarations."
        );
        let doc = Document::parse_with_options(
            &xml,
            ParsingOptions {
                allow_dtd: false,
                nodes_limit: 2_000_000,
                ..Default::default()
            },
        )
        .ok()
        .context("A file is not well-formed Activity Flex XML.")?;
        let root = doc.root_element();
        ensure!(
            root.tag_name().name() == "FlexQueryResponse"
                && matches!(
                    root.attribute("type")
                        .unwrap_or("AF")
                        .to_ascii_uppercase()
                        .as_str(),
                    "AF" | "ACTIVITY" | "ACTIVITYFLEX"
                ),
            "Expected an IBKR Activity Flex XML response."
        );
        let group = root
            .children()
            .find(|n| n.tag_name().name() == "FlexStatements")
            .context("No Activity Flex statements found.")?;
        let count = group.children().filter(Node::is_element).count();
        ensure!(
            count > 0
                && !group
                    .attribute("count")
                    .is_some_and(|s| s != count.to_string()),
            "Flex statement count does not match the XML contents."
        );
        for node in group.children().filter(Node::is_element) {
            ensure!(
                node.tag_name().name() == "FlexStatement",
                "Unrecognized Activity Flex statement."
            );
            let attrs = Row::read(node);
            let account = attrs.required("accountId")?.to_owned();
            ensure!(
                !matches!(
                    account.to_ascii_lowercase().as_str(),
                    "all" | "consolidated" | "multiple"
                ),
                "Use separate, account-specific Flex statements."
            );
            let first = date(attrs.required("fromDate")?)?;
            let last = date(attrs.required("toDate")?)?;
            ensure!(first <= last, "Statement dates are reversed.");
            let mut st = Statement {
                account: account.clone(),
                first,
                last,
                generated: attrs.get("whenGenerated").to_owned(),
                sections: HashMap::new(),
                blocked: HashSet::new(),
            };
            let mut from = midnight(first, zone)?;
            let mut to = last_ms(last, zone)?;
            let mut new = Vec::new();
            for section in node.children().filter(Node::is_element) {
                let name = section.tag_name().name();
                let is_trades = name == "Trades";
                if !is_trades
                    && !(verify
                        && (name == "OpenPositions"
                            || ACTIVITY.contains(&name)
                            || ADJUSTMENTS.contains(&name)))
                {
                    continue;
                }
                ensure!(
                    !st.sections.contains_key(name),
                    "Duplicate section in Activity Flex statement."
                );
                let mut rows = Vec::new();
                let mut summaries = 0;
                let mut executions = 0;
                for child in section.children().filter(Node::is_element) {
                    let r = Row::read(child);
                    if is_trades {
                        if r.tag != "Trade" {
                            ensure!(
                                matches!(
                                    r.tag.as_str(),
                                    "Lot" | "WashSale" | "Order" | "SymbolSummary" | "AssetSummary"
                                ),
                                "Unrecognized row in the Flex Trades section."
                            );
                            summaries += 1;
                            continue;
                        }
                        let level = r.get("levelOfDetail").to_ascii_uppercase();
                        if matches!(
                            level.as_str(),
                            "ORDER"
                                | "SUMMARY"
                                | "SYMBOL_SUMMARY"
                                | "ASSET_CLASS"
                                | "CLOSED_LOT"
                                | "LOT"
                                | "WASH_SALE"
                        ) {
                            summaries += 1;
                            continue;
                        }
                        ensure!(
                            level == "EXECUTION",
                            "Include Level of Detail = EXECUTION for Flex trades."
                        );
                        ensure!(
                            r.get("accountId").is_empty() || r.get("accountId") == account,
                            "Mixed account identifiers in statement executions."
                        );
                        executions += 1;
                        if matches!(
                            r.required("assetCategory")?.to_ascii_uppercase().as_str(),
                            "OPT" | "FOP"
                        ) {
                            ensure!(
                                !r.canceled(),
                                "This option export contains canceled or busted executions. Supply a corrected final execution export."
                            );
                            let non_exchange =
                                !r.get("transactionType").is_empty() && !r.exchange();
                            let event = if non_exchange {
                                st.blocked.insert(r.id()?);
                                if let (Some(kind), Some(id)) =
                                    (r.lifecycle_type(), r.transaction_id())
                                {
                                    Some(r.event(zone, &id, Some(kind))?)
                                } else {
                                    omitted = true;
                                    None
                                }
                            } else {
                                Some(r.execution(zone)?)
                            };
                            if let Some(mut event) = event {
                                if let Some(lots) = closing_lots(child, &r, zone, &event) {
                                    event["closedLots"] = json!(lots);
                                }
                                let at = event["at"]
                                    .as_i64()
                                    .context("Invalid execution timestamp.")?;
                                from = from.min(at);
                                to = to.max(at);
                                let key = (
                                    account.clone(),
                                    event["id"]
                                        .as_str()
                                        .context("Missing broker event identity.")?
                                        .to_owned(),
                                );
                                if let Some(prev) = seen.get_mut(&key) {
                                    let mut merged = prev.clone();
                                    for (field, value) in event
                                        .as_object()
                                        .context("Invalid normalized broker row.")?
                                    {
                                        if value.is_null() {
                                            continue;
                                        }
                                        ensure!(
                                            merged[field].is_null() || &merged[field] == value,
                                            "Conflicting copies of an execution ID. Use consistent original reports."
                                        );
                                        merged[field] = value.clone();
                                    }
                                    if &merged != prev {
                                        *prev = merged.clone();
                                        new.push(merged);
                                    }
                                } else {
                                    seen.insert(key, event.clone());
                                    new.push(event);
                                }
                            }
                        }
                    }
                    if verify {
                        rows.push(r);
                    }
                }
                ensure!(
                    !is_trades || executions > 0 || summaries == 0,
                    "The Trades section contains totals or lots without execution-level rows."
                );
                st.sections.insert(name.to_owned(), rows);
            }
            ensure!(
                st.sections.contains_key("Trades"),
                "Include the Trades section at Executions level in the Flex XML."
            );
            accounts.insert(account.clone());
            batches.push(json!({"accountId":account,"from":from,"to":to,"executions":new}));
            statements.push(st);
        }
    }
    Ok(Parsed {
        statements,
        history: json!({"source":"IBKR Flex","accounts":batches}),
        executions: seen.values().filter(|v| v["eventType"].is_null()).count(),
        lifecycle_events: seen.values().filter(|v| !v["eventType"].is_null()).count(),
        omitted,
        accounts,
    })
}
