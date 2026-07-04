# Project Status & Execution Tracker — Lobster Browser

> **This is the single, authoritative, living source of truth for "what is done / in progress / remaining."**
> It reconciles [`MASTER_PLAN.md`](MASTER_PLAN.md) (strategy) and [`GAP-ANALYSIS.md`](GAP-ANALYSIS.md) (the
> Day‑4 snapshot, now superseded here) with the **actual verified state of the code**. Update this doc
> whenever a task moves. Every "done" line below is backed by a test, a proof run, or a commit — not
> aspiration. Last reconciled against `main` @ commit `5f1e8a0`.
>
> **How to read priorities:** `P0` = blocks a sellable v1 · `P1` = needed for Octo-class parity · `P2` =
> depth/scale. **Effort:** `S` <½ day · `M` ½–2 days · `L` 2–5 days · `XL` >1 week / needs a build farm or
> a real-hardware lab.

---

## 0. Status snapshot (the one-paragraph truth)

The **anti-detect engine is real and works end-to-end.** Lobium (our from-source Chromium 152 fork) is
built and driven by a native config channel with **six proven native fingerprint surfaces**, and a
**live-detector CI gate** launches the real binary and scores it: **10/10 surfaces applied,
bot.sannysoft.com 30‑pass/0‑fail, CreepJS hard‑"headless" 0%, worker contexts coherent, per‑profile
diverse.** The v1 orchestrator (desktop core, NestJS SaaS, proxy, cookies, automation API) is built and
**160 unit/integration tests pass**. The gap to a *shippable, Octo‑class* product is now (a) **run the
detector matrix on real GPU hardware** (this dev box is GPU‑less → SwiftShader inflates one soft metric),
(b) a handful of **engine hardening items** (chrome.runtime branding, WebGL pixel farbling, fonts
packaging), and (c) the **productization layer** (packaging/signing/auto‑update, backend deploy +
observability, billing/RBAC/security depth, detector‑matrix breadth). None of the core architecture is in
doubt; the remaining work is enumerated and prioritized below.

---

## 1. Verified‑DONE inventory (with evidence)

### 1.1 Native engine — Lobium (the moat) ✅

The from-source fork + config channel + surfaces. See [`lobium/patches/hooks.md`](../lobium/patches/hooks.md)
for per-surface hook points and [`ci/validation/lobium-detect.mjs`](../ci/validation/lobium-detect.mjs)
for the live gate. All surfaces proven on Chromium **152.0.7928.0**.

| Surface | Mechanism | Proof |
|---|---|---|
| From-source build | `lobium/build.sh` (Chromium 152, ~6.5h) + `rebase.sh` | `chrome --version` OK; incremental rebuilds ~2–5 min |
| Config channel | browser reads `--lobium-fp-config` → base64 `--lobium-fp-data` → renderer `LobiumFpConfig::Current()` (added `//components/lobium_fp`) | proven end-to-end; propagates to worker renderer processes |
| navigator.hardwareConcurrency | `navigator_concurrent_hardware.cc` | file value vs host, main+worker consistent |
| navigator.deviceMemory + `Device-Memory` header | single source `approximated_device_memory.cc` | JS getter == HTTP header, bucket-snapped |
| navigator.maxTouchPoints | `navigator_events.cc` | 0→persona |
| **navigator.userAgent + platform (ALL contexts)** | `navigator_base.cc` (shared base of `Navigator` + `WorkerNavigator`) | **main + dedicated + shared workers all report persona** (was leaking Linux); CreepJS hard‑headless **33%→0%** |
| WebGL unmasked vendor/renderer | `webgl_rendering_context_base.cc` (atomic pair, WebGL1+2 + workers) | SwiftShader→persona GPU; masked stays "WebKit" |
| Canvas 2D farbling | `lobium_farble.cc` + 4 readback hooks (getImageData/toDataURL/toBlob/OffscreenCanvas.convertToBlob) | stable-per-seed, distinct-per-seed, host-diff; `drawImage` no-double-farble MATCH=true |
| Web Audio farbling | `lobium_audio_farble.cc` + OfflineAudioContext result + AnalyserNode float paths | host-diff/stable/distinct; playback bit-exact |
| Web Audio **upstream taps** | AudioWorkletProcessor + ScriptProcessorNode (offline-gated) | closes the deterministic-offline bypass; 0-confirmed adversarial review |
| screen / DPR | `screen.cc` (GetRect/colorDepth) + `local_dom_window.cc` + `media_values.cc` (matchMedia DPR) | closes 800×600 headless tell; macOS availTop coherent; matchMedia==window.devicePixelRatio |

