//! The local snapshot ledger: LSK-encrypted artifacts on disk, one directory per version.
//!
//! ```text
//! <app_data>/snapshots/<profile_id>/<version>/manifest.lbm   LBv1 over canonical CBOR
//! <app_data>/snapshots/<profile_id>/<version>/<artifact>.lba LBv1 over the artifact payload
//! ```
//!
//! Encrypted under the existing per-install Local Store Key only. Nothing here needs an account, a
//! password, or the network, which is the point: this is the durable copy, and the cloud transport
//! that arrives later is an additional copy, not a prerequisite. It also means a snapshot does NOT
//! survive a new machine — the LSK is per-install and regenerated fresh — and that limitation is the
//! whole reason the key ladder exists in a later phase. Nothing in this module should pretend
//! otherwise.
//!
//! ## What binds an artifact to its snapshot
//!
//! The LBv1 envelope has no AAD, so a sealed blob is not self-identifying — a determined local
//! attacker with write access to the ledger could move `cookies.lba` from one version to another.
//! What catches that here is the digest chain: the manifest records the BLAKE3 of every artifact's
//! SEALED bytes as well as its plaintext, so a swapped blob fails before decryption is attempted, and
//! `verify` checks both for every artifact. AAD binding proper (profile/artifact/version inside the
//! authenticated header) is the LBv2 envelope's job, which is a later phase's work; until then this
//! chain is the mechanism and it is worth being explicit that it is not the same thing.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use zeroize::Zeroize;

use crate::blob_crypto::{BlobCipher, LB_V1_KEY_ID_LEN};

use super::manifest::{digest_hex, safe_artifact_filename, SnapshotManifest};

const MANIFEST_FILE: &str = "manifest.lbm";

pub struct SnapshotVault {
    root: PathBuf,
    cipher: BlobCipher,
    key_id: [u8; LB_V1_KEY_ID_LEN],
}

impl SnapshotVault {
    /// Open the ledger under `app_data_dir`, loading the Local Store Key from the OS keychain (or the
    /// 0600 file fallback) exactly as the profile store does.
    ///
    /// The key is loaded here rather than threaded in from `AppState` because `SecretCipher`
    /// deliberately does not expose its key bytes: it encrypts strings into the `lbsec1:` cell form,
    /// and snapshot artifacts are binary blobs that need the byte-oriented LBv1 envelope. Capture and
    /// restore are user-initiated and never on the first-paint path, so the extra keychain read costs
    /// nothing that matters.
    pub fn open(app_data_dir: &Path) -> Result<Self> {
        let (mut key, source) =
            crate::keychain::load_or_create_lsk(&app_data_dir.join("secrets.key"))
                .context("loading the Local Store Key for the snapshot ledger")?;
        tracing::info!(?source, "opened snapshot ledger");
        let vault = Self::with_key(&app_data_dir.join("snapshots"), &key)?;
        key.zeroize();
        Ok(vault)
    }

    pub fn with_key(root: &Path, key: &[u8; 32]) -> Result<Self> {
        std::fs::create_dir_all(root)
            .with_context(|| format!("creating snapshot ledger at {}", root.display()))?;
        // A stable, non-secret key id derived from the key itself, so a snapshot written under one LSK
        // is recognisably not decryptable under another before the AEAD tag says so. It is a
        // diagnostic, never a check: the header is unauthenticated in LBv1.
        let mut key_id = [0u8; LB_V1_KEY_ID_LEN];
        key_id.copy_from_slice(&blake3::hash(key).as_bytes()[..LB_V1_KEY_ID_LEN]);
        Ok(Self {
            root: root.to_path_buf(),
            cipher: BlobCipher::new(key),
            key_id,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn profile_dir(&self, profile_id: &str) -> Result<PathBuf> {
        // Profile ids come from the store as `prf_<hex>`, but this is the one place a caller-supplied
        // id becomes a filesystem path, so it is checked here rather than trusted.
        if profile_id.is_empty()
            || profile_id.len() > 64
            || !profile_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            bail!("profile id `{profile_id}` is not a safe directory name");
        }
        Ok(self.root.join(profile_id))
    }

    fn version_dir(&self, profile_id: &str, version: u64) -> Result<PathBuf> {
        Ok(self.profile_dir(profile_id)?.join(version.to_string()))
    }

    /// Committed versions for a profile, ascending. A directory with no `manifest.lbm` is a capture
    /// that died before it committed and is not listed: an incomplete snapshot must be invisible, not
    /// restorable.
    pub fn versions(&self, profile_id: &str) -> Result<Vec<u64>> {
        let dir = self.profile_dir(profile_id)?;
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(Vec::new());
        };
        let mut versions = Vec::new();
        for entry in entries {
            let entry = entry?;
            let Some(version) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.parse::<u64>().ok())
            else {
                continue;
            };
            if entry.path().join(MANIFEST_FILE).is_file() {
                versions.push(version);
            }
        }
        versions.sort_unstable();
        Ok(versions)
    }

