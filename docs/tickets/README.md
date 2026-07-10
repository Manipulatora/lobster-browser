# Ticket Board — Lobster Browser

Work happens one ticket at a time (see [agent-protocol.md](../agent-protocol.md)). Claude authors
tickets; the assigned agent implements; the other agent reviews. Keep this table current.

> **The current, detailed status + prioritized remaining-work breakdown lives in
> [`../PROJECT-STATUS.md`](../PROJECT-STATUS.md)** (the living tracker). This board is the per-ticket
> history; PROJECT-STATUS is the "where are we / what's next" view. Native-engine surface detail is in
> [`../../lobium/patches/hooks.md`](../../lobium/patches/hooks.md).
>
> ⚠️ **"done" here means "the ticket delivered its coded scope + unit tests," NOT "production-proven
> end-to-end."** Current maturity lives in PROJECT-STATUS. RUN-1 is done when a native Lobium binary is
> provided/discovered (`LOBSTER_LOBIUM_BIN`, `LOBSTER_LOBIUM_DIR`, local dev layout, or packaged resource),
> desktop launch/stop commands call the sidecar, and the local API
> fail-closes with a key. Still open: real-GPU/host-calibrated proof, native Lobium CI, encrypted blobs,
> S3/Postgres production durability, packaged sidecar/installer, proxy/cookie product wiring, and broad
> detector/live anti-bot validation. **ADR-0003 supersedes the old interim-engine plan:** production
> profiles launch native Lobium only; Patchright/Chromium entries below are historical/internal harness
> work unless explicitly marked as a current production task.

