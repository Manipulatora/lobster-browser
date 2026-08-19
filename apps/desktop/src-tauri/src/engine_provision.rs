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

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};

/// No TOTAL request timeout — the archive is ~840 MB and a slow line is not an error. What must not
/// happen is an indefinite hang on first launch, so a connect deadline plus an idle deadline on the
/// response and on every body chunk turn a half-open or silently dropped connection into a retryable
/// error instead of a frozen progress bar the user can only escape by killing the app.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const CHUNK_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Where a manifest / env points the download.
#[derive(Debug, Clone)]
pub struct EngineSource {
    pub url: String,
    /// Lowercase hex SHA-256 of the engine archive.
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

    // Pick the entry for THIS platform.
    //
    // The manifest used to be a single flat object describing the Linux tarball, which a Windows
    // install would happily download and unpack — leaving a `chrome` ELF binary that cannot execute,
    // and an error at first launch rather than at provisioning. A `platforms` map makes the mismatch
    // impossible: an absent entry is a clear error here instead of a broken install later.
    //
    // The flat shape is still accepted so an already-shipped manifest keeps working, but only when
    // its `platform` names the host — an unlabelled or foreign-labelled flat manifest is refused for
    // the same reason.
    let want = engine_platform_id();
    let entry = match json.get("platforms").and_then(|v| v.as_object()) {
        Some(platforms) => platforms
            .get(want)
            .ok_or_else(|| {
                anyhow!(
                    "engine manifest has no '{want}' entry (available: {})",
                    platforms.keys().cloned().collect::<Vec<_>>().join(", ")
                )
            })?
            .clone(),
        None => {
            let declared = json.get("platform").and_then(|v| v.as_str());
            if declared != Some(want) {
                bail!(
                    "engine manifest describes '{}' but this build needs '{want}'; \
                     downloading it would install an engine that cannot run here",
                    declared.unwrap_or("an unspecified platform")
                );
            }
            json.clone()
        }
    };

    let url = entry
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("engine manifest entry for '{want}' is missing 'url'"))?
        .to_string();
    let sha256 = entry
        .get("sha256")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("engine manifest entry for '{want}' is missing 'sha256'"))?
        .to_ascii_lowercase();
    let version = entry
        .get("version")
        .or_else(|| json.get("version"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    Ok(EngineSource {
        url,
        sha256,
        version,
    })
}

/// The manifest key for the platform this binary was built for.
///
/// Derived from the compile target rather than from a runtime probe: the engine archive has to match
/// the app's own architecture, and a runtime check would report the emulated architecture under
/// Rosetta or Windows-on-ARM and pick an archive the app cannot load.
pub fn engine_platform_id() -> &'static str {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "win-x64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "mac-x64"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "mac-arm64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-arm64"
    }
    #[cfg(not(any(
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    {
        "unsupported"
    }
}

/// True when a usable engine binary already exists in `runtime_dir`.
///
/// The binary is `chrome.exe` on Windows; hard-coding `chrome` reported "no engine" for a correctly
/// provisioned Windows runtime and would have re-downloaded ~840 MB on every launch.
pub fn engine_present(runtime_dir: &Path) -> bool {
    runtime_dir.join(crate::CHROME_BIN).is_file()
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
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .context("building HTTP client")?;
    let downloaded = async {
        // The connect deadline ends at the TCP/TLS handshake; a server that accepts the connection
        // and then never answers would still wedge here, so the header wait gets the same deadline
        // the body chunks get.
        let resp = tokio::time::timeout(CHUNK_IDLE_TIMEOUT, client.get(&source.url).send())
            .await
            .map_err(|_| {
                anyhow!(
                    "the engine host accepted the connection but sent no response within {}s; \
                     retry the download",
                    CHUNK_IDLE_TIMEOUT.as_secs()
                )
            })?
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
        let mut file =
            std::fs::File::create(&tmp_archive).with_context(|| "creating temp engine archive")?;
        let mut stream = resp.bytes_stream();
        loop {
            let next = tokio::time::timeout(CHUNK_IDLE_TIMEOUT, stream.next())
                .await
                .map_err(|_| {
                    anyhow!(
                        "engine download stalled for {}s with {received} of {} bytes received; \
                         the connection died mid-stream — retry the download",
                        CHUNK_IDLE_TIMEOUT.as_secs(),
                        total
                            .map(|t| t.to_string())
                            .unwrap_or_else(|| "?".to_string())
                    )
                })?;
            let Some(chunk) = next else { break };
            let chunk = chunk.context("reading engine archive chunk")?;
            hasher.update(&chunk);
            file.write_all(&chunk)
                .context("writing engine archive chunk")?;
            received += chunk.len() as u64;
            on_progress(received, total);
        }
        file.flush().ok();
        file.sync_all().ok();
        Ok(hex_lower(&hasher.finalize()))
    }
    .await;
    // A failed or abandoned download must not leave ~840 MB of unusable bytes behind, and a partial
    // file under the fixed temp name would be appended to nothing on the next attempt.
    let digest = match downloaded {
        Ok(digest) => digest,
        Err(err) => {
            let _ = std::fs::remove_file(&tmp_archive);
            return Err(err);
        }
    };

    // 2) Verify integrity BEFORE touching the install location.
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
    let extracted = tokio::task::spawn_blocking(move || -> Result<()> {
        extract_and_swap(&archive_path, &staging_for_task, &runtime_owned)
    })
    .await
    .context("engine extraction task panicked")?;

    let _ = std::fs::remove_file(&tmp_archive);
    extracted?;
    if !engine_present(runtime_dir) {
        bail!(
            "engine extraction completed but {} is missing",
            runtime_dir.join(crate::CHROME_BIN).display()
        );
    }
    std::fs::write(
        runtime_dir.join(".lobium-engine-version"),
        format!("{}\n", source.version),
    )
    .with_context(|| "writing installed engine version marker")?;
    Ok(())
}

