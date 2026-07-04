//! Local automation API (Axum 0.7), bound to 127.0.0.1 only.
//!
//! The programmatic surface external tools drive (Playwright/Puppeteer via `connectOverCDP`,
//! Selenium via `debuggerAddress`). `start`/`stop`/`status` are delegated to the engine-runner
//! sidecar; `list` reads the local profile store. Envelope mirrors `@lobster/shared-types`
//! `ApiResponse` (`{ code, data, msg }`, `code == 0` = success) — the AdsPower/Octo contract.
//!
//! Auth: a Bearer API key (`LOBSTER_API_KEY`). When unset the loopback-only server allows local
//! dev. Per-key rate limiting is a follow-up.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::profile_store;
use crate::sidecar::SidecarClient;

const API_OK: i32 = 0;
const API_ERR: i32 = 1;

/// Shared state for the local API: the profile store, the sidecar client, the per-profile
/// user-data-dir root, and the optional Bearer key.
pub struct LocalApiState {
    pub db: Arc<Mutex<Connection>>,
    pub sidecar: Arc<SidecarClient>,
    pub profiles_dir: PathBuf,
    pub api_key: Option<String>,
}

#[derive(serde::Serialize)]
struct ApiResponse {
    code: i32,
    data: Value,
    msg: String,
}

impl ApiResponse {
    fn ok(data: Value) -> Json<Self> {
        Json(Self {
            code: API_OK,
            data,
            msg: "success".to_string(),
        })
    }

    fn err(msg: impl Into<String>) -> Json<Self> {
        Json(Self {
            code: API_ERR,
            data: Value::Null,
            msg: msg.into(),
        })
    }
}

/// True when the request carries the configured Bearer key (or no key is configured — dev).
fn authorized(state: &LocalApiState, headers: &HeaderMap) -> bool {
    match &state.api_key {
        None => true,
        Some(key) => headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .map(|token| token == key)
            .unwrap_or(false),
    }
}

/// Distinguishes a missing profile (→ HTTP 404) from a launch failure (→ 500), so refactoring the
/// launch path into a shared helper preserves the API's status-code contract.
#[derive(Debug)]
pub enum StartError {
    NotFound(String),
    Failed(anyhow::Error),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::NotFound(id) => write!(f, "profile {id} not found"),
            StartError::Failed(e) => write!(f, "{e}"),
        }
    }
}

/// Start a profile through the engine-runner sidecar. Shared by the local HTTP API and the desktop
/// `launch_profile` Tauri command so both entry points drive the SAME launch path (derive fingerprint
/// from the stored seed + overrides + proxy geo, then launch). Returns the sidecar's `startProfile`
/// result (`{ profileId, pid, ws, debuggerAddress }`); `NotFound` for an unknown profile.
pub async fn start_profile_via_sidecar(
    db: &Arc<Mutex<Connection>>,
    sidecar: &SidecarClient,
    profiles_dir: &Path,
    profile_id: &str,
    headless: bool,
) -> Result<Value, StartError> {
    let profile = {
        let conn = db
            .lock()
            .map_err(|_| StartError::Failed(anyhow::anyhow!("profile store lock poisoned")))?;
        profile_store::get(&conn, profile_id)
            .map_err(StartError::Failed)?
            .ok_or_else(|| StartError::NotFound(profile_id.to_string()))?
    };
    let user_data_dir = profiles_dir.join(&profile.id);
    let params = json!({
        "profileId": profile.id,
        "engine": profile.engine,
        "os": profile.os,
        "fingerprintSeed": profile.fingerprint_seed,
        "fingerprintOverrides": profile.fingerprint_overrides,
        "proxy": profile.proxy,
        "userDataDir": user_data_dir.to_string_lossy(),
        "headless": headless,
    });
    sidecar
        .call("startProfile", params)
        .await
        .map_err(StartError::Failed)
}

/// Stop a running profile through the sidecar. Shared by the HTTP API and the Tauri command.
pub async fn stop_profile_via_sidecar(
    sidecar: &SidecarClient,
    profile_id: &str,
) -> anyhow::Result<Value> {
    sidecar
        .call("stop", json!({ "profileId": profile_id }))
        .await
}

