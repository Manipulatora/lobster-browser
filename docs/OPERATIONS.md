# Lobium Operations — Build, Install, Validate, Contracts

Everything needed to build the engine, ship the product, run the gates, and integrate. Updated 2026-08-14.

Everything below is **Linux x64**. No Windows or macOS build exists; see
[`STATUS.md`](STATUS.md) §2–3 for the blockers and the build-host requirements before attempting one.

## 1. Build the Lobium engine

Chromium source lives at `~/lobium-build/src`; `depot_tools` at `~/lobium-build/depot_tools` (put it on
`PATH`). Custom code is in `components/lobium_fp/` + the quilt series `lobium/patches/series`.

```bash
export PATH="$HOME/lobium-build/depot_tools:$PATH"
cd ~/lobium-build/src

# Official build (shipping): is_official_build, thin-LTO, PGO. Single ~525MB binary + 7 .so.
autoninja -C out/LobiumOfficial chrome

# Component build (fast dev iteration): ~172MB + ~556 .so. Faster link, slower startup.
autoninja -C out/Lobium chrome
```

The official build needs the V8 builtins PGO profile:
`python3 v8/tools/builtins-pgo/download_profiles.py download --depot-tools ~/lobium-build/depot_tools`.

**Do not mix builds when deploying** — the official binary loads 7 `.so`; the component binary needs ~556.
Deploying component `.so` over an official install breaks with `libui_ozone.so: cannot open shared object`.

Branding assets (icons, tab/product logos, mono-dark favicon) are rendered by
`scripts/apply-lobium-branding.mjs`.

### 1.1 Bumping the Chrome version

