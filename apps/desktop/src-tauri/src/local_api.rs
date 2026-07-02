//! Local automation API (Axum 0.7), bound to 127.0.0.1 only.
//!
//! This is the programmatic surface external tools drive (Playwright/Puppeteer via
//! `connectOverCDP`, Selenium via `debuggerAddress`). The response envelope mirrors
//! `@lobster/shared-types` `ApiResponse` (`{ code, data, msg }`, `code == 0` = success)
//! and the AdsPower/Octo contract developers already integrate against.
//!
//! SECURITY (added Day 4): Bearer API-key auth (keys minted per team, see
//! shared-types `ApiKey`) + per-key rate limiting via a tower middleware layer. Until
//! then the server is loopback-only and every route is a stub.

use std::net::SocketAddr;

use axum::{
    extract::Query,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

/// Success code for the shared `{ code, data, msg }` envelope.
const API_OK: i32 = 0;
/// Generic error code (matches shared-types `API_ERR`).
const API_ERR: i32 = 1;

/// Wire envelope matching shared-types `ApiResponse`. `data` is kept as a
/// `serde_json::Value` so each route can return its own shape without a generic.
#[derive(serde::Serialize)]
struct ApiResponse {
    code: i32,
    data: Value,
    msg: String,
}

impl ApiResponse {
    /// A successful response with the default "success" message.
    fn ok(data: Value) -> Json<Self> {
        Json(Self {
            code: API_OK,
            data,
            msg: "success".to_string(),
        })
    }

    /// An error response (`code != 0`, `data: null`). Used for not-yet-implemented routes so SDK
    /// clients — which treat `code == 0` as success — never mistake a stub for a real result.
    fn err(msg: &str) -> Json<Self> {
        Json(Self {
            code: API_ERR,
            data: Value::Null,
            msg: msg.to_string(),
        })
    }
}

/// Body for `POST /api/v1/profile/start` and `/stop`.
#[derive(Deserialize)]
struct ProfileIdBody {
    #[serde(rename = "profileId")]
    profile_id: String,
}

/// Query params for `GET /api/v1/profile/status?profileId=...`.
#[derive(Deserialize)]
struct StatusQuery {
    #[serde(rename = "profileId")]
    profile_id: String,
}

/// Build the router. Split out from `serve` so it can be exercised in tests later.
fn router() -> Router {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/profile/start", post(profile_start))
        .route("/api/v1/profile/stop", post(profile_stop))
        .route("/api/v1/profile/list", get(profile_list))
        .route("/api/v1/profile/status", get(profile_status))
}

/// Bind the local API to 127.0.0.1:`port` and serve until the process exits.
pub async fn serve(port: u16) -> anyhow::Result<()> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("local automation API listening on http://{addr}");
    axum::serve(listener, router()).await?;
    Ok(())
}

/// Liveness probe.
async fn health() -> Json<ApiResponse> {
    ApiResponse::ok(json!({ "status": "ok" }))
}

/// Launch a profile and return both connection styles. Stubbed until Day 4, when the
/// engine-runner sidecar actually starts the browser and reports its CDP endpoint.
async fn profile_start(Json(body): Json<ProfileIdBody>) -> Json<ApiResponse> {
    // Not implemented until Day 4. Return an error envelope (not code 0) so SDK clients don't treat
    // an empty CDP endpoint as a successful launch.
    ApiResponse::err(&format!(
        "profile/start ({}) not implemented until Day 4",
        body.profile_id
    ))
}

/// Stop a running profile. Stubbed until Day 4.
async fn profile_stop(Json(body): Json<ProfileIdBody>) -> Json<ApiResponse> {
    ApiResponse::err(&format!(
        "profile/stop ({}) not implemented until Day 4",
        body.profile_id
    ))
}

/// List profiles known to the local store. Empty until the store is wired in (Day 4).
async fn profile_list() -> Json<ApiResponse> {
    ApiResponse::ok(json!([]))
}

/// Report whether a profile is currently running. Always `false` for now.
async fn profile_status(Query(q): Query<StatusQuery>) -> Json<ApiResponse> {
    // Shape matches shared-types `ProfileStatusResult`.
    ApiResponse::ok(json!({
        "profileId": q.profile_id,
        "running": false,
    }))
}
