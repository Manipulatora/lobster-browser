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

use crate::agent_secrets;
use crate::profile_store;
use crate::proxy_check;
use crate::proxy_store;
use crate::secrets::{SecretCipher, PROXY_SECRET_FIELDS};
use crate::sidecar::SidecarClient;

const API_OK: i32 = 0;
const API_ERR: i32 = 1;

/// Shared state for the local API: the profile store, the sidecar client, the per-profile
/// user-data-dir root, and the optional Bearer key.
pub struct LocalApiState {
    pub db: Arc<Mutex<Connection>>,
    /// SEC-12: decrypts at-rest secrets (proxy creds, cookie imports) at the store boundary.
    pub cipher: Arc<SecretCipher>,
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

struct LaunchOsTarget {
    os: &'static str,
    arch: Option<&'static str>,
}

fn normalize_desktop_launch_os(os: &str) -> Result<LaunchOsTarget, StartError> {
    match os {
        "windows" => Ok(LaunchOsTarget {
            os: "windows",
            arch: None,
        }),
        "macos" => Ok(LaunchOsTarget {
            os: "macos",
            arch: None,
        }),
        "macos_intel" => Ok(LaunchOsTarget {
            os: "macos",
            arch: Some("x86_64"),
        }),
        "macos_arm" => Ok(LaunchOsTarget {
            os: "macos",
            arch: Some("arm64"),
        }),
        "linux" => Ok(LaunchOsTarget {
            os: "linux",
            arch: None,
        }),
        "android" => Ok(LaunchOsTarget {
            os: "android",
            arch: Some("arm64"),
        }),
        other => Err(StartError::Failed(anyhow::anyhow!(
            "unsupported profile OS target \"{other}\""
        ))),
    }
}

/// Start a profile through the engine-runner sidecar. Shared by the local HTTP API and the desktop
/// `launch_profile` Tauri command so both entry points drive the SAME launch path (derive fingerprint
/// from the stored seed + overrides + proxy geo, then launch). Returns the sidecar's `startProfile`
/// result (`{ profileId, pid, ws, debuggerAddress }`); `NotFound` for an unknown profile.
pub async fn start_profile_via_sidecar(
    db: &Arc<Mutex<Connection>>,
    cipher: &SecretCipher,
    sidecar: &SidecarClient,
    profiles_dir: &Path,
    profile_id: &str,
    password: Option<&str>,
    headless: bool,
) -> Result<Value, StartError> {
    let (profile, resolved_proxy, agent_memory_key) = {
        let conn = db
            .lock()
            .map_err(|_| StartError::Failed(anyhow::anyhow!("profile store lock poisoned")))?;
        let profile = profile_store::get(&conn, cipher, profile_id)
            .map_err(StartError::Failed)?
            .ok_or_else(|| StartError::NotFound(profile_id.to_string()))?;
        if !profile_store::verify_password(&conn, profile_id, password)
            .map_err(StartError::Failed)?
        {
            return Err(StartError::Failed(anyhow::anyhow!(
                "profile password is required or incorrect"
            )));
        }
        let resolved_proxy = match profile.proxy_id.as_deref() {
            Some(proxy_id) => Some(
                proxy_store::get(&conn, cipher, proxy_id)
                    .map_err(StartError::Failed)?
                    .ok_or_else(|| {
                        StartError::Failed(anyhow::anyhow!(
                            "profile {} references missing proxy {}",
                            profile.id,
                            proxy_id
                        ))
                    })?
                    .config,
            ),
            None => profile.proxy.clone(),
        };
        // Per-profile encrypted-memory key, so the in-browser Lobee panel can run tasks over the
        // loopback bridge. Best-effort: on failure the desktop agent path still works.
        let agent_memory_key = agent_secrets::memory_key(&conn, cipher, profile_id).ok();
        (profile, resolved_proxy, agent_memory_key)
    };
    if profile.engine != "lobium" {
        return Err(StartError::Failed(anyhow::anyhow!(
            "Lobium is the only supported engine; profile {} is configured for {}",
            profile.id,
            profile.engine
        )));
    }
    let launch_target = normalize_desktop_launch_os(&profile.os)?;
    {
        let conn = db
            .lock()
            .map_err(|_| StartError::Failed(anyhow::anyhow!("profile store lock poisoned")))?;
        profile_store::set_status(&conn, profile_id, "launching").map_err(StartError::Failed)?;
    }
    let user_data_dir = profiles_dir.join(&profile.id);
    // Only a PENDING import is handed to the sidecar. The payload is kept after it is applied (it is
    // the profile's only durable session record), so the applied-at stamp — not a NULL cell — is
    // what stops a second launch re-injecting a stale jar.
    let pending_cookie_import = if profile.cookies_import_applied_at.is_some() {
        None
    } else {
        profile.cookies_import.clone()
    };
    let params = json!({
        "profileId": profile.id,
        "profileName": profile.name,
        "engine": profile.engine,
        "os": launch_target.os,
        "arch": launch_target.arch,
        "osVersion": profile.os_version,
        "fingerprintSeed": profile.fingerprint_seed,
        "fingerprintOverrides": profile.fingerprint_overrides,
        "proxy": resolved_proxy,
        "cookiesImport": pending_cookie_import,
        "extensions": profile.extensions,
        "userDataDir": user_data_dir.to_string_lossy(),
        "headless": headless,
        "agentMemoryKey": agent_memory_key,
    });
    let launched = sidecar.call("startProfile", params).await;
    match launched {
        Ok(result) => {
            let conn = db
                .lock()
                .map_err(|_| StartError::Failed(anyhow::anyhow!("profile store lock poisoned")))?;
            if result
                .get("cookieImportApplied")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                profile_store::mark_cookie_import_applied(&conn, profile_id)
                    .map_err(StartError::Failed)?;
            }
            profile_store::set_status(&conn, profile_id, "running").map_err(StartError::Failed)?;
            Ok(result)
        }
        Err(error) => {
            if let Ok(conn) = db.lock() {
                let _ = profile_store::set_status(&conn, profile_id, "error");
            }
            Err(StartError::Failed(error))
        }
    }
}