    pub fn latest_version(&self, profile_id: &str) -> Result<Option<u64>> {
        Ok(self.versions(profile_id)?.into_iter().max())
    }

    /// Reserve the next version directory. Fails if it already exists, so two concurrent captures
    /// cannot both believe they own a version number.
    pub fn begin(&self, profile_id: &str) -> Result<(u64, PathBuf)> {
        let next = self.latest_version(profile_id)?.map_or(1, |v| v + 1);
        let dir = self.version_dir(profile_id, next)?;
        if dir.exists() {
            bail!(
                "snapshot version directory {} already exists; another capture is in flight",
                dir.display()
            );
        }
        std::fs::create_dir_all(&dir)?;
        Ok((next, dir))
    }

    /// Seal an artifact payload into the version directory. Returns `(sealed_digest, sealed_bytes)`.
    pub fn put_artifact(
        &self,
        profile_id: &str,
        version: u64,
        artifact_id: &str,
        plaintext: &[u8],
    ) -> Result<(String, u64)> {
        let dir = self.version_dir(profile_id, version)?;
        std::fs::create_dir_all(&dir)?;
        let sealed = self.cipher.encrypt(plaintext, &self.key_id)?;
        let path = dir.join(safe_artifact_filename(artifact_id)?);
        write_atomic(&path, &sealed)?;
        Ok((digest_hex(&sealed), sealed.len() as u64))
    }

    /// Read an artifact back, checking the sealed digest BEFORE decrypting.
    ///
    /// Order matters: a blob that is not the one the manifest recorded must be rejected on identity,
    /// not merely fail to authenticate — the two produce different diagnostics and only the first
    /// tells the user which artifact of which version is wrong.
    pub fn get_artifact(
        &self,
        profile_id: &str,
        version: u64,
        artifact_id: &str,
        expect_sealed_digest: &str,
    ) -> Result<Vec<u8>> {
        let path = self
            .version_dir(profile_id, version)?
            .join(safe_artifact_filename(artifact_id)?);
        let sealed = std::fs::read(&path)
            .with_context(|| format!("reading sealed artifact {}", path.display()))?;
        let actual = digest_hex(&sealed);
        if actual != expect_sealed_digest {
            bail!(
                "SEALED_DIGEST_MISMATCH: {artifact_id}@{version} for {profile_id} is not the blob the \
                 manifest recorded (expected {expect_sealed_digest}, found {actual}); refusing to \
                 decrypt it"
            );
        }
        let (plaintext, _) = self.cipher.decrypt(&sealed).with_context(|| {
            format!("decrypting {artifact_id}@{version} — this install's Local Store Key may not be the one it was written with")
        })?;
        Ok(plaintext)
    }

    /// Commit the manifest. Written LAST and atomically, so a version directory only becomes
    /// restorable once every artifact it names is already on disk.
    pub fn commit(&self, manifest: &SnapshotManifest) -> Result<()> {
        let dir = self.version_dir(&manifest.profile_id, manifest.version)?;
        std::fs::create_dir_all(&dir)?;
        let sealed = self.cipher.encrypt(&manifest.encode()?, &self.key_id)?;
        write_atomic(&dir.join(MANIFEST_FILE), &sealed)
    }

    pub fn manifest(&self, profile_id: &str, version: u64) -> Result<SnapshotManifest> {
        let path = self.version_dir(profile_id, version)?.join(MANIFEST_FILE);
        let sealed = std::fs::read(&path)
            .with_context(|| format!("reading snapshot manifest {}", path.display()))?;
        let (plaintext, _) = self
            .cipher
            .decrypt(&sealed)
            .with_context(|| format!("decrypting snapshot manifest {}", path.display()))?;
        let manifest = SnapshotManifest::decode(&plaintext)?;
        if manifest.profile_id != profile_id || manifest.version != version {
            bail!(
                "MANIFEST_IDENTITY_MISMATCH: {} holds a manifest for {}@{}",
                path.display(),
                manifest.profile_id,
                manifest.version
            );
        }
        Ok(manifest)
    }

