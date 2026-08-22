//! Moving a profile between this machine and the account's storage.
//!
//! ## What actually crosses the wire
//!
//! Two things, and the split matters.
//!
//! 1. A **server row**, in the clear: name, engine, OS, fingerprint seed, tags, folder. It is the
//!    ENUMERATION HANDLE — a machine that has never seen this profile finds it by listing
//!    `GET /profiles`, and there is no other way to discover that a profile exists. Its id is also
//!    the only identifier both machines agree on, which is why the content key is derived from it and
//!    not from the local `prf_…` id, which is minted per install.
//! 2. A **sealed payload**: the profile row in full — proxy credentials, notes, the cookie import —
//!    plus the snapshot manifest and every artifact. One LBv1 envelope under the profile's content
//!    key, which is derived from the ACCOUNT key ([`crate::vault_key`]) rather than this install's.
//!    That is the point: the server stores bytes it cannot read, and any machine that can sign in can
//!    open them.
//!
//! The row travels inside the payload as well as beside it, and the sealed copy is the authority. A
//! machine that pulls a snapshot without the row has cookies and no fingerprint — the same session
//! arriving as a visibly different device, which is the exact failure this product exists to avoid —
//! and on a fresh install there would be nothing to restore INTO at all.
//!
//! ## Why the payload is CBOR byte strings, and compressed
//!
//! Artifact payloads are raw bytes, and serde treats `Vec<u8>` as a sequence. `serde_json` renders
//! that as a list of decimal numbers — measured on a real profile, 27.33 MB of artifacts encoded to
//! 109 MB against a 25 MiB server limit, so the largest profiles could not be synced at all and the
//! failure was a 413 that named nothing. CBOR alone only halves that, because a sequence of integers
//! is still one item per byte; the payloads are therefore
//! [`crate::profile_portable::ArtifactBytes`], which encodes as a CBOR byte STRING. Deflate then
//! roughly halves what is left, because vacuumed SQLite and IndexedDB compress hard.
//!
//! ## Versions belong to the server
//!
//! The push carries the version it believes is current (`baseVersion`). If the server has moved on,
//! it answers 409 and this refuses rather than overwriting — the other machine's snapshot is somebody
//! else's session, and last-write-wins would silently destroy it. Recovering from that is a decision
//! for the caller, which is why the conflict is a distinct error rather than a generic failure.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::io::Write as _;
use std::time::Duration;

use crate::blob_crypto::{BlobCipher, LB_V1_KEY_ID_LEN, LB_V1_KEY_LEN};
use crate::cloud_auth;
use crate::profile_portable::{ArtifactBytes, PortableRow};
use crate::snapshot::manifest::{CaptureMode, SnapshotManifest};
use crate::snapshot::vault::SnapshotVault;
use crate::AppState;
use tauri::Manager as _;

/// A stalled request must not wedge a capture, but a 25 MiB upload over a poor link is legitimately
/// slow, so this is generous rather than snappy.
const HTTP_TIMEOUT: Duration = Duration::from_secs(120);

/// The server refuses a body larger than this, so refuse locally with a message that says why rather
/// than surfacing an opaque 413.
const MAX_PAYLOAD_BYTES: usize = 25 * 1024 * 1024;

/// Payload framing, ahead of the CBOR: magic then a codec byte.
///
/// The byte is what lets the encoding change again without a flag day — a reader that meets a codec
/// it does not know says so by name instead of handing malformed bytes to a decoder.
const PAYLOAD_MAGIC: &[u8; 4] = b"LSP1";
const CODEC_CBOR: u8 = 0;
const CODEC_CBOR_DEFLATE: u8 = 1;

/// Deflate level 1, not the default 6.
///
/// Measured on the artifacts of a real 33 MB profile: level 6 buys 0.1% on LevelDB extension state,
/// 3.4% on the SNSS session directories and 4.6% on IndexedDB, for 40% to 110% more CPU. On the
/// upload path the bytes saved are not worth the seconds spent, and the seconds are what the user
/// waits through.
const DEFLATE_LEVEL: flate2::Compression = flate2::Compression::new(1);

/// What travels inside the envelope.
#[derive(Debug, Serialize, Deserialize)]
struct SyncPayload {
    manifest: SnapshotManifest,
    /// `(artifact id, payload)`. A Vec rather than a map so the encoding is order-stable, and
    /// [`ArtifactBytes`] so the payload is a CBOR byte string rather than an array of integers —
    /// which is a doubling, on top of the fourfold one JSON was already costing.
    artifacts: Vec<(String, ArtifactBytes)>,
    /// Defaulted so a snapshot pushed before rows travelled still pulls — it restores into whatever
    /// row the puller already has.
    #[serde(default)]
    row: Option<PortableRow>,
}

/// What a push did.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    pub profile_id: String,
    pub remote_id: String,
    /// Local ledger version that was uploaded.
    pub snapshot_version: u64,
    /// Server-side blob version now current.
    pub remote_version: u64,
    pub bytes: usize,
}

/// What a pull did.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullOutcome {
    pub profile_id: String,
    pub remote_version: u64,
    /// Ledger version the downloaded snapshot was written to.
    pub snapshot_version: u64,
    pub artifacts: usize,
    /// The sealed row the payload carried, if it carried one. The caller decides what to do with it:
    /// a pull onto a machine that already has the profile leaves the local row alone, a first pull
    /// creates it.
    #[serde(skip)]
    pub row: Option<PortableRow>,
}

/// The server rejected the push because someone else advanced the blob first.
#[derive(Debug)]
pub struct SyncConflict {
    pub profile_id: String,
    pub base_version: u64,
}

impl std::fmt::Display for SyncConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "SYNC_CONFLICT: {} has been synced from another machine since version {} — pushing would \
             overwrite that session. Pull it, or push again after reconciling.",
            self.profile_id, self.base_version
        )
    }
}

impl std::error::Error for SyncConflict {}

