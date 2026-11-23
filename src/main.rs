mod catalog;
mod flex_upload;
mod library;
mod market;
mod options_history;
mod position;
mod session_calendar;
mod snapshots;
mod sources;

use anyhow::{Context, Result, anyhow, ensure};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path as UrlPath, Query, Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use catalog::Catalog;
use library::Library;
use market::Market;
use serde_json::{Value, json};
use sources::Sources;
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{net::TcpListener, time::sleep};

struct App {
    market: Market,
    catalog: Catalog,
    snapshots: snapshots::Snapshots,
    sources: Sources,
    library: Library,
    options_history: options_history::OptionsHistory,
    root: PathBuf,
    authority: String,
}
type Shared = Arc<App>;
type ArgsMap = HashMap<String, String>;
struct ApiError(String);
impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        Self(e.to_string())
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (StatusCode::BAD_REQUEST, Json(json!({"error":self.0}))).into_response()
    }
}
fn arg<'a>(q: &'a ArgsMap, key: &str) -> Result<&'a str> {
    q.get(key)
        .map(String::as_str)
        .ok_or_else(|| anyhow!("Missing {key}."))
}
fn id(q: &ArgsMap) -> Result<i32> {
    Ok(arg(q, "id")?.parse()?)
}

async fn read(
    State(s): State<Shared>,
    UrlPath(name): UrlPath<String>,
    Query(q): Query<ArgsMap>,
) -> Result<Json<Value>, ApiError> {
    let value = match name.as_str() {
        "options-history" => s.options_history.response(&s.market, &s.library).await?,
        "status" => s.market.status().await,
        "search" => s.catalog.search(&s.market, arg(&q, "q")?).await?,
        "instrument" => s.catalog.instrument(&s.market, arg(&q, "symbol")?).await?,
        "book" => {
            s.catalog
                .book(
                    &s.market,
                    arg(&q, "symbol")?,
                    arg(&q, "root")?,
                    arg(&q, "expiry")?,
                )
                .await?
        }
        "activity" => s.market.activity().await,
        "scanner" => s.sources.scanner(&s.market, arg(&q, "code")?).await?,
        "news" => s.sources.news(&s.market, id(&q)?).await?,
        "article" => {
            s.sources
                .article(&s.market, arg(&q, "provider")?, arg(&q, "id")?)
                .await?
        }
        "tape" => s.sources.tape(&s.market, id(&q)?).await?,
        "bars" => json!(
            s.sources
                .bars(&s.market, id(&q)?, arg(&q, "window")?)
                .await?
        ),
        "events" => s.sources.events(&s.market, id(&q)?).await?,
        "library" => json!(s.library.list()?),
        "saved-snapshots" => {
            snapshots::response(
                &s,
                q.get("mode")
                    .map(|v| v.parse::<u8>())
                    .transpose()
                    .context("Choose market data mode 1–4.")?
                    .unwrap_or(1),
            )
            .await?
        }
        "marks" => s.library.marks(arg(&q, "id")?)?,
        _ => return Err(ApiError("Unknown endpoint.".to_string())),
    };
    Ok(Json(value))
}
async fn history(s: &App, data: &Value) -> Result<Value> {
    let legs = data["legs"]
        .as_array()
        .ok_or_else(|| anyhow!("Select strategy legs."))?;
    ensure!(
        (1..=16).contains(&legs.len()),
        "Choose one to sixteen legs."
    );
    let window = data["window"].as_str().unwrap_or("5D");
    let commission = position::commission_rate(data)?;
    let mut positions = vec![];
    let mut archived = vec![];
    let mut ids = vec![];
    for l in legs {
        if l["excluded"] == true {
            continue;
        }
        let position = position::Position::read(l, commission)?;
        if position.is_unqualified_archive(l, chrono::Utc::now()) {
            archived.push(position);
        } else {
            let id = i32::try_from(
                l["conId"]
                    .as_i64()
                    .context("Load each open contract first.")?,
            )?;
            ensure!(id > 0, "Load each open contract first.");
            ids.push(id);
            positions.push(position);
        }
    }
    let uncertain = archived
        .iter()
        .chain(&positions)
        .any(position::Position::has_uncertain_close_time);
    let message = match (archived.is_empty(), uncertain) {
        (false, true) => {
            "Archived option prices are unavailable. Historical P&L is available only where all closing cash flows are known. A confirmed-by date is the latest known bound on a close."
        }
        (false, false) => {
            "The expired archived option has no TWS contract ID. Historical P&L is available only after it closed, when other legs supply pricing dates."
        }
        (true, true) => {
            "Historical P&L before a close with an unknown execution date is unavailable. The confirmed-by date is its latest known bound."
        }
        (true, false) => "",
    };
    let usable_from = archived
        .iter()
        .filter_map(|p| p.last_confirmed_cashflow(chrono::Utc::now().timestamp_millis()))
        .max();
    let all_archived_or_closed =
        usable_from.is_some_and(|at| positions.iter().all(|p| p.pnl(at, None).is_some()));
    if ids.is_empty() || all_archived_or_closed {
        return Ok(json!({"points":[],"coverage":[],"contracts":[],"message":message}));
    }
    let series = futures_util::future::try_join_all(
        ids.iter().map(|i| s.sources.bars(&s.market, *i, window)),
    )
    .await
    .map_err(|error| {
        if message.is_empty() {
            error
        } else {
            anyhow!("{message} TWS historical bars unavailable. {error}")
        }
    })?;
    let coverage = series.iter().map(Vec::len).collect::<Vec<_>>();
    let bars = series
        .into_iter()
        .map(|pts| {
            pts.into_iter()
                .map(|b| (b.time, b.close))
                .collect::<BTreeMap<i64, f64>>()
        })
        .collect::<Vec<_>>();
    let timestamps = bars
        .iter()
        .flat_map(|bars| bars.keys().copied())
        .collect::<std::collections::BTreeSet<_>>();
    let pts = timestamps
        .into_iter()
        .filter_map(|t| {
            let pnl = bars
                .iter()
                .zip(&positions)
                .map(|(bars, p)| p.pnl(t, bars.get(&t).copied()).map(|v| v.0))
                .sum::<Option<f64>>()?;
            let pnl = pnl
                + archived
                    .iter()
                    .map(|p| p.pnl(t, None).map(|v| v.0))
                    .sum::<Option<f64>>()?;
            Some(json!([t, (pnl * 1000.0).round() / 1000.0]))
        })
        .collect::<Vec<_>>();
    Ok(json!({"points":pts,"coverage":coverage,"contracts":ids,"message":message}))
}
async fn write(
    State(s): State<Shared>,
    UrlPath(name): UrlPath<String>,
    Json(data): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let value = match name.as_str() {
        "quotes" => {
            let raw = data["ids"]
                .as_array()
                .context("Supply a list of qualified contract IDs.")?;
            if raw.len() > 54 {
                return Err(ApiError("Select a smaller strike window.".into()));
            }
            let mut ids = vec![];
            for v in raw {
                let i = v
                    .as_i64()
                    .and_then(|n| i32::try_from(n).ok())
                    .context("Invalid contract ID.")?;
                if !ids.contains(&i) {
                    ids.push(i)
                }
            }
            let mode = data["mode"].as_u64().unwrap_or(1);
            if !(1..=4).contains(&mode) {
                return Err(ApiError("Choose a valid IBKR data mode.".into()));
            }
            s.market.quotes(&ids, mode as u8).await?
        }
        "history" => history(&s, &data).await?,
        "manual-spread" => s.options_history.manual_spread(&s.market, &data).await?,
        "save" => s.library.save(&data)?,
        "import" => s.library.import(&data)?,
        "account-scope" => {
            json!({"accountScope":s.options_history.scope(data["accountId"].as_str().context("Supply an IBKR account identifier.")?)?})
        }
        "account-session-evidence" => s.library.import_account_sessions(data)?,
        "delete" => s.library.delete(&data)?,
        _ => return Err(ApiError("Unknown endpoint.".into())),
    };
    Ok(Json(value))
}
async fn import_executions(
    State(s): State<Shared>,
    Json(data): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(s.options_history.import(data)?))
}
async fn file(s: &App, name: &str) -> Response {
    let kind = match name {
        "index.html" => "text/html; charset=utf-8",
        "fonts/Inter-latin.woff2" | "fonts/Montserrat-latin.woff2" => "font/woff2",
        "style.css" | "options-history.css" => "text/css; charset=utf-8",
        "app.js"
        | "risk.js"
        | "strategies.js"
        | "optimizer.js"
        | "ticker.js"
        | "saved.js"
        | "saved-actions.js"
        | "options-history.js"
        | "history-grouping.js" => "text/javascript; charset=utf-8",
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    match tokio::fs::read(s.root.join("web").join(name)).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, kind)], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
async fn asset(State(s): State<Shared>, UrlPath(name): UrlPath<String>) -> Response {
    file(&s, &name).await
}
async fn font(State(s): State<Shared>, UrlPath(name): UrlPath<String>) -> Response {
    file(&s, &format!("fonts/{name}")).await
}
async fn index(State(s): State<Shared>) -> Response {
    file(&s, "index.html").await
}
async fn guard(State(s): State<Shared>, req: Request<Body>, next: Next) -> Response {
    if req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        != Some(&s.authority)
        || req
            .headers()
            .get(header::ORIGIN)
            .is_some_and(|h| h.to_str().ok() != Some(format!("http://{}", s.authority).as_str()))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = next.run(req).await;
    let h = response.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}
