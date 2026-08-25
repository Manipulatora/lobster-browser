# Operations — Build, Package, Deploy, Validate, Contracts

The runbooks: build the engine, ship the product, deploy the site, run the gates, and integrate against
the runtime contracts. Updated 2026-08-19.

**Both Windows x64 and Linux x64 are supported build and run targets**, and they need genuinely different
procedures rather than one with substitutions. Windows is the first target platform; Linux is the
development platform. macOS is not built. Where a step is platform-specific it says so; where it is not,
it applies to both. [`STATUS.md`](STATUS.md) §2–3 has the support matrix and the build-host requirements.

## 1. Build the Lobium engine

Chromium source lives at `~/lobium-build/src` (`C:\lobium-build\src` on the Windows host); `depot_tools`
beside it, on `PATH`. Custom code is in `components/lobium_fp/` plus the quilt series
`lobium/patches/series`.

```bash
export PATH="$HOME/lobium-build/depot_tools:$PATH"
export LOBIUM_CHROMIUM_SRC="$HOME/lobium-build/src"
cd "$LOBIUM_CHROMIUM_SRC"

# Official build (shipping): is_official_build, thin-LTO, PGO. Single ~525MB binary + 7 .so.
autoninja -C out/LobiumOfficial chrome

# Component build (fast dev iteration): ~172MB + ~556 .so. Faster link, slower startup.
autoninja -C out/Lobium chrome
```

On Windows the driver is `lobium/build.ps1` (`build.sh` is bash-only and its `quilt push -a` step has no
Windows equivalent). It stages, patches, configures and builds, and it is idempotent; see
[`STATUS.md`](STATUS.md) §3.1 for the preflight it enforces and why each item is in it.

```powershell
$env:LOBIUM_CHROMIUM_SRC = 'C:\lobium-build\src'
powershell -NoProfile -ExecutionPolicy Bypass -File lobium\build.ps1 -Run
```

All checkout-aware Node tools use the same `LOBIUM_CHROMIUM_SRC` contract. They fail with an
actionable error when it is absent instead of guessing a developer's drive or home directory.

The official build needs the V8 builtins PGO profile:
`python3 v8/tools/builtins-pgo/download_profiles.py download --depot-tools ~/lobium-build/depot_tools`.

**Do not mix builds when deploying** — the official binary loads 7 `.so`; the component binary needs
~556. Deploying component `.so` over an official install breaks with
`libui_ozone.so: cannot open shared object`.

Branding assets (icons, tab/product logos, mono-dark favicon) are rendered by
`scripts/apply-lobium-branding.mjs`.

> **Before planning a build, read [`STATUS.md`](STATUS.md) §3.** Existing Windows and Linux binaries
> predate the current semantic capability contract and native-policy fixes. Start from a clean exact
> `152.0.7977.42` checkout, apply the full current series, and rebuild; never package an older local
> output merely because its Chromium product version still matches.

### 1.1 Bumping the Chrome version