**Coherence bugs found by the gate + fixed:** UA‑CH version leak (persona claimed Chrome 151 while
`fullVersionList` leaked the real 152 build) → pinned UA to engine version + coherent `fullVersionList`;
**worker host‑identity leak** (workers reported the real Linux UA/platform) → native `NavigatorBase` hook.

**Live-gate result (3 diverse seeds, latest run):** `verdict=pass`, `surfaces=10/10`, `sannysoft 30p/0f`,
`workers_ok=true`, diverse GPUs (Intel/AMD/NVIDIA) + distinct canvas/audio hashes.

### 1.2 v1 orchestrator (product surface) ✅ built + unit-tested

All green (typecheck + build + **160 tests**). Maturity note: "built + unit-tested," not yet
"battle-tested in production" (see §3 for what that requires).

| Area | Built | Tests |
|---|---|---|
| Fingerprint engine | internal coherent device catalog (Apify dropped), `deriveFingerprint`/`applyGeo`/`applyOverrides`/`validateCoherence`, UA pinned to engine version + `fullVersionList` | 41 |
| Engine-runner | `buildLaunchOptions`, `buildCdpEmulation`, `applyCdpFingerprint`, `buildLobiumConfig`/`writeLobiumConfig`, `CompositeRunner`, patchright launcher, human-input | 37 |
| Proxy | exit-IP geo derivation, proxy test, WebRTC policy | 16 |
| Cookies | Netscape + Playwright/CDP JSON parse/serialize | 8 |
| Desktop (Rust/Tauri) | SQLite profile store + CRUD, local automation API (Axum), `SidecarClient` JSON-RPC, single-instance lock, fingerprint editor UI | cargo tests |
| Backend (NestJS) | JWT auth, teams/roles, profiles (team-scoped, plan limit), cloud sync (encrypted blob + versioning), API keys, audit log | 49 |
| Local API SDK | Python + JS examples, connect recipes | 8 |
| Detector gate | `run.mjs` (interim engine) + `lobium-detect.mjs` (native engine) | live |

---

## 2. Native‑engine REMAINING work (Phase 2 — the moat)

Ordered by anti-detect impact. Each has a clear disposition already scouted.

