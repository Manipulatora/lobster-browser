# Project Status — What Exists, What Runs Where

Status date: 2026-08-14. Written as the orientation document for an engineer or agent picking this
repository up on a new machine. It records what is true today, not what is planned; the plans live in
[`ENGINEERING.md`](ENGINEERING.md) §5 and [`LOBEE_AGENT_ROADMAP.md`](LOBEE_AGENT_ROADMAP.md).

## 1. What this repository contains

Four deliverables share one monorepo:

| Deliverable | Path | State |
| --- | --- | --- |
| **Desktop app** — Tauri 2 (Rust) + React UI, the product | `apps/desktop` | Builds and runs on Linux. Linux-only bundle target. |
| **Lobium engine** — Chromium 152 fork with native fingerprinting | `lobium/` (build scripts + patches) | Builds on Linux. **No Windows build exists.** |
| **Marketing site** — Angular 22 SSR/SSG | `apps/web` | Live at `lobrowser.com`, deployed from this machine. |
| **Cloud backend** — NestJS (auth, teams, sync, billing) | `apps/backend` | In-repo; not covered by this document. |

The engine is **not** bundled into the installer. `apps/desktop/src-tauri/resources/engine-manifest.json`
declares a URL + SHA256, and the Rust core streams and extracts that tarball on first run. This is why the
`.deb` is small and why platform support is a manifest question as much as a build question.

## 2. Platform support — the honest matrix

| Component | Linux x64 | Windows x64 | macOS |
| --- | --- | --- | --- |
| Rust/Tauri core | Ships | Should compile; **never built or run** | Untested |
| Sidecar (`engine-runner`) | Ships | Pure JS, no native modules — expected to work | Untested |
| Vendored Node runtime | Ships | **Broken by construction** (see below) | Untested |
| Lobium engine | Ships | **Does not exist** | Does not exist |
| Installer bundle target | `deb` | **Not configured** | Not configured |
| Fingerprint personas | Ships | Ships (~1.8k Windows presets) | Ships (~200 presets) |

Three concrete blockers stand between this repository and a working Windows installer:

1. **No Windows engine.** `engine-manifest.json` pins `"platform": "linux-x64"` and a
   `lobium-linux-x64.tar.gz` URL. Chromium cannot be cross-compiled from Linux to Windows; producing
   `lobium-win-x64` needs a native Windows build host. Without it a Windows build installs and opens but
   cannot launch a single profile.
2. **The vendored Node binary is a Linux ELF.** `scripts/build-linux-product.sh` step 3 does
   `cp -a "$(command -v node)" resources/node/bin/node` — it copies *this host's* interpreter. A Windows
   build needs an official win-x64 `node.exe` fetched instead of copied.
3. **`tauri.conf.json` declares `"targets": ["deb"]`.** Windows needs `nsis` (and/or `msi`), plus WebView2
   handling, since WebView2 is not guaranteed present on Windows 10.

What is *not* a blocker: the sidecar has no native modules, the Rust core's Linux-specific code is properly
`cfg(target_os = "linux")`-gated (sandbox and GPU heuristics that are Linux concepts anyway), `main.rs`
already sets `windows_subsystem`, and the fingerprint catalog already models Windows personas.

## 3. Build hosts — what can be built where

Chromium's own requirements, checked against `lobium/gn-args.gn.example`:

- **Disk:** the args set `symbol_level = 0` and `blink_symbol_level = 0`, which is the biggest saver. Source
  checkout (~50–70GB on Windows) + `out/` (~30–60GB without symbols) + VS/SDK (~20–30GB) lands near the
  ~150GB the `lobium/build.sh` header quotes.
- **RAM:** `is_official_build` + `use_thin_lto` makes the `chrome.dll` link the peak. 16GB is the documented
  minimum, 32GB the comfortable figure. On 24GB, set `concurrent_links = 1` or the link can OOM.
- **CPU:** 8 cores is fine but slow — expect ~8–12h for a clean build. `chrome_pgo_phase = 2` *uses* a
  downloaded PGO profile (fetched by `gclient runhooks`), so no instrumented pass is needed.

**GitHub Actions cannot build the engine on a hosted runner.** A hosted `windows-latest` gives roughly
4 vCPU / 16GB / ~14GB free disk against a ~150GB requirement, jobs are killed at 6 hours, and the Actions
cache is capped at 10GB per repository so `out/` cannot be checkpointed between jobs. The engine build must
run on a **self-hosted** runner. This repository already uses that pattern —
`.github/workflows/agent-battery.yml` runs on `[self-hosted, agent-battery]` with a 240-minute timeout, and
`real-gpu-gate.yml` on `[self-hosted, gpu]`.

The **installer** has no such problem: a hosted `windows-latest` runner builds a Tauri bundle in minutes.
Splitting the two matches how often each changes — the engine per Chromium bump, the installer per release.

`lobium/build.sh` step 4 applies patches with `quilt`, which is not available natively on Windows and the
build must be native (Windows Chromium cannot be built from WSL). That step needs reworking — `git apply`
over `lobium/patches/series` is the direct substitute.

## 4. What a fresh clone does not include

`.gitignore` correctly excludes build output and secrets, so a clone is ~84MB and needs provisioning:

| Missing | Restore with |
| --- | --- |
| `node_modules/` | `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install` |
| `apps/desktop/src-tauri/resources/{sidecar,node,fonts,lobee}` | `node scripts/bundle-sidecar.mjs`, `node scripts/build-lobee.mjs`, and the vendoring steps in `build-linux-product.sh` |
| `packages/lobee/` | `node scripts/build-lobee.mjs` (rm -rf's and rewrites it) |
| `.env` | Recreate from `.env.example`. The only key here is `VENICE_API_KEY`, used by `scripts/venice-chat.mjs`. |
| The Lobium engine | Downloaded on first run per `engine-manifest.json`, or pointed at a local build via `LOBSTER_LOBIUM_BIN` |
| `ci/validation/reports/` | Regenerated by the validation harnesses |

`engine-manifest.json` **is** tracked — it is configuration, not build output, and it is the only file under
`resources/` in git.

Profile data (`profiles.sqlite`, `secrets.key`, per-profile dirs) lives in the OS app-data directory
(`~/.local/share/com.lobster.browser/` on Linux), never in the repository. It does not travel with a clone,
and uninstalling the app does not remove it.

## 5. Verification status

Read [`ENGINEERING.md`](ENGINEERING.md) §4 and [`LOBEE_AGENT_ROADMAP.md`](LOBEE_AGENT_ROADMAP.md) §4 for the
full picture. The short version, because it is easy to overstate:

- The **software gate** (`regression-gate.mjs`) runs anywhere: coherence, device-class diversity floors, and
  fingerprint unit contracts. It reads no baseline and launches no browser.
- The **engine gates** (`battle-test.mjs`, `deep-probe-50.mjs`) need the native binary, and
  `battle-test.mjs` reports a deep-GPU tell on a software renderer — so this host cannot produce a
  release-valid verdict from them.
- The **real-GPU detection gate** is the release blocker and requires real hardware; the evidence policy in
  `detector-matrix.json` rejects software renderers.
- The **paid live agent battery** has not been run. Deterministic grader success is not a live
  model/browser pass.

This build host has no real GPU (SwiftShader only), so W1 data capture and the W5 live detection gate
cannot execute here — only their code and schemas can.
