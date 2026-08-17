//! Moving a snapshot between this machine and the account's storage.
//!
//! ## What actually crosses the wire
//!
//! One LBv1 envelope per push, sealed under the profile's content key — which is derived from the
//! ACCOUNT key ([`crate::vault_key`]), not this install's. That is the whole point: the server stores
//! bytes it cannot read, and any machine that can sign in and supply the password can open them.
//!
//! The envelope contains the snapshot manifest and every artifact payload, so a pull reconstructs the
//! ledger entry exactly. The artifacts inside are already individually sealed by the ledger under its
//! own key, so this is a re-seal for transport and for the account, not a first encryption.
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
use std::time::Duration;

use crate::blob_crypto::{BlobCipher, LB_V1_KEY_ID_LEN, LB_V1_KEY_LEN};
use crate::cloud_auth;
use crate::snapshot::manifest::SnapshotManifest;
use crate::snapshot::vault::SnapshotVault;

/// Uploads are small (the slim identity set), but a stalled request must not wedge a capture.
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);

/// The server refuses a body larger than this, so refuse locally with a message that says why rather
/// than surfacing an opaque 413.
const MAX_PAYLOAD_BYTES: usize = 25 * 1024 * 1024;

/// The snapshot as it travels: the manifest plus every artifact payload, keyed by artifact id.
#[derive(Debug, Serialize, Deserialize)]
struct SyncPayload {
    manifest: SnapshotManifest,
    /// `(artifact id, sealed bytes)`. A Vec rather than a map so the encoding is order-stable.
    artifacts: Vec<(String, Vec<u8>)>,
}

/// What a push did.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    pub profile_id: String,
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

/// Seal the newest local snapshot for the account and upload it.
pub async fn push(
    vault: &SnapshotVault,
    profile_id: &str,
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
        artifacts.push((record.id.clone(), bytes));
    }

    let payload = SyncPayload {
        manifest: manifest.clone(),
        artifacts,
    };
    let encoded = serde_json::to_vec(&payload).context("encoding the snapshot for upload")?;
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
    let res = request(profile_id, &body).await?;

    match res {
        SyncResponse::Ok(data) => Ok(PushOutcome {
            profile_id: profile_id.to_string(),
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

/// Download the account's snapshot and write it into the local ledger.
pub async fn pull(
    vault: &SnapshotVault,
    profile_id: &str,
    content_key: &[u8; LB_V1_KEY_LEN],
) -> Result<PullOutcome> {
    let body = serde_json::json!({ "direction": "pull" });
    let SyncResponse::Ok(data) = request(profile_id, &body).await? else {
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
    let payload: SyncPayload =
        serde_json::from_slice(&plain).context("the downloaded snapshot is malformed")?;

    // Written as a NEW local version rather than over an existing one, so a pull can never destroy a
    // local snapshot that has not been uploaded yet.
    let (snapshot_version, _dir) = vault.begin(profile_id)?;
    let mut manifest = payload.manifest;
    manifest.version = snapshot_version;

    let count = payload.artifacts.len();
    for (id, bytes) in payload.artifacts {
        let record = manifest
            .artifacts
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or_else(|| anyhow!("downloaded artifact `{id}` is not in its own manifest"))?;
        record.captured_in_version = snapshot_version;
        vault
            .put_artifact(profile_id, snapshot_version, &id, &bytes)
            .with_context(|| format!("writing downloaded `{id}` into the ledger"))?;
    }
    vault.commit(&manifest)?;

    Ok(PullOutcome {
        profile_id: profile_id.to_string(),
        remote_version: data.version,
        snapshot_version,
        artifacts: count,
    })
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

async fn request(profile_id: &str, body: &serde_json::Value) -> Result<SyncResponse> {
    let token = cloud_auth::load_token().ok_or_else(|| anyhow!("not signed in"))?;
    let client = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build()?;
    let res = client
        .post(format!(
            "{}/profiles/{profile_id}/sync",
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob_crypto;

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
}