/// Frame, encode and compress a payload for transport.
fn encode_payload(payload: &SyncPayload) -> Result<Vec<u8>> {
    let mut cbor = Vec::new();
    ciborium::into_writer(payload, &mut cbor).context("encoding the snapshot for upload")?;

    let mut out = Vec::with_capacity(cbor.len() / 2 + PAYLOAD_MAGIC.len() + 1);
    out.extend_from_slice(PAYLOAD_MAGIC);
    out.push(CODEC_CBOR_DEFLATE);
    let mut encoder = flate2::write::ZlibEncoder::new(out, DEFLATE_LEVEL);
    encoder
        .write_all(&cbor)
        .context("compressing the snapshot for upload")?;
    encoder
        .finish()
        .context("compressing the snapshot for upload")
}

fn decode_payload(bytes: &[u8]) -> Result<SyncPayload> {
    // A payload with no framing is one this build's predecessor wrote as bare JSON. Reading it is
    // three lines and the alternative is telling a user their only backup is unreadable.
    if bytes.len() < PAYLOAD_MAGIC.len() + 1 || &bytes[..PAYLOAD_MAGIC.len()] != PAYLOAD_MAGIC {
        return serde_json::from_slice(bytes).context("the downloaded snapshot is malformed");
    }
    let codec = bytes[PAYLOAD_MAGIC.len()];
    let body = &bytes[PAYLOAD_MAGIC.len() + 1..];
    match codec {
        CODEC_CBOR => ciborium::from_reader(body).context("the downloaded snapshot is malformed"),
        CODEC_CBOR_DEFLATE => {
            let mut plain = Vec::new();
            flate2::read::ZlibDecoder::new(body)
                .read_to_end(&mut plain)
                .context("the downloaded snapshot could not be decompressed")?;
            ciborium::from_reader(&plain[..]).context("the downloaded snapshot is malformed")
        }
        other => bail!(
            "this snapshot was packed with codec {other}, which this version of Lobster does not \
             know how to read. Update Lobster, then sync again."
        ),
    }
}

use std::io::Read as _;

/// Seal the newest local snapshot — and the profile row that gives it a browser to belong to — for
/// the account, and upload it.
///
/// `remote_id` is the server's id for this profile, NOT the local one: it is the identifier both
/// machines agree on, and the content key is derived from it.
pub async fn push(
    vault: &SnapshotVault,
    profile_id: &str,
    remote_id: &str,
    row: Option<PortableRow>,
    content_key: &[u8; LB_V1_KEY_LEN],
    key_id: &[u8; LB_V1_KEY_ID_LEN],
    base_version: u64,
) -> Result<PushOutcome> {
    let snapshot_version = vault
        .latest_version(profile_id)?
        .ok_or_else(|| anyhow!("{profile_id} has no local snapshot to push — capture one first"))?;
    let manifest = vault.manifest(profile_id, snapshot_version)?;

    let mut artifacts = Vec::with_capacity(manifest.artifacts.len());
    for record in &manifest.artifacts {
        let bytes = vault
            .get_artifact(
                profile_id,
                record.captured_in_version,
                &record.id,
                &record.sealed_digest,
            )
            .with_context(|| format!("reading `{}` out of the ledger to push", record.id))?;
        artifacts.push((record.id.clone(), ArtifactBytes(bytes)));
    }

    let payload = SyncPayload {
        manifest,
        artifacts,
        row,
    };
    let encoded = encode_payload(&payload)?;
    let sealed = BlobCipher::new(content_key).encrypt(&encoded, key_id)?;

    if sealed.len() > MAX_PAYLOAD_BYTES {
        bail!(
            "sealed snapshot is {} bytes, over the {} byte server limit — exclude large artifacts \
             or capture a slimmer set",
            sealed.len(),
            MAX_PAYLOAD_BYTES
        );
    }

    let body = serde_json::json!({
        "direction": "push",
        "payload": base64::engine::general_purpose::STANDARD.encode(&sealed),
        "baseVersion": base_version,
    });
    let res = sync_request(remote_id, &body).await?;

    match res {
        SyncResponse::Ok(data) => Ok(PushOutcome {
            profile_id: profile_id.to_string(),
            remote_id: remote_id.to_string(),
            snapshot_version,
            remote_version: data.version,
            bytes: sealed.len(),
        }),
        SyncResponse::Conflict => Err(SyncConflict {
            profile_id: profile_id.to_string(),
            base_version,
        }
        .into()),
    }
}

/// Download the account's snapshot and write it into the local ledger under `profile_id`.
pub async fn pull(
    vault: &SnapshotVault,
    profile_id: &str,
    remote_id: &str,
    content_key: &[u8; LB_V1_KEY_LEN],
) -> Result<PullOutcome> {
    let body = serde_json::json!({ "direction": "pull" });
    let SyncResponse::Ok(data) = sync_request(remote_id, &body).await? else {
        // A pull cannot conflict: it takes no baseVersion.
        bail!("unexpected conflict on pull for {profile_id}");
    };
    let encoded = data
        .payload
        .ok_or_else(|| anyhow!("{profile_id} has never been synced from any machine"))?;
    let sealed = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("the downloaded snapshot is not valid base64")?;

    // Fails closed on the wrong key: the AEAD tag makes "another account's snapshot" and "a tampered
    // one" both a decryption failure rather than plausible-looking garbage written into the ledger.
    let (plain, _key_id) = BlobCipher::new(content_key).decrypt(&sealed).context(
        "could not open the downloaded snapshot — it was sealed for a different account key",
    )?;
    let payload = decode_payload(&plain)?;

    // Written as a NEW local version rather than over an existing one, so a pull can never destroy a
    // local snapshot that has not been uploaded yet. `adopt` re-seals every artifact under this
    // install's key and re-points the manifest at the digests that produces — the downloaded ones
    // describe blobs from the machine that pushed them and would be rejected here as transplanted.
    let adopted = vault
        .adopt(
            profile_id,
            &payload.manifest,
            payload
                .artifacts
                .into_iter()
                .map(|(id, bytes)| (id, bytes.0))
                .collect(),
        )
        .context("writing the downloaded snapshot into the ledger")?;

    Ok(PullOutcome {
        profile_id: profile_id.to_string(),
        remote_version: data.version,
        snapshot_version: adopted.version,
        artifacts: adopted.artifacts.len(),
        row: payload.row,
    })
}

