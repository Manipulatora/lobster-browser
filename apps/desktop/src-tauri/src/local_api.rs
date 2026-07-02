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
use std::path::PathBuf;
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

#[derive(Deserialize)]
struct ProfileIdBody {
    #[serde(rename = "profileId")]
    profile_id: String,
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
    Json(body): Json<ProfileIdBody>,
) -> (StatusCode, Json<ApiResponse>) {
    if !authorized(&state, &headers) {
        return (StatusCode::UNAUTHORIZED, ApiResponse::err("unauthorized"));
    }

    let profile = {
        let conn = match state.db.lock() {
            Ok(conn) => conn,
            Err(_) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ApiResponse::err("db lock"),
                )
            }
        };
        match profile_store::get(&conn, &body.profile_id) {
            Ok(Some(profile)) => profile,
            Ok(None) => {
                return (
                    StatusCode::NOT_FOUND,
                    ApiResponse::err(format!("profile {} not found", body.profile_id)),
                )
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ApiResponse::err(e.to_string()),
                )
            }
        }
    };

    let user_data_dir = state.profiles_dir.join(&profile.id);
    let params = json!({
        "profileId": profile.id,
        "engine": profile.engine,
        "os": profile.os,
        "fingerprintSeed": profile.fingerprint_seed,
        "fingerprintOverrides": profile.fingerprint_overrides,
        "proxy": profile.proxy,
        "userDataDir": user_data_dir.to_string_lossy(),
        "headless": false,
    });

    match state.sidecar.call("startProfile", params).await {
        Ok(result) => (StatusCode::OK, ApiResponse::ok(result)),
        Err(e) => (
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
    match state
        .sidecar
        .call("stop", json!({ "profileId": body.profile_id }))
        .await
    {
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