#[derive(Deserialize)]
struct ProfileIdBody {
    #[serde(rename = "profileId")]
    profile_id: String,
}

#[derive(Deserialize)]
struct StartProfileBody {
    #[serde(rename = "profileId")]
    profile_id: String,
    /// Optional; when omitted the engine launches headful (the desktop default). Honors the SDK/docs
    /// `headless` option instead of silently ignoring it.
    #[serde(default)]
    headless: Option<bool>,
}

#[derive(Deserialize)]
struct StatusQuery {
    #[serde(rename = "profileId")]
    profile_id: Option<String>,
}

pub async fn serve(port: u16, state: Arc<LocalApiState>) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/profile/start", post(profile_start))
        .route("/api/v1/profile/stop", post(profile_stop))
        .route("/api/v1/profile/list", get(profile_list))
        .route("/api/v1/profile/status", get(profile_status))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("local automation API listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> Json<ApiResponse> {
    ApiResponse::ok(json!({ "status": "ok" }))
}

/// Launch a profile: look it up, ask the sidecar to derive its fingerprint + launch, return the
/// CDP endpoints for `connectOverCDP` / Selenium `debuggerAddress`.
async fn profile_start(
    State(state): State<Arc<LocalApiState>>,
    headers: HeaderMap,
    Json(body): Json<StartProfileBody>,
) -> (StatusCode, Json<ApiResponse>) {
    if !authorized(&state, &headers) {
        return (StatusCode::UNAUTHORIZED, ApiResponse::err("unauthorized"));
    }

    match start_profile_via_sidecar(
        &state.db,
        &state.sidecar,
        &state.profiles_dir,
        &body.profile_id,
        body.headless.unwrap_or(false),
    )
    .await
    {
        Ok(result) => (StatusCode::OK, ApiResponse::ok(result)),
        // Preserve the status-code contract: unknown profile → 404, launch failure → 500.
        Err(StartError::NotFound(id)) => (
            StatusCode::NOT_FOUND,
            ApiResponse::err(format!("profile {id} not found")),
        ),
        Err(e @ StartError::Failed(_)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiResponse::err(e.to_string()),
        ),
    }
}

async fn profile_stop(
    State(state): State<Arc<LocalApiState>>,
    headers: HeaderMap,
    Json(body): Json<ProfileIdBody>,
) -> (StatusCode, Json<ApiResponse>) {
    if !authorized(&state, &headers) {
        return (StatusCode::UNAUTHORIZED, ApiResponse::err("unauthorized"));
    }
    match stop_profile_via_sidecar(&state.sidecar, &body.profile_id).await {
        Ok(_) => (
            StatusCode::OK,
            ApiResponse::ok(json!({ "profileId": body.profile_id, "stopped": true })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiResponse::err(e.to_string()),
        ),
    }
}

async fn profile_list(
    State(state): State<Arc<LocalApiState>>,
    headers: HeaderMap,
) -> (StatusCode, Json<ApiResponse>) {
    if !authorized(&state, &headers) {
        return (StatusCode::UNAUTHORIZED, ApiResponse::err("unauthorized"));
    }
    let conn = match state.db.lock() {
        Ok(conn) => conn,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiResponse::err("db lock"),
            )
        }
    };
    match profile_store::list(&conn) {
        Ok(profiles) => (
            StatusCode::OK,
            ApiResponse::ok(serde_json::to_value(profiles).unwrap_or(Value::Null)),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiResponse::err(e.to_string()),
        ),
    }
}

async fn profile_status(
    State(state): State<Arc<LocalApiState>>,
    headers: HeaderMap,
    Query(q): Query<StatusQuery>,
) -> (StatusCode, Json<ApiResponse>) {
    if !authorized(&state, &headers) {
        return (StatusCode::UNAUTHORIZED, ApiResponse::err("unauthorized"));
    }
    let params = match q.profile_id {
        Some(id) => json!({ "profileId": id }),
        None => json!({}),
    };
    match state.sidecar.call("status", params).await {
        Ok(result) => (StatusCode::OK, ApiResponse::ok(result)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiResponse::err(e.to_string()),
        ),
    }
}