// --- The server's own profile row ----------------------------------------------------------------

/// One profile as the server lists it. Only the fields this machine can act on.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub os_version: Option<String>,
    pub fingerprint_seed: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub folder: Option<String>,
}

/// The projection of a local row that is allowed to sit on the server IN THE CLEAR.
///
/// Deliberately narrow. The server needs enough to answer "which profiles does this account have,
/// and which browser is each one" — that is the enumeration handle, and `fingerprintSeed` is a
/// required column on it. Everything else a profile carries (the proxy and its credentials, the
/// notes, the cookie import, the extension list) stays inside the sealed payload, where the server
/// cannot read it and no DTO change on the other side can reject it.
fn remote_row_body(row: &PortableRow, include_seed: bool) -> serde_json::Value {
    let mut body = serde_json::json!({
        "name": row.name,
        "engine": row.engine,
        "os": row.os,
        "tags": row.tags,
    });
    let map = body.as_object_mut().expect("object literal");
    if include_seed {
        map.insert(
            "fingerprintSeed".to_string(),
            serde_json::Value::String(row.fingerprint_seed.clone()),
        );
    }
    if let Some(version) = &row.os_version {
        map.insert(
            "osVersion".to_string(),
            serde_json::Value::String(version.clone()),
        );
    }
    if let Some(folder) = &row.folder {
        map.insert(
            "folder".to_string(),
            serde_json::Value::String(folder.clone()),
        );
    }
    body
}

/// Create the account's row for a profile that has never been synced, returning the server's id.
///
/// This is the step that has to happen before anything else: the blob is keyed by the server id, so
/// a push against a profile the server has never heard of is a 404 with nothing to explain it.
pub async fn create_remote_row(row: &PortableRow) -> Result<RemoteProfile> {
    let created: RemoteProfile = api_call(
        reqwest::Method::POST,
        "/profiles",
        Some(remote_row_body(row, /* include_seed = */ true)),
    )
    .await
    .context("creating this profile on the account")?;
    Ok(created)
}

/// Update the account's row after a local edit. The seed is never sent: it is immutable, and the
/// server's own DTO refuses it.
pub async fn update_remote_row(remote_id: &str, row: &PortableRow) -> Result<()> {
    let _: serde::de::IgnoredAny = api_call(
        reqwest::Method::PATCH,
        &format!("/profiles/{remote_id}"),
        Some(remote_row_body(row, /* include_seed = */ false)),
    )
    .await
    .context("updating this profile on the account")?;
    Ok(())
}

