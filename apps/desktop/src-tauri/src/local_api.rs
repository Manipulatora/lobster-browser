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
use crate::proxy_check;
use crate::proxy_store;
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

/// Length-independent byte compare, so key verification doesn't leak the key via timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// DNS-rebinding defense: only accept requests whose `Host` is a loopback literal. A malicious web page
/// can rebind a hostname it controls to 127.0.0.1 and POST to the local API; CORS blocks reading the
/// response, but the side-effect (launching/stopping a profile) still fires. Requiring a loopback Host
/// (browsers send the *original* Host, not the rebound IP) closes that.
fn host_is_loopback(headers: &HeaderMap) -> bool {
    match headers.get("host").and_then(|v| v.to_str().ok()) {
        Some(h) => {
            let host = h.rsplit_once(':').map(|(a, _)| a).unwrap_or(h);
            host == "127.0.0.1" || host == "localhost" || host == "[::1]" || host == "::1"
        }
        None => false, // a legitimate local client always sends Host
    }
}

/// True when the request is a loopback caller carrying the configured Bearer key. **Fail-closed**: if no
/// key is configured, every request is denied (the desktop always provisions one at startup — see
/// `lib.rs`). This replaces the old default-allow, which let any local process — or, via DNS rebinding,
/// any website — drive authenticated sessions.
fn authorized(state: &LocalApiState, headers: &HeaderMap) -> bool {
    if !host_is_loopback(headers) {
        return false;
    }
    match &state.api_key {
        None => false,
        Some(key) => headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .map(|token| constant_time_eq(token.as_bytes(), key.as_bytes()))
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
    password: Option<&str>,
    headless: bool,
) -> Result<Value, StartError> {
    let profile = {
        let conn = db
            .lock()
            .map_err(|_| StartError::Failed(anyhow::anyhow!("profile store lock poisoned")))?;
        let profile = profile_store::get(&conn, profile_id)
            .map_err(StartError::Failed)?
            .ok_or_else(|| StartError::NotFound(profile_id.to_string()))?;
        if !profile_store::verify_password(&conn, profile_id, password)
            .map_err(StartError::Failed)?
        {
            return Err(StartError::Failed(anyhow::anyhow!(
                "profile password is required or incorrect"
            )));
        }
        profile
    };
    let user_data_dir = profiles_dir.join(&profile.id);
    let params = json!({
        "profileId": profile.id,
        "engine": profile.engine,
        "os": profile.os,
        "osVersion": profile.os_version,
        "fingerprintSeed": profile.fingerprint_seed,
        "fingerprintOverrides": profile.fingerprint_overrides,
        "proxy": profile.proxy,
        "cookiesImport": profile.cookies_import,
        "extensions": profile.extensions,
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
    #[serde(default)]
    password: Option<String>,
}

#[derive(Deserialize)]
struct StatusQuery {
    #[serde(rename = "profileId")]
    profile_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyTestBody {
    #[serde(default)]
    id: Option<String>,
    config: Value,
}

pub async fn serve(port: u16, state: Arc<LocalApiState>) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/profile/start", post(profile_start))
        .route("/api/v1/profile/stop", post(profile_stop))
        .route("/api/v1/profile/list", get(profile_list))
        .route("/api/v1/profile/status", get(profile_status))
        .route("/api/v1/proxy/test", post(proxy_test))
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
        body.password.as_deref(),
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

async fn proxy_test(
    State(state): State<Arc<LocalApiState>>,
    headers: HeaderMap,
    Json(body): Json<ProxyTestBody>,
) -> (StatusCode, Json<ApiResponse>) {
    if !authorized(&state, &headers) {
        return (StatusCode::UNAUTHORIZED, ApiResponse::err("unauthorized"));
    }

    let result = proxy_check::run_proxy_check(body.config).await;
    if let Some(id) = body.id.as_deref() {
        let location = result.geo.as_ref().map(|geo| {
            [
                geo.country_code.as_str(),
                geo.region.as_deref().unwrap_or_default(),
                geo.city.as_deref().unwrap_or_default(),
            ]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
        });
        let timezone = result.geo.as_ref().map(|geo| geo.timezone.clone());
        let conn = match state.db.lock() {
            Ok(conn) => conn,
            Err(_) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ApiResponse::err("db lock"),
                )
            }
        };
        if let Err(err) = proxy_store::update_test_result(
            &conn,
            id,
            result.ok,
            result.latency_ms,
            location,
            timezone,
            result.error.clone(),
        ) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiResponse::err(err.to_string()),
            );
        }
    }

    (
        StatusCode::OK,
        ApiResponse::ok(serde_json::to_value(result).unwrap_or(Value::Null)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_input(name: &str) -> profile_store::CreateProfileInput {
        profile_store::CreateProfileInput {
            name: name.to_string(),
            engine: "chromium".to_string(),
            os: "windows".to_string(),
            os_version: Some("Windows 11 23H2".to_string()),
            fingerprint_seed: None,
            fingerprint_overrides: None,
            proxy: None,
            proxy_id: None,
            template_id: None,
            cookies_import: None,
            extensions: None,
            tags: Some(vec!["e2e".to_string()]),
            folder: None,
            notes: None,
        }
    }

    fn mem_db() -> Arc<Mutex<Connection>> {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(profile_store::SCHEMA).unwrap();
        Arc::new(Mutex::new(conn))
    }

    fn sidecar_path() -> String {
        std::env::var("LOBSTER_SIDECAR").unwrap_or_else(|_| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../packages/engine-runner/dist/index.js")
                .to_string_lossy()
                .into_owned()
        })
    }

    #[tokio::test]
    async fn start_profile_missing_profile_returns_not_found() {
        let db = mem_db();
        let sidecar = SidecarClient::spawn("true", "")
            .await
            .expect("spawn fake sidecar");
        let profiles_dir = std::env::temp_dir();
        let err = start_profile_via_sidecar(
            &db,
            &sidecar,
            &profiles_dir,
            "missing",
            Some("secret"),
            true,
        )
        .await
        .expect_err("missing profile should fail");
        assert!(matches!(err, StartError::NotFound(id) if id == "missing"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn product_launch_connect_stop_e2e_when_enabled() {
        if std::env::var("LOBSTER_PRODUCT_E2E").as_deref() != Ok("1") {
            return;
        }

        // The sidecar inherits env at spawn. Headless CI/container runs need the Chromium sandbox off.
        std::env::set_var("LOBSTER_NO_SANDBOX", "1");

        let root = std::env::temp_dir().join(format!(
            "lobster-product-e2e-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let profiles_dir = root.join("profiles");
        std::fs::create_dir_all(&profiles_dir).unwrap();

        let conn = profile_store::init(root.join("profiles.sqlite")).unwrap();
        let mut input = test_input("Product E2E");
        input.engine = "lobium".to_string();
        let profile = profile_store::create(&conn, input).unwrap();
        let db = Arc::new(Mutex::new(conn));
        let sidecar = SidecarClient::spawn("node", &sidecar_path())
            .await
            .expect("spawn real sidecar");

        let launched =
            start_profile_via_sidecar(&db, &sidecar, &profiles_dir, &profile.id, None, true)
                .await
                .expect("launch profile through sidecar");
        let cfg_path = profiles_dir.join(&profile.id).join("lobium-fp.json");
        let cfg_raw = std::fs::read_to_string(&cfg_path).expect("native Lobium config should exist");
        let cfg: Value = serde_json::from_str(&cfg_raw).expect("native Lobium config should be JSON");
        assert_eq!(cfg.get("version").and_then(Value::as_i64), Some(1));
        assert_eq!(
            cfg.pointer("/net/webrtcPolicy").and_then(Value::as_str),
            Some("default_public_interface_only")
        );
        assert!(
            cfg.pointer("/navigator/userAgent")
                .and_then(Value::as_str)
                .is_some_and(|ua| ua.contains("Chrome/")),
            "native config should carry the UA"
        );
        assert!(
            cfg.pointer("/seeds/canvas").and_then(Value::as_u64).is_some(),
            "native config should carry per-profile farbling seeds"
        );
        let debugger_address = launched
            .get("debuggerAddress")
            .and_then(Value::as_str)
            .expect("debuggerAddress");
        let version_url = format!("http://{debugger_address}/json/version");
        let version = reqwest::get(version_url)
            .await
            .expect("fetch CDP version")
            .json::<Value>()
            .await
            .expect("parse CDP version");
        assert!(
            version.get("Browser").and_then(Value::as_str).is_some()
                || version
                    .get("webSocketDebuggerUrl")
                    .and_then(Value::as_str)
                    .is_some(),
            "CDP /json/version should expose a browser identity or websocket URL"
        );

        stop_profile_via_sidecar(&sidecar, &profile.id)
            .await
            .expect("stop profile");
        std::fs::remove_dir_all(root).unwrap();
    }
}