/// How the downloaded engine runtime is packaged.
///
/// The Linux artifact is a `.tar.gz` and the Windows one a `.zip` — the Windows build host packages
/// with `Compress-Archive`, and demanding a tarball there would mean shipping a tar implementation
/// with the packaging script. Both must therefore be installable, and the form is read from the
/// file's own magic bytes rather than the URL: a release asset can be redirected, renamed, or served
/// without an extension, and the bytes cannot lie about what they are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveForm {
    TarGz,
    Zip,
}

fn archive_form(archive: &Path) -> Result<ArchiveForm> {
    let mut magic = [0u8; 2];
    std::fs::File::open(archive)
        .with_context(|| "opening downloaded engine archive")?
        .read_exact(&mut magic)
        .with_context(|| "reading the engine archive header")?;
    match magic {
        [0x1f, 0x8b] => Ok(ArchiveForm::TarGz),
        // Any zip local-file/central-directory/spanning marker starts "PK"; a malformed one is the
        // zip reader's error to report, with far more detail than a magic-byte guess could give.
        [b'P', b'K'] => Ok(ArchiveForm::Zip),
        _ => bail!(
            "the engine archive is neither a gzip tarball nor a zip (starts {:02x} {:02x}); \
             refusing to install it",
            magic[0],
            magic[1]
        ),
    }
}

fn unpack_tar_gz(archive: &Path, staging: &Path) -> Result<()> {
    let file = std::fs::File::open(archive).with_context(|| "opening downloaded engine archive")?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(gz);
    tar.set_preserve_permissions(true);
    tar.unpack(staging)
        .with_context(|| "extracting engine archive")
}

fn unpack_zip(archive: &Path, staging: &Path) -> Result<()> {
    let file = std::fs::File::open(archive).with_context(|| "opening downloaded engine archive")?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file))
        .with_context(|| "reading the engine zip directory")?;
    // `extract` refuses entries whose path escapes the destination and restores unix modes when the
    // producer recorded them — a zip written on Windows records none, which is harmless there because
    // nothing has to be marked executable.
    zip.extract(staging)
        .with_context(|| "extracting engine archive")?;
    Ok(())
}

/// The directory inside `staging` that actually holds the engine.
///
/// The tarball is created with `tar -C <lobium> .`, so its entries land directly under staging. A zip
/// is not guaranteed to be packed that way — compressing the runtime FOLDER rather than its contents
/// nests everything one level deep — so a single wrapping directory that contains the browser binary
/// is unwrapped instead of installing a runtime dir whose only child is another directory.
fn extracted_root(staging: &Path) -> Result<PathBuf> {
    if staging.join(crate::CHROME_BIN).is_file() {
        return Ok(staging.to_path_buf());
    }
    let mut entries = std::fs::read_dir(staging)
        .with_context(|| "listing the extracted engine")?
        .collect::<std::io::Result<Vec<_>>>()
        .with_context(|| "listing the extracted engine")?;
    if entries.len() == 1 {
        let only = entries.remove(0).path();
        if only.join(crate::CHROME_BIN).is_file() {
            return Ok(only);
        }
    }
    bail!(
        "the engine archive does not contain {} at its root",
        crate::CHROME_BIN
    )
}