/// Every profile the account holds. This is how a second machine learns what there is to restore.
pub async fn list_remote_rows() -> Result<Vec<RemoteProfile>> {
    api_call(reqwest::Method::GET, "/profiles", None)
        .await
        .context("listing the account's profiles")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncData {
    version: u64,
    #[serde(default)]
    payload: Option<String>,
}

enum SyncResponse {
    Ok(SyncData),
    Conflict,
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .context("building the HTTP client")
}

/// One `{code,data,msg}` call against the account API, decoded into `T`.
async fn api_call<T: serde::de::DeserializeOwned>(
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<T> {
    let token = cloud_auth::load_token().ok_or_else(|| anyhow!("not signed in"))?;
    let mut request = client()?
        .request(method, format!("{}{path}", cloud_auth::api_origin()))
        .bearer_auth(&token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let res = request.send().await.context("talking to the account API")?;
    if !res.status().is_success() {
        let status = res.status();
        let detail = res.text().await.unwrap_or_default();
        bail!(
            "{path} failed: HTTP {status} {}",
            detail.chars().take(200).collect::<String>()
        );
    }

    #[derive(Deserialize)]
    struct Envelope<T> {
        code: i32,
        data: Option<T>,
        msg: Option<String>,
    }
    let envelope: Envelope<T> = res.json().await.context("parsing the account response")?;
    if envelope.code != 0 {
        bail!(
            "{path} refused: {}",
            envelope.msg.unwrap_or_else(|| "unknown error".to_string())
        );
    }
    envelope
        .data
        .ok_or_else(|| anyhow!("{path} answered with no data"))
}

async fn sync_request(remote_id: &str, body: &serde_json::Value) -> Result<SyncResponse> {
    let token = cloud_auth::load_token().ok_or_else(|| anyhow!("not signed in"))?;
    let res = client()?
        .post(format!(
            "{}/profiles/{remote_id}/sync",
            cloud_auth::api_origin()
        ))
        .bearer_auth(&token)
        .json(body)
        .send()
        .await
        .context("talking to the sync endpoint")?;

    // 409 is the server telling us another machine moved first. It is a normal outcome of a
    // distributed edit, not a fault, so it gets its own branch rather than a generic HTTP error.
    if res.status() == reqwest::StatusCode::CONFLICT {
        return Ok(SyncResponse::Conflict);
    }
    if !res.status().is_success() {
        let status = res.status();
        let detail = res.text().await.unwrap_or_default();
        bail!(
            "sync failed: HTTP {status} {}",
            detail.chars().take(200).collect::<String>()
        );
    }

    #[derive(Deserialize)]
    struct Envelope {
        code: i32,
        data: Option<SyncData>,
        msg: Option<String>,
    }
    let envelope: Envelope = res.json().await.context("parsing the sync response")?;
    if envelope.code != 0 {
        bail!(
            "sync refused: {}",
            envelope.msg.unwrap_or_else(|| "unknown error".to_string())
        );
    }
    envelope
        .data
        .map(SyncResponse::Ok)
        .ok_or_else(|| anyhow!("sync response carried no data"))
}

// --- Orchestration: the part that makes any of the above run ------------------------------------

/// What one reconcile did, per profile, in words the UI can show without interpreting.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncedProfile {
    pub profile_id: String,
    pub name: String,
    /// `pushed` | `pulled` | `restored` | `unchanged` | `conflict` | `failed`.
    pub action: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub profiles: Vec<SyncedProfile>,
    pub pushed: usize,
    pub pulled: usize,
    pub failed: usize,
}

/// Make sure the account key is cached for this session, fetching it if sign-in has not needed it
/// yet.
///
/// Sync is the first thing that genuinely requires it, and making the user visit a settings screen
/// first would rule out any automatic background sync.
async fn ensure_account_key(state: &AppState) -> Result<()> {
    if state
        .account_key
        .lock()
        .map_err(|e| anyhow!("{e}"))?
        .is_some()
    {
        return Ok(());
    }
    let key = crate::vault_key::fetch()
        .await
        .context("fetching the account key")?;
    *state.account_key.lock().map_err(|e| anyhow!("{e}"))? = Some(key);
    Ok(())
}

/// The content key and key id for a profile, derived from the ACCOUNT key and the profile's REMOTE
/// id — the only identifier both machines agree on.
///
/// Derived under the lock and never handed out: `AccountKey` is deliberately not `Clone`, so the key
/// material has exactly one home for the life of the session.
fn content_key(
    state: &AppState,
    remote_id: &str,
) -> Result<([u8; LB_V1_KEY_LEN], [u8; LB_V1_KEY_ID_LEN])> {
    let guard = state.account_key.lock().map_err(|e| anyhow!("{e}"))?;
    let account = guard
        .as_ref()
        .ok_or_else(|| anyhow!("the account key is not loaded yet — sign in, then try again"))?;
    let key = account.profile_content_key(remote_id)?;
    let key_id = crate::blob_crypto::derive_key_id(&key, remote_id)?;
    Ok((key, key_id))
}

fn open_vault(state: &AppState) -> Result<SnapshotVault> {
    let app_data = state
        .profiles_dir
        .parent()
        .ok_or_else(|| anyhow!("profiles directory has no parent; cannot locate the ledger"))?;
    SnapshotVault::open(app_data).context("opening the snapshot ledger")
}

/// Bind a local profile to an account row, creating that row if the account has none for it.
///
/// A profile is matched to an existing account row by FINGERPRINT SEED, not by name. The seed is
/// immutable and unique per profile, so it is the one field that identifies the same profile on two
/// machines — and a profile that reached the second machine as a `.lobprofile` before sync existed
/// would otherwise be adopted as a second, duplicate account row and then fight itself over one blob.
async fn ensure_remote_id(
    state: &AppState,
    profile_id: &str,
) -> Result<(String, crate::profile_portable::PortableRow)> {
    let (row, existing) = {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        let profile = crate::profile_store::get(&conn, &state.cipher, profile_id)
            .map_err(|e| anyhow!("{e}"))?
            .ok_or_else(|| anyhow!("profile {profile_id} not found"))?;
        if !profile.unreadable_secrets.is_empty() {
            bail!(
                "cannot sync {profile_id}: this machine cannot decrypt {} — uploading would replace \
                 the account's copy with one that has lost these values",
                profile.unreadable_secrets.join(", ")
            );
        }
        let link = crate::profile_store::sync_link(&conn, profile_id)
            .map_err(|e| anyhow!("{e}"))?
            .and_then(|l| l.remote_id);
        (
            crate::profile_portable::portable_row(&conn, &profile)?,
            link,
        )
    };

    if let Some(remote_id) = existing {
        update_remote_row(&remote_id, &row).await?;
        return Ok((remote_id, row));
    }

    let adopted = list_remote_rows()
        .await?
        .into_iter()
        .find(|r| r.fingerprint_seed == row.fingerprint_seed);
    let remote_id = match adopted {
        Some(remote) => {
            update_remote_row(&remote.id, &row).await?;
            remote.id
        }
        None => create_remote_row(&row).await?.id,
    };
    {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        crate::profile_store::set_remote_id(&conn, profile_id, &remote_id)
            .map_err(|e| anyhow!("{e}"))?;
    }
    Ok((remote_id, row))
}

/// Capture the profile if asked, then upload the newest snapshot and the row.
pub async fn push_profile(
    state: &AppState,
    profile_id: &str,
    capture_mode: Option<CaptureMode>,
) -> Result<PushOutcome> {
    ensure_account_key(state).await?;
    let (remote_id, row) = ensure_remote_id(state, profile_id).await?;
    let (key, key_id) = content_key(state, &remote_id)?;
    let vault = open_vault(state)?;

    if let Some(mode) = capture_mode {
        let identity = {
            let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
            crate::snapshot::commands::identity_of_row(&conn, &state.cipher, profile_id)
                .map_err(|e| anyhow!("{e}"))?
        };
        crate::snapshot::capture(
            &vault,
            &state.profiles_dir.join(profile_id),
            profile_id,
            mode,
            &identity,
            &crate::snapshot::CaptureOptions::default(),
        )
        .context("capturing before the upload")?;
    }

    let base_version = {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        crate::profile_store::sync_link(&conn, profile_id)
            .map_err(|e| anyhow!("{e}"))?
            .map(|l| l.remote_version)
            .unwrap_or(0)
    };

    let outcome = push(
        &vault,
        profile_id,
        &remote_id,
        Some(row),
        &key,
        &key_id,
        base_version,
    )
    .await?;

    {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        crate::profile_store::mark_synced(&conn, profile_id, outcome.remote_version)
            .map_err(|e| anyhow!("{e}"))?;
    }
    Ok(outcome)
}

/// Download the account's snapshot into an existing local profile's ledger.
///
/// It does NOT touch the user-data-dir. Writing another machine's session over a directory this one
/// has been using is a data-loss event dressed as a sync, so the restore is a separate, deliberate
/// step — the exception is a profile that has no user-data-dir at all, which [`reconcile`] handles
/// because there is nothing there to lose.
pub async fn pull_profile(state: &AppState, profile_id: &str) -> Result<PullOutcome> {
    ensure_account_key(state).await?;
    let remote_id = {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        crate::profile_store::sync_link(&conn, profile_id)
            .map_err(|e| anyhow!("{e}"))?
            .and_then(|l| l.remote_id)
            .ok_or_else(|| anyhow!("{profile_id} has never been synced from this account"))?
    };
    let (key, _) = content_key(state, &remote_id)?;
    let vault = open_vault(state)?;
    let outcome = pull(&vault, profile_id, &remote_id, &key).await?;
    {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        crate::profile_store::mark_synced(&conn, profile_id, outcome.remote_version)
            .map_err(|e| anyhow!("{e}"))?;
    }
    Ok(outcome)
}

/// Make this machine and the account agree, in both directions.
///
/// The direction per profile is decided by two facts and nothing else: whether the local row has
/// changed since its last successful sync, and whether the account's blob version has moved past the
/// one this machine last saw. A profile the account has and this machine does not is created here —
/// that case is the whole point, and it is the one that was impossible while only the blob synced.
pub async fn reconcile(state: &AppState) -> Result<SyncSummary> {
    ensure_account_key(state).await?;
    let remote_rows = list_remote_rows().await?;
    let mut summary = SyncSummary::default();

    let locals = {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        crate::profile_store::list(&conn, &state.cipher).map_err(|e| anyhow!("{e}"))?
    };

    for profile in &locals {
        let link = {
            let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
            crate::profile_store::sync_link(&conn, &profile.id).map_err(|e| anyhow!("{e}"))?
        };
        let dirty = link.as_ref().is_none_or(|l| l.dirty);
        if !dirty {
            summary.profiles.push(SyncedProfile {
                profile_id: profile.id.clone(),
                name: profile.name.clone(),
                action: "unchanged".into(),
                detail: None,
            });
            continue;
        }
        // A running profile is still writing; a quiesced capture of it would be a lie the restore UI
        // then acts on, so it is captured live and labelled that way.
        let mode = if profile.status == "running" {
            CaptureMode::Live
        } else {
            CaptureMode::Quiesced
        };
        match push_profile(state, &profile.id, Some(mode)).await {
            Ok(outcome) => {
                summary.pushed += 1;
                summary.profiles.push(SyncedProfile {
                    profile_id: profile.id.clone(),
                    name: profile.name.clone(),
                    action: "pushed".into(),
                    detail: Some(format!("version {}", outcome.remote_version)),
                });
            }
            Err(err) => {
                let conflict = err.downcast_ref::<SyncConflict>().is_some();
                summary.failed += 1;
                summary.profiles.push(SyncedProfile {
                    profile_id: profile.id.clone(),
                    name: profile.name.clone(),
                    action: if conflict { "conflict" } else { "failed" }.into(),
                    detail: Some(format!("{err:#}")),
                });
            }
        }
    }

    for remote in &remote_rows {
        let already = {
            let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
            crate::profile_store::find_by_remote_id(&conn, &state.cipher, &remote.id)
                .map_err(|e| anyhow!("{e}"))?
                .is_some()
        };
        if already {
            continue;
        }
        match materialise(state, remote).await {
            Ok(name) => {
                summary.pulled += 1;
                summary.profiles.push(SyncedProfile {
                    profile_id: remote.id.clone(),
                    name,
                    action: "restored".into(),
                    detail: None,
                });
            }
            Err(err) => {
                summary.failed += 1;
                summary.profiles.push(SyncedProfile {
                    profile_id: remote.id.clone(),
                    name: remote.name.clone(),
                    action: "failed".into(),
                    detail: Some(format!("{err:#}")),
                });
            }
        }
    }

    Ok(summary)
}

/// Bring a profile the account has and this machine does not into existence, data and all.
///
/// The sealed row is preferred over the account's plaintext one: it carries the proxy, its
/// credentials, the notes and the cookie import, none of which the server row holds. Falling back to
/// the server row is what makes a profile created on the website — which has never pushed a
/// snapshot — arrive here as a usable profile rather than not at all.
async fn materialise(state: &AppState, remote: &RemoteProfile) -> Result<String> {
    let (key, _) = content_key(state, &remote.id)?;
    let vault = open_vault(state)?;

    // Pulled into a scratch id first: the ledger is keyed by profile id, and a row created before the
    // download is a row left behind when the download fails.
    let downloaded = pull(&vault, &remote.id, &remote.id, &key).await;
    let (row, pulled) = match downloaded {
        Ok(outcome) => (outcome.row.clone(), Some(outcome)),
        Err(err) => {
            tracing::info!(
                remote_id = %remote.id,
                error = %format!("{err:#}"),
                "no snapshot for this account profile; creating the row only"
            );
            (None, None)
        }
    };

    let row = row.unwrap_or_else(|| crate::profile_portable::PortableRow {
        source_profile_id: remote.id.clone(),
        name: remote.name.clone(),
        engine: remote.engine.clone().unwrap_or_else(|| "lobium".into()),
        os: remote.os.clone().unwrap_or_else(|| "windows".into()),
        os_version: remote.os_version.clone(),
        fingerprint_seed: remote.fingerprint_seed.clone(),
        fingerprint_overrides_json: None,
        proxy: None,
        cookies_import: None,
        cookies_import_applied_at: None,
        extensions: None,
        tags: remote.tags.clone(),
        folder: remote.folder.clone(),
        notes: None,
        password_hash: None,
    });

    let created = {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        let existing =
            crate::profile_store::list(&conn, &state.cipher).map_err(|e| anyhow!("{e}"))?;
        let name = crate::profile_portable::free_name(&existing, &row.name);
        let created =
            crate::profile_portable::create_from_portable_row(&conn, &state.cipher, &row, name)?;
        crate::profile_store::set_remote_id(&conn, &created.id, &remote.id)
            .map_err(|e| anyhow!("{e}"))?;
        created
    };

    let result = finish_materialise(state, &vault, &created.id, remote, pulled.as_ref());
    match result {
        Ok(()) => Ok(created.name),
        Err(err) => {
            if let Ok(conn) = state.db.lock() {
                let _ = crate::profile_store::delete(&conn, &created.id);
                let _ = crate::profile_store::purge(&conn, &created.id);
            }
            let _ = crate::remove_profile_data_dir(&state.profiles_dir, &created.id);
            Err(err)
        }
    }
}

/// Move the downloaded snapshot onto the new local id and restore it.
///
/// The restore is unconditional here and only here: the user-data-dir was created by this function a
/// moment ago, so there is no session in it to lose.
fn finish_materialise(
    state: &AppState,
    vault: &SnapshotVault,
    profile_id: &str,
    remote: &RemoteProfile,
    pulled: Option<&PullOutcome>,
) -> Result<()> {
    let Some(pulled) = pulled else {
        return Ok(());
    };
    let manifest = vault.manifest(&remote.id, pulled.snapshot_version)?;
    let mut artifacts = Vec::with_capacity(manifest.artifacts.len());
    for record in &manifest.artifacts {
        artifacts.push((
            record.id.clone(),
            vault.get_artifact(
                &remote.id,
                record.captured_in_version,
                &record.id,
                &record.sealed_digest,
            )?,
        ));
    }
    let adopted = vault.adopt(profile_id, &manifest, artifacts)?;
    // The scratch entry has served its purpose; leaving it would make the ledger carry a version
    // under an id no profile row names.
    let _ = vault.discard(&remote.id, pulled.snapshot_version);

    let udd = state.profiles_dir.join(profile_id);
    let target = {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        crate::snapshot::commands::identity_of_row(&conn, &state.cipher, profile_id)
            .map_err(|e| anyhow!("{e}"))?
    };
    let report = crate::snapshot::restore(vault, &udd, profile_id, adopted.version, &target, false)
        .context("restoring the downloaded profile")?;
    if !report.ok {
        bail!(
            "RESTORE_FAILED: {}",
            report
                .failure
                .clone()
                .unwrap_or_else(|| "the profile's data could not be restored".to_string())
        );
    }
    {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        crate::profile_store::mark_synced(&conn, profile_id, pulled.remote_version)
            .map_err(|e| anyhow!("{e}"))?;
    }
    Ok(())
}

// --- Lifecycle -----------------------------------------------------------------------------------

/// Whether this install can sync at all right now. Everything below is a no-op without it, silently:
/// a signed-out user has not asked for an account and must not be nagged by one.
fn signed_in() -> bool {
    cloud_auth::load_token().is_some()
}

/// Back a profile up after it stops, without making the user wait for it.
///
/// Fire-and-forget on purpose. The local ledger is the durable copy and the capture commits to it
/// before a byte reaches the network, so an upload that fails is a retry next time rather than a lost
/// session — while a Stop button that blocked on a network round trip would make a flaky connection
/// feel like a broken app. Errors are logged, never raised: the profile has already stopped, and
/// there is nothing the user could usefully do about a 502 at that moment.
pub fn spawn_backup_after_stop(app: tauri::AppHandle, profile_id: String) {
    if !signed_in() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        // Quiesced: the profile has just stopped, so this is the one moment every store is mutually
        // consistent, and it is the only mode allowed to read the LevelDB extension stores.
        match push_profile(&state, &profile_id, Some(CaptureMode::Quiesced)).await {
            Ok(outcome) => tracing::info!(
                profile_id,
                remote_version = outcome.remote_version,
                bytes = outcome.bytes,
                "backed the profile up after it stopped"
            ),
            Err(err) => tracing::warn!(
                profile_id,
                error = %format!("{err:#}"),
                "could not back the profile up after it stopped; the local snapshot is still on disk"
            ),
        }
    });
}