| # | Task | Priority | Effort | Disposition / plan |
|---|---|---|---|---|
| E‑1 | **Validate on real GPU hardware** | **P0** | M | This dev box has no GPU → `--enable-unsafe-swiftshader`, which is itself a VM/headless signature (drives CreepJS "like headless: 38%" + the WebGL cap mismatch). Run the gate on a machine with a real GPU to get the true CreepJS/Pixelscan score. **This is the single most important remaining engine task** — most "soft" tells are expected to drop. |
| E‑2 | **chrome.runtime / Chrome branding** (`chromium: true` tell) | P1 | L | Lobium is vanilla Chromium; `window.chrome` has `app`+`loadTimes`+`csi` but no `runtime`, so CreepJS flags `chromium: true`. Clean fix = native Chrome extension bindings (build-flag work) OR a carefully native-`toString` JS injection. **Not** a rushed JS inject (would add its own tell). |
| E‑3 | **WebGL pixel farbling** (`seeds.webgl`) | P1 | M | Per-profile WebGL pixel hash (unlinkability). Tractable (readPixels hook reuses canvas kernel) but has a **readPixels‑vs‑toDataURL Y‑flip coherence trap** — must farble both paths on a shared Y‑normalised key. Own cycle. |
| E‑4 | **Fonts** (OS-accurate enumeration + metrics) | P1 | L | **Packaging task, not a Blink hook.** The dominant vector is the permissionless `measureText` metrics probe (reads real glyph advances off a font FILE). Plan: bundle a metric-compatible substitute pack (Liberation/Carlito/Caladea/Noto) + a private fontconfig + a launch `env` channel + constrain `pools.ts` to the pack, THEN a subtract-only allowlist gate. See `series`. |
| E‑5 | **WebGL capability alignment** (MAX_* limits, extension list) | P2 | L | Needs a per-GPU-class capability DB. Largely **mooted in production** by pinning personas to the host GPU class (the SwiftShader mismatch is a dev artifact). |
| E‑6 | **HTTP User‑Agent header in workers** | P1 | M | The native `NavigatorBase` hook fixes the JS `navigator.userAgent` in all contexts; the worker *request header* (server-side) still derives from the engine UA. Fix = browser-process `GetUserAgent()` override from the config, OR the mitmproxy header layer. |
| E‑7 | **screen Window‑Management‑API surfaces** | P2 | S | `getScreenDetails()` (ScreenDetailed dpr/label), `Screen.isExtended`, `getScreens()` still reflect the host — but they are **permission-gated** (`window-management` prompt), so not silently scriptable. |
| E‑8 | **TLS / JA3 / JA4 / HTTP‑2** | — | — | **Already coherent for Chrome personas** — Lobium *is* stock Chromium 152 (unmodified BoringSSL + HTTP/2), so its network fingerprint is genuine Chrome, matching a Chrome-on-engine-version persona. Native TLS work is only needed to impersonate a *different* browser (Firefox/Safari) — out of v1 scope. |
| E‑9 | **AudioContext/analyser byte paths** | P2 | S | `getByteFrequencyData`/`getByteTimeDomainData` not farbled — near-inert at the current magnitude (sub-quantization); documented. |
| E‑10 | **Release build matrix + signing** | P0 (ship) | XL | Signed Win/mac‑Intel/mac‑ARM/Linux binaries + notarization + hosting + `rebase.sh` automation to track Chrome stable within days. Needs a build farm. |

---

## 3. v1 PRODUCT remaining work (to "sellable")

The orchestrator is built; these close the gap from "built + unit-tested" to "shippable + operable."

### 3.1 QA / validation (P0 — this is how we *prove* Octo-class)
- **E2E product flow** (§13 of the plan): create → launch behind proxy → pass validation → connect Playwright/Selenium → stop. Wire as a CI job.
- **Detector-matrix breadth** (P1): CreepJS trust/lies + Pixelscan "consistent" + Iphey + browserleaks + FingerprintJS, all scored against Lobium, thresholds in `ci/validation/thresholds.json`. (Sannysoft is done; CreepJS is env-gated/partly-scrapeable.)
- **Live anti-bot targets** (P1): Cloudflare / DataDome / Akamai / HUMAN / Kasada test pages.
- **WebRTC leak-behind-proxy on Lobium** (P0): the interim gate proves `disable_non_proxied_udp` suppresses the STUN public-IP srflx; re-run it on Lobium with a real proxy.
- **Rust local-API E2E launch** (P1): `/profile/start`→`/stop`→CDP connect exercised against the real binary end-to-end (currently unit-tested, not launched E2E this session).

### 3.2 Desktop app lifecycle (P0 for ship)
- Packaging (Windows-first installer), engine download-on-first-run, code-signing/notarization, auto-update, first-run onboarding, crash reporting. → [`specs/observability-ops.md`](specs/observability-ops.md).

### 3.3 Backend / SaaS depth (P1)
- Deploy to staging (Postgres + S3), observability (logs/metrics/tracing/error-tracking), rate-limiting, backups/DR.
- Billing metering (Stripe, profile-count freemium) is minimal; granular/tag-scoped RBAC beyond admin/member; SSO/2FA/session-device management. → [`specs/security.md`](specs/security.md), [`specs/data-model.md`](specs/data-model.md).