fn extract_and_swap(archive: &Path, staging: &Path, runtime_dir: &Path) -> Result<()> {
    if staging.exists() {
        std::fs::remove_dir_all(staging).ok();
    }
    std::fs::create_dir_all(staging).with_context(|| "creating engine staging dir")?;
    match archive_form(archive)? {
        ArchiveForm::TarGz => unpack_tar_gz(archive, staging)?,
        ArchiveForm::Zip => unpack_zip(archive, staging)?,
    }
    let root = extracted_root(staging)?;

    // Atomic-ish swap: move any existing runtime aside, rename the extracted root in, then delete the
    // old one.
    let backup = PathBuf::from(format!("{}.old", runtime_dir.display()));
    if runtime_dir.exists() {
        let _ = std::fs::remove_dir_all(&backup);
        std::fs::rename(runtime_dir, &backup).with_context(|| "moving previous engine aside")?;
    }
    match std::fs::rename(&root, runtime_dir) {
        Ok(()) => {
            let _ = std::fs::remove_dir_all(&backup);
            let _ = std::fs::remove_dir_all(staging);
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

    const FAKE_CHROME: &[u8] = b"#!/bin/sh\necho fake-chrome\n";
    const MARKER: &[u8] = b"{\"engine\":\"lobium\"}";

    /// Build an in-memory `.tar.gz` containing an executable browser binary + the engine marker, and
    /// its sha. The binary is named after [`crate::CHROME_BIN`] so the fixture describes the platform
    /// the test is running on rather than always the Linux one.
    fn synthetic_archive() -> (Vec<u8>, String) {
        let mut gz_buf = Vec::new();
        {
            let enc = flate2::write::GzEncoder::new(&mut gz_buf, flate2::Compression::fast());
            let mut builder = tar::Builder::new(enc);
            let mut h = tar::Header::new_gnu();
            h.set_path(crate::CHROME_BIN).unwrap();
            h.set_size(FAKE_CHROME.len() as u64);
            h.set_mode(0o755);
            h.set_cksum();
            builder.append(&h, FAKE_CHROME).unwrap();
            let mut h2 = tar::Header::new_gnu();
            h2.set_path("LOBSTER_ENGINE.json").unwrap();
            h2.set_size(MARKER.len() as u64);
            h2.set_mode(0o644);
            h2.set_cksum();
            builder.append(&h2, MARKER).unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        let sha = hex_lower(&Sha256::digest(&gz_buf));
        (gz_buf, sha)
    }

    /// The same runtime packaged the way the Windows build host packages it: a zip, with everything
    /// nested under the runtime folder the way `Compress-Archive <dir>` writes it.
    fn synthetic_zip() -> (Vec<u8>, String) {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            // Stored, not deflated: the fixture is about the container, and an uncompressed entry
            // keeps the test independent of which compression features are enabled.
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            w.start_file(format!("lobium-runtime/{}", crate::CHROME_BIN), opts)
                .unwrap();
            w.write_all(FAKE_CHROME).unwrap();
            w.start_file("lobium-runtime/LOBSTER_ENGINE.json", opts)
                .unwrap();
            w.write_all(MARKER).unwrap();
            w.finish().unwrap();
        }
        let bytes = buf.into_inner();
        let sha = hex_lower(&Sha256::digest(&bytes));
        (bytes, sha)
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

    /// The Windows artifact is a zip, and it is the FIRST first-run that would discover it: an
    /// installer that only knows tar would fail after an ~840 MB download that passed its checksum.
    #[tokio::test]
    async fn installs_a_zip_artifact_the_same_way_as_a_tarball() {
        let (archive, sha) = synthetic_zip();
        let url = serve_once(archive);
        let base = std::env::temp_dir().join(format!("lobium-prov-zip-{}", uuid::Uuid::new_v4()));
        let dir = base.join("lobium");
        let src = EngineSource {
            url,
            sha256: sha,
            version: "test".into(),
        };
        provision(&src, &dir, |_, _| {}).await.unwrap();
        assert!(engine_present(&dir), "the browser binary must be installed");
        assert!(
            dir.join("LOBSTER_ENGINE.json").is_file(),
            "the wrapping directory must be unwrapped, not installed as the runtime root"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Neither form: refuse before extraction rather than surface an inflate error that reads like a
    /// corrupt download when the artifact is simply not an archive (an HTML error page, say).
    #[test]
    fn refuses_an_archive_that_is_neither_gzip_nor_zip() {
        let path = std::env::temp_dir().join(format!("lobium-form-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"<!doctype html>").unwrap();
        let err = archive_form(&path).unwrap_err().to_string();
        assert!(err.contains("neither"), "unexpected error: {err}");
        let _ = std::fs::remove_file(&path);
    }
}