async fn maintenance(s: Shared) {
    loop {
        s.market.cleanup().await;
        if let Ok((saved, _, _)) = snapshots::scoped_saved(&s, 1).await
            && let Ok(book) = s.snapshots.book(&s, 1, &saved).await
        {
            let quotes = book.recording_quotes();
            for item in &saved {
                let doc = &item["document"];
                if let (Some(id), Some(version), Some(legs), Ok(rate)) = (
                    item["id"].as_str(),
                    item["version"].as_i64(),
                    doc["legs"].as_array(),
                    position::commission_rate(doc),
                ) {
                    let _ = s.library.record(id, version, legs, &quotes, rate);
                }
            }
        }
        sleep(Duration::from_secs(5)).await;
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let (mut port, mut tws_port) = (18762u16, None);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf();
    let mut folder = root.join(".data");
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => port = args.next().context("Missing web port")?.parse()?,
            "--tws-port" => tws_port = Some(args.next().context("Missing TWS port")?.parse()?),
            "--data-dir" => folder = PathBuf::from(args.next().context("Missing data directory")?),
            "--no-open" => {}
            _ => anyhow::bail!("Unknown argument: {arg}"),
        }
    }
    let authority = format!("127.0.0.1:{port}");
    let socket = TcpListener::bind(&authority).await?;
    let state = Arc::new(App {
        market: Market::new(tws_port),
        catalog: Catalog::default(),
        snapshots: snapshots::Snapshots::default(),
        sources: Sources::default(),
        library: Library::new(&folder)?,
        options_history: options_history::OptionsHistory::new(&folder)?,
        root,
        authority: authority.clone(),
    });
    let app = Router::new()
        .route("/", get(index))
        .route("/{asset}", get(asset))
        .route("/fonts/{name}", get(font))
        .route("/api/options-history/import", post(import_executions))
        .route("/api/{name}", get(read).merge(post(write)))
        .layer(DefaultBodyLimit::max(128 * 1024))
        .route(
            "/api/ibkr-flex",
            post(flex_upload::import).layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state.clone());
    tokio::spawn(maintenance(state.clone()));
    tokio::spawn(async move {
        // Archive the rolling TWS window while the app runs, including when
        // the History tab is closed. The same snapshot lock serves UI readers.
        sleep(Duration::from_secs(120)).await;
        loop {
            let report = state
                .options_history
                .response(&state.market, &state.library)
                .await;
            let ok = report.ok().is_some_and(|data| data["status"] == "ok");
            sleep(Duration::from_secs(if ok { 4 * 60 * 60 } else { 30 * 60 })).await;
        }
    });
    println!("Options Lab · Rust backend · http://{authority}/");
    axum::serve(socket, app).await?;
    Ok(())
}
