// The verification script appends this adapter only to a private build copy of
// snapshots.rs. It supplies the clock, broker listings and observed prices to
// the actual saved-trade valuation entry point; no test HTTP route is exposed.
pub(super) fn session_report(input: impl std::io::Read) -> anyhow::Result<()> {
    let envelopes = session_values(input)?;
    serde_json::to_writer(std::io::stdout().lock(), &envelopes)?;
    Ok(())
}

pub(super) fn session_values(input: impl std::io::Read) -> anyhow::Result<serde_json::Value> {
    use crate::sources::SessionClose;
    let cases: serde_json::Value = serde_json::from_reader(input)?;
    let mut envelopes = serde_json::Map::new();
    for (name, case) in cases
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Missing scenarios"))?
    {
        let now = case["now"].as_i64().unwrap();
        let saved = case["trades"].as_array().unwrap();
        let observations = case["history"].as_array().unwrap();
        let mut book = Book::default();
        for raw in case["items"].as_array().unwrap() {
            book.items.insert(
                raw["conId"].as_i64().unwrap() as i32,
                Item {
                    listing: raw["listing"].clone(),
                    quote: raw["quote"].clone(),
                    checked: now,
                    ..Default::default()
                },
            );
        }
        let mut history = completed::History::default();
        let mut wanted = BTreeSet::new();
        for trade in saved {
            valuation(trade, &book, now, &history, &mut wanted);
        }
        let mut requested = vec![];
        for key in wanted {
            let side = format!("{:?}", key.side).to_uppercase();
            let observe = |finish: i64| {
                let raw = observations.iter().find(|raw| {
                    raw["conId"].as_i64() == Some(i64::from(key.id))
                        && raw["side"].as_str() == Some(side.as_str())
                        && raw["end"].as_i64() == Some(finish)
                })?;
                Some(SessionClose {
                    price: raw["price"].as_f64()?,
                    at: raw["at"].as_i64()?,
                    source: format!("TWS historical {side} · replay"),
                    method: key.side,
                })
            };
            let current = key
                .need_current
                .then(|| observe(key.period.current.end))
                .flatten();
            let prior = key
                .need_prior
                .then(|| observe(key.period.prior.end))
                .flatten();
            requested.push(json!({"conId":key.id, "side":side, "end":key.period.current.end,
                "priorEnd":key.period.prior.end, "requestedCurrent":key.need_current, "requestedPrior":key.need_prior,
                "observedCurrent":current.is_some(), "observedPrior":prior.is_some()}));
            let error = ((key.need_current && current.is_none())
                || (key.need_prior && prior.is_none()))
            .then(|| "No broker observation for the requested session".to_owned());
            history.insert(
                key.clone(),
                completed::Prices {
                    current,
                    prior,
                    method: key.side,
                    error,
                    updated: Instant::now(),
                },
            );
        }
        let mut pending = BTreeSet::new();
        let rows: Map<String, Value> = saved
            .iter()
            .map(|s| {
                (
                    s["id"].as_str().unwrap().to_owned(),
                    valuation(s, &book, now, &history, &mut pending),
                )
            })
            .collect();
        envelopes.insert(
            name.clone(),
            json!({"asOf":now,"connected":true,"mode":1,"rows":rows,"requested":requested}),
        );
    }
    Ok(Value::Object(envelopes))
}