Four files pin the version and must never disagree: `lobium/build.sh` (`CHROMIUM_REF`, Linux),
`lobium/build.ps1` (`ChromiumRef`, Windows), `packages/fingerprint/src/pools.ts` (`ENGINE_CHROME`, what every persona's UA claims), and
`apps/desktop/src-tauri/resources/engine-manifest.json` (which archive first-run provisioning installs).
Never edit them by hand:

```bash
node scripts/track-upstream.mjs                      # is a bump due? exits non-zero if action needed
node scripts/bump-engine-version.mjs 152.0.7977.42   # or --latest-stable; moves build.sh + ENGINE_CHROME
bash lobium/rebase.sh 152.0.7977.42 --run            # re-applies the quilt series (does the bump for you)
bash lobium/build.sh --run                           # 6-8h+ on the build host
bash scripts/package-lobium-runtime.sh               # produces lobium-linux-x64.tar.gz
# upload the archive to the GitHub release, then finalize the manifest against the REAL digest:
node scripts/bump-engine-version.mjs 152.0.7977.42 --tarball dist/lobium-linux-x64.tar.gz
node scripts/track-upstream.mjs                      # must exit 0
node --test ci/validation/version-coherence.test.mjs
```

**Pin a RELEASED build, never a canary.** `getHighEntropyValues(['fullVersionList'])` returns the real
build, so a nightly nobody runs is close to a globally unique identifier — and a `.0` patch component
advertises it as a branch-point build. Both the bump script and the coherence test refuse one. (The repo
sat on canary `152.0.7928.0` because the old tracker compared version ordering only and reported the
canary as "UP TO DATE".)

**The manifest moves last, and only against a real artifact.** Pointing it at a version whose archive is
not uploaded does not prepare anything — the URL 404s or the SHA-256 mismatches and first-run provisioning
fails for every user. Between the source bump and the rebuild the manifest carries a `rebuildPending`
block; the coherence test requires that declaration and requires it to stay inside the same milestone.

`scripts/bump-engine-version.mjs` moves both build-script pins, and
`ci/validation/version-coherence.test.mjs` refuses a Windows/Linux mismatch.

## 2. Package & install the product

The desktop app bundles the React UI, the Node sidecar, the font pack, the built Lobee extension, and
`engine-manifest.json`. It does **not** bundle the ~840 MB Lobium runtime — see §2.1.

Bundle targets live in platform configs (`tauri.windows.conf.json` → `nsis`, `tauri.linux.conf.json` →
`deb` + the font pack), which Tauri merges over `tauri.conf.json`. The merge is per-key for objects: a
platform config **adds to** `bundle.resources` and cannot remove an entry — which is why the font pack had
to move out of the base config rather than being overridden.

### 2.1 Engine provisioning (the downloader model)

`apps/desktop/src-tauri/resources/engine-manifest.json` is a **per-platform map**:

```jsonc
{
  "engine": "lobium",
  "note": "...",
  "platforms": {
    "linux-x64": { "version": "…", "url": "https://…", "sha256": "…" }
  },
  "rebuildPending": { "targetVersion": "…", "why": "…", "howToClear": "…" },
  "win-x64Pending": { "why": "…", "howToClear": "…" }
}
```

`rebuildPending` and `win-x64Pending` are **top-level siblings** of `platforms`, not entries inside it.
The Rust core never reads them; they exist for `version-coherence.test.mjs` and for humans.

On first run the Rust core (`engine_provision.rs`) resolves `platforms[engine_platform_id()]`, streams the
archive, verifies the digest, and extracts it. The platform id comes from the **compile target**
(`linux-x64`, `win-x64`, `mac-x64`, `mac-arm64`, `linux-arm64`), not a runtime probe, so Rosetta or
Windows-on-ARM cannot mislead it. A platform with **no entry** is a hard error that names the ids which do
exist — no download is attempted. The legacy flat shape (a top-level `platform` string) is still accepted
and refused unless it matches the host, so an old manifest cannot install an engine that cannot run.

The archive form is detected from the file's own **magic bytes** (`1f 8b` gzip, `PK` zip), not from the
URL, because a release asset can be redirected, renamed, or served with any content-type. Both extract.

`LOBSTER_ENGINE_URL` / `LOBSTER_ENGINE_SHA256` override the manifest for testing or self-hosting
(`LOBSTER_ENGINE_VERSION` defaults to the literal `override`), and `LOBSTER_LOBIUM_BIN` bypasses
provisioning entirely by pointing at a local build.

The manifest is the **only** file under `resources/` that is committed; everything else there is
regenerated by the build scripts and is git-ignored.

What the coherence gate enforces on it: at least one platform; every id from the known set; `version`
matching `w.x.y.z`; a 64-hex `sha256`; an `https://` url containing both its own version and its own
platform id; a `<id>Pending` block for any expected-but-absent platform; and either a manifest matching
the pin or a `rebuildPending` whose `targetVersion` equals `ENGINE_CHROME.full` and does not span a
milestone.

### 2.2 Linux

The supported path is the one-shot driver, which builds, packages, installs, and runs the product E2E:

```bash
bash scripts/build-linux-product.sh
```

It bundles the sidecar, packages the Lobium runtime, vendors Node + fonts + Lobee into
`apps/desktop/src-tauri/resources/`, builds the `.deb` (`npm run tauri -- build --bundles deb`), then
installs. Raw `npm run -w apps/desktop tauri build` produces only the `.deb`.

Install topology — **as `build-linux-product.sh` actually installs it**:

- `~/.local/share/lobster/` — `bin/lobster-desktop`, `lib/` (node, sidecar, fonts, lobee), `lobium/` (the
  official binary + `.so` + fonts + swiftshader), `env` (engine pointers), `host-calibration.json`.
- `dist-linux/run-lobster.sh` — sources `~/.local/share/lobster/env`, then execs the binary.
- `~/.local/bin/lobster-browser` — symlink to that wrapper.
- `~/.local/share/applications/lobster-browser.desktop` — launcher entry pointing at the wrapper.

The script **extracts** the `.deb` (`dpkg-deb -x`) into `~/.local/share/lobster`; it never runs `dpkg -i`.
Nothing is installed to `/usr` and no root is required. If you instead `dpkg -i` the `.deb` by hand you get
a system install at `/usr/bin/lobster-desktop` with a `.desktop` entry whose `Exec=lobster-desktop` does
**not** source the `env` file, so the packaged engine/font pointers are lost — repoint it at a wrapper.

To uninstall the per-user install: remove `~/.local/share/lobster`, `~/.local/bin/lobster-browser`,
`~/.local/share/applications/lobster-browser.desktop`, and the `lobster-browser.png` icons under
`~/.local/share/icons/hicolor/*/apps/`. That leaves profile data intact; delete
`~/.local/share/com.lobster.browser/` separately if you also want the data gone.

Key `env` pointers: `LOBSTER_LOBIUM_BIN`, `LOBSTER_LOBIUM_DIR`, `LOBSTER_FONTS_DIR`, `VK_ICD_FILENAMES`,
`VK_DRIVER_FILES`.

### 2.3 Windows

Builds natively — no WSL, no reboot. WSL cannot help here anyway: Windows Chromium cannot be built from
WSL, and Chromium cannot be cross-compiled from Linux to Windows.

Prerequisites: Node `>=22.12 <25`, the Rust MSVC toolchain (`rustup`, host `x86_64-pc-windows-msvc`),
VS Build Tools with the **Desktop development with C++** workload + Windows SDK, and WebView2 (the
installer ships a bootstrapper for machines without it, since WebView2 is not guaranteed on Windows 10).

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows-product.ps1
```

It stages the resources a fresh clone lacks — bundles the sidecar, downloads and SHA-256-verifies the
official win-x64 `node.exe` against `SHASUMS256.txt` (never copies the build host's interpreter), rebuilds
Lobee — then runs `tauri build --bundles nsis`. Output:
`apps\desktop\src-tauri\target\release\bundle\nsis\*.exe`.

**What it can and cannot do.** The installer carries the UI, Rust core, local automation API, the SQLite
profile/proxy/template stores, the sidecar and Lobee. It cannot launch a profile until a `win-x64` engine
archive is published — see below and [`STATUS.md`](STATUS.md) §2. `startProfile` refuses any engine but
Lobium, so a launch attempt fails closed with a clear error rather than falling back to an unprotected
browser.

#### Packaging the Windows engine runtime

The engine itself is built separately (§1) and packaged with:

```powershell
$version = '152.0.7977.42'
$src = 'C:\lobium-build\src\out\Lobium'
$fontPack = 'C:\lobster-build-inputs\lobster-open-fonts-<verified-pack-id>'
$fontScanner = 'C:\project\tools\msys64\mingw64\bin\fc-scan.exe'
$out = "C:\lobster\dist-win\lobium-runtime-$version"
if (-not (Test-Path -LiteralPath (Join-Path $fontPack 'font-pack.manifest.json') -PathType Leaf)) {
  throw "verified font pack is missing its manifest: $fontPack"
}
if (-not (Test-Path -LiteralPath $fontScanner -PathType Leaf)) {
  throw "reviewed fc-scan executable is missing: $fontScanner"
}
if (Test-Path -LiteralPath $out) { throw "refusing existing package output: $out" }
node scripts\verify-lobium-runtime.mjs --font-pack $fontPack --font-scanner $fontScanner
if ($LASTEXITCODE -ne 0) { throw 'font bytes do not match the declared family inventory' }
powershell -ExecutionPolicy Bypass -File scripts\package-lobium-runtime.ps1 `
  -SourceDir $src -OutDir $out -FontPack $fontPack -FontScanner $fontScanner
```

Use explicit paths and a new versioned output directory. The packager rejects source/output overlap,
validates the source version and complete native capability manifest before touching an existing output,
builds in a sibling staging directory, and rolls the previous output back if the final rename fails.
`LOBSTER_ENGINE.json` schema v2 records the observed Chromium/GN/capability provenance plus an SHA-256
ledger for every runtime file. With a font pack it also records the ordinal path/content/family
inventory digest and the exact fc-scan version/executable SHA-256 used before and after copying. The
external archive SHA-256 remains the trust anchor: this marker is an attestation, not a signature.
Verify any copied/extracted tree with `node scripts\verify-lobium-runtime.mjs <runtime-directory>`;
that no-scanner form validates the packaging attestation but explicitly says it did **not** rescan font
bytes. On a release host, pass `--font-scanner $fontScanner` to repeat the physical family proof.
That rescan also requires the scanner product, version, and executable SHA-256 to match the packaging
attestation; use no-scanner attestation mode rather than silently substituting a different tool.

Not a port of the Linux script — the two platforms ship genuinely different file sets, and copying the
Linux list produces a runtime that does not start. `chrome.exe` on Windows is a ~4 MB stub and essentially
the whole browser is `chrome.dll`; `chrome_elf.dll` must sit beside the exe because it is loaded before
anything else and resolved by directory; `d3dcompiler_47.dll` is what makes WebGL work, and its absence
does not fail loudly — `getContext('webgl')` simply returns null, which renders WebGL sites blank and is
itself a headless signal. Every load-bearing file is a hard error if missing rather than a warning.

Two were found by running the script rather than by reading it, and both produce errors that name neither
the missing file nor the real cause:

- **`<version>.manifest`** (e.g. `152.0.7977.42.manifest`). `chrome.exe`'s embedded manifest declares a
  dependency on that side-by-side assembly, and without the file the loader refuses to start the process
  with *"the application has failed to start because its side-by-side configuration is incorrect"* —
  before any Chromium code runs.
- **`msvcp140.dll` / `vcruntime140.dll` / `vcruntime140_1.dll`.** The build links the VC++ runtime
  dynamically. They are present on a developer machine and frequently absent on a user's, so this fails
  only after distribution.

The script reads `chrome.exe`'s PE `VERSIONINFO.ProductVersion` and requires the exact pinned four-part
Chromium version, then runs `--lobium-fingerprint-capabilities` against the packaged binary and checks
the Lobium v3 hooks the product requires. These are deliberately separate attestations: Chromium's
`--version` early-exit is POSIX-only and must not be used for a Windows executable, while PE version
metadata alone does not prove Lobium's native privacy semantics. A runtime that fails the capability
check would have failed at profile launch anyway; finding out at packaging time is cheaper. Compress
only the versioned `$out` created above, then extract the archive into a new directory and verify both
the artifact ledger and the executable:

```powershell
$archive = "C:\lobster\dist-win\lobium-win-x64-$version.zip"
$verifyDir = "C:\lobster\dist-win\verify-lobium-win-x64-$version"
if (Test-Path -LiteralPath $archive) { throw "refusing existing archive: $archive" }
if (Test-Path -LiteralPath $verifyDir) { throw "refusing existing verification directory: $verifyDir" }

node scripts\verify-lobium-runtime.mjs $out --font-scanner $fontScanner
if ($LASTEXITCODE -ne 0) { throw 'packaged runtime ledger verification failed' }
Compress-Archive -LiteralPath $out -DestinationPath $archive -CompressionLevel Optimal
Expand-Archive -LiteralPath $archive -DestinationPath $verifyDir
$extracted = Join-Path $verifyDir (Split-Path -Leaf $out)
node scripts\verify-lobium-runtime.mjs $extracted --font-scanner $fontScanner
if ($LASTEXITCODE -ne 0) { throw 'extracted runtime ledger verification failed' }

# Read the exact Windows PE version resource; use cmd.exe only to capture stdout from the
# WINDOWS-subsystem executable's native Lobium capability probe.
$probeTag = [guid]::NewGuid().ToString('N')
$capsProbe = Join-Path $env:TEMP "lobium-capabilities-$probeTag.json"
$extractedChrome = Join-Path $extracted 'chrome.exe'
$reportedVersion = (Get-Item -LiteralPath $extractedChrome -ErrorAction Stop).VersionInfo.ProductVersion
if ($reportedVersion -notmatch '^\d+\.\d+\.\d+\.\d+$' -or $reportedVersion -cne $version) {
  throw "unexpected engine ProductVersion: $reportedVersion"
}
cmd /d /c "`"$extractedChrome`" --lobium-fingerprint-capabilities > `"$capsProbe`" 2>&1"
if ($LASTEXITCODE -ne 0) { throw 'extracted Lobium capability probe failed' }
$actualCaps = Get-Content -LiteralPath $capsProbe -Raw | ConvertFrom-Json
$marker = Get-Content -LiteralPath (Join-Path $extracted 'LOBSTER_ENGINE.json') -Raw | ConvertFrom-Json
if ($actualCaps.product -cne 'Lobium' -or $actualCaps.contractVersion -ne 3 -or
    ((@($actualCaps.capabilities) -join "`n") -cne (@($marker.provenance.capabilities) -join "`n"))) {
  throw 'extracted executable capability manifest differs from its verified package marker'
}
$archiveSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "verified archive SHA-256: $archiveSha256"
```

`--url` is mandatory for the first Windows publication because there is no prior `win-x64` URL from
which the bump tool can derive the new one. Upload `$archive`, then download that exact final URL and
compare it with `$archiveSha256` before moving the manifest; the bump tool hashes the local archive but
does not fetch the remote asset:

```powershell
$url = "https://github.com/Manipulatora/lobster-browser/releases/download/engine-v$version/lobium-win-x64-$version.zip"
$publishedCopy = Join-Path $env:TEMP "published-lobium-win-x64-$probeTag.zip"
Invoke-WebRequest $url -OutFile $publishedCopy -UseBasicParsing -TimeoutSec 1800
$publishedSha256 = (Get-FileHash -LiteralPath $publishedCopy -Algorithm SHA256).Hash.ToLowerInvariant()
if ($publishedSha256 -cne $archiveSha256) { throw 'published archive differs from the verified local archive' }
node scripts\bump-engine-version.mjs $version --platform win-x64 `
  --archive $archive --url $url
```

The `win-x64` entry is deliberately absent until that archive exists. A URL published ahead of its
artifact means every Windows first run 404s after an ~840 MB download; an absent entry fails immediately
and says why.

**Fonts on Windows.** `provision-open-fonts.mjs` shells out to `fc-scan`, so the pack must be produced in
an environment with fontconfig. That can be Linux or a reviewed Windows/MSYS2 installation supplied via
`--fc-scan <executable>`; this build host currently uses the explicit `$fontScanner` above. The pack is
then carried into the runtime directory by the packaging script. It is consumed differently per
platform: Linux points
`FONTCONFIG_FILE` at it, while on Windows the engine sideloads the faces into its DirectWrite collection
from the `fontPackDir` in the profile config. Both need the files physically present. Font isolation
itself is native on Windows and works without the pack — the engine filters font lookups against the
persona list — but filtering can only *subtract*; see [`STATUS.md`](STATUS.md) §2.

Before transferring `$fontPack` to the Windows build host, independently verify manifest version 1, safe
unique `files/` paths and supported font extensions, an exact declared-versus-present file set, every
declared SHA-256, **exact equality** between each file's declared families and its complete `fc-scan`
family set (including every TTC companion face), each persona's physical set closed over every family
exposed by any selected multi-family file, and required persona/license coverage, with no symlinks or
reparse points. Transfer it as a new archive with an external SHA-256, extract it into a fresh
directory on Windows, and repeat the manifest/file/digest and scanner checks before using
`-FontPack -FontScanner`. Omitting
`-FontPack` is supported only for local diagnosis as a visibly degraded subtractive-only runtime; do not
publish that runtime as the production `win-x64` engine.

> **The packaged sidecar could not start, on any platform.** `scripts/bundle-sidecar.mjs` copies a
> HAND-MAINTAINED list of third-party packages, and `copyPkg` only *warns* when one is absent — so when
> `@lobster/agent` gained a `tldts` dependency, the bundle kept being produced and kept being shipped.
> The installed app opened normally, reported nothing, and died with
> `ERR_MODULE_NOT_FOUND: Cannot find package 'tldts'` before its first RPC, leaving a live app wired to a
> dead sidecar in which every profile launch fails. Unit tests could not catch it: they run against the
> workspace, where the dependency is hoisted and resolves fine.
>
> The bundler now **starts the bundle it just produced and round-trips a `ping`**, with a bare
> environment, and fails the build if that does not work. A dependency check would only catch what it
> knows to look for; running the artifact catches anything that stops it starting.

### 2.4 Profile data

- DB: `~/.local/share/com.lobster.browser/profiles.sqlite` (tables: `profiles`, `proxies`,
  `profile_templates`, `agent_secrets`). Recreated empty on first launch if absent.
- Per-profile user-data dirs: `~/.local/share/com.lobster.browser/profiles/<id>/`.
- To reset ("init the db"): delete `profiles.sqlite{,-wal,-shm}` + the `profiles/` dirs. Keep app
  infrastructure (`secrets.key`, `local-api-key`, caches).

**Cookie durability (Linux).** Native launches pass `--password-store=basic` so OSCrypt does not depend on
an unstable or absent keyring on headless/Xvfb hosts; without it, cookies become undecryptable on the next
launch and users get re-logged-out.

Portability, snapshotting and cloud sync are a separate design with its own document —
[`PROFILE_DATA_SYNC.md`](subsystems/profile-data.md).

## 3. Deploy the cloud

The backend (`api.lobrowser.com`) and the site (`lobrowser.com`) have their own runbook with the nginx and
systemd units that serve them: **[`../deploy/README.md`](../deploy/README.md)**.

`scripts/deploy-web.sh` builds `apps/web` and publishes it. It stages the build into a fresh timestamped
directory under `/var/www/lobster-releases`, then swaps the `/var/www/lobster` **symlink** with
`ln -sfn`, which renames over the old link so there is no instant where the path does not exist. An
`rsync --delete` straight over the live root — which is what this did before — is not atomic. It then
verifies over loopback and **rolls back by itself** if the new release does not serve:

```sh
./scripts/deploy-web.sh              # build, publish, verify, auto-rollback on failure
./scripts/deploy-web.sh --rollback   # repoint at the previous release
```

Run `npm run gate:migrations` before deploying a backend migration: it applies the whole chain to PGlite
(real Postgres, compiled to WASM) and asserts the billing invariants, so an `ALTER TYPE` that cannot apply
is caught here rather than against the live database.

## 4. Validation gates

```bash
# Offline gates (run anywhere; no GPU, proxy, or engine binary needed). CI runs these three on every push.
npm run gate:engine                       # patch-series structure + version/manifest coherence + hygiene
npm run gate:desktop-css                  # every class the desktop renders has a CSS definition
npm run gate:migrations                   # the migration chain against PGlite + the money invariants

node ci/validation/regression-gate.mjs    # in-process coherence/diversity floors + fingerprint units
node scripts/track-upstream.mjs           # online: pin is released + not behind stable

# Engine-source gates (need the Chromium checkout; no browser launch)
npm run gate:series                       # the series REPRODUCES the checkout, file for file
npm run gate:kernels                      # compile the shipping canvas/audio kernels, assert the oracles

# In-browser gates (need the native binary; these catch what source review cannot)
LOBSTER_LOBIUM_BIN=/path/to/chrome npm run gate:oracles   # the ENGINE_AUDIT oracles, in the page
LOBSTER_LOBIUM_BIN=/path/to/chrome npm run gate:fonts     # does the font filter actually engage?

# Desktop UI end-to-end (Playwright; starts its own vite, no Tauri shell needed)
npm run e2e:desktop                       # 38 tests across 7 specs, ci/playwright.desktop.config.ts

# Real-browser agent fixtures (needs an engine; no model, no credentials, no network)
node ci/validation/e2e/agent-browser-e2e.mjs             # interim Chromium: browser-integration evidence
LOBSTER_LOBIUM_BIN=/path/to/chrome \
  node ci/validation/e2e/agent-browser-e2e.mjs           # shipping engine: Gate B evidence

# Engine gate (needs the native Lobium binary; a REAL GPU for a release-valid verdict)
LOBSTER_LOBIUM_BIN=/path/to/chrome node ci/validation/battle-test.mjs   # per-persona surface application
LOBSTER_LOBIUM_BIN=/path/to/chrome node ci/validation/deep-probe-50.mjs # 50 personas: tells + distinctness
LOBSTER_GPU=gpu node ci/validation/gate.mjs                             # release blocker, real-GPU only

# Deterministic Lobee gates
npm test --workspace @lobster/agent
npm test --workspace @lobster/engine-runner
npm test --workspace @lobster/lobee-app
node --test ci/validation/agent-battery.test.mjs
npm run typecheck --workspaces --if-present
npm run build --workspace @lobster/lobee-app
npx prettier --check "packages/**/*.{ts,tsx,js,json}"
```

Three of these do not belong to the "runs anywhere" tier despite looking like they do:

- `gate:series` needs a Chromium checkout **at the pinned version**. It sits permanently red on any host
  whose checkout is stale, which is why CI gives it its own opt-in job on a self-hosted runner rather than
  putting it in the offline set. See [`STATUS.md`](STATUS.md) §3.
- `gate:kernels` is a PowerShell entry point (`lobium/test/run.ps1`) for the Windows build host.
- `battle-test.mjs` and `deep-probe-50.mjs` both launch the native binary, and `battle-test.mjs` reports a
  host-GPU tell on a software renderer, so only a real-GPU host produces a release-valid verdict.

`gate:oracles` has three outcomes, not two: `0` PASS, `1` FAIL (an oracle for a *fixed* finding measured
and failed — a fact about the engine), `2` BLOCKED (nothing conclusive was measured — a fact about the
environment). It exits BLOCKED when there is no binary, or when the binary's capabilities do not cover
what the launcher requires. Collapsing the two is how a run against an unmeasurable engine gets filed as a
regression report. Persona OS comes from `LOBIUM_ORACLE_OS` (default `windows`), not from
`process.platform`.

`regression-gate.mjs` is an in-process coherence and diversity floor plus the fingerprint unit suite. It
reads **no committed baseline**, launches **no browser**, and runs **no automation-tell probe**; earlier
wording here and in [`ENGINEERING.md`](ENGINEERING.md) claimed all three.

### What CI actually runs

`.github/workflows/ci.yml` (push and PR to `main`) runs twelve jobs. Always-on and blocking: web
typecheck/build/test/format; the three offline gates; the desktop Playwright e2e; secret scan; Rust
build/test/fmt/clippy; the cross-platform matrix; engine launch under an interim Chromium; and the
fingerprint software gate. Opt-in behind repository variables: the series replay
(`LOBSTER_ENABLE_SERIES_REPLAY`, self-hosted `lobium-build`), the native Lobium detector
(`LOBSTER_ENABLE_LOBIUM_DETECT`), and the product E2E (`LOBSTER_ENABLE_PRODUCT_E2E`).

`gate:oracles` and `gate:fonts` run **only** in `.github/workflows/real-gpu-gate.yml`, on the self-hosted
`gpu` runner, nightly and on demand. Its `pull_request` trigger is commented out until that runner is
reliably online. The evidence policy in `detector-matrix.json` forbids software renderers, so a genuine
detection pass requires real hardware.

The Lobee paid/live capability battery is a separate protected workflow
(`.github/workflows/agent-battery.yml`, self-hosted, 240-minute timeout, its own environment). It is kept
structurally away from `pull_request` CI so untrusted PR code can never reach an environment holding
provider secrets. It returns non-zero `BLOCKED` when its environment is incomplete. Deterministic grader
success is not a live model/browser pass, and no paid live pass has been run.

The desktop e2e suite is **blocking on purpose**. A suite that cannot red the branch is a suite nobody
repairs; these specs must be updated with the UI rather than carried as a permanent `continue-on-error`.

## 5. Runtime contracts

### Rust core ⇄ sidecar (stdio JSON-RPC)

The Tauri Rust core spawns the Node sidecar and calls it over line-delimited JSON-RPC on stdio. Primary
method: `startProfile(StartProfileParams) → { profileId, pid, ws, debuggerAddress }`. The sidecar refuses
any engine but `lobium` and probes the exact executable for the native hooks the profile's policy requires
before spawning it. It resolves the CDP endpoint from the `DevToolsActivePort` file, injects imported
cookies over the first-party CDP client, and (for mobile profiles) installs native device emulation. It
returns the raw CDP `ws` + Selenium `debuggerAddress` for the user's own automation.

**Dispatch is concurrent, launches are bounded.** The read loop no longer awaits each dispatch: it used to
serialise every request behind the one before it, so starting the second of a hundred profiles waited for
the first browser to come up while a status poll queued behind both, past the core's 90 s per-call
deadline. Responses already carry the request id and the reader already routes by id, so out-of-order
completion was part of the contract. What stays bounded is how many browsers start at once, which is now
an explicit semaphore, with one write call per response line so concurrent handlers cannot interleave and
break the newline framing.

Web-agent methods share the same authenticated desktop boundary: `agent.start`, `agent.stop`,
`agent.sendInput`, `agent.status`, and `agent.setCredential`. Never log or persist the raw `agent.start`
params — they carry the in-memory provider credential during that call. The agent's own state model,
bridge, journal and recovery rules are in [`subsystems/agent.md`](subsystems/agent.md).

The type definitions live in `packages/shared-types/src/ipc.ts`, which cites this section as its spec.

### Local automation API (developer-facing)

The desktop app exposes a local HTTP API (Axum) that delegates `start`/`stop`/`status` to the sidecar and
returns `{ profileId, pid, ws, debuggerAddress }`. Users attach their own tooling:

```js
// The SDK does NOT import Playwright/Puppeteer — you pass ws to your own client.
const { ws } = await lobster.start(profileId);
const browser = await chromium.connectOverCDP(ws);   // your automation, your choice
```

Client SDK + snippets (Playwright/Puppeteer/Selenium, JS + Python) live in `packages/local-api-sdk`.

### At-rest encryption

`packages/crypto` and `apps/desktop/src-tauri/src/blob_crypto.rs` cite a normative wire format as
"`docs/OPERATIONS.md` §1.3". **That section does not exist in this file.** The key hierarchy and envelope
format as built are in [`PROFILE_DATA_SYNC.md`](subsystems/profile-data.md) §8 and its "Correction: the key
custody design was over-built" section; the source comments are the stale pointer, not the doc.

## 6. Known operational gotchas

- `pkill -f <pattern>` self-matches the calling shell (the pattern appears in the command line) → it can
  kill your own command (exit 144). Use `fuser -k <file>` or `pgrep -x <exact-name>` instead.
- `nohup <cmd> &` inside a backgrounded wrapper detaches a grandchild and the wrapper exits immediately
  (no completion signal). Run the blocking command directly as the background job.
- Native `-Werror`: a `return;` before code triggers `-Wunreachable-code`; an unused local triggers
  `-Wunused-variable`. Keep engine edits warning-clean.
- **Windows PowerShell 5.1 writes a UTF-8 BOM** from `Set-Content -Encoding utf8` and
  `Out-File -Encoding utf8`. A BOM is invisible in every editor and has broken this repo twice (patch
  files that `git apply` rejected; a `package.json` whose failure surfaced as "Failed to load PostCSS
  config" in an unrelated package). Use `[System.IO.File]::WriteAllText($path, $text, (New-Object
  System.Text.UTF8Encoding($false)))`, or write the file from Node. `gate:engine` fails on one.
- Agent URL/DNS preflight covers explicit top-level navigation only; it is not a browser-wide
  private-network egress sandbox. Perception also uses main-world DOM APIs that a hostile page can
  monkeypatch. Keep both limitations visible when assessing a deployment; see
  [`LOBEE_AGENT_ROADMAP.md`](subsystems/agent.md) §10.