    /// Delete a version directory. Used to clean up a capture that failed partway; nothing else
    /// prunes, because retention is a separate concern that must never run inside a capture.
    pub fn discard(&self, profile_id: &str, version: u64) -> Result<()> {
        let dir = self.version_dir(profile_id, version)?;
        if dir.exists() {
            std::fs::remove_dir_all(&dir)
                .with_context(|| format!("discarding {}", dir.display()))?;
        }
        Ok(())
    }
}

/// Temp file, fsync, rename. A snapshot artifact half-written by a process that was killed must not
/// be readable as a whole one.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("lba-tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        use std::io::Write;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::manifest::Identity;
    use super::*;
    use crate::snapshot::manifest::{
        ArtifactKind, ArtifactRecord, CaptureMode, Coherence, Fidelity, MANIFEST_VERSION,
    };

    fn temp_root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lobster-vault-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn vault(root: &Path, key: u8) -> SnapshotVault {
        SnapshotVault::with_key(root, &[key; 32]).unwrap()
    }

    fn manifest_for(profile: &str, version: u64, record: ArtifactRecord) -> SnapshotManifest {
        SnapshotManifest {
            manifest_version: MANIFEST_VERSION,
            profile_id: profile.into(),
            version,
            captured_at: "2026-08-17T12:00:00Z".into(),
            capture_mode: CaptureMode::Quiesced,
            identity: Identity::fixture(),
            coherence: Coherence::new(CaptureMode::Quiesced, 12),
            artifacts: vec![record],
            absent: Vec::new(),
            skipped: Vec::new(),
        }
    }

    fn record(
        id: &str,
        plaintext: &[u8],
        sealed_digest: String,
        sealed_bytes: u64,
    ) -> ArtifactRecord {
        ArtifactRecord {
            id: id.into(),
            kind: ArtifactKind::SqliteVacuum,
            plain_digest: digest_hex(plaintext),
            sealed_digest,
            plain_bytes: plaintext.len() as u64,
            sealed_bytes,
            fidelity: Fidelity::Full,
            backend: None,
            counts: Vec::new(),
            captured_in_version: 1,
            offset_ms: 0,
        }
    }

    #[test]
    fn artifacts_round_trip_and_versions_increase() {
        let root = temp_root("roundtrip");
        let v = vault(&root, 3);
        let (version, _) = v.begin("prf_a").unwrap();
        assert_eq!(version, 1);

        let payload = b"cookie jar bytes".to_vec();
        let (sealed_digest, sealed_bytes) = v
            .put_artifact("prf_a", version, "cookies", &payload)
            .unwrap();
        let manifest = manifest_for(
            "prf_a",
            version,
            record("cookies", &payload, sealed_digest.clone(), sealed_bytes),
        );
        v.commit(&manifest).unwrap();

        assert_eq!(v.versions("prf_a").unwrap(), vec![1]);
        assert_eq!(v.latest_version("prf_a").unwrap(), Some(1));
        assert_eq!(
            v.get_artifact("prf_a", 1, "cookies", &sealed_digest)
                .unwrap(),
            payload
        );
        assert_eq!(v.manifest("prf_a", 1).unwrap().version, 1);

        let (next, _) = v.begin("prf_a").unwrap();
        assert_eq!(next, 2);
        // A version with no committed manifest must not be listed or restorable.
        assert_eq!(v.versions("prf_a").unwrap(), vec![1]);
        assert!(v.manifest("prf_a", 2).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Nothing may be plaintext on disk. The whole point of the ledger is that the cookie jar it
    /// holds is not readable from a file-level backup of the app-data directory.
    #[test]
    fn nothing_is_stored_in_the_clear() {
        let root = temp_root("sealed");
        let v = vault(&root, 5);
        let (version, dir) = v.begin("prf_a").unwrap();
        let secret = b"authToken=live-session-value";
        let (digest, bytes) = v.put_artifact("prf_a", version, "cookies", secret).unwrap();
        v.commit(&manifest_for(
            "prf_a",
            version,
            record("cookies", secret, digest, bytes),
        ))
        .unwrap();
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let raw = std::fs::read(&path).unwrap();
            assert!(
                !raw.windows(secret.len()).any(|w| w == secret),
                "{} contains the plaintext",
                path.display()
            );
            assert_eq!(&raw[..4], b"LBv1", "{} is not an envelope", path.display());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The digest chain, not the envelope, is what binds a blob to its snapshot in LBv1. This is the
    /// transplant attempt it catches.
    #[test]
    fn a_transplanted_artifact_is_rejected_before_it_is_decrypted() {
        let root = temp_root("transplant");
        let v = vault(&root, 7);

        let (v1, _) = v.begin("prf_a").unwrap();
        let old = b"version 1 cookies";
        let (digest_v1, bytes_v1) = v.put_artifact("prf_a", v1, "cookies", old).unwrap();
        v.commit(&manifest_for(
            "prf_a",
            v1,
            record("cookies", old, digest_v1.clone(), bytes_v1),
        ))
        .unwrap();

        let (v2, dir2) = v.begin("prf_a").unwrap();
        let new = b"version 2 cookies";
        let (digest_v2, bytes_v2) = v.put_artifact("prf_a", v2, "cookies", new).unwrap();
        v.commit(&manifest_for(
            "prf_a",
            v2,
            record("cookies", new, digest_v2.clone(), bytes_v2),
        ))
        .unwrap();

        // Move version 1's sealed blob over version 2's. It decrypts perfectly — same key — and it is
        // the wrong data.
        let stolen =
            std::fs::read(v.version_dir("prf_a", v1).unwrap().join("cookies.lba")).unwrap();
        std::fs::write(dir2.join("cookies.lba"), &stolen).unwrap();
        let err = v
            .get_artifact("prf_a", v2, "cookies", &digest_v2)
            .unwrap_err()
            .to_string();
        assert!(err.contains("SEALED_DIGEST_MISMATCH"), "{err}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_snapshot_written_under_another_key_fails_to_open_rather_than_returning_garbage() {
        let root = temp_root("wrongkey");
        let (digest, bytes, payload) = {
            let v = vault(&root, 11);
            let (version, _) = v.begin("prf_a").unwrap();
            let payload = b"secrets".to_vec();
            let (digest, bytes) = v
                .put_artifact("prf_a", version, "cookies", &payload)
                .unwrap();
            v.commit(&manifest_for(
                "prf_a",
                version,
                record("cookies", &payload, digest.clone(), bytes),
            ))
            .unwrap();
            (digest, bytes, payload)
        };
        let _ = bytes;
        // A different install: fresh LSK, same files.
        let other = vault(&root, 12);
        let err = other
            .get_artifact("prf_a", 1, "cookies", &digest)
            .unwrap_err()
            .to_string();
        assert!(err.contains("Local Store Key"), "{err}");
        assert!(other.manifest("prf_a", 1).is_err());
        // And with the right key it still reads, so the failure is the key and not the files.
        assert_eq!(
            vault(&root, 11)
                .get_artifact("prf_a", 1, "cookies", &digest)
                .unwrap(),
            payload
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_manifest_naming_another_profile_is_refused() {
        let root = temp_root("identity");
        let v = vault(&root, 13);
        let (version, _) = v.begin("prf_a").unwrap();
        // Commit a manifest whose body says prf_b into prf_a's directory.
        let mut manifest = manifest_for("prf_a", version, record("cookies", b"x", "d".into(), 1));
        manifest.profile_id = "prf_b".into();
        let dir = v.version_dir("prf_a", version).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let sealed = v
            .cipher
            .encrypt(&manifest.encode().unwrap(), &v.key_id)
            .unwrap();
        write_atomic(&dir.join(MANIFEST_FILE), &sealed).unwrap();
        let err = v.manifest("prf_a", version).unwrap_err().to_string();
        assert!(err.contains("MANIFEST_IDENTITY_MISMATCH"), "{err}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsafe_profile_ids_and_artifact_ids_never_become_paths() {
        let root = temp_root("paths");
        let v = vault(&root, 17);
        for bad in ["../escape", "a/b", "", "with space", "x\0y"] {
            assert!(v.versions(bad).is_err(), "accepted profile id `{bad}`");
        }
        assert!(v.put_artifact("prf_a", 1, "../../evil", b"x").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
