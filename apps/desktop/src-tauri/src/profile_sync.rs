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
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use std::io::Write as _;
use std::time::{Duration, Instant};

use crate::blob_crypto::{BlobCipher, LB_V1_KEY_ID_LEN, LB_V1_KEY_LEN};
use crate::cloud_auth;
use crate::profile_portable::{ArtifactBytes, PortableRow};
use crate::snapshot::manifest::{CaptureMode, SnapshotManifest};
use crate::snapshot::vault::SnapshotVault;
use crate::AppState;
use tauri::Manager as _;

/// Where each local profile's data stands while it is arriving from the account — what the profile
/// list shows beside the row ("Downloading 3.2 / 12.5 MB", "Restoring 12/40 files"). In memory
/// only: a phase outlives nothing, and a restart that finds no data simply shows "Not downloaded
/// yet" again.
static SYNC_PHASES: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, String>>,
> = std::sync::OnceLock::new();

fn set_phase(profile_id: &str, phase: Option<&str>) {
    let phases =
        SYNC_PHASES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    if let Ok(mut map) = phases.lock() {
        match phase {
            Some(text) => {
                map.insert(profile_id.to_string(), text.to_string());
            }
            None => {
                map.remove(profile_id);
            }
        }
    }
}

fn phase_of(profile_id: &str) -> Option<String> {
    SYNC_PHASES.get()?.lock().ok()?.get(profile_id).cloned()
}

/// Clears a profile's phase when dropped.
///
/// Whoever sets a phase holds one of these for exactly as long as the phase is true, so that every
/// way out — the success path, an early `?`, a future dropped mid-download, a panic unwinding
/// through a restore — leaves the row reading nothing rather than the last thing that happened to
/// it. Clearing on one function's success path alone is how the reconcile path's restore left
/// "Restoring…" beside a row whose data had long since arrived, until the app was restarted.
struct PhaseScope<'a>(&'a str);

impl Drop for PhaseScope<'_> {
    fn drop(&mut self) {
        set_phase(self.0, None);
    }
}

/// A download reporter that writes the running figure into `profile_id`'s phase.
fn phase_reporter(profile_id: &str) -> impl FnMut(u64, Option<u64>) + '_ {
    move |received, total| set_phase(profile_id, Some(&download_phase(received, total)))
}

const KIB: u64 = 1024;
const MIB: u64 = 1024 * 1024;

/// The phrase the list shows while a snapshot is arriving: "Downloading 3.2 / 12.5 MB" when the
/// server said how much is coming, "Downloading… 3.2 MB" when it did not (a chunked response has
/// no Content-Length), and the bare "Downloading…" before the first byte of a body of unknown size.
///
/// Both figures share one unit — that of the larger of the two — so the line reads "3.2 / 12.5",
/// not "3276 KB / 12.5 MB". Binary units, the same arithmetic as [`MAX_PAYLOAD_BYTES`], so a
/// snapshot at the limit reads "25.0 MB" here and "25 MiB" in the error that names the limit
/// rather than as two different numbers for one size.
fn download_phase(received: u64, total: Option<u64>) -> String {
    match total {
        Some(total) => {
            let unit = SizeUnit::for_bytes(received.max(total));
            format!(
                "Downloading {} / {} {}",
                unit.figure(received),
                unit.figure(total),
                unit.label()
            )
        }
        None if received == 0 => "Downloading…".to_string(),
        None => {
            let unit = SizeUnit::for_bytes(received);
            format!("Downloading… {} {}", unit.figure(received), unit.label())
        }
    }
}

#[derive(Clone, Copy)]
enum SizeUnit {
    Bytes,
    Kilobytes,
    Megabytes,
}

impl SizeUnit {
    fn for_bytes(bytes: u64) -> Self {
        if bytes >= MIB {
            Self::Megabytes
        } else if bytes >= KIB {
            Self::Kilobytes
        } else {
            Self::Bytes
        }
    }

    /// One decimal for megabytes — "3.2" is what a person reads off a progress line — and whole
    /// numbers below that, where a decimal would be noise.
    fn figure(self, bytes: u64) -> String {
        match self {
            Self::Megabytes => format!("{:.1}", bytes as f64 / MIB as f64),
            Self::Kilobytes => ((bytes as f64 / KIB as f64).round() as u64).to_string(),
            Self::Bytes => bytes.to_string(),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Megabytes => "MB",
            Self::Kilobytes => "KB",
            Self::Bytes => "B",
        }
    }
}

/// One phase write per this much time, not per chunk.
///
/// A 12 MB body arrives as thousands of chunks, the list re-reads the phase every couple of
/// seconds, and a person takes in a changing number perhaps twice a second. Writing every chunk
/// would be hundreds of lock-and-format rounds a second for text nobody sees change — each one
/// contending with the `list_profiles` poll that reads the same map. Five a second is dense enough
/// to look live on a slow line and costs nothing on a fast one.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// Decides which body chunks earn a phase write; see [`PROGRESS_INTERVAL`].
struct ProgressThrottle {
    reported_at: Instant,
    reported_bytes: u64,
}

impl ProgressThrottle {
    /// Starts counting from a report of zero bytes made at `now`.
    fn new(now: Instant) -> Self {
        Self {
            reported_at: now,
            reported_bytes: 0,
        }
    }

    /// Whether `received` bytes at `now` are worth a write — and if so, records that it was made.
    fn admit(&mut self, now: Instant, received: u64) -> bool {
        if now.duration_since(self.reported_at) < PROGRESS_INTERVAL {
            return false;
        }
        self.reported_at = now;
        self.reported_bytes = received;
        true
    }

    /// Whether the figure last written is already `received`.
    fn reported(&self, received: u64) -> bool {
        self.reported_bytes == received
    }
}

/// The phrase the list shows for a profile whose data is not (fully) here, or None when it is.
///
/// "Not downloaded yet" is derived, never stored: the row came from the account (it has a remote
/// id), no server version was ever applied here (`remote_version == 0`), and there is no
/// user-data-dir. A profile created on this machine and never pushed has no remote id; one that
/// was pushed has a version — neither reads as missing.
pub(crate) fn sync_state_of(
    _state: &AppState,
    profile_id: &str,
    link: Option<&crate::profile_store::SyncLink>,
) -> Option<String> {
    if let Some(phase) = phase_of(profile_id) {
        return Some(phase);
    }
    pending_state_text(link.map(|l| l.data_state.as_str()))
}

/// The list's phrase for a profile whose data is not here. Only an explicitly recorded
/// `remote_pending` row says so — a profile created on this machine (no data directory until its
/// first launch, an account id from the moment its row is published) never does.
fn pending_state_text(data_state: Option<&str>) -> Option<String> {
    match data_state {
        Some("remote_pending") => Some("Not downloaded yet".to_string()),
        _ => None,
    }
}

/// A stalled request must not wedge a capture, but a 25 MiB upload over a poor link is legitimately
/// slow, so this is generous rather than snappy.
const HTTP_TIMEOUT: Duration = Duration::from_secs(120);

/// The server refuses a body larger than this, so refuse locally with a message that says why rather
/// than surfacing an opaque 413.
const MAX_PAYLOAD_BYTES: usize = 25 * 1024 * 1024;