| ID | Title | Pillar / Track | Assignee | Status |
|----|-------|----------------|----------|--------|
| T-001 | Tauri shell boots + loads React UI shell | A · Desktop | Codex | done · desktop crate builds (Rust 1.96.1 + webkit2gtk); SQLite store + Axum local API + IPC commands cargo-tested; GUI window needs a display |
| T-002 | Sidecar: real engine launch (historical Patchright harness) | B · Engine | Claude | done · historical harness: live Chromium, `connectOverCDP`, status/stop, CI compatibility plumbing. **Superseded for production by ADR-0003/RUN-3:** product launch is direct native Lobium only; no Patchright stealth/fallback. |
| T-002d | Historical CDP override propagation | B · Engine | Claude | superseded · production fingerprint values must be native Lobium; CDP auto-attach may be used only for control/measurement tests |
| T-003 | Fingerprint: integrate Apify fingerprint-suite behind `deriveFingerprint` | Fingerprint | Codex | done |
| T-004 | Backend: JWT auth + real data layer | C · Backend | Codex | done · bcrypt+JWT, guard, `/auth/me`, e2e; Prisma repo/module + `0001_init` migration + docker-compose (Postgres path via CI/infra), JWT hard-fails in prod |
| T-005 | Anti-detect validation harness (live detector gate) | E · QA | Claude | done · historical harness plus detector plumbing. Current production proof must run native Lobium (`lobium-detect.mjs`) on real GPU and treat CDP as control/measurement only. |
| T-006 | Add `apps/desktop` + `apps/backend` to root workspaces | infra | Claude | done |
| T-007 | Profile CRUD Tauri commands + single-instance lock | A · Desktop | Claude | done · real SQLite-backed create/get/update/delete/list commands (cargo-tested); single-instance launch lock lands with T-002c engine wiring |
| T-008 | Fingerprint editor UI (legacy support badges) | A · Desktop | Codex | done · superseded by UI-4 native/control-only support language |
| T-009 | Unit tests: fingerprint determinism/coherence + proxy parse | tests | Claude | done |
| T-013 | Backend Teams + Profiles (real, JWT-scoped, plan limit) | C · Backend | Codex | done · repos (Prisma+in-memory), @CurrentUser, team scoping, e2e |
| T-014 | Proxy: exit-IP geo derivation + proxy test (coherence auto-sync) | Proxy | Codex | done · `deriveGeoFromExitIp` (undici ProxyAgent, HTTP/HTTPS; SOCKS follow-up), `parseGeoResponse`, `testProxy`; applied to fingerprint at launch |
| T-015 | Cookie import/export (JSON + Netscape) — `@lobster/cookies` | Fingerprint | Codex | done · canonical `Cookie` + parse/serialize both formats, 8 tests |
| T-016 | Backend cloud sync (client-encrypted blob push/pull + versioning) | C · Backend | Codex | done · BlobStore (in-memory + S3 stub), push/pull, version bump, stale-baseVersion conflict, e2e |
| T-017 | Local automation API: Rust core → sidecar → real launch | A/B · Desktop | Claude | done · `SidecarClient` (spawn node, JSON-RPC, reader task), `POST /profile/start` → store → sidecar `startProfile` (derive fp from seed+overrides+geo) → CDP endpoint; Bearer auth; cargo ping/status test + Node startProfile live-launch test |
| T-010 | Lobium: build environment + first Chromium build | F · Lobium | Claude | **done** · ✅ **built Chromium 152.0.7928.0 from source** (~6.5h, 12-core box) via `lobium/build.sh` pipeline; `chrome` runs (`--version` OK). Release/multi-OS signed binaries still want a build farm |
| T-011 | Lobium: quilt series + native config channel (browser→renderer) | F · Lobium | Claude | **done** · Config channel built; native surfaces now include navigator hardware, UA/platform in all contexts, WebGL vendor/renderer + pixel farbling + scalar caps, canvas, audio, screen/DPR, UA header/Sec-CH-UA, and fontconfig launch env. Proof is still SwiftShader/dev-path unless PROJECT-STATUS says otherwise. Remaining engine work is real-GPU/host-calibrated proof, multi-OS builds, extension/precision host capture, final font bundles, codecs/signing, and native CI. |
| T-025 | Detector matrix: deep-surface measurement + CreepJS wiring | E · QA | Claude | done · harness now measures canvas/WebGL/audio (claimed-vs-host, **non-blocking** — needs Lobium) + env-gated CreepJS; `detectorMatrix` summary; Sannysoft/WebRTC/coherence stay blocking |
| T-012 | Fingerprint: 50+ param model + Android profiles | Fingerprint | Codex | draft · Android only; iOS discarded |
| T-018 | Fingerprint coherence & geolocation-application hardening | Fingerprint | Claude | done · coherence fixes remain valid; CDP geolocation work is now internal/control-harness context only. Native Lobium must own production geo/locale behavior. |
| T-018a | q-weighted `Accept-Language` HTTP header (keep clean `navigator.languages`) | Fingerprint | Claude | draft · follow-up from T-018 |
| T-019 | WebRTC leak protection + validation-gate integration | Proxy | Claude | done · [proxy-aware `--force-webrtc-ip-handling-policy`](T-019-webrtc-leak-protection.md) (`disable_non_proxied_udp` when proxied); non-vacuous gate proves the policy suppresses the STUN public-IP srflx (v4+v6) + mDNS local masking; hardened after adversarial review; 95 tests + live gate green |
| T-019a | Assert `srflx == proxy egress IP` against a live test proxy (CI secret) | Proxy · QA | Claude | draft · follow-up from T-019 |
| T-020 | Profile bulk-create + import/export/transfer | A · Profiles | Claude | done · [`/profiles/bulk`, `/export`, `/import`](T-020-profile-bulk-import-export.md); secret-free portable bundle; import preserves seed identity (transfer); batch plan-limit; e2e |
| T-021 | API-key management (issue/list/revoke + verify) | C · Backend | Claude | done · [`/api-keys`](T-021-api-key-management.md); one-time `lb_live_` secret, only prefix+sha256 stored; `verify()` for the automation API; team-scoped; 9 e2e |
| T-022 | Action logs / audit trail | C · Backend | Claude | done · [`AuditService.record` (fail-safe) + `GET /audit`](T-022-audit-log.md) team-scoped **keyset**-cursor feed (lossless across same-ms ties, hardened after review); instrumented into profiles + api-keys; 7 e2e |
| T-020a | Atomic plan-limit enforcement (serializable txn / advisory lock) | C · Backend | Claude | draft · follow-up from T-020 (TOCTOU under concurrent bulk/import) |
| T-026 | Full-codebase review follow-ups (deferred findings) | cross-cutting | Claude | draft · [deferred HIGH/MED/LOW](T-026-review-followups.md) from the 25-finding review (single-instance-lock release, local-API default-deny auth, popup override race, …) |
| T-023 | Official SDK examples (Py/JS) + connect docs | D · Automation | Codex+Claude | done · [`@lobster/local-api-sdk`](T-023-sdk-examples-connect-docs.md) fleshed out (timeout/retry/typed errors); Selenium/Playwright/Puppeteer recipes; 8 JS tests |
| T-024 | Human-like input (mouse Bézier paths + typing cadence) | Automation · Stealth | Claude | done · [`humanize`](T-024-human-like-input.md) seeded mouse/type generators + CDP dispatch; hardened after review (double-insert, key/code, `buttons` bitmask, integer coords); 8 tests |
| T-027 | Lobium: canvas + audio + screen/DPR native farbling surfaces | F · Lobium | Claude | **done** · canvas 2D farbling (4 readback paths, drawImage no-double-farble); Web Audio farbling (offline result + analyser + AudioWorklet/ScriptProcessorNode taps, playback-safe); screen/DPR (GetRect/colorDepth + matchMedia-DPR + macOS availTop). All adversarially reviewed + PROVEN on Chromium 152. `fingerprint/*.patch` |
| T-028 | Lobium: native UA/platform in ALL contexts (worker leak) | F · Lobium | Claude | **done** · `navigator_base.cc` hook (shared base of Navigator + WorkerNavigator); fixed workers leaking the Linux host UA/platform; **CreepJS hard-headless 33%→0%**; corrects the earlier "UA/platform are CDP-only" finding. See [PROJECT-STATUS §1.1](../PROJECT-STATUS.md) |
| T-029 | Lobium: native-engine detector gate + coherence fixes | E · QA | Claude | **done** · [`lobium-detect.mjs`](../../ci/validation/lobium-detect.mjs) launches the real binary → sannysoft + direct surface assertions + worker coherence + CreepJS best-effort; **10/10, 0-fail**. Caught + fixed the UA-CH `fullVersionList` leak and the worker leak |
| T-030 | Lobium: validate the detector matrix on REAL GPU hardware | E · QA | **P0** | **open** · Re-measure native Lobium without SwiftShader on a consumer GPU; archive CreepJS/Pixelscan/WebGL caps/extensions baseline. **The #1 remaining engine proof task.** |
| T-031 | Lobium: chrome.runtime / Chrome branding (`chromium:true` tell) | F · Lobium | Claude | resolved · Do **not** add `chrome.runtime`; modern Chrome hides it on normal pages too. Residual follow-up is media-codec/`proprietary_codecs` parity, not runtime injection. |
| T-032 | Lobium: WebGL pixel farbling (`seeds.webgl`) | F · Lobium | Claude | done · readPixels + WebGL toDataURL/toBlob path implemented in the native patch series; Y-flip coherent; still needs real-GPU validation. |
| T-033 | Lobium: fonts (substitute-pack + fontconfig + launch env) | F · Lobium | Claude | partial · Private fontconfig launch env and dev font packs exist; production still needs final licensed metric-compatible bundles and packaging resources. |
| T-034 | Detector-matrix breadth + live anti-bot + E2E product flow | E · QA | P1 | open · CreepJS/Pixelscan/Iphey/browserleaks scored vs Lobium + Cloudflare/DataDome pages + the §13 create→launch→connect→stop E2E as a CI job |
| UX-1 | Light/red app shell + required IA | A · Desktop UI | Codex | open · Replace dark scaffold/emoji branding with image logo, top header notification/profile controls, and sidebar items Profiles/Proxies/Templates/Pricing. See [`product-ui-ux-plan.md`](../specs/product-ui-ux-plan.md). |
| UX-2 | Profiles workspace redesign | A · Desktop UI | Codex | open · Scalable profiles table/list with search, filters, create action, and existing launch/stop/edit/clone/delete actions preserved. |
| DATA-UX-1 | Profile wizard schema/contract expansion | Shared types · Desktop · Backend · Sidecar | Claude+Codex | open · Add persistence/IPC support for description, proxy ref, OS version, cookies, extensions, WebRTC, hardware noise, media devices, renderer policy. |
| UX-3 | Create Profile wizard | A · Desktop UI | Codex | open · General, Fingerprint, Cookies, Extensions, Review categories; drag/drop cookie import and Chrome Web Store link input. |
| UX-4 | Full fingerprint editor UI | A/B · Desktop UI/Fingerprint | Codex+Claude | open · UI for requested fingerprint fields with support badges, coherence validation, and disabled unsupported launch paths. |
| PROX-UI-1 | Proxy workspace tabs | Proxy · Desktop UI | Codex | open · Proxies page with My Proxies and Hive Proxy tabs; each tab has Add Proxy. |
| TPL-1 | Templates workspace | Profiles · Desktop UI | Codex | open · Template list, Add Template flow, reusable presets, and create-from-template integration. |
| PRICE-1 | Pricing workspace | Billing · Desktop UI | Codex | open · Plan/usage/upgrade UI backed by billing plan config. |
| ENG-UX-1 | Launch/config support for new UI fields | B/F · Engine/Lobium | Claude | open · Sidecar/Lobium config support for OS version, WebRTC policy, hardware noise, media devices, renderer policy. |
| AND-0 | Android Lobium scope + device matrix | Product · Engine | Claude/Codex | ready · iOS discarded; define Android APK/device runner path from [`../specs/android.md`](../specs/android.md) |
| AND-2 | Android ADB bridge / runner POC | Engine | Codex | partial · device parsing, config push, CDP forward, APK start/stop command planning and bridge sequencing unit-tested; real APK/device proof remains |
| AND-3 | Android fingerprint catalog + coherence | Fingerprint | Codex | partial · TS catalog/types/derive/coherence/tests done; native APK consumption remains AND-4..AND-6 |
| AND-4 | Android config-channel delivery | Engine | Codex+Claude | partial · Android config JSON + ADB app-specific file delivery plan exists; APK reader/app-private bridge remains |

**Status legend:** `draft` (spec not final) · `ready` (spec final, unassigned work can start) ·
`in-progress` · `in-review` · `done`.

**Statuses map to the plan** in [`../MASTER_PLAN.md` §10](../MASTER_PLAN.md). **Day 0 complete.**
**Day 1 landed** (all verifiable-here work): T-003, T-004 (auth), T-006 done; T-002a (engine launch
builders) done; desktop frontend type-clean. Remaining Day 1 items are **infra-gated** in this
environment and need a build machine: T-001 (rustup/Tauri), T-002b (browser binaries), T-005 (real
browser+GPU), T-010/T-011 (Chromium build farm). **T-010/T-011** start the parallel Lobium
track (F). Donut Browser is **reference only** — we build our own Lobium engine and UI/UX.
