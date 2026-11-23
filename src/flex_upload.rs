mod reconcile;
mod statements;

use crate::{ApiError, Shared};
use anyhow::{Context, Result, ensure};
use axum::{Json, extract::State};
use chrono::NaiveDate;
use chrono_tz::Tz;
use serde::Deserialize;
use serde_json::{Value, json};
use statements::Parsed;
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FlexUpload {
    xml: Vec<String>,
    timezone: String,
    verify_saved: Option<NaiveDate>,
    #[serde(default)]
    confirm_unfiltered: bool,
}

pub(crate) async fn import(
    State(state): State<Shared>,
    Json(upload): Json<FlexUpload>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(run(&state, upload).await?))
}

async fn trusted_snapshots(state: &Shared) -> Result<Value> {
    let mut snapshots = crate::snapshots::response(state, 1).await?;
    for _ in 0..12 {
        if !snapshots["rows"].as_object().is_some_and(|rows| {
            rows.values()
                .any(|row| matches!(row["dayPeriod"]["mode"].as_str(), Some("unknown" | "mixed")))
        }) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        snapshots = crate::snapshots::response(state, 1).await?;
    }
    Ok(snapshots)
}

async fn verification(
    state: &Shared,
    parsed: &Parsed,
    requested: NaiveDate,
    zone: Tz,
) -> Result<reconcile::Evidence> {
    let daily = reconcile::daily(parsed, requested)?;
    let account = parsed
        .accounts
        .iter()
        .next()
        .context("Account is missing in Flex export.")?;
    let scope = state.options_history.scope(account)?;
    let library = state
        .library
        .list()
        .context("Saved library is unavailable.")?;
    let snapshots = trusted_snapshots(state)
        .await
        .context("Dated saved snapshots are unavailable.")?;
    Ok(reconcile::evaluate(
        &daily, &library, &snapshots, requested, zone, &scope,
    ))
}

async fn run(state: &Shared, upload: FlexUpload) -> Result<Value> {
    ensure!(
        (1..=32).contains(&upload.xml.len()),
        "Choose one to 32 Activity Flex XML files."
    );
    let zone = upload
        .timezone
        .parse::<Tz>()
        .ok()
        .context("Choose the timezone used in the Flex statement.")?;
    ensure!(
        upload.verify_saved.is_none() || upload.confirm_unfiltered,
        "Confirm the statements are complete and unfiltered before verifying returns."
    );
    let requested = upload.verify_saved;
    let mut parsed = tokio::task::spawn_blocking(move || {
        statements::parse(upload.xml, zone, requested.is_some())
    })
    .await
    .context("The local statement reader was interrupted.")??;
    let history = parsed.history.take();
    let shared = state.clone();
    tokio::task::spawn_blocking(move || shared.options_history.import(history))
        .await
        .context("The local history import was interrupted.")??;
    let mut verified = 0;
    let mut skipped = Vec::new();
    let mut warnings = Vec::new();
    if let Some(date) = requested {
        match verification(state, &parsed, date, zone).await {
            Ok(evidence) => {
                skipped = evidence.skipped;
                for (name, record) in evidence.records {
                    match state.library.import_account_sessions(json!({"records":[record]})){
                        Ok(_)=>verified+=1,
                        Err(_)=>skipped.push(json!({"name":name,"reason":"The saved version or an existing account attestation conflicts with this report."}))
                    }
                }
            }
            Err(e) => warnings.push(format!(
                "Saved-trade ownership verification unavailable. {e}"
            )),
        }
    }
    for skip in &mut skipped {
        for field in ["name", "reason"] {
            if let Some(text) = skip[field].as_str() {
                let mut redacted = text.to_owned();
                for account in &parsed.accounts {
                    redacted = redacted.replace(account, "[account]");
                }
                skip[field] = json!(redacted);
            }
        }
    }
    if parsed.omitted {
        warnings.push("Some non-exchange option entries lacked a recognized lifecycle code or a stable broker transaction ID. They were excluded from history and historical ownership verification.".into());
    }
    if parsed.executions == 0 {
        warnings.push("The supplied Trades sections contain zero option executions.".into());
    }
    Ok(
        json!({"ok":true,"dryRun":false,"statements":parsed.statements.len(),"accounts":parsed.accounts.len(),"executions":parsed.executions,"lifecycleEvents":parsed.lifecycle_events,"verifiedStrategies":verified,"skippedStrategies":skipped,"warnings":warnings}),
    )
}