/// The most a pull response may weigh on the wire before this side stops reading it.
///
/// [`MAX_PAYLOAD_BYTES`] bounds the SEALED payload; the wire carries that payload base64-encoded —
/// four bytes for every three — inside a JSON envelope, so a snapshot the push side accepted right
/// at the limit arrives as some 33 MiB of body. A cap at the payload figure would refuse exactly
/// the largest snapshots that were allowed up, which are the ones a user most needs back. The cap
/// exists because the body has to be whole before it can be decoded: a server answering with
/// something other than a snapshot must not be able to grow this process without bound.
const MAX_PULL_BODY_BYTES: u64 = (MAX_PAYLOAD_BYTES as u64).div_ceil(3) * 4 + 64 * KIB;

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
    // A push's answer is a version number; there is nothing to count.
    let res = sync_request(remote_id, &body, |_, _| {}).await?;

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
///
/// The running figure goes into `profile_id`'s phase — "Downloading 3.2 / 12.5 MB" beside that
/// row in the list while the body streams in — and the caller holds the [`PhaseScope`] that
/// clears it. A bare "Downloading…" over a 30 MB snapshot on a slow line is indistinguishable
/// from a download that has hung; the number is what tells them apart.
pub async fn pull(
    vault: &SnapshotVault,
    profile_id: &str,
    remote_id: &str,
    content_key: &[u8; LB_V1_KEY_LEN],
) -> Result<PullOutcome> {
    pull_with_progress(
        vault,
        profile_id,
        remote_id,
        content_key,
        phase_reporter(profile_id),
    )
    .await
}

/// [`pull`] with the reporter spelled out: `(bytes received, total when the server said)`.
///
/// For the one pull whose ledger entry is not the row the list shows: the sign-in path pulls
/// under the REMOTE id as a scratch entry and reports against the local row.
async fn pull_with_progress<F>(
    vault: &SnapshotVault,
    profile_id: &str,
    remote_id: &str,
    content_key: &[u8; LB_V1_KEY_LEN],
    on_progress: F,
) -> Result<PullOutcome>
where
    F: FnMut(u64, Option<u64>),
{
    let body = serde_json::json!({ "direction": "pull" });
    let SyncResponse::Ok(data) = sync_request(remote_id, &body, on_progress).await? else {
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

/// Existing local identities use the import DTO; ordinary POST /profiles is canonical-new only.
const PROFILE_IDENTITY_IMPORT_PATH: &str = "/profiles/import";

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
    /// The account's latest blob version, when the server reports it (older backends do not).
    #[serde(default)]
    pub sync_version: Option<u64>,
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

/// POST /profiles is intentionally reserved for NEW identities and accepts only a canonical
/// 128-bit seed. A local row being attached to sync is a transfer of an EXISTING identity, however,
/// and older Lobster releases issued valid lowercase-hex seeds from 8 through 256 characters. Route
/// that operation through the backend's identity-preserving import contract so a legacy profile is
/// not trapped locally or silently re-seeded.
fn remote_row_import_body(row: &PortableRow) -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "profiles": [remote_row_body(row, /* include_seed = */ true)],
    })
}

