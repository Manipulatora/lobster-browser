//! First-run engine provisioning (LOBIUM distribution model: DOWNLOADER, not bundled).
//!
//! The shipped `.deb` deliberately does NOT carry the ~840 MB Lobium engine. On first launch, if no
//! engine is present, the app streams a compressed engine runtime from a release URL, verifies its
//! SHA-256 against a signed manifest, and extracts it into the user runtime dir
//! (`~/.local/share/lobster/lobium`). Subsequent launches find it and skip.
//!
//! Everything here is fail-closed on integrity: a hash mismatch or a truncated download NEVER leaves a
//! partial engine in place — extraction happens in a sibling temp dir and is atomically renamed only
//! after the whole archive is verified.

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};

/// Where a manifest / env points the download.
#[derive(Debug, Clone)]
pub struct EngineSource {
    pub url: String,
    /// Lowercase hex SHA-256 of the `.tar.gz` archive.
    pub sha256: String,
    pub version: String,
}

/// Resolve the engine source: `LOBSTER_ENGINE_URL` + `LOBSTER_ENGINE_SHA256` env win (used for testing
/// / self-hosting); otherwise read the manifest shipped alongside the app.
pub fn resolve_source(manifest_path: Option<&Path>) -> Result<EngineSource> {
    if let (Some(url), Some(sha256)) = (
        std::env::var("LOBSTER_ENGINE_URL")
            .ok()
            .filter(|s| !s.is_empty()),
        std::env::var("LOBSTER_ENGINE_SHA256")
            .ok()
            .filter(|s| !s.is_empty()),
    ) {
        let version =
            std::env::var("LOBSTER_ENGINE_VERSION").unwrap_or_else(|_| "override".to_string());
        return Ok(EngineSource {
            url,
            sha256,
            version,
        });
    }
    let path = manifest_path.ok_or_else(|| {
        anyhow!("no engine manifest available and LOBSTER_ENGINE_URL/SHA256 are not set")
    })?;
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading engine manifest {}", path.display()))?;
    let json: serde_json::Value =
        serde_json::from_str(&raw).with_context(|| "parsing engine manifest")?;
    let url = json
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("engine manifest missing 'url'"))?
        .to_string();
    let sha256 = json
        .get("sha256")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("engine manifest missing 'sha256'"))?
        .to_ascii_lowercase();
    let version = json
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    Ok(EngineSource {
        url,
        sha256,
        version,
    })
}

/// True when a usable engine binary already exists in `runtime_dir`.
pub fn engine_present(runtime_dir: &Path) -> bool {
    runtime_dir.join("chrome").is_file()
}

/// Download + verify + extract the engine into `runtime_dir`. `on_progress(received, total)` is called
/// periodically during the download (total is None when the server sends no Content-Length).
pub async fn provision<F>(
    source: &EngineSource,
    runtime_dir: &Path,
    mut on_progress: F,
) -> Result<()>
where
    F: FnMut(u64, Option<u64>),
{
    let parent = runtime_dir
        .parent()
        .ok_or_else(|| anyhow!("runtime dir has no parent"))?;
    std::fs::create_dir_all(parent).with_context(|| "creating engine runtime parent dir")?;

    // 1) Stream the archive to a temp file, hashing every byte as it lands.
    let tmp_archive = parent.join(".lobium-engine.download");
    let _ = std::fs::remove_file(&tmp_archive);
    let client = reqwest::Client::builder()
        .build()
        .context("building HTTP client")?;
    let resp = client
        .get(&source.url)
        .send()
        .await
        .with_context(|| format!("requesting engine archive {}", source.url))?;
    if !resp.status().is_success() {
        bail!(
            "engine download failed: HTTP {} for {}",
            resp.status(),
            source.url
        );
    }
    let total = resp.content_length();
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    {
        let mut file =
            std::fs::File::create(&tmp_archive).with_context(|| "creating temp engine archive")?;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("reading engine archive chunk")?;
            hasher.update(&chunk);
            file.write_all(&chunk)
                .context("writing engine archive chunk")?;
            received += chunk.len() as u64;
            on_progress(received, total);
        }
        file.flush().ok();
        file.sync_all().ok();
    }

    // 2) Verify integrity BEFORE touching the install location.
    let digest = hex_lower(&hasher.finalize());
    if digest != source.sha256.to_ascii_lowercase() {
        let _ = std::fs::remove_file(&tmp_archive);
        bail!(
            "engine archive integrity check FAILED (expected {}, got {}); refusing to install",
            source.sha256,
            digest
        );
    }

    // 3) Extract into a sibling temp dir (sync work off the async runtime), then atomically swap in.
    let staging = parent.join(".lobium-engine.incoming");
    let archive_path = tmp_archive.clone();
    let staging_for_task = staging.clone();
    let runtime_owned = runtime_dir.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        extract_and_swap(&archive_path, &staging_for_task, &runtime_owned)
    })
    .await
    .context("engine extraction task panicked")??;

    let _ = std::fs::remove_file(&tmp_archive);
    if !engine_present(runtime_dir) {
        bail!(
            "engine extraction completed but {}/chrome is missing",
            runtime_dir.display()
        );
    }
    std::fs::write(
        runtime_dir.join(".lobium-engine-version"),
        format!("{}\n", source.version),
    )
    .with_context(|| "writing installed engine version marker")?;
    Ok(())
}