### 3.4 Data & automation breadth (P1/P2)
- Browser-data sync beyond cookies: localStorage/IndexedDB, extensions, bookmarks, history, autofill; cookie warm-up/robot.
- Official SDKs (Py/JS/C#), MCP server, cloud-run profiles, RPA/human-input library (basics landed in `humanize`).
- Mobile/Android fingerprints + engine (P2).

### 3.5 Open follow-up tickets (already drafted)
`T-002d` (CDP override → external connectOverCDP pages via Target.setAutoAttach) · `T-012` (50+ param model + Android) · `T-018a` (q-weighted Accept-Language header) · `T-019a` (assert srflx==proxy egress on a live proxy) · `T-020a` (atomic plan-limit txn) · `T-026` (deferred review findings: single-instance-lock release, local-API default-deny auth, popup override race).

---

## 4. Phased roadmap (what to do, in order)

**Phase A — Prove it (P0, ~1 week, mostly a real-hardware lab):**
E‑1 (real-GPU detector run) → 3.1 E2E product flow + detector-matrix breadth + WebRTC-on-Lobium →
green the `fingerprint-gate` CI job against Lobium. *Exit:* an objective, real-hardware Octo-class score.

**Phase B — Harden the engine (P1, ~1–2 weeks):**
E‑2 (chrome.runtime/branding) · E‑3 (WebGL pixel farbling) · E‑4 (fonts packaging) · E‑6 (worker UA
header). *Exit:* CreepJS `chromium:false`-equivalent + no cross-surface tells on real hardware.

**Phase C — Ship v1 (P0 for launch, ~1–2 weeks, needs a build farm):**
E‑10 (signed multi-OS build matrix + rebase automation) · 3.2 (packaging/signing/auto-update) · 3.3
(backend deploy + observability + billing). *Exit:* a signed installer + a deployed backend + a demoable,
sellable product.

**Phase D — Scale & depth (P2, post-launch):**
E‑5 (WebGL caps) · E‑7 (WMA surfaces) · 3.4 (data breadth, SDKs, MCP, cloud-run, mobile) · granular
RBAC/SSO · proxy marketplace/rotation. TLS work only if cross-browser personas are added.

---

## 5. Honest limitations (do not mistake for bugs)

- **SwiftShader on this box:** no GPU here → software WebGL, which is a VM/headless signature and produces
  an RTX/AMD *string* next to *software* capabilities. This inflates CreepJS "like headless" (~38%) and
  the WebGL cap mismatch **in the dev environment only**; production runs on a real GPU. Any headless/GPU
  number must be re-measured on real hardware (E‑1) before it is trusted.
- **CreepJS scraping is flaky** (research page, shifting DOM). The reliable signals we assert are the
  direct coherence probes + sannysoft; CreepJS is measured best-effort.
- **`connectOverCDP` vs `launchPersistentContext`:** the production launcher uses
  `launchPersistentContext` (context-level UA → workers + header). A test that forgets `--lobium-fp-config`
  or uses page-level `setUserAgentOverride` will show false worker leaks — always pass the config.

---

## 6. How this maps to the plan & tickets

- **Strategy** stays in [`MASTER_PLAN.md`](MASTER_PLAN.md) (§0–§9, §11 roadmap, §16 risk register).
- **This doc** replaces the day-by-day tracking of `MASTER_PLAN §10` and supersedes the Day‑4
  [`GAP-ANALYSIS.md`](GAP-ANALYSIS.md) snapshot for "current state."
- **Per-task detail** lives in [`docs/tickets/`](tickets/) (keep `T-011` and the board current) and the
  deep specs in [`docs/specs/`](specs/).
- **Native surface detail** lives in [`lobium/patches/hooks.md`](../lobium/patches/hooks.md) +
  [`lobium/patches/series`](../lobium/patches/series).