/// Create the account's row for a profile that has never been synced, returning the server's id.
///
/// This is the step that has to happen before anything else: the blob is keyed by the server id, so
/// a push against a profile the server has never heard of is a 404 with nothing to explain it.
pub async fn create_remote_row(row: &PortableRow) -> Result<RemoteProfile> {
    let mut created: Vec<RemoteProfile> = api_call(
        reqwest::Method::POST,
        PROFILE_IDENTITY_IMPORT_PATH,
        Some(remote_row_import_body(row)),
    )
    .await
    .context("creating this profile on the account")?;
    if created.len() != 1 {
        bail!(
            "the account import returned {} profiles for one local profile",
            created.len()
        );
    }
    Ok(created.remove(0))
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

/// Whether the account has a blob version this machine has not applied yet.
///
/// The version probe. Before it, the only way to learn whether the account had moved was to
/// download the whole blob — up to 25 MiB per profile — and compare its version afterwards, which
/// `reconcile` did for every clean profile on every tick. A backend that does not report the
/// version (None) keeps the old behaviour: pull and compare.
fn needs_pull(server_version: Option<u64>, last_seen: u64) -> bool {
    match server_version {
        Some(version) => version > last_seen,
        None => true,
    }
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

#[derive(Debug)]
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
pub(crate) async fn api_call<T: serde::de::DeserializeOwned>(
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

async fn sync_request<F>(
    remote_id: &str,
    body: &serde_json::Value,
    on_progress: F,
) -> Result<SyncResponse>
where
    F: FnMut(u64, Option<u64>),
{
    let token = cloud_auth::load_token().ok_or_else(|| anyhow!("not signed in"))?;
    let url = format!("{}/profiles/{remote_id}/sync", cloud_auth::api_origin());
    sync_request_at(&client()?, &url, &token, body, on_progress).await
}

/// The sync round trip itself, against a URL rather than the account — so a test can point it at
/// a throwaway local server and watch the body arrive in pieces.
async fn sync_request_at<F>(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    body: &serde_json::Value,
    on_progress: F,
) -> Result<SyncResponse>
where
    F: FnMut(u64, Option<u64>),
{
    let res = client
        .post(url)
        .bearer_auth(token)
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

    // Read chunk by chunk rather than letting reqwest buffer the body: being the one that counts
    // the bytes is the only way to say how far a download has got. The client's total timeout
    // still bounds the whole read, exactly as it bounded the buffered one.
    let total = res.content_length();
    let raw = read_body(res.bytes_stream(), total, MAX_PULL_BODY_BYTES, on_progress).await?;

    #[derive(Deserialize)]
    struct Envelope {
        code: i32,
        data: Option<SyncData>,
        msg: Option<String>,
    }
    let envelope: Envelope = serde_json::from_slice(&raw).context("parsing the sync response")?;
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

/// Read a response body to the end, reporting the count as it grows and refusing to grow past
/// `cap`.
///
/// Generic over the chunk stream so the arithmetic — the count, the cap, the throttle — runs in a
/// test against an in-memory stream, where "the server sent one byte more than allowed" is a
/// fixture rather than a network condition nobody can reproduce on demand.
async fn read_body<S, B, E, F>(
    stream: S,
    total: Option<u64>,
    cap: u64,
    mut on_progress: F,
) -> Result<Vec<u8>>
where
    S: futures_util::Stream<Item = std::result::Result<B, E>>,
    B: AsRef<[u8]>,
    E: std::error::Error + Send + Sync + 'static,
    F: FnMut(u64, Option<u64>),
{
    if let Some(declared) = total.filter(|&declared| declared > cap) {
        bail!(
            "the sync response declares {declared} bytes, over the {cap} byte limit — not \
             downloading it"
        );
    }
    // The size is news the moment the headers are in: "0.0 / 12.5 MB" says what the wait is for
    // before the first chunk lands.
    on_progress(0, total);
    let mut throttle = ProgressThrottle::new(Instant::now());
    let mut body = Vec::with_capacity(total.unwrap_or(0) as usize);
    let mut received: u64 = 0;
    let mut stream = std::pin::pin!(stream);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("reading the sync response")?;
        let chunk = chunk.as_ref();
        received += chunk.len() as u64;
        if received > cap {
            bail!(
                "the sync response passed the {cap} byte limit without ending — stopped reading it"
            );
        }
        body.extend_from_slice(chunk);
        if throttle.admit(Instant::now(), received) {
            on_progress(received, total);
        }
    }
    // The last word is the whole figure, whatever the throttle swallowed: the phase sits on this
    // number while the payload is opened and unpacked, and "12.3 / 12.5 MB" there reads as stalled.
    if !throttle.reported(received) {
        on_progress(received, total);
    }
    Ok(body)
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
            crate::profile_portable::portable_row(&conn, &state.cipher, &profile)?,
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

/// What [`reconcile`] should do with a snapshot it has just downloaded.
#[derive(Debug, PartialEq, Eq)]
enum PullDisposition {
    /// Overlay the row and stamp the watermark.
    Apply,
    /// The account has nothing newer than this machine already has. Drop the duplicate snapshot.
    Stale,
    /// The profile changed locally while the download was in flight, so this pull is already out of
    /// date. Drop it, leave the watermark alone, and let the next tick push the local edit first.
    LocallyLeads,
}

/// Decide what to do with a pulled snapshot, given the sync link as it stands RIGHT NOW.
///
/// Separated from [`reconcile`] because both of its non-`Apply` answers are bugs that were shipped
/// and are invisible in an integration test: each needs an exact interleaving of a network download
/// against a local write, which is precisely what a unit test can state and a live sync cannot.
///
/// `link_now` MUST be re-read under the same lock the overlay will be written through — the guard
/// that ran before the download is stale by definition, because `pull_profile` awaits the network
/// with the database lock released.
fn pull_disposition(
    link_now: Option<&crate::profile_store::SyncLink>,
    remote_version: u64,
    last_seen: u64,
) -> PullDisposition {
    // Dirty first: a local edit outranks a remote version regardless of how new the remote is.
    // Checking staleness first would let a newer remote overwrite an edit the user just made.
    if link_now.is_none_or(|l| l.dirty) {
        return PullDisposition::LocallyLeads;
    }
    if remote_version <= last_seen {
        return PullDisposition::Stale;
    }
    PullDisposition::Apply
}

/// Download the account's snapshot into an existing local profile's ledger.
///
/// It does NOT touch the user-data-dir. Writing another machine's session over a directory this one
/// has been using is a data-loss event dressed as a sync, so the restore is a separate, deliberate
/// step — the exception is a profile that has no user-data-dir at all, which [`reconcile`] handles
/// because there is nothing there to lose.
///
/// IT ALSO DOES NOT ADVANCE `remote_version`. That watermark is the ONLY record of what this machine
/// still has to catch up on, and a download is not a catch-up: [`reconcile`] pulls a row and can
/// still fail to apply it. When this function advanced the watermark itself, that failure was
/// permanent — the next tick read `remote_version == V`, decided nothing had moved, discarded the
/// snapshot, and never retried, while the UI reported the profile as synced. So the caller stamps
/// the watermark, and only once the row it pulled is actually in the local store.
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
    // Shown in the list while it runs, for a profile that is here as much as for one that is not:
    // a reconcile fetching a newer version of a 30 MB profile is a download the user can watch the
    // machine make, and the row-first sign-in's retry (a first download that failed lands here on
    // the next tick) was otherwise a silent gap between "Not downloaded yet" and "Restoring…".
    let _phase = PhaseScope(profile_id);
    set_phase(profile_id, Some("Downloading…"));
    pull(&vault, profile_id, &remote_id, &key).await
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

    // Profiles whose push just succeeded. The pull direction skips these: the version this machine
    // holds after a push IS the server's current one, and pulling it straight back would download
    // the whole blob — up to 25 MiB — to learn nothing.
    let mut pushed_now: std::collections::HashSet<String> = std::collections::HashSet::new();

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
        // Nothing to snapshot yet: a profile that has never been launched has no data directory.
        // Its row goes up and the dirty bit clears; capturing would fail every minute forever.
        if !state.profiles_dir.join(&profile.id).exists() {
            let published = async {
                let (remote_id, _) = ensure_remote_id(state, &profile.id).await?;
                let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
                crate::profile_store::touch_synced(&conn, &profile.id)
                    .map_err(|e| anyhow!("{e}"))?;
                Ok::<String, anyhow::Error>(remote_id)
            }
            .await;
            match published {
                Ok(_) => {
                    summary.pushed += 1;
                    summary.profiles.push(SyncedProfile {
                        profile_id: profile.id.clone(),
                        name: profile.name.clone(),
                        action: "row published".into(),
                        detail: Some(
                            "no data to upload until the profile has been launched".into(),
                        ),
                    });
                }
                Err(err) => {
                    summary.failed += 1;
                    summary.profiles.push(SyncedProfile {
                        profile_id: profile.id.clone(),
                        name: profile.name.clone(),
                        action: "failed".into(),
                        detail: Some(format!("{err:#}")),
                    });
                }
            }
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
                pushed_now.insert(profile.id.clone());
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
        let local = {
            let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
            crate::profile_store::find_by_remote_id(&conn, &state.cipher, &remote.id)
                .map_err(|e| anyhow!("{e}"))?
        };
        let Some(local) = local else {
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
            continue;
        };

        // The profile exists here. The pull direction used to stop at that fact — create-only — so
        // an edit made on another machine (a proxy attached, notes, tags, a rename) never landed on
        // a machine that already had the profile: the account's copy advanced and this one just sat
        // there. Overlay the sealed row instead, under one hard guard: a LOCALLY-DIRTY profile is
        // never touched. Its local edits are the push direction's job (it just ran, above), and
        // overwriting them with the remote copy would turn a sync into a data shredder.
        if pushed_now.contains(&local.id) {
            continue;
        }
        let link = {
            let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
            crate::profile_store::sync_link(&conn, &local.id).map_err(|e| anyhow!("{e}"))?
        };
        if link.as_ref().is_none_or(|l| l.dirty) {
            // Pushed — or failed to push — above; either way the local copy leads right now.
            continue;
        }
        let last_seen = link.map(|l| l.remote_version).unwrap_or(0);
        if !needs_pull(remote.sync_version, last_seen) {
            summary.profiles.push(SyncedProfile {
                profile_id: local.id.clone(),
                name: local.name.clone(),
                action: "current".into(),
                detail: Some(format!("version {last_seen}")),
            });
            continue;
        }

        match pull_profile(state, &local.id).await {
            Ok(outcome) => {
                // The snapshot is in the ledger for a deliberate restore (`pull_profile` never
                // touches a user-data-dir this machine is using); the ROW is applied now, because
                // proxy, notes, tags and folder are what "profile sync" means between launches. A
                // payload from before rows travelled has nothing to overlay.
                //
                // Both decisions are made against a link re-read under the lock the overlay writes
                // through: the pre-download guard is stale by construction, because `pull_profile`
                // awaits the network with the lock released.
                let applied = {
                    let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
                    let link_now = crate::profile_store::sync_link(&conn, &local.id)
                        .map_err(|e| anyhow!("{e}"))?;
                    match pull_disposition(link_now.as_ref(), outcome.remote_version, last_seen) {
                        PullDisposition::Apply => {}
                        // Nothing moved server-side, or a local edit landed mid-download. Either way
                        // the pull adopted a snapshot we do not want: drop it (reconcile runs every
                        // minute now, and keeping one duplicate per tick would grow the ledger
                        // without bound) and leave the watermark exactly where it was, so a genuine
                        // remote change is still seen as new on the next tick. No summary entry —
                        // the push loop already reported this profile.
                        PullDisposition::Stale | PullDisposition::LocallyLeads => {
                            drop(conn);
                            if let Ok(vault) = open_vault(state) {
                                let _ = vault.discard(&local.id, outcome.snapshot_version);
                            }
                            continue;
                        }
                    }
                    match outcome.row.as_ref() {
                        Some(row) => apply_portable_row(&conn, &state.cipher, &local, row),
                        None => Ok(()),
                    }
                    .and_then(|()| {
                        // Stamp ONLY here, on the success path. `apply_portable_row` bumped
                        // `updated_at` past `synced_at`, so without this the overlay this machine
                        // just ACCEPTED would be pushed straight back on the next tick as if it
                        // were a local edit. And because `pull_profile` no longer stamps, a failure
                        // below leaves the watermark at `last_seen`, so the next tick genuinely
                        // retries instead of concluding that nothing moved.
                        crate::profile_store::mark_synced(&conn, &local.id, outcome.remote_version)
                            .map_err(|e| anyhow!("{e}"))
                            .map(|_| ())
                    })
                };
                // A row that came from the account before its data did (row-first sign-in) has
                // no user-data-dir yet: this pull IS its data, so restore it as well as record it.
                let applied = match applied {
                    Ok(()) if !state.profiles_dir.join(&local.id).exists() => {
                        let _phase = PhaseScope(&local.id);
                        match open_vault(state) {
                            Ok(vault) => {
                                restore_pulled(state, &vault, &local.id, &local.id, &outcome)
                                    .and_then(|()| {
                                        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
                                        crate::profile_store::set_data_state(
                                            &conn, &local.id, "local",
                                        )
                                        .map_err(|e| anyhow!("{e}"))
                                        .map(|_| ())
                                    })
                            }
                            Err(err) => Err(err),
                        }
                    }
                    other => other,
                };
                match applied {
                    Ok(()) => {
                        summary.pulled += 1;
                        summary.profiles.push(SyncedProfile {
                            profile_id: local.id.clone(),
                            name: local.name.clone(),
                            action: "pulled".into(),
                            detail: Some(format!("version {}", outcome.remote_version)),
                        });
                    }
                    Err(err) => {
                        summary.failed += 1;
                        summary.profiles.push(SyncedProfile {
                            profile_id: local.id.clone(),
                            name: local.name.clone(),
                            action: "failed".into(),
                            detail: Some(format!("{err:#}")),
                        });
                    }
                }
            }
            Err(err) => {
                summary.failed += 1;
                summary.profiles.push(SyncedProfile {
                    profile_id: local.id.clone(),
                    name: local.name.clone(),
                    action: "failed".into(),
                    detail: Some(format!("{err:#}")),
                });
            }
        }
    }

    Ok(summary)
}

/// Overlay a sealed row that arrived from the account onto a profile this machine already has.
///
/// The update half of what [`materialise`] does for a profile that does not exist yet. Only the
/// fields [`crate::profile_store::UpdateProfilePatch`] can express are applied — which is every
/// portable field except identity (the seed is immutable; engine and OS are store-gated and never
/// legitimately change under a profile) and the password hash (not patchable, and silently swapping
/// a lock the user is relying on is not a background sync's call). The patch shape cannot express
/// CLEARING an optional field (`None` means "keep"), so a field the remote emptied stays as it was
/// locally — conservative on purpose.
fn apply_portable_row(
    conn: &rusqlite::Connection,
    cipher: &crate::secrets::SecretCipher,
    local: &crate::profile_store::Profile,
    row: &PortableRow,
) -> Result<()> {
    use crate::profile_portable::AdoptedProxy;

    // The same helper the import path uses, for the same reason: the blob names its catalog entry,
    // and this machine may not have that entry yet — re-materialising it is precisely how "the
    // proxy is not imported from the DB" gets fixed for a profile that already exists here.
    let (proxy, proxy_id) = match row.proxy.as_ref() {
        Some(blob) => match crate::profile_portable::adopt_portable_proxy(conn, cipher, blob)? {
            // `Some(id)` selects the catalog entry; the store nulls the inline column itself.
            AdoptedProxy::Catalog { id } => (None, Some(id)),
            // An inline blob plus an EMPTY selection clears any stale catalog binding — the store
            // reads `Some("")` as "no stored proxy selected", exactly as the edit form sends it.
            AdoptedProxy::Inline(value) => (Some(value), Some(String::new())),
        },
        // A row with NO proxy is not an order to clear the local one. Every blob pushed by a
        // pre-fix build carries `proxy: None` for every catalog-bound profile (the very defect this
        // was fixed for), and honouring that as a clear would let one machine on old code delete
        // the proxies a fixed machine just preserved.
        None => (None, None),
    };

    // A name that collides with a DIFFERENT local profile is suffixed, never forced: the import
    // path already makes this promise, and two rows under one name is the confusion `free_name`
    // exists to prevent.
    let name = if row.name == local.name {
        None
    } else {
        let others: Vec<_> = crate::profile_store::list(conn, cipher)
            .map_err(|e| anyhow!("{e}"))?
            .into_iter()
            .filter(|p| p.id != local.id)
            .collect();
        Some(crate::profile_portable::free_name(&others, &row.name))
    };

    let fingerprint_overrides = match &row.fingerprint_overrides_json {
        Some(text) => Some(
            serde_json::from_str::<serde_json::Value>(text)
                .context("the synced profile's fingerprint overrides are malformed")?,
        ),
        None => None,
    };

    crate::profile_store::update(
        conn,
        cipher,
        &local.id,
        crate::profile_store::UpdateProfilePatch {
            name,
            engine: None,
            os: None,
            os_version: row.os_version.clone(),
            fingerprint_overrides,
            proxy,
            proxy_id,
            template_id: None,
            cookies_import: row.cookies_import.clone(),
            extensions: row.extensions.clone(),
            tags: Some(row.tags.clone()),
            folder: row.folder.clone(),
            notes: row.notes.clone(),
        },
    )
    .map_err(|e| anyhow!("{e}"))?
    .ok_or_else(|| {
        anyhow!(
            "profile {} vanished while applying the pulled row",
            local.id
        )
    })?;

    // A DIFFERENT cookie-import draft re-arms the applied stamp inside `update`; if the machine
    // that pushed it had already injected it, carry that fact across so this machine's next launch
    // does not inject the same stale session again.
    if row.cookies_import_applied_at.is_some() {
        crate::profile_store::mark_cookie_import_applied(conn, &local.id)
            .map_err(|e| anyhow!("{e}"))?;
    }
    Ok(())
}

/// Bring a profile the account has and this machine does not into existence, data and all.
///
/// The sealed row is preferred over the account's plaintext one: it carries the proxy, its
/// credentials, the notes and the cookie import, none of which the server row holds. Falling back to
/// the server row is what makes a profile created on the website — which has never pushed a
/// snapshot — arrive here as a usable profile rather than not at all.
async fn materialise(state: &AppState, remote: &RemoteProfile) -> Result<String> {
    // THE ROW FIRST, THE DATA SECOND. A second machine used to download and restore every profile
    // before a single one appeared, and a download that failed deleted the row it had created — so a
    // slow line or one bad snapshot looked like "no profiles" for as long as it kept failing. Now
    // the list is complete as soon as the account has been asked, each row says where its data
    // stands, and the data arrives behind it (or at launch, see `ensure_materialised`).
    let row = crate::profile_portable::PortableRow {
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
    };
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

    // A profile the account knows but no machine ever synced has no snapshot: the row IS the
    // profile, and there is nothing to download.
    if remote.sync_version == Some(0) {
        return Ok(created.name);
    }
    {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        crate::profile_store::set_data_state(&conn, &created.id, "remote_pending")
            .map_err(|e| anyhow!("{e}"))?;
    }

    match fetch_into(state, &created, &remote.id).await {
        Ok(()) => Ok(created.name),
        Err(err) => {
            // The row stays: the list shows it as not downloaded, the next tick retries, and Run
            // fetches it on demand. Deleting it was how a failed download became a missing profile.
            tracing::warn!(
                profile_id = %created.id,
                remote_id = %remote.id,
                error = %format!("{err:#}"),
                "the profile's data did not arrive; the row is kept and the download will be retried"
            );
            Err(err)
        }
    }
}

/// Download the account's snapshot for `profile` (keyed by `remote_id`) and put it in place:
/// the sealed fields onto the row, the artifacts into the user-data-dir, the watermark last.
/// The list shows each phase while it runs.
async fn fetch_into(
    state: &AppState,
    profile: &crate::profile_store::Profile,
    remote_id: &str,
) -> Result<()> {
    let _phase = PhaseScope(&profile.id);
    set_phase(&profile.id, Some("Downloading…"));
    let (key, _) = content_key(state, remote_id)?;
    let vault = open_vault(state)?;
    // Pulled under the REMOTE id as a scratch entry: the ledger is keyed by profile id, and the
    // restore below adopts it under the local one. The progress goes to the LOCAL id, which is
    // the row the list shows.
    let pulled = pull_with_progress(
        &vault,
        remote_id,
        remote_id,
        &key,
        phase_reporter(&profile.id),
    )
    .await?;
    if let Some(row) = pulled.row.as_ref() {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        apply_portable_row(&conn, &state.cipher, profile, row)?;
    }
    restore_pulled(state, &vault, &profile.id, remote_id, &pulled)?;
    let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
    crate::profile_store::set_data_state(&conn, &profile.id, "local")
        .map_err(|e| anyhow!("{e}"))?;
    Ok(())
}

/// Make sure a profile's data is on this machine before it is used — the on-demand half of the
/// row-first sign-in. A profile whose data is already here returns at once with `false`.
pub async fn ensure_materialised(state: &AppState, profile_id: &str) -> Result<bool> {
    let (profile, link) = {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        let profile = crate::profile_store::get(&conn, &state.cipher, profile_id)
            .map_err(|e| anyhow!("{e}"))?
            .ok_or_else(|| anyhow!("profile {profile_id} not found"))?;
        let link =
            crate::profile_store::sync_link(&conn, profile_id).map_err(|e| anyhow!("{e}"))?;
        (profile, link)
    };
    // Only a row that arrived ahead of its data fetches. Anything else — a profile created here,
    // one that already applied a version, one whose data landed — launches with what it has.
    let Some(link) = link.filter(|l| l.data_state == "remote_pending") else {
        return Ok(false);
    };
    let Some(remote_id) = link.remote_id.clone() else {
        return Ok(false);
    };
    if !signed_in() {
        bail!("this profile's data has not been downloaded yet — sign in to fetch it");
    }
    ensure_account_key(state).await?;
    fetch_into(state, &profile, &remote_id)
        .await
        .context("downloading the profile's data from your account")?;
    Ok(true)
}

/// Put a pulled snapshot in place: adopt its artifacts under the local profile id, restore them into
/// the user-data-dir, and only then advance the watermark — so a restore that fails is retried.
/// Sets the "Restoring…" phases and clears none of them: the caller holds the [`PhaseScope`].
fn restore_pulled(
    state: &AppState,
    vault: &SnapshotVault,
    profile_id: &str,
    source_id: &str,
    pulled: &PullOutcome,
) -> Result<()> {
    let manifest = vault.manifest(source_id, pulled.snapshot_version)?;
    let total = manifest.artifacts.len();
    let mut artifacts = Vec::with_capacity(total);
    for (index, record) in manifest.artifacts.iter().enumerate() {
        set_phase(
            profile_id,
            Some(&format!("Restoring {}/{} files", index + 1, total)),
        );
        artifacts.push((
            record.id.clone(),
            vault.get_artifact(
                source_id,
                record.captured_in_version,
                &record.id,
                &record.sealed_digest,
            )?,
        ));
    }
    // A pull made under the local id (the reconcile path) is already in the ledger where the
    // restore reads it; a scratch pull under the remote id (sign-in) is adopted under the local id
    // first, and the scratch entry dropped so the ledger never carries a version no row names.
    let version = if source_id == profile_id {
        pulled.snapshot_version
    } else {
        let adopted = vault.adopt(profile_id, &manifest, artifacts)?;
        let _ = vault.discard(source_id, pulled.snapshot_version);
        adopted.version
    };

    set_phase(profile_id, Some("Restoring…"));
    let udd = state.profiles_dir.join(profile_id);
    let target = {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        crate::snapshot::commands::identity_of_row(&conn, &state.cipher, profile_id)
            .map_err(|e| anyhow!("{e}"))?
    };
    let report = crate::snapshot::restore(vault, &udd, profile_id, version, &target, false)
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
pub(crate) fn signed_in() -> bool {
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

/// Push a profile the moment it is created or edited, without making the caller wait.
///
/// Fire-and-forget for the same reason as [`spawn_backup_after_stop`]: the local store is the
/// durable copy and has already committed, so a failed upload is a retry on the next reconcile tick
/// rather than a lost edit — while a Save button blocking on a network round trip would make a
/// flaky connection feel like a broken app. This exists because reconcile used to be the ONLY push
/// trigger for row edits: attach a proxy here and the other machine saw nothing until this one next
/// restarted — "sync" that was not remotely instant.
///
/// The push reuses the newest snapshot (no capture): what changed is the ROW — name, proxy, notes —
/// and the sealed payload re-sent around it is what carries those fields. A profile with no
/// snapshot yet (just created, never launched) has nothing for `push` to wrap, so only its remote
/// row is published — enough for other machines to materialise it instantly — and it stays dirty,
/// so the first real capture (on stop, or on a reconcile tick) uploads the blob.
pub fn spawn_push_after_write(app: tauri::AppHandle, profile_id: String) {
    if !signed_in() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let has_snapshot = open_vault(&state)
            .ok()
            .and_then(|vault| vault.latest_version(&profile_id).ok().flatten())
            .is_some();
        if has_snapshot {
            match push_profile(&state, &profile_id, None).await {
                Ok(outcome) => tracing::info!(
                    profile_id,
                    remote_version = outcome.remote_version,
                    "pushed the profile after a local write"
                ),
                Err(err) => tracing::warn!(
                    profile_id,
                    error = %format!("{err:#}"),
                    "could not push the profile after a local write; reconcile will retry"
                ),
            }
            return;
        }
        let published = async {
            ensure_account_key(&state).await?;
            ensure_remote_id(&state, &profile_id).await
        }
        .await;
        match published {
            Ok((remote_id, _row)) => {
                if let Ok(conn) = state.db.lock() {
                    let _ = crate::profile_store::touch_synced(&conn, &profile_id);
                }
                tracing::info!(
                    profile_id,
                    remote_id,
                    "published the profile's row after a local write; no snapshot to upload yet"
                )
            }
            Err(err) => tracing::warn!(
                profile_id,
                error = %format!("{err:#}"),
                "could not publish the profile's row after a local write; reconcile will retry"
            ),
        }
    });
}

/// How often this machine and the account re-agree while the app stays open.
///
/// One minute is the "instant enough" point: an edit on another machine lands here within a tick,
/// while a clean profile's cost per tick stays one blob download (see `reconcile`'s pull side) —
/// tight enough to feel live, loose enough not to saturate a metered connection.
const RECONCILE_INTERVAL: Duration = Duration::from_secs(60);

/// Reconcile with the account shortly after startup, then KEEP reconciling while the app runs.
///
/// A loop, not a one-shot: reconcile used to run exactly once per launch, so a profile created or
/// edited on another machine while this one sat open never appeared until the next restart —
/// nothing later ever landed. Delayed rather than immediate on the first pass: first paint must not
/// compete with a capture, and the account key fetch is a network call that has no business in
/// front of the profile list. Nothing here blocks the UI, and a failed tick leaves the app exactly
/// as usable as it is offline.
pub fn spawn_startup_reconcile(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            // Checked INSIDE the loop, not once before it: signing in mid-session must start the
            // sync on the next tick rather than after a restart — and signing out must stop it
            // just as quietly.
            if signed_in() {
                let state = app.state::<AppState>();
                match reconcile(&state).await {
                    Ok(summary) => tracing::info!(
                        pushed = summary.pushed,
                        pulled = summary.pulled,
                        failed = summary.failed,
                        "reconciled with the account"
                    ),
                    Err(err) => tracing::warn!(error = %format!("{err:#}"), "reconcile failed"),
                }
            }
            tokio::time::sleep(RECONCILE_INTERVAL).await;
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
///
/// This one DOES stamp the watermark, because the user asked for exactly this and nothing further is
/// pending: the snapshot is in the ledger, and there is no row-apply step that could still fail.
/// [`reconcile`] has one, which is why [`pull_profile`] leaves the stamp to its caller.
#[tauri::command]
pub async fn sync_pull_profile(
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<PullOutcome, String> {
    let outcome = pull_profile(&state, &profile_id)
        .await
        .map_err(|e| format!("{e:#}"))?;
    {
        let conn = state.db.lock().map_err(|e| format!("{e}"))?;
        crate::profile_store::mark_synced(&conn, &profile_id, outcome.remote_version)
            .map_err(|e| format!("{e}"))?;
    }
    Ok(outcome)
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
    #[test]
    fn only_an_explicitly_pending_row_reads_as_not_downloaded() {
        assert_eq!(
            super::pending_state_text(Some("remote_pending")).as_deref(),
            Some("Not downloaded yet")
        );
        assert_eq!(
            super::pending_state_text(Some("local")),
            None,
            "created here: never"
        );
        assert_eq!(
            super::pending_state_text(None),
            None,
            "no link at all: never"
        );
        assert_eq!(
            super::pending_state_text(Some("")),
            None,
            "unknown value: never"
        );
    }

    #[test]
    fn a_sync_phase_is_shown_while_set_and_gone_when_cleared() {
        super::set_phase("p-phase", Some("Downloading…"));
        assert_eq!(super::phase_of("p-phase").as_deref(), Some("Downloading…"));
        super::set_phase("p-phase", Some("Restoring 3/9 files"));
        assert_eq!(
            super::phase_of("p-phase").as_deref(),
            Some("Restoring 3/9 files")
        );
        super::set_phase("p-phase", None);
        assert_eq!(super::phase_of("p-phase"), None);
    }

    #[test]
    fn the_version_probe_pulls_only_when_the_account_moved_on() {
        assert!(
            !super::needs_pull(Some(3), 3),
            "same version: nothing to fetch"
        );
        assert!(
            !super::needs_pull(Some(2), 3),
            "server behind (after a push): nothing to fetch"
        );
        assert!(super::needs_pull(Some(4), 3), "server ahead: pull");
        assert!(
            super::needs_pull(None, 3),
            "a backend that cannot say: pull and compare, as before"
        );
        assert!(
            !super::needs_pull(Some(0), 0),
            "never synced anywhere: nothing to fetch"
        );
    }

    use super::*;
    use crate::blob_crypto;
    use crate::snapshot::manifest::{
        ArtifactKind, ArtifactRecord, CaptureMode, Coherence, Fidelity, Identity, MANIFEST_VERSION,
    };

    // --- Download progress -----------------------------------------------------------------------

    #[test]
    fn a_phase_scope_clears_the_phase_however_the_operation_ends() {
        // The reconcile path's restore used to leave "Restoring…" beside a row for the life of the
        // process, because only the success path of a different function cleared it.
        let outcome: Result<()> = (|| {
            let _phase = PhaseScope("p-scope");
            set_phase("p-scope", Some("Restoring 1/2 files"));
            assert_eq!(phase_of("p-scope").as_deref(), Some("Restoring 1/2 files"));
            bail!("the restore failed half way");
        })();
        assert!(outcome.is_err());
        assert_eq!(
            phase_of("p-scope"),
            None,
            "an early exit must not leave the phase behind"
        );
    }

    #[test]
    fn the_download_phrase_carries_real_numbers() {
        // Known total: one shared unit, one decimal for megabytes.
        assert_eq!(
            download_phase(3_355_443, Some(13_107_200)),
            "Downloading 3.2 / 12.5 MB"
        );
        // The size shows before the first byte, and the whole figure at the end.
        assert_eq!(
            download_phase(0, Some(13_107_200)),
            "Downloading 0.0 / 12.5 MB"
        );
        assert_eq!(
            download_phase(13_107_200, Some(13_107_200)),
            "Downloading 12.5 / 12.5 MB"
        );
        // The received figure takes the total's unit even while it is tiny.
        assert_eq!(
            download_phase(4_096, Some(13_107_200)),
            "Downloading 0.0 / 12.5 MB"
        );
        // Under a megabyte: whole kilobytes, where a decimal would be noise.
        assert_eq!(
            download_phase(122_880, Some(655_360)),
            "Downloading 120 / 640 KB"
        );
        assert_eq!(download_phase(0, Some(512)), "Downloading 0 / 512 B");

        // Unknown total (a chunked response): a count, and the bare word before there is one.
        assert_eq!(download_phase(0, None), "Downloading…");
        assert_eq!(download_phase(3_355_443, None), "Downloading… 3.2 MB");
        assert_eq!(download_phase(122_880, None), "Downloading… 120 KB");
        assert_eq!(download_phase(512, None), "Downloading… 512 B");
    }

    #[test]
    fn the_download_phrase_rounds_and_changes_unit_where_a_person_would() {
        assert_eq!(
            download_phase(1_150_000, None),
            "Downloading… 1.1 MB",
            "1.097 rounds up"
        );
        assert_eq!(
            download_phase(1_100_000, None),
            "Downloading… 1.0 MB",
            "1.049 rounds down"
        );
        assert_eq!(
            download_phase(1_600, None),
            "Downloading… 2 KB",
            "1.56 KB rounds up"
        );
        assert_eq!(
            download_phase(1_500, None),
            "Downloading… 1 KB",
            "1.46 KB rounds down"
        );
        // Thresholds: a full unit is one of that unit; one byte less is still the smaller unit.
        assert_eq!(download_phase(1_048_576, None), "Downloading… 1.0 MB");
        assert_eq!(download_phase(1_048_575, None), "Downloading… 1024 KB");
        assert_eq!(download_phase(1_024, None), "Downloading… 1 KB");
        assert_eq!(download_phase(1_023, None), "Downloading… 1023 B");
    }

    #[test]
    fn progress_is_written_at_most_a_few_times_a_second() {
        let t0 = Instant::now();
        let mut throttle = ProgressThrottle::new(t0);
        assert!(
            !throttle.admit(t0 + Duration::from_millis(50), 16 * KIB),
            "too soon after the last write"
        );
        assert!(!throttle.admit(t0 + Duration::from_millis(199), 32 * KIB));
        assert!(
            throttle.admit(t0 + Duration::from_millis(200), 48 * KIB),
            "the interval has elapsed"
        );
        // The interval restarts from the write that was admitted, not from the one refused.
        assert!(!throttle.admit(t0 + Duration::from_millis(399), 64 * KIB));
        assert!(throttle.admit(t0 + Duration::from_millis(400), 80 * KIB));
        // What was last written is what the closing write is measured against.
        assert!(throttle.reported(80 * KIB));
        assert!(!throttle.reported(96 * KIB));
    }

    #[tokio::test]
    async fn a_streamed_body_is_reassembled_counted_and_reported() {
        // 120 chunks of 100 KiB, each filled with its own index, so a reordered or dropped chunk
        // shows in the bytes and not only in the count.
        const CHUNK: usize = 100 * 1024;
        let chunks: Vec<std::result::Result<Vec<u8>, std::io::Error>> =
            (0..120u8).map(|i| Ok(vec![i; CHUNK])).collect();
        let total = (120 * CHUNK) as u64;
        let mut reports: Vec<(u64, Option<u64>)> = Vec::new();
        let body = read_body(
            futures_util::stream::iter(chunks),
            Some(total),
            MAX_PULL_BODY_BYTES,
            |received, total| reports.push((received, total)),
        )
        .await
        .unwrap();

        assert_eq!(body.len() as u64, total);
        assert!(body
            .chunks(CHUNK)
            .enumerate()
            .all(|(i, chunk)| chunk.iter().all(|&b| b == i as u8)));
        assert_eq!(
            reports.first(),
            Some(&(0, Some(total))),
            "the size is announced before the first byte"
        );
        assert_eq!(
            reports.last(),
            Some(&(total, Some(total))),
            "the last word is the whole figure"
        );
        assert!(
            reports.windows(2).all(|pair| pair[0].0 <= pair[1].0),
            "the count never goes backwards: {reports:?}"
        );
        assert!(
            reports.len() < 120,
            "120 chunks must not become 120 phase writes; got {}",
            reports.len()
        );
    }

    #[tokio::test]
    async fn a_slow_body_reports_as_it_trickles_in() {
        // Three chunks, each a beat apart: a slow line must produce a moving number, not the start
        // and end figures with silence in between.
        let chunks = futures_util::stream::iter(
            (1..=3u64).map(|i| Ok::<Vec<u8>, std::io::Error>(vec![0u8; (i * KIB) as usize])),
        )
        .then(|chunk| async move {
            tokio::time::sleep(PROGRESS_INTERVAL + Duration::from_millis(20)).await;
            chunk
        });
        let mut reports = Vec::new();
        read_body(chunks, None, MAX_PULL_BODY_BYTES, |received, total| {
            reports.push((received, total))
        })
        .await
        .unwrap();
        assert_eq!(
            reports,
            vec![(0, None), (KIB, None), (3 * KIB, None), (6 * KIB, None)]
        );
    }

    #[tokio::test]
    async fn a_body_over_the_limit_is_refused_before_or_during_the_read() {
        // Declared over the limit: refused on the headers, before a byte is read — the stream here
        // would fail the test with its own message if it were polled at all.
        let never: Vec<std::result::Result<Vec<u8>, std::io::Error>> =
            vec![Err(std::io::Error::other("the body must not be read"))];
        let mut reports = 0;
        let err = read_body(futures_util::stream::iter(never), Some(251), 250, |_, _| {
            reports += 1
        })
        .await
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("declares 251 bytes") && err.contains("250 byte limit"),
            "{err}"
        );
        assert_eq!(
            reports, 0,
            "nothing to report about a download that never started"
        );

        // No declared size and the chunks keep coming: stopped at the first byte past the limit,
        // holding at most one chunk over the cap rather than whatever the server felt like sending.
        let endless: Vec<std::result::Result<Vec<u8>, std::io::Error>> =
            (0..4).map(|_| Ok(vec![0u8; 100])).collect();
        let err = read_body(futures_util::stream::iter(endless), None, 250, |_, _| {})
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("250 byte limit"), "{err}");
    }

    #[test]
    fn the_pull_limit_admits_a_snapshot_the_push_side_accepted_at_its_limit() {
        // The wire carries the sealed payload as base64 inside a JSON envelope. A cap at the
        // payload figure would refuse the largest snapshots that were allowed up.
        let sealed_at_limit = vec![0u8; MAX_PAYLOAD_BYTES];
        let on_the_wire = serde_json::to_vec(&serde_json::json!({
            "code": 0,
            "data": {
                "version": 1,
                "payload": base64::engine::general_purpose::STANDARD.encode(&sealed_at_limit),
            },
            "msg": null,
        }))
        .unwrap();
        assert!(
            (on_the_wire.len() as u64) <= MAX_PULL_BODY_BYTES,
            "{} bytes on the wire against a {} byte cap",
            on_the_wire.len(),
            MAX_PULL_BODY_BYTES
        );
    }

    /// Answer every connection with `response`, byte for byte, and return the URL to post to.
    fn serve_raw(response: Vec<u8>) -> String {
        use std::io::{Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut stream) = conn else { break };
                // The request is a few hundred bytes of head and a one-field JSON body; nothing in
                // it decides the answer.
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(&response);
                let _ = stream.flush();
            }
        });
        format!("http://{addr}/profiles/rp_test/sync")
    }

    fn framed_with_length(body: &[u8], declared: u64) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {declared}\r\n\
             Connection: close\r\n\r\n"
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    /// Chunked transfer encoding: the framing a server uses when it does not know the size up
    /// front, and the one case in which the client cannot either.
    fn framed_chunked(body: &[u8]) -> Vec<u8> {
        let mut out = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                        Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
            .to_vec();
        for chunk in body.chunks(64 * 1024) {
            out.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
            out.extend_from_slice(chunk);
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(b"0\r\n\r\n");
        out
    }

    /// A pull envelope the size a real one is: a base64 payload of a megabyte or so.
    fn sync_envelope_fixture() -> (Vec<u8>, String) {
        let sealed: Vec<u8> = (0..1_200_000u32)
            .map(|i| (i.wrapping_mul(2654435761) >> 13) as u8)
            .collect();
        let payload = base64::engine::general_purpose::STANDARD.encode(&sealed);
        let body = serde_json::to_vec(&serde_json::json!({
            "code": 0,
            "data": { "version": 7, "payload": payload },
            "msg": null,
        }))
        .unwrap();
        (body, payload)
    }

    #[tokio::test]
    async fn a_pull_streams_its_body_and_says_how_far_it_has_got() {
        let (body, payload) = sync_envelope_fixture();
        let total = body.len() as u64;
        let request = serde_json::json!({ "direction": "pull" });

        // Framed with a Content-Length: figures against a total.
        let url = serve_raw(framed_with_length(&body, total));
        let mut reports = Vec::new();
        let answer = sync_request_at(&client().unwrap(), &url, "token", &request, |r, t| {
            reports.push((r, t))
        })
        .await
        .unwrap();
        let SyncResponse::Ok(data) = answer else {
            panic!("a pull answered with a conflict")
        };
        assert_eq!(data.version, 7);
        assert_eq!(
            data.payload.as_deref(),
            Some(payload.as_str()),
            "the envelope parses exactly as it did when reqwest buffered it"
        );
        assert_eq!(reports.first(), Some(&(0, Some(total))));
        assert_eq!(reports.last(), Some(&(total, Some(total))));
        let (received, known) = *reports.last().unwrap();
        assert_eq!(download_phase(received, known), "Downloading 1.5 / 1.5 MB");

        // Chunked, no Content-Length: a count without a total.
        let url = serve_raw(framed_chunked(&body));
        let mut reports = Vec::new();
        let answer = sync_request_at(&client().unwrap(), &url, "token", &request, |r, t| {
            reports.push((r, t))
        })
        .await
        .unwrap();
        let SyncResponse::Ok(data) = answer else {
            panic!("a pull answered with a conflict")
        };
        assert_eq!(data.payload.as_deref(), Some(payload.as_str()));
        assert!(
            reports.iter().all(|(_, total)| total.is_none()),
            "a chunked body has no total to show: {reports:?}"
        );
        assert_eq!(reports.last().map(|report| report.0), Some(total));
        assert_eq!(download_phase(total, None), "Downloading… 1.5 MB");
    }

    #[tokio::test]
    async fn a_pull_declared_over_the_limit_is_refused_without_reading_it() {
        // The head alone, with no body behind it: a client that tried to read the body it was told
        // about would sit on the connection instead of answering at once.
        let url = serve_raw(framed_with_length(b"", MAX_PULL_BODY_BYTES + 1));
        let mut reports = 0;
        let err = sync_request_at(
            &client().unwrap(),
            &url,
            "token",
            &serde_json::json!({ "direction": "pull" }),
            |_, _| reports += 1,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("byte limit"), "{err}");
        assert_eq!(reports, 0);
    }

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

    /// Sync is identity transfer, not creation of a fresh browser identity. In particular, a seed
    /// minted by an older release must use the backend's legacy-compatible import DTO while the
    /// ordinary POST /profiles contract remains free to require a new canonical 128-bit seed.
    #[test]
    fn a_legacy_seed_uses_the_identity_preserving_import_contract() {
        assert_eq!(PROFILE_IDENTITY_IMPORT_PATH, "/profiles/import");
        let mut row = row_fixture();
        row.fingerprint_seed = "deadbeef".into();

        let body = remote_row_import_body(&row);
        assert_eq!(
            body.get("version").and_then(serde_json::Value::as_u64),
            Some(1)
        );
        let profiles = body
            .get("profiles")
            .and_then(serde_json::Value::as_array)
            .expect("the import envelope carries a profiles array");
        assert_eq!(profiles.len(), 1);
        assert_eq!(
            profiles[0]
                .get("fingerprintSeed")
                .and_then(serde_json::Value::as_str),
            Some("deadbeef"),
            "sync must preserve the legacy identity byte-for-byte"
        );
        assert!(
            profiles[0].get("proxy").is_none()
                && profiles[0].get("notes").is_none()
                && profiles[0].get("cookiesImport").is_none(),
            "the import envelope must remain a secret-free server row"
        );
    }

    // --- Applying a pulled row to a profile this machine already has -----------------------------
    //
    // The pull direction used to be create-only, so these fields never landed on a machine that
    // already had the profile. The overlay is what makes an edit made elsewhere arrive here.

    fn store_fixture() -> (rusqlite::Connection, crate::secrets::SecretCipher) {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::profile_store::SCHEMA).unwrap();
        conn.execute_batch(crate::proxy_store::SCHEMA).unwrap();
        (conn, crate::secrets::SecretCipher::new(&[7u8; 32]))
    }

    fn local_profile(
        conn: &rusqlite::Connection,
        cipher: &crate::secrets::SecretCipher,
        proxy: Option<serde_json::Value>,
        proxy_id: Option<String>,
    ) -> crate::profile_store::Profile {
        crate::profile_store::create(
            conn,
            cipher,
            crate::profile_store::CreateProfileInput {
                name: "US Retail".into(),
                engine: "lobium".into(),
                os: "windows".into(),
                os_version: Some("11".into()),
                fingerprint_seed: None,
                fingerprint_overrides: None,
                proxy,
                proxy_id,
                template_id: None,
                cookies_import: None,
                extensions: None,
                tags: Some(vec!["stale".into()]),
                folder: None,
                notes: None,
            },
        )
        .unwrap()
    }

    #[test]
    fn a_pulled_row_overlays_the_local_profile_and_rematerialises_its_proxy() {
        let (conn, cipher) = store_fixture();
        let local = local_profile(&conn, &cipher, None, None);

        let mut row = row_fixture();
        row.name = local.name.clone();
        row.proxy = Some(serde_json::json!({
            "id": "px_from_other_machine", "type": "http",
            "host": "gw.example.com", "port": 8080, "username": "u", "password": "p",
        }));
        row.tags = vec!["retail".into(), "us".into()];
        row.folder = Some("Shopping".into());
        row.notes = Some("attached on the desktop upstairs".into());

        apply_portable_row(&conn, &cipher, &local, &row).unwrap();

        let after = crate::profile_store::get(&conn, &cipher, &local.id)
            .unwrap()
            .unwrap();
        assert_eq!(
            after.proxy_id.as_deref(),
            Some("px_from_other_machine"),
            "the arriving proxy must be bound through the catalog, as the UI would bind it"
        );
        assert!(after.proxy.is_none(), "not orphaned inline beside the id");
        assert_eq!(after.tags, vec!["retail".to_string(), "us".to_string()]);
        assert_eq!(after.folder.as_deref(), Some("Shopping"));
        assert_eq!(
            after.notes.as_deref(),
            Some("attached on the desktop upstairs")
        );
        let entry = crate::proxy_store::get(&conn, &cipher, "px_from_other_machine")
            .unwrap()
            .expect("the catalog entry was re-created on this machine");
        assert_eq!(
            entry.config.get("password").and_then(|v| v.as_str()),
            Some("p")
        );
    }

    #[test]
    fn a_pulled_row_with_no_proxy_never_clears_the_local_binding() {
        // The hazard is mixed versions: every blob pushed by a pre-fix build carries `proxy: None`
        // for every catalog-bound profile. Reading that as "clear the proxy" would let one machine
        // on old code delete the binding a fixed machine just preserved.
        let (conn, cipher) = store_fixture();
        let stored = crate::proxy_store::create(
            &conn,
            &cipher,
            crate::proxy_store::CreateStoredProxyInput {
                source: "mine".into(),
                label: "Kept".into(),
                config: serde_json::json!({ "type": "http", "host": "keep.example.com", "port": 9090 }),
                location: None,
                timezone: None,
                rotate_url: None,
            },
        )
        .unwrap();
        let local = local_profile(&conn, &cipher, None, Some(stored.id.clone()));

        let mut row = row_fixture();
        row.name = local.name.clone();
        row.proxy = None;

        apply_portable_row(&conn, &cipher, &local, &row).unwrap();

        let after = crate::profile_store::get(&conn, &cipher, &local.id)
            .unwrap()
            .unwrap();
        assert_eq!(
            after.proxy_id.as_deref(),
            Some(stored.id.as_str()),
            "a rowless proxy is silence, not an instruction to clear"
        );
    }

    #[test]
    fn a_pulled_name_that_collides_with_another_profile_is_suffixed_not_forced() {
        let (conn, cipher) = store_fixture();
        let local = local_profile(&conn, &cipher, None, None);
        // A second, unrelated profile already owns the name the remote wants to give the first.
        crate::profile_store::create(
            &conn,
            &cipher,
            crate::profile_store::CreateProfileInput {
                name: "EU Retail".into(),
                engine: "lobium".into(),
                os: "windows".into(),
                os_version: None,
                fingerprint_seed: None,
                fingerprint_overrides: None,
                proxy: None,
                proxy_id: None,
                template_id: None,
                cookies_import: None,
                extensions: None,
                tags: None,
                folder: None,
                notes: None,
            },
        )
        .unwrap();

        let mut row = row_fixture();
        row.name = "EU Retail".into();
        row.proxy = None;

        apply_portable_row(&conn, &cipher, &local, &row).unwrap();

        let after = crate::profile_store::get(&conn, &cipher, &local.id)
            .unwrap()
            .unwrap();
        assert_eq!(after.name, "EU Retail (imported)");
    }

    fn link(remote_version: u64, dirty: bool) -> crate::profile_store::SyncLink {
        crate::profile_store::SyncLink {
            remote_id: Some("rp_1".into()),
            remote_version,
            synced_at: Some("2026-08-31T00:00:00Z".into()),
            dirty,
            data_state: "local".to_string(),
        }
    }

    #[test]
    fn an_edit_made_while_the_pull_was_downloading_beats_the_snapshot_it_raced() {
        // The bug this pins: the dirty guard ran BEFORE the download, and `pull_profile` awaits the
        // network with the db lock released. A user editing the profile in that window had their
        // work overwritten by the arriving row AND stamped synced, so it was never pushed either —
        // silent data loss. A local edit outranks a remote version no matter how new the remote is,
        // which is why the dirty test comes first.
        assert_eq!(
            pull_disposition(Some(&link(5, true)), 9, 5),
            PullDisposition::LocallyLeads,
            "a strictly newer remote must still lose to an edit made mid-download"
        );
        assert_eq!(
            pull_disposition(None, 9, 0),
            PullDisposition::LocallyLeads,
            "no link at all is not an invitation to overwrite"
        );
    }

    #[test]
    fn a_pull_that_is_not_applied_leaves_the_watermark_for_the_next_tick() {
        // The other half of the same defect. `pull_profile` used to stamp `remote_version` itself,
        // as a side effect of downloading. So when the overlay then FAILED — an unreadable secret
        // on the local copy is enough — the watermark had already advanced to the remote version,
        // every later tick concluded "nothing moved", discarded the snapshot, and the remote change
        // never landed while the UI reported the profile as synced. Permanent, silent divergence.
        //
        // The stamp now happens only on the success path in `reconcile`, so a non-applied pull is
        // still seen as new next time. `Stale` is the only disposition that means "genuinely
        // nothing to do", and it requires the watermark to have been advanced by a real apply.
        assert_eq!(
            pull_disposition(Some(&link(5, false)), 5, 5),
            PullDisposition::Stale,
            "already applied: the account has nothing this machine lacks"
        );
        assert_eq!(
            pull_disposition(Some(&link(5, false)), 6, 5),
            PullDisposition::Apply,
            "a watermark left at 5 by a failed apply must read as new work, not as settled"
        );
    }
}