/// Stop a running profile through the sidecar. Shared by the HTTP API and the Tauri command.
pub async fn stop_profile_via_sidecar(
    db: &Arc<Mutex<Connection>>,
    sidecar: &SidecarClient,
    profile_id: &str,
) -> anyhow::Result<Value> {
    {
        let conn = db
            .lock()
            .map_err(|_| anyhow::anyhow!("profile store lock poisoned"))?;
        profile_store::set_status(&conn, profile_id, "stopping")?;
    }
    let stopped = sidecar
        .call("stop", json!({ "profileId": profile_id }))
        .await;
    let conn = db
        .lock()
        .map_err(|_| anyhow::anyhow!("profile store lock poisoned"))?;
    match stopped {
        Ok(result) => {
            profile_store::set_status(&conn, profile_id, "idle")?;
            Ok(result)
        }
        Err(error) => {
            profile_store::set_status(&conn, profile_id, "error")?;
            Err(error)
        }
    }
}

pub async fn reconcile_profile_statuses(
    db: &Arc<Mutex<Connection>>,
    sidecar: &SidecarClient,
) -> anyhow::Result<()> {
    let status = sidecar.call("status", json!({})).await?;
    let running_ids = status
        .get("running")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("profileId").and_then(Value::as_str))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let error_ids = status
        .get("errors")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("profileId").and_then(Value::as_str))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let conn = db
        .lock()
        .map_err(|_| anyhow::anyhow!("profile store lock poisoned"))?;
    profile_store::reconcile_statuses(&conn, &running_ids, &error_ids)
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
        &state.cipher,
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
    match stop_profile_via_sidecar(&state.db, &state.sidecar, &body.profile_id).await {
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

/// Cookie-import fields that are diagnostics rather than session material, and so may leave the
/// machine. Allowlist, mirroring the backend's `sanitizeCookieImportMetadata`
/// (apps/backend/src/profiles/sanitize-cookie-import.ts): `rawText` IS the cookie jar, and an
/// unrecognised future field is dropped rather than leaked.
const SAFE_COOKIE_IMPORT_FIELDS: &[&str] = &["mode", "source", "fileName", "parsedCount", "errors"];

/// Strip live secrets from a profile before it goes out over the loopback API.
///
/// The holder of the API key is not the holder of the profiles: every automation script, every
/// third-party tool the key is pasted into, and any same-user malware that reads the 0600 key file
/// gets whatever this returns. Session cookies and proxy credentials are not automation inputs —
/// the sidecar reads them from the store directly — so they never appear here, which also stops the
/// loopback API from undoing the backend's deliberate `rawText` stripping.
fn redact_profile_for_automation(profile: &mut Value) {
    let Some(object) = profile.as_object_mut() else {
        return;
    };
    // FAILS CLOSED. An `and_then(as_object_mut)` here would silently pass the field through whenever
    // it is not an object, and these cells are stored as arbitrary `serde_json::Value` with no shape
    // validation on write — so an array or a scalar would reach an API-key holder verbatim. That
    // matters more since the cookie import is now KEPT after launch rather than nulled, which makes
    // the exposure permanent instead of one-shot. Anything not matching the expected object shape is
    // dropped entirely rather than inspected.
    match object.get_mut("cookiesImport") {
        Some(Value::Object(cookies_import)) => {
            cookies_import.retain(|field, _| SAFE_COOKIE_IMPORT_FIELDS.contains(&field.as_str()));
        }
        Some(_) => {
            object.remove("cookiesImport");
        }
        None => {}
    }
    match object.get_mut("proxy") {
        Some(Value::Object(proxy)) => {
            for field in PROXY_SECRET_FIELDS {
                proxy.remove(*field);
            }
        }
        Some(_) => {
            object.remove("proxy");
        }
        None => {}
    }
}

async fn profile_list(
    State(state): State<Arc<LocalApiState>>,
    headers: HeaderMap,
) -> (StatusCode, Json<ApiResponse>) {
    if !authorized(&state, &headers) {
        return (StatusCode::UNAUTHORIZED, ApiResponse::err("unauthorized"));
    }
    if let Err(error) = reconcile_profile_statuses(&state.db, &state.sidecar).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiResponse::err(error.to_string()),
        );
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
    match profile_store::list(&conn, &state.cipher) {
        Ok(profiles) => {
            let mut data = serde_json::to_value(profiles).unwrap_or(Value::Null);
            for profile in data.as_array_mut().into_iter().flatten() {
                redact_profile_for_automation(profile);
            }
            (StatusCode::OK, ApiResponse::ok(data))
        }
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
            engine: "lobium".to_string(),
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
        proxy_store::init(&conn).unwrap();
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

    fn lifecycle_fake_sidecar() -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "lobster-lifecycle-sidecar-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("sidecar.mjs");
        std::fs::write(
            &script,
            r#"import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'startProfile') {
    if (request.params.profileName === 'Fail import') {
      process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: { code: 'inject', message: 'cookie injection failed' } }) + '\n');
      return;
    }
    const applied = Boolean(request.params.cookiesImport);
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: {
      profileId: request.params.profileId, pid: 7, ws: 'ws://test', debuggerAddress: '127.0.0.1:7',
      cookieImportApplied: applied, proxyHost: request.params.proxy?.host ?? null
    } }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { running: [] } }) + '\n');
});"#,
        )
        .unwrap();
        (root, script)
    }

    #[tokio::test]
    async fn start_profile_missing_profile_returns_not_found() {
        let db = mem_db();
        let cipher = SecretCipher::new(&[42u8; 32]);
        let sidecar = SidecarClient::spawn("true", "")
            .await
            .expect("spawn fake sidecar");
        let profiles_dir = std::env::temp_dir();
        let err = start_profile_via_sidecar(
            &db,
            &cipher,
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

    #[tokio::test]
    async fn start_profile_rejects_a_stale_stored_proxy_reference_before_sidecar_launch() {
        let db = mem_db();
        let cipher = SecretCipher::new(&[42u8; 32]);
        let mut input = test_input("Stale proxy");
        input.proxy_id = Some("px_missing".to_string());
        let profile = {
            let conn = db.lock().unwrap();
            profile_store::create(&conn, &cipher, input).unwrap()
        };
        let sidecar = SidecarClient::spawn("true", "")
            .await
            .expect("spawn fake sidecar");
        let error = start_profile_via_sidecar(
            &db,
            &cipher,
            &sidecar,
            &std::env::temp_dir(),
            &profile.id,
            None,
            true,
        )
        .await
        .expect_err("stale proxy reference must fail closed");
        assert!(error
            .to_string()
            .contains("references missing proxy px_missing"));
    }

    #[tokio::test]
    async fn applied_cookie_import_is_stamped_kept_and_never_reapplied() {
        let db = mem_db();
        let cipher = SecretCipher::new(&[42u8; 32]);
        let mut success_input = test_input("Import once");
        success_input.cookies_import = Some(serde_json::json!({ "mode": "empty" }));
        let mut failure_input = test_input("Fail import");
        failure_input.cookies_import = Some(serde_json::json!({
            "mode": "merge", "rawText": "example.test\tFALSE\t/\tFALSE\t0\tsid\tsecret"
        }));
        let (success, failure) = {
            let conn = db.lock().unwrap();
            (
                profile_store::create(&conn, &cipher, success_input).unwrap(),
                profile_store::create(&conn, &cipher, failure_input).unwrap(),
            )
        };
        let (root, script) = lifecycle_fake_sidecar();
        let sidecar = SidecarClient::spawn("node", script.to_string_lossy().as_ref())
            .await
            .unwrap();

        let first =
            start_profile_via_sidecar(&db, &cipher, &sidecar, &root, &success.id, None, true)
                .await
                .unwrap();
        assert_eq!(
            first.get("cookieImportApplied").and_then(Value::as_bool),
            Some(true)
        );
        let applied = profile_store::get(&db.lock().unwrap(), &cipher, &success.id)
            .unwrap()
            .unwrap();
        assert!(
            applied.cookies_import.is_some(),
            "the import is the profile's only durable session record — it must survive the launch"
        );
        assert!(applied.cookies_import_applied_at.is_some());

        let second =
            start_profile_via_sidecar(&db, &cipher, &sidecar, &root, &success.id, None, true)
                .await
                .unwrap();
        assert_eq!(
            second.get("cookieImportApplied").and_then(Value::as_bool),
            Some(false),
            "a later launch must not reapply an import that is already in the jar"
        );

        let failed =
            start_profile_via_sidecar(&db, &cipher, &sidecar, &root, &failure.id, None, true).await;
        assert!(failed.is_err());
        let preserved = profile_store::get(&db.lock().unwrap(), &cipher, &failure.id)
            .unwrap()
            .unwrap();
        assert!(preserved.cookies_import.is_some());
        assert_eq!(preserved.status, "error");
        drop(sidecar);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn stored_proxy_is_resolved_fresh_for_every_launch() {
        let db = mem_db();
        let cipher = SecretCipher::new(&[42u8; 32]);
        let profile = {
            let conn = db.lock().unwrap();
            proxy_store::create(
                &conn,
                &cipher,
                proxy_store::CreateStoredProxyInput {
                    source: "mine".to_string(),
                    label: "Current".to_string(),
                    config: serde_json::json!({
                        "id": "px_fresh", "type": "http", "host": "first.example", "port": 8080
                    }),
                    location: None,
                    timezone: None,
                    rotate_url: None,
                },
            )
            .unwrap();
            let mut input = test_input("Fresh proxy");
            input.proxy_id = Some("px_fresh".to_string());
            profile_store::create(&conn, &cipher, input).unwrap()
        };
        let (root, script) = lifecycle_fake_sidecar();
        let sidecar = SidecarClient::spawn("node", script.to_string_lossy().as_ref())
            .await
            .unwrap();
        let first =
            start_profile_via_sidecar(&db, &cipher, &sidecar, &root, &profile.id, None, true)
                .await
                .unwrap();
        assert_eq!(
            first.get("proxyHost").and_then(Value::as_str),
            Some("first.example")
        );

        {
            let conn = db.lock().unwrap();
            proxy_store::update(
                &conn,
                &cipher,
                "px_fresh",
                proxy_store::UpdateStoredProxyInput {
                    source: None,
                    label: None,
                    config: Some(serde_json::json!({
                        "id": "px_fresh", "type": "socks5", "host": "second.example", "port": 1080
                    })),
                    location: None,
                    timezone: None,
                    rotate_url: None,
                },
            )
            .unwrap();
        }
        let second =
            start_profile_via_sidecar(&db, &cipher, &sidecar, &root, &profile.id, None, true)
                .await
                .unwrap();
        assert_eq!(
            second.get("proxyHost").and_then(Value::as_str),
            Some("second.example")
        );
        drop(sidecar);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The loopback API's audience is every automation script and every tool the API key is pasted
    /// into, so `GET /api/v1/profile/list` must not be a one-request harvest of live sessions and
    /// proxy credentials.
    #[test]
    fn profile_list_never_emits_cookie_raw_text_or_proxy_credentials() {
        let db = mem_db();
        let cipher = SecretCipher::new(&[42u8; 32]);
        let mut input = test_input("Automation");
        input.proxy = Some(serde_json::json!({
            "type": "socks5", "host": "proxy.example", "port": 1080,
            "username": "alice-user", "password": "hunter2-topsecret"
        }));
        input.cookies_import = Some(serde_json::json!({
            "mode": "merge", "source": "plain_text", "parsedCount": 1,
            "rawText": "example.test\tFALSE\t/\tFALSE\t0\tsid\tlive-session-token"
        }));
        let conn = db.lock().unwrap();
        profile_store::create(&conn, &cipher, input).unwrap();
        let mut data = serde_json::to_value(profile_store::list(&conn, &cipher).unwrap()).unwrap();
        for profile in data.as_array_mut().into_iter().flatten() {
            redact_profile_for_automation(profile);
        }

        let body = data.to_string();
        for secret in [
            "live-session-token",
            "rawText",
            "hunter2-topsecret",
            "alice-user",
        ] {
            assert!(
                !body.contains(secret),
                "`{secret}` must not leave the app: {body}"
            );
        }
        // Non-secret diagnostics and proxy topology still describe the profile to automation.
        assert_eq!(data[0]["cookiesImport"]["mode"], "merge");
        assert_eq!(data[0]["cookiesImport"]["parsedCount"], 1);
        assert_eq!(data[0]["proxy"]["host"], "proxy.example");
    }

    /// Opt-in: launches the REAL engine, so it is `#[ignore]`d rather than gated on an env var with
    /// a bare `return`. That return made `cargo test` report a green pass for zero work — and this is
    /// the only relaunch-persistence proof in the Rust suite, so a false pass hid its absence
    /// entirely. Run it with `LOBSTER_PRODUCT_E2E=1 cargo test -- --ignored`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "real-engine E2E: LOBSTER_PRODUCT_E2E=1 cargo test -- --ignored"]
    async fn product_launch_connect_stop_e2e_when_enabled() {
        assert_eq!(
            std::env::var("LOBSTER_PRODUCT_E2E").as_deref(),
            Ok("1"),
            "this test provisions and launches the real engine; set LOBSTER_PRODUCT_E2E=1 to confirm"
        );

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
        let cipher = SecretCipher::new(&[42u8; 32]);
        let mut input = test_input("Product E2E");
        input.engine = "lobium".to_string();
        let profile = profile_store::create(&conn, &cipher, input).unwrap();
        let db = Arc::new(Mutex::new(conn));
        let sidecar = SidecarClient::spawn("node", &sidecar_path())
            .await
            .expect("spawn real sidecar");

        let launched = start_profile_via_sidecar(
            &db,
            &cipher,
            &sidecar,
            &profiles_dir,
            &profile.id,
            None,
            true,
        )
        .await
        .expect("launch profile through sidecar");
        let cfg_path = profiles_dir.join(&profile.id).join("lobium-fp.json");
        let cfg_raw =
            std::fs::read_to_string(&cfg_path).expect("native Lobium config should exist");
        let cfg: Value =
            serde_json::from_str(&cfg_raw).expect("native Lobium config should be JSON");
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
            cfg.pointer("/seeds/canvas")
                .and_then(Value::as_u64)
                .is_some(),
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

        stop_profile_via_sidecar(&db, &sidecar, &profile.id)
            .await
            .expect("stop profile");
        std::fs::remove_dir_all(root).unwrap();
    }
}
