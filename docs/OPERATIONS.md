# Lobium Operations — Build, Install, Validate, Contracts

Everything needed to build the engine, ship the product, run the gates, and integrate. Updated 2026-08-10.

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
# Software gate (runs anywhere; no GPU, proxy, or engine binary needed)
node ci/validation/regression-gate.mjs    # in-process coherence/diversity floors + fingerprint units

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