/// Reconcile with the account shortly after startup.
///
/// Delayed rather than immediate: first paint must not compete with a capture, and the account key
/// fetch is a network call that has no business in front of the profile list. Nothing here blocks the
/// UI, and a failure leaves the app exactly as usable as it is offline.
pub fn spawn_startup_reconcile(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        if !signed_in() {
            return;
        }
        let state = app.state::<AppState>();
        match reconcile(&state).await {
            Ok(summary) => tracing::info!(
                pushed = summary.pushed,
                pulled = summary.pulled,
                failed = summary.failed,
                "reconciled with the account"
            ),
            Err(err) => tracing::warn!(error = %format!("{err:#}"), "startup reconcile failed"),
        }
    });
}

/// Tombstone the account's row for a profile the user has permanently deleted.
///
/// Without it the next reconcile finds a row this machine has no local profile for and RESTORES it —
/// the classic resurrection bug, where deleting something makes it come back. Best-effort and
/// awaited: the local purge has already happened by the time this runs, so a failure leaves a row the
/// next delete or another machine will clear, not a half-deleted profile.
pub async fn forget_remote_row(remote_id: &str) {
    if !signed_in() {
        return;
    }
    if let Err(err) = api_call::<serde::de::IgnoredAny>(
        reqwest::Method::DELETE,
        &format!("/profiles/{remote_id}"),
        None,
    )
    .await
    {
        tracing::warn!(
            remote_id,
            error = %format!("{err:#}"),
            "could not remove the account's copy of a deleted profile"
        );
    }
}