Three files pin the version and must never disagree: `lobium/build.sh` (`CHROMIUM_REF`, what is built),
`packages/fingerprint/src/pools.ts` (`ENGINE_CHROME`, what every persona's UA claims), and
`apps/desktop/src-tauri/resources/engine-manifest.json` (which tarball first-run provisioning installs).
Never edit them by hand:

```bash
node scripts/track-upstream.mjs                      # is a bump due? exits non-zero if action needed
node scripts/bump-engine-version.mjs 152.0.7977.42   # or --latest-stable; moves build.sh + ENGINE_CHROME
bash lobium/rebase.sh 152.0.7977.42 --run            # re-applies the quilt series (does the bump for you)
bash lobium/build.sh --run                           # ~8-12h on the build host
bash scripts/package-lobium-runtime.sh               # produces lobium-linux-x64.tar.gz
# upload the tarball to the GitHub release, then finalize the manifest against the REAL digest:
node scripts/bump-engine-version.mjs 152.0.7977.42 --tarball dist/lobium-linux-x64.tar.gz
node scripts/track-upstream.mjs                      # must exit 0
node --test ci/validation/version-coherence.test.mjs
```

**Pin a RELEASED build, never a canary.** `getHighEntropyValues(['fullVersionList'])` returns the real
build, so a nightly nobody runs is close to a globally unique identifier — and a `.0` patch component
advertises it as a branch-point build. Both the bump script and the coherence test refuse one. (The repo
sat on canary `152.0.7928.0` until 2026-08-14 because the old tracker compared version ordering only and
reported the canary as "UP TO DATE".)

**The manifest moves last, and only against a real artifact.** Pointing it at a version whose tarball is
not uploaded does not prepare anything — the URL 404s or the SHA-256 mismatches and first-run
provisioning fails for every user. Between the source bump and the rebuild the manifest carries a
`rebuildPending` block; the coherence test requires that declaration and requires it to stay inside the
same milestone.

## 2. Package & install the product

The desktop app bundles the React UI, the Node sidecar, the font pack, the built Lobee extension, and
`engine-manifest.json`. It does **not** bundle the ~840MB Lobium runtime — see §2.1.

The supported path is the one-shot driver, which builds, packages, installs, and runs the product E2E:

```bash
bash scripts/build-linux-product.sh
```

It bundles the sidecar, packages the Lobium runtime, vendors Node + fonts + Lobee into
`apps/desktop/src-tauri/resources/`, builds the `.deb` (`npm run tauri -- build --bundles deb`), then
installs. Raw `npm run -w apps/desktop tauri build` produces only the `.deb`.

Install topology (Linux) — **as `build-linux-product.sh` actually installs it**:

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
`~/.local/share/icons/hicolor/*/apps/`. That leaves profile data intact (see "Profiles data" below);
delete `~/.local/share/com.lobster.browser/` separately if you also want the data gone.

Key `env` pointers: `LOBSTER_LOBIUM_BIN`, `LOBSTER_LOBIUM_DIR`, `LOBSTER_FONTS_DIR`, `VK_ICD_FILENAMES`,
`VK_DRIVER_FILES`.

### 2.1 Engine provisioning (the downloader model)

`apps/desktop/src-tauri/resources/engine-manifest.json` declares `{engine, platform, version, url,
sha256}`. On first run the Rust core streams that tarball, verifies the digest, and extracts it, which is
why the `.deb` ships without the engine. `LOBSTER_ENGINE_URL` / `LOBSTER_ENGINE_SHA256` override it for
testing or self-hosting, and `LOBSTER_LOBIUM_BIN` bypasses provisioning entirely by pointing at a local
build.

The manifest is the **only** file under `resources/` that is committed; everything else there is
regenerated by the build scripts and is git-ignored. It currently pins `"platform": "linux-x64"`, so it is
also the file that must gain per-platform selection before any non-Linux build can provision an engine.

### 2.2 Marketing site

`apps/web` is an Angular 22 SSR/SSG site deployed by `scripts/deploy-web.sh`, which builds, checks the
prerender produced an `index.html`, `rsync --delete`s to `/var/www/lobster`, reloads nginx, and curls
`/`, `/pricing`, `/auth/sign-in` expecting 200. It runs on the web host itself; there is no remote step.

### 2.3 Windows build (desktop app only)

Builds natively on Windows — no WSL, no reboot. WSL cannot help here anyway: Windows Chromium cannot be
built from WSL, and Chromium cannot be cross-compiled from Linux to Windows.

Prerequisites: Node `>=22.12 <25`, the Rust MSVC toolchain (`rustup`, host `x86_64-pc-windows-msvc`),
VS Build Tools with the **Desktop development with C++** workload + Windows SDK, and WebView2 (the
installer ships a bootstrapper for machines without it).

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows-product.ps1
```

It stages the resources a fresh clone lacks — bundles the sidecar, downloads and SHA256-verifies the
official win-x64 `node.exe` (never copies the build host's interpreter), rebuilds Lobee — then runs
`tauri build --bundles nsis`. Output: `apps\desktop\src-tauri\target\release\bundle\nsis\*.exe`.

**What it can and cannot do.** The installer carries the UI, Rust core, local automation API, the
SQLite profile/proxy/template stores, the sidecar and Lobee. It cannot launch a profile until a
`win-x64` engine archive is published — see below, and [`STATUS.md`](STATUS.md) §2. `startProfile`
refuses any engine but Lobium, so a launch attempt fails closed with a clear error rather than
falling back to an unprotected browser.

#### Packaging the Windows engine runtime

The engine itself is built separately (§1) and packaged with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\package-lobium-runtime.ps1
```

Not a port of the Linux script — the two platforms ship genuinely different file sets, and copying
the Linux list produces a runtime that does not start. `chrome.exe` on Windows is a ~4 MB stub and
essentially the whole browser is `chrome.dll`; `chrome_elf.dll` must sit beside the exe because it is
loaded before anything else and resolved by directory; `d3dcompiler_47.dll` is what makes WebGL work,
and its absence does not fail loudly — `getContext('webgl')` simply returns null, which renders WebGL
sites blank and is itself a headless signal. Every load-bearing file is a hard error if missing rather
than a warning.

> **The packaged sidecar could not start, on any platform.** `scripts/bundle-sidecar.mjs` copies a
> HAND-MAINTAINED list of third-party packages, and `copyPkg` only *warns* when one is absent — so
> when `@lobster/agent` gained a `tldts` dependency, the bundle kept being produced and kept being
> shipped. The installed app opened normally, reported nothing, and died with
> `ERR_MODULE_NOT_FOUND: Cannot find package 'tldts'` before its first RPC, leaving a live app wired
> to a dead sidecar in which every profile launch fails. Unit tests could not catch it: they run
> against the workspace, where the dependency is hoisted and resolves fine.
>
> The bundler now **starts the bundle it just produced and round-trips a `ping`**, with a bare
> environment, and fails the build if that does not work. A dependency check would only catch what it
> knows to look for; running the artifact catches anything that stops it starting.

Two of those were found by running the script rather than by reading it, and both produce errors that
name neither the missing file nor the real cause:

- **`<version>.manifest`** (e.g. `152.0.7977.42.manifest`). `chrome.exe`'s embedded manifest declares
  a dependency on that side-by-side assembly, and without the file the loader refuses to start the
  process with *"the application has failed to start because its side-by-side configuration is
  incorrect"* — before any Chromium code runs.
- **`msvcp140.dll` / `vcruntime140.dll` / `vcruntime140_1.dll`.** The build links the VC++ runtime
  dynamically. They are present on a developer machine and frequently absent on a user's, so this
  fails only after distribution.

The script finishes by running `--lobium-fingerprint-capabilities` against the packaged binary and
checking the hooks the product requires. A runtime that fails there would have failed at profile
launch anyway; finding out at packaging time is cheaper.

Then compress `dist-win\lobium-runtime`, upload it to the engine release, and register it:

```powershell
node scripts\bump-engine-version.mjs 152.0.7977.42 --platform win-x64 --archive <lobium-win-x64.zip>
```

`engine-manifest.json` is a per-platform map, and the `win-x64` entry is deliberately absent until
that archive exists. A URL published ahead of its artifact means every Windows first run 404s after
an ~840 MB download; an absent entry fails immediately and says why.

**Fonts on Windows.** `provision-open-fonts.mjs` shells out to `fc-scan`, which does not exist on
Windows, so the pack is provisioned on a Linux host (or by any environment with fontconfig) and
carried into the runtime directory by the packaging script above. The pack is consumed differently
per platform: Linux points `FONTCONFIG_FILE` at it, while on Windows the engine sideloads the faces
into its DirectWrite collection from the `fontPackDir` in the profile config. Both need the files
physically present.

Font isolation itself is native on Windows and works without the pack — the engine filters font
lookups against the persona list — but filtering can only *subtract*. Without a pack the measurable
set is host ∩ persona: narrower than the persona claims, never wider than the host. Degraded, not
leaking, which is why this path fails open where the Linux one fails closed.

Bundle targets live in platform configs (`tauri.windows.conf.json` → `nsis`,
`tauri.linux.conf.json` → `deb` + the font pack), which Tauri merges over `tauri.conf.json`. Note the
merge is per-key for objects: a platform config **adds to** `bundle.resources`, it cannot remove an
entry — which is why the font pack had to move out of the base config rather than being overridden.

### Profiles data

- DB: `~/.local/share/com.lobster.browser/profiles.sqlite` (tables: `profiles`, `proxies`,
  `profile_templates`). Recreated empty on first launch if absent.
- Per-profile user-data dirs: `~/.local/share/com.lobster.browser/profiles/<id>/`.
- To reset ("init the db"): delete `profiles.sqlite{,-wal,-shm}` + the `profiles/` dirs. Keep app
  infrastructure (`secrets.key`, `local-api-key`, caches).

### Cookie durability (Linux)

Native launches pass `--password-store=basic` so OSCrypt does not depend on an unstable/absent keyring on
headless/Xvfb hosts; without it, cookies become undecryptable on the next launch and users get re-logged-out.

## 3. Validation gates

```bash
# Software gate (runs anywhere; no GPU, proxy, or engine binary needed)
node ci/validation/regression-gate.mjs    # in-process coherence/diversity floors + fingerprint units
npm run gate:engine                       # patch-series structure + version/manifest coherence
node scripts/track-upstream.mjs           # online: pin is released + not behind stable

# Engine-source gates (need the Chromium checkout; no browser launch)
npm run gate:series                       # the series REPRODUCES the checkout, file for file
npm run gate:kernels                      # compile the shipping canvas/audio kernels, assert the oracles

# In-browser gates (need the native binary; these catch what source review cannot)
LOBSTER_LOBIUM_BIN=/path/to/chrome npm run gate:oracles   # the ENGINE_AUDIT oracles, in the page
LOBSTER_LOBIUM_BIN=/path/to/chrome npm run gate:fonts     # does the font filter actually engage?

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

`battle-test.mjs` and `deep-probe-50.mjs` are **not** part of the "runs anywhere" tier: both launch the
native binary, and `battle-test.mjs` reports a host-GPU tell on a software renderer, so only a real-GPU
host produces a release-valid verdict from them. They were listed as offline/software checks and are
not.

`regression-gate.mjs` is an in-process coherence and diversity floor plus the fingerprint unit suite. It
reads **no committed baseline**, launches **no browser**, and runs **no automation-tell probe**; earlier
wording here and in `docs/ENGINEERING.md` claimed all three.

`.github/workflows/ci.yml` runs the software gate, the deterministic Lobee suites, and the real-browser
agent fixtures on an interim Chromium; `.github/workflows/real-gpu-gate.yml` runs the release gate on a
self-hosted `real-gpu` runner. The evidence policy in `detector-matrix.json` forbids software
renderers, so a genuine detection pass requires real hardware.

The Lobee paid/live capability battery is a separate protected workflow. It requires an explicit Lobium
binary and managed-proxy credential pair, gives every attempt the validated configured token budget, and
returns non-zero `BLOCKED` when its environment is incomplete. Deterministic grader success is not a live
model/browser pass; no paid live pass was run during the 2026-08-10 hardening work.

## 4. Runtime contracts

### Rust core ⇄ sidecar (stdio JSON-RPC)

The Tauri Rust core spawns the Node sidecar and calls it over line-delimited JSON-RPC on stdio. Primary
method: `startProfile(StartProfileParams) → { profileId, pid, ws, debuggerAddress }`. The sidecar refuses
any engine but `lobium`. It spawns the native binary, resolves the CDP endpoint from the
`DevToolsActivePort` file, injects imported cookies over the first-party CDP client, and (for mobile
profiles) installs native device emulation. It returns the raw CDP `ws` + Selenium `debuggerAddress` for
the user's own automation. The built-in agent uses the same first-party CDP boundary only after the user
explicitly starts a run for that profile.

Web-agent methods share the same authenticated desktop boundary: `agent.start`, `agent.stop`,
`agent.sendInput`, and `agent.status`. The Rust command validates the profile, injects the encrypted-store
provider credential and per-profile memory key, then the sidecar streams session-scoped `agent-event`
notifications. Never log or persist the raw `agent.start` params because they contain the in-memory provider
credential during that call.

The panel's loopback HTTP bridge is bound to one profile token. Authentication uses the
`x-lobee-token` header, including for the event stream; do not put the token in a URL, query string, log,
or telemetry. The panel attaches a random request id to `/run` and `/input`; the sidecar binds that id to
the request body and deduplicates a bounded retry after response loss. Reusing an id with different input
is rejected. The deduplication window is process-local: a full sidecar restart also destroys its prior
in-memory `AgentManager`, so clients reconcile the new bridge identity instead of assuming an old run
survived. The extension token and memory-directory locator are staged while the profile's extension snapshot
is prepared so the launched panel can read `bridge.json`; the memory key and direct/remote-proxy route are
committed only after launch succeeds. A successful owned profile stop revokes the registry entry. An
out-of-band browser crash/close can leave it present until a later successful relaunch-and-stop or sidecar
restart.

Agent state lives at:

- `profiles.sqlite / agent_secrets` — provider credentials and memory keys, each AES-GCM encrypted;
- `profiles/<id>/agent/memory.json` — authenticated per-profile facts/settings;
- `profiles/<id>/agent/runs/*.json` — authenticated run records with secret actions redacted;
- `profiles/<id>/agent/journals/*.journal` — AES-GCM encrypted, path-authenticated safety journals with
  non-executable action digests and durable dispatch boundaries;
- `profiles/<id>/agent/.lobee-agent.lock` — an exclusive per-profile manager lease containing only
  process ownership metadata, not task/action content;
- extension `chrome.storage.local` (or standalone `localStorage`) — a bounded, heuristically redacted
  plaintext task/result/step fallback used only while encrypted thread history cannot be verified. It is
  not safe storage for arbitrary PII or private business content and is retired only after exact encrypted-
  thread verification; if no counterpart is ever written, it can remain until manually cleared.

Before admitting a new run, the sidecar authenticates every unfinished journal. It closes clean,
not-yet-dispatched, and read-only checkpoints without replaying them. A corrupt journal, an interrupted
sensitive handoff, failed navigation reconciliation, or an action whose write/consequential effect may
already have happened fails closed. The manager acquires the profile lease before admission and holds it
through the run. It automatically replaces a lease only when its process owner is provably dead; a live,
corrupt, or unverifiable lease is treated as active.

The executor records dispatch only after deterministic preflight and immediately before its first effect.
After a mutating browser driver call, a fresh readable observation with matching full-URL identity is
required before the journal records success. This does not prove action-specific business success; for a
purchase, send, deletion, or similar operation, inspect an independent receipt or current service state.

The current desktop panel does not yet expose the explicit operator-resolution workflow. Preserve the
journal and verify the live browser/external service state rather than repeatedly restarting or deleting
the record. Do not delete `.lobee-agent.lock` merely to bypass an active/corrupt owner check. The recovery
UI/RPC workflow is tracked as a release item in `docs/LOBEE_AGENT_ROADMAP.md`.

CAPTCHA and sensitive-field prompts pause the session. The user completes a CAPTCHA in the visible window,
or enters a password/OTP in the masked desktop prompt; the latter is typed directly into its target and is
not returned to the model.

### Local automation API (developer-facing)

The desktop app exposes a local HTTP API (Axum) that delegates `start`/`stop`/`status` to the sidecar and
returns `{ profileId, pid, ws, debuggerAddress }`. Users attach their own tooling:

```js
// The SDK does NOT import Playwright/Puppeteer — you pass ws to your own client.
const { ws } = await lobster.start(profileId);
const browser = await chromium.connectOverCDP(ws);   // your automation, your choice
```

Client SDK + snippets (Playwright/Puppeteer/Selenium, JS + Python) live in `packages/local-api-sdk`.

## 5. Known operational gotchas

- `pkill -f <pattern>` self-matches the calling shell (the pattern appears in the command line) → it can
  kill your own command (exit 144). Use `fuser -k <file>` or `pgrep -x <exact-name>` instead.
- `nohup <cmd> &` inside a backgrounded wrapper detaches a grandchild and the wrapper exits immediately
  (no completion signal). Run the blocking command directly as the background job.
- Native `-Werror`: a `return;` before code triggers `-Wunreachable-code`; an unused local triggers
  `-Wunused-variable`. Keep engine edits warning-clean.
- Agent URL/DNS preflight covers explicit top-level navigation only; it is not a browser-wide private-
  network egress sandbox. Perception also uses main-world DOM APIs that a hostile page can monkeypatch.
  Keep both limitations visible when assessing a deployment; see `docs/LOBEE_AGENT_ROADMAP.md` §10.
