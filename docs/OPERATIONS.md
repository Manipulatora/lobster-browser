# Lobium Operations — Build, Install, Validate, Contracts

Everything needed to build the engine, ship the product, run the gates, and integrate. Updated 2026-07-15.

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

## 2. Package & install the product

The desktop app bundles the React UI + the Node sidecar; the Lobium runtime is delivered alongside.

```bash
# Build the .deb (Tauri) — produces dist-linux/Lobster Browser_0.0.0_amd64.deb + lobium-runtime/
npm run -w apps/desktop tauri build
```

Install topology (Linux):

- `~/.local/share/lobster/` — the optimized engine runtime: `bin/lobster-desktop`, `lib/`, `lobium/`
  (the official binary + 7 `.so` + fonts + swiftshader), `env` (engine pointers), `host-calibration.json`.
- `/usr/bin/lobster-desktop` — the system binary (from `dpkg -i`).
- `/usr/local/bin/lobster-browser-launch` — wrapper: sources `~/.local/share/lobster/env` (so the
  optimized engine + fonts are used) and preserves the session `DISPLAY`.
- `/usr/share/applications/Lobster Browser.desktop` — GNOME entry. **`dpkg -i` overwrites this** back to
  `Exec=lobster-desktop`; **re-point it to the wrapper** (`Exec=/usr/local/bin/lobster-browser-launch`)
  after every `dpkg -i`.

Key `env` pointers: `LOBSTER_LOBIUM_BIN`, `LOBSTER_LOBIUM_DIR`, `LOBSTER_FONTS_DIR`, `VK_ICD_FILENAMES`,
`VK_DRIVER_FILES`.

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
# Software gate (runs anywhere; no GPU/proxy needed)
node ci/validation/battle-test.mjs        # offline coherence incl. cross-context worker
node ci/validation/deep-probe-50.mjs      # 50 personas: surface application + tells + distinctness
node ci/validation/regression-gate.mjs    # orchestrates software checks vs committed baselines

# Real-GPU gate (release blocker; needs a real-GPU host — see docs/ENGINEERING.md §4/§6)
LOBSTER_GPU=gpu node ci/validation/gate.mjs
```

`.github/workflows/ci.yml` runs the software gate; `.github/workflows/real-gpu-gate.yml` runs the release
gate on a self-hosted `real-gpu` runner. The evidence policy in `detector-matrix.json` forbids software
renderers, so a genuine detection pass requires real hardware.

## 4. Runtime contracts

### Rust core ⇄ sidecar (stdio JSON-RPC)

The Tauri Rust core spawns the Node sidecar and calls it over line-delimited JSON-RPC on stdio. Primary
method: `startProfile(StartProfileParams) → { profileId, pid, ws, debuggerAddress }`. The sidecar refuses
any engine but `lobium`. It spawns the native binary, resolves the CDP endpoint from the
`DevToolsActivePort` file, injects imported cookies over the first-party CDP client, and (for mobile
profiles) installs native device emulation. It returns the raw CDP `ws` + Selenium `debuggerAddress` for
the user's own automation — the product never drives them.

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