// --- Commands ------------------------------------------------------------------------------------

/// Capture and upload one profile.
#[tauri::command]
pub async fn sync_push_profile(
    state: tauri::State<'_, AppState>,
    profile_id: String,
    capture: Option<String>,
) -> Result<PushOutcome, String> {
    let mode = match capture.as_deref() {
        None | Some("quiesced") => Some(CaptureMode::Quiesced),
        Some("live") => Some(CaptureMode::Live),
        Some("dirty") => Some(CaptureMode::Dirty),
        Some("reuse-latest") => None,
        Some(other) => return Err(format!("unknown capture mode `{other}`")),
    };
    push_profile(&state, &profile_id, mode)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Download one profile's snapshot into the local ledger. Does not touch the user-data-dir.
#[tauri::command]
pub async fn sync_pull_profile(
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<PullOutcome, String> {
    pull_profile(&state, &profile_id)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Reconcile every profile in both directions.
#[tauri::command]
pub async fn sync_now(state: tauri::State<'_, AppState>) -> Result<SyncSummary, String> {
    reconcile(&state).await.map_err(|e| format!("{e:#}"))
}

/// Where each local profile stands against the account, without touching the network.
#[tauri::command]
pub fn sync_status(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let profiles = crate::profile_store::list(&conn, &state.cipher).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(profiles.len());
    for profile in profiles {
        let link =
            crate::profile_store::sync_link(&conn, &profile.id).map_err(|e| e.to_string())?;
        out.push(serde_json::json!({
            "profileId": profile.id,
            "linked": link.as_ref().is_some_and(|l| l.remote_id.is_some()),
            "remoteVersion": link.as_ref().map(|l| l.remote_version).unwrap_or(0),
            "syncedAt": link.as_ref().and_then(|l| l.synced_at.clone()),
            "dirty": link.as_ref().is_none_or(|l| l.dirty),
        }));
    }
    Ok(out)
}

/// What one profile's snapshot weighs on the wire, both ways.
///
/// Exists so the benchmark measures the encoder the push actually uses rather than extrapolating
/// from a synthetic buffer — the number that decides whether a profile can sync at all is its real
/// payload against the server's 25 MiB limit.
#[cfg(test)]
pub(crate) fn measure_encodings(
    manifest: &SnapshotManifest,
    artifacts: Vec<(String, ArtifactBytes)>,
) -> (usize, usize) {
    let payload = SyncPayload {
        manifest: manifest.clone(),
        artifacts,
        row: None,
    };
    (
        serde_json::to_vec(&payload).unwrap().len(),
        encode_payload(&payload).unwrap().len(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob_crypto;
    use crate::snapshot::manifest::{
        ArtifactKind, ArtifactRecord, CaptureMode, Coherence, Fidelity, Identity, MANIFEST_VERSION,
    };

    fn row_fixture() -> PortableRow {
        PortableRow {
            source_profile_id: "prf_local".into(),
            name: "US Retail".into(),
            engine: "lobium".into(),
            os: "windows".into(),
            os_version: Some("11".into()),
            fingerprint_seed: "0123456789abcdef0123456789abcdef".into(),
            fingerprint_overrides_json: Some(r#"{"screen":{"width":1920}}"#.into()),
            proxy: Some(serde_json::json!({
                "host": "gw.example.com", "port": 8080, "username": "u", "password": "p"
            })),
            cookies_import: Some(serde_json::json!({ "mode": "merge", "rawText": "secret" })),
            cookies_import_applied_at: Some("2026-08-18T00:00:00Z".into()),
            extensions: Some(serde_json::json!([{ "source": "unpacked", "enabled": true }])),
            tags: vec!["retail".into()],
            folder: Some("Shopping".into()),
            notes: Some("do not launch on the laptop".into()),
            password_hash: Some("$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA".into()),
        }
    }

    fn payload_fixture(artifact: Vec<u8>) -> SyncPayload {
        SyncPayload {
            manifest: SnapshotManifest {
                manifest_version: MANIFEST_VERSION,
                profile_id: "prf_local".into(),
                version: 3,
                captured_at: "2026-08-18T00:00:00Z".into(),
                capture_mode: CaptureMode::Quiesced,
                identity: Identity::fixture(),
                coherence: Coherence::new(CaptureMode::Quiesced, 12),
                artifacts: vec![ArtifactRecord {
                    id: "cookies".into(),
                    kind: ArtifactKind::SqliteVacuum,
                    plain_digest: crate::snapshot::manifest::digest_hex(&artifact),
                    sealed_digest: "not-this-machine's".into(),
                    plain_bytes: artifact.len() as u64,
                    sealed_bytes: 0,
                    fidelity: Fidelity::Full,
                    backend: None,
                    counts: Vec::new(),
                    captured_in_version: 3,
                    offset_ms: 0,
                    content_digest: None,
                    portable: None,
                }],
                absent: Vec::new(),
                skipped: Vec::new(),
            },
            artifacts: vec![("cookies".into(), ArtifactBytes(artifact))],
            row: Some(row_fixture()),
        }
    }

    /// The property the whole phase exists for: bytes sealed for the ACCOUNT open on a machine that
    /// has never seen this install's Local Store Key, and do not open under a different account.
    ///
    /// Exercised at the envelope level rather than over HTTP, because what could silently break here
    /// is the sealing, not the transport — a wrong key must fail closed rather than yield garbage the
    /// ledger would then accept.
    #[test]
    fn a_snapshot_sealed_for_the_account_opens_only_under_that_account_key() {
        let profile_id = "prf_sync";
        let team_data_key = [0x11u8; LB_V1_KEY_LEN];
        let other_account = [0x22u8; LB_V1_KEY_LEN];

        let key = blob_crypto::derive_profile_content_key(&team_data_key, profile_id).unwrap();
        let key_id = blob_crypto::derive_key_id(&key, profile_id).unwrap();

        // Stand in for a real payload: the shape does not matter to the seal, only the bytes.
        let plaintext = br#"{"manifest":"...","artifacts":[]}"#;
        let sealed = BlobCipher::new(&key).encrypt(plaintext, &key_id).unwrap();

        // The receiving machine derives the SAME key from the same account, having never seen this
        // install's key.
        let elsewhere =
            blob_crypto::derive_profile_content_key(&team_data_key, profile_id).unwrap();
        let (opened, _) = BlobCipher::new(&elsewhere).decrypt(&sealed).unwrap();
        assert_eq!(opened, plaintext);

        // A different account cannot open it, and fails closed rather than returning something.
        let stranger = blob_crypto::derive_profile_content_key(&other_account, profile_id).unwrap();
        assert!(BlobCipher::new(&stranger).decrypt(&sealed).is_err());

        // Nor can the same account's key for a DIFFERENT profile — keys are per profile, so one
        // profile's compromise does not open another's.
        let wrong_profile =
            blob_crypto::derive_profile_content_key(&team_data_key, "prf_other").unwrap();
        assert!(BlobCipher::new(&wrong_profile).decrypt(&sealed).is_err());
    }

    #[test]
    fn a_conflict_says_what_happened_and_what_to_do() {
        // The message is the whole value of a distinct error type: "409" tells a user nothing, and
        // the wrong reaction (push harder) destroys the other machine's session.
        let err = SyncConflict {
            profile_id: "prf_x".to_string(),
            base_version: 3,
        };
        let text = err.to_string();
        assert!(text.contains("SYNC_CONFLICT"));
        assert!(text.contains("another machine"));
        assert!(text.contains("Pull it"));
    }

    /// The row is what makes a pull onto a fresh machine a recovery rather than a pile of cookies,
    /// so every field that decides identity has to survive the encoding.
    #[test]
    fn the_profile_row_survives_the_payload_encoding() {
        let payload = payload_fixture(b"cookie jar".to_vec());
        let decoded = decode_payload(&encode_payload(&payload).unwrap()).unwrap();
        let row = decoded.row.expect("the row travelled");
        let original = row_fixture();

        assert_eq!(row.fingerprint_seed, original.fingerprint_seed);
        assert_eq!(
            row.fingerprint_overrides_json,
            original.fingerprint_overrides_json
        );
        assert_eq!(row.proxy, original.proxy);
        assert_eq!(row.cookies_import, original.cookies_import);
        assert_eq!(
            row.cookies_import_applied_at,
            original.cookies_import_applied_at
        );
        assert_eq!(row.extensions, original.extensions);
        assert_eq!(row.notes, original.notes);
        assert_eq!(row.tags, original.tags);
        assert_eq!(row.password_hash, original.password_hash);
        assert_eq!(decoded.artifacts[0].1 .0, b"cookie jar");
    }

    /// The measurement that motivated the encoding: JSON renders artifact bytes as decimal lists, so
    /// a profile that fits under the server's limit as CBOR does not as JSON. The ratio, not a
    /// particular byte count, is the thing that must not regress.
    #[test]
    fn the_payload_encoding_does_not_inflate_artifact_bytes() {
        // Incompressible, so the win measured here is the encoding rather than the deflate.
        let artifact: Vec<u8> = (0..64_000u32)
            .map(|i| (i.wrapping_mul(2654435761) >> 13) as u8)
            .collect();
        let payload = payload_fixture(artifact.clone());

        let framed = encode_payload(&payload).unwrap();
        let as_json = serde_json::to_vec(&payload).unwrap();

        assert!(
            as_json.len() > artifact.len() * 3,
            "the JSON encoding used to inflate roughly fourfold; if it no longer does, this test is \
             measuring the wrong thing ({} for {} bytes of artifact)",
            as_json.len(),
            artifact.len()
        );
        assert!(
            framed.len() < artifact.len() * 3 / 2,
            "the framed encoding must stay close to the artifact's own size, got {} for {}",
            framed.len(),
            artifact.len()
        );
    }

    /// Compressible bytes are what a real profile is made of. Half is the conservative claim; the
    /// measured figure on a real IndexedDB set was 2.7x.
    #[test]
    fn a_compressible_payload_is_actually_compressed() {
        let artifact = vec![0x7au8; 512 * 1024];
        let framed = encode_payload(&payload_fixture(artifact.clone())).unwrap();
        assert!(
            framed.len() < artifact.len() / 2,
            "expected the deflate to at least halve 512 KiB of repeated bytes, got {}",
            framed.len()
        );
        assert_eq!(
            decode_payload(&framed).unwrap().artifacts[0].1 .0,
            artifact,
            "compression must be lossless"
        );
    }

    /// A snapshot pushed by a build that framed nothing must still open, and one framed with a codec
    /// this build does not know must say so rather than hand rubbish to a decoder.
    #[test]
    fn an_unframed_payload_still_reads_and_an_unknown_codec_is_named() {
        let payload = payload_fixture(b"legacy".to_vec());
        let legacy = serde_json::to_vec(&payload).unwrap();
        assert_eq!(
            decode_payload(&legacy).unwrap().artifacts[0].1 .0,
            b"legacy"
        );

        let mut future = PAYLOAD_MAGIC.to_vec();
        future.push(200);
        future.extend_from_slice(b"whatever comes next");
        let err = decode_payload(&future).unwrap_err().to_string();
        assert!(err.contains("codec 200"), "{err}");
        assert!(err.contains("Update Lobster"), "{err}");
    }

    /// The server row is the enumeration handle and nothing more. A field that leaks into it is a
    /// field the operator can read, so the set is asserted exactly rather than by absence of one name.
    #[test]
    fn the_server_row_carries_identity_and_no_secrets() {
        let row = row_fixture();
        let body = remote_row_body(&row, true);
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "engine",
                "fingerprintSeed",
                "folder",
                "name",
                "os",
                "osVersion",
                "tags"
            ],
            "the plaintext server row grew a field"
        );

        // The seed is immutable and the server's update DTO refuses it outright.
        assert!(remote_row_body(&row, false)
            .get("fingerprintSeed")
            .is_none());
    }
}