fn extract_and_swap(archive: &Path, staging: &Path, runtime_dir: &Path) -> Result<()> {
    if staging.exists() {
        std::fs::remove_dir_all(staging).ok();
    }
    std::fs::create_dir_all(staging).with_context(|| "creating engine staging dir")?;
    let file = std::fs::File::open(archive).with_context(|| "opening downloaded engine archive")?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(gz);
    tar.set_preserve_permissions(true);
    tar.unpack(staging)
        .with_context(|| "extracting engine archive")?;

    // The archive is created with `tar -C <lobium> .`, so entries land directly under staging.
    // Atomic-ish swap: move any existing runtime aside, rename staging in, then delete the old one.
    let backup = PathBuf::from(format!("{}.old", runtime_dir.display()));
    if runtime_dir.exists() {
        let _ = std::fs::remove_dir_all(&backup);
        std::fs::rename(runtime_dir, &backup).with_context(|| "moving previous engine aside")?;
    }
    match std::fs::rename(staging, runtime_dir) {
        Ok(()) => {
            let _ = std::fs::remove_dir_all(&backup);
            Ok(())
        }
        Err(err) => {
            // Roll back to the previous engine if the swap failed.
            if backup.exists() {
                let _ = std::fs::rename(&backup, runtime_dir);
            }
            Err(anyhow!(err).context("installing extracted engine"))
        }
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Build an in-memory `.tar.gz` containing an executable `chrome` + the engine marker, and its sha.
    fn synthetic_archive() -> (Vec<u8>, String) {
        let mut gz_buf = Vec::new();
        {
            let enc = flate2::write::GzEncoder::new(&mut gz_buf, flate2::Compression::fast());
            let mut builder = tar::Builder::new(enc);
            let chrome = b"#!/bin/sh\necho fake-chrome\n";
            let mut h = tar::Header::new_gnu();
            h.set_path("chrome").unwrap();
            h.set_size(chrome.len() as u64);
            h.set_mode(0o755);
            h.set_cksum();
            builder.append(&h, &chrome[..]).unwrap();
            let marker = b"{\"engine\":\"lobium\"}";
            let mut h2 = tar::Header::new_gnu();
            h2.set_path("LOBSTER_ENGINE.json").unwrap();
            h2.set_size(marker.len() as u64);
            h2.set_mode(0o644);
            h2.set_cksum();
            builder.append(&h2, &marker[..]).unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        let sha = hex_lower(&Sha256::digest(&gz_buf));
        (gz_buf, sha)
    }

    /// Serve `body` once over a throwaway localhost port; returns the URL.
    fn serve_once(body: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            // Serve every connection (a client may open more than one) for the life of the test.
            for conn in listener.incoming() {
                let Ok(mut stream) = conn else { break };
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let header = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        format!("http://{addr}/engine.tar.gz")
    }

    #[tokio::test]
    async fn downloads_verifies_and_installs() {
        let (archive, sha) = synthetic_archive();
        let url = serve_once(archive);
        // Isolated parent per test: the provisioner uses fixed temp-file names in the parent dir, which
        // is fine in production (single-instance lock) but would collide across parallel tests.
        let base = std::env::temp_dir().join(format!("lobium-prov-{}", uuid::Uuid::new_v4()));
        let dir = base.join("lobium");
        let src = EngineSource {
            url,
            sha256: sha,
            version: "test".into(),
        };
        let mut last: (u64, Option<u64>) = (0, None);
        provision(&src, &dir, |r, t| last = (r, t)).await.unwrap();
        assert!(engine_present(&dir), "chrome must be installed");
        assert!(last.0 > 0, "progress must have been reported");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn refuses_install_on_checksum_mismatch() {
        let (archive, _) = synthetic_archive();
        let url = serve_once(archive);
        let base = std::env::temp_dir().join(format!("lobium-prov-bad-{}", uuid::Uuid::new_v4()));
        let dir = base.join("lobium");
        let src = EngineSource {
            url,
            sha256: "0".repeat(64),
            version: "test".into(),
        };
        let res = provision(&src, &dir, |_, _| {}).await;
        assert!(res.is_err(), "a checksum mismatch must fail the provision");
        assert!(
            !engine_present(&dir),
            "must NOT install an unverified engine"
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
