# Project Status & Operating Manual — Lobster Browser

> **Authoritative live status.** This file records what is real in the repository, what is
> conditional/dev-only, and what remains before beta/GA. Strategy lives in
> [`MASTER_PLAN.md`](MASTER_PLAN.md); the phased host-calibrated production plan lives in
> [`PRODUCTION-ROADMAP.md`](PRODUCTION-ROADMAP.md); dependency ordering lives in
> [`DEPENDENCIES.md`](DEPENDENCIES.md).
>
> **Last audited:** 2026-07-08 after native Lobium auto-discovery, host-calibration type/derive
> scaffolding, and the stronger native product E2E pass.
> **Maturity legend:** **PROVEN** = exercised by a local run/test or live script; **CONDITIONAL** =
> implemented but depends on provisioned env/assets/hardware; **SCAFFOLDED** = compiles/tests in
> isolation but not production wired; **ABSENT/STUB** = not implemented.

---

## 1. Executive Status

**Short version:** Lobster now has a serious native-engine foundation and a real launch path, but it is
not production-grade yet. The engine is ahead of the product shell. The next correctness frontier is
**host-calibrated, real-GPU validation**, not more arbitrary device-catalog spoofing.

What is real now:

- **Native Lobium launch path is wired and discoverable.** When a built Lobium binary is found through
  `LOBSTER_LOBIUM_BIN`, `LOBSTER_LOBIUM_DIR`, the local `~/lobium-build/src/out/Lobium/chrome` dev
  layout, or a packaged engine resource, `lobium` launches use that binary, write `lobium-fp.json`, pass
  `--lobium-fp-config`, and thread the profile seed so canvas/WebGL/audio farbling seeds are distinct
  per profile.
- **Desktop launch/stop commands are wired to the sidecar.** The Tauri commands no longer return an
  unconditional error; they call the same `startProfile`/`stop` path as the local HTTP API.
- **Desktop proxy/template/password workflows are now local-durable.** Tauri/SQLite stores exist for
  proxies and profile templates, proxy checking is exposed through Rust IPC, UI buttons, and
  `/api/v1/proxy/test`, profile creation can consume stored proxies/templates, and profile password
  protection hashes via Argon2.
- **Local automation API now fail-closes.** Non-health routes require a bearer key, reject non-loopback
  Host values, and compare tokens with a constant-time byte loop.
- **Host-calibration scaffolding is partially wired.** Shared types model captured WebGL extension lists,
  shader precision buckets, GL version strings, and `HostCalibrationProfile`; `@lobster/fingerprint`
  has deterministic `deriveFingerprintFromHost` + validation that rejects software-rendered hosts; the
  engine-runner has a browser-side host probe scaffold and `startProfile` can now derive from a supplied
  host snapshot. This is not yet a persisted first-run desktop service or real-GPU-proven path.
- **The latest focused JS/Rust gates are green locally.** Current run: shared-types/fingerprint/
  engine-runner typechecks, fingerprint tests, engine-runner tests, native Lobium detector auto-discovery,
  and the opt-in native product E2E passed.

What is still not real:

- **No real-GPU proof.** Native surface proofs still come from SwiftShader/headless/dev runs. Until a
  consumer GPU baseline exists, no "Octo-class" detector claim is defensible.
- **No persisted host calibration service yet.** `deriveFingerprint` still uses `pools.ts` when no host
  snapshot is supplied; there is no persisted first-run desktop host profile, no real-GPU host baseline,
  and no UI flow that makes host calibration the default.
- **No native Lobium CI gate.** CI runs patched Chromium through `ci/validation/run.mjs`; the native
  `lobium-detect.mjs` script exists but is not a blocking real-GPU CI job.
- **No sellable packaging/security/durability.** No signed installers, bundled sidecar, updater,
  client-side blob encryption, local SQLite encryption, S3 implementation, Postgres CI, or real Stripe.

**Current maturity:** engine R&D alpha with strong foundations; product/orchestrator pre-beta.

---

## 2. Verified Inventory

### 2.1 Native Lobium Engine

| Item | Status | Notes |
|---|---|---|
| Chromium 152.0.7928.0 fork + `//components/lobium_fp` | PROVEN | Build/proof exists outside the repo checkout; repo contains reproducible patch/build pipeline. |
| Config channel (`--lobium-fp-config` -> browser -> renderer config) | PROVEN | Native reader and launch-side writer exist. |
| Navigator UA/platform/hardware fields in main + workers | PROVEN | UA/platform/hwc/deviceMemory/maxTouchPoints covered natively. |
| WebGL vendor/renderer | PROVEN ON SWIFTSHADER | String/cap coherence improved; real GPU still unmeasured. |
| WebGL pixel farbling (`seeds.webgl`) | PROVEN ON SWIFTSHADER | No longer dead config; readPixels/toDataURL path is implemented in the folded core patch. |
| Canvas farbling | PROVEN ON SWIFTSHADER | Multiple readback paths covered. |
| Web Audio farbling | PROVEN ON SWIFTSHADER | Offline/analyser/worklet/SPN and byte paths covered. |
| Screen/DPR/colorDepth/availTop | PROVEN ON SWIFTSHADER | Native screen hooks exist. |
| Fonts via private fontconfig | CONDITIONAL | Launcher sets `FONTCONFIG_FILE` only when `LOBSTER_FONTS_DIR` exists; repo has dev symlink packs, not final licensed production bundles. |
| Real-GPU detector score | ABSENT | Must be measured without SwiftShader on consumer hardware. |
| Host-calibrated GPU extensions/precision/version | SCAFFOLDED | Shared types, host-derived fingerprint helper, and Lobium config serialization can carry extension lists, shader precision, and GL version strings. Actual host probe + native consumption remain open. |
| Multi-OS builds/signing/notarization | ABSENT | Linux/dev path only. |

### 2.2 Runner, Desktop, Backend, QA

| Area | Real Today | Still Missing |
|---|---|---|
| **fingerprint** | Deterministic seed -> coherent desktop persona; proxy geo overlay; coherence validator; Apple-Silicon arch and several cross-surface tells fixed. | Host-derived primary path; Android mobile family; real host screen/window model; richer fallback catalog. |
| **engine-runner** | `buildLaunchers` prefers native Lobium when discovered via `LOBSTER_LOBIUM_BIN`, `LOBSTER_LOBIUM_DIR`, local dev layout, or packaged resource and falls back loudly/cleanly; per-profile config and font env hooks; `startProfile` fails closed on incoherence; runner evicts crashed/closed browsers. | Native real-GPU CI; `pid` still 0 due persistent-context API; popup gate for CDP-only tz/locale/geo; packaged sidecar. |
| **desktop** | SQLite CRUD; `launch_profile`/`stop_profile` call sidecar; local API starts with generated/persisted key; light/red React shell uses image branding, header actions, and required Profiles/Proxies/Templates/Pricing IA; Profiles table/search/filter/create/launch/stop/edit/clone/password/trash/fingerprint flows exist; create-profile modal has General/Fingerprint/Cookies/Security/Extensions categories; local SQLite persists OS version, proxy/template refs, cookie import draft, extension refs, proxy catalog rows, template rows, and Argon2 password hashes. | First integrated `tauri dev` proof on all OSes; packaged sidecar/engine; signed installers/updater; single-instance plugin; backend/cloud proxy/template/pricing APIs; encrypted local secrets; full engine support for every wizard field. |
| **backend** | Auth, teams/RBAC, profiles, API keys, audit, blob sync contract, plan limit; in-memory tests green. | S3BlobStore throws; Postgres/Prisma path not in CI; client-side crypto absent; Stripe stub; member removal/team deletion; staging/deploy/observability. |
| **proxy/cookies** | Proxy parsing, HTTP/HTTPS exit geo, desktop Rust proxy test command for HTTP/HTTPS/SOCKS5, WebRTC launch policy, cookie parse/serialize library. | Cookie injection/export in launched context; encrypted proxy credentials; kill-switch/DNS leak gate; live proxy WebRTC proof. |
| **QA/CI** | Format/typecheck/build/tests; patched Chromium live launch; interim Sannysoft/WebRTC gate. | Native Lobium gate in CI; real-GPU runners; full product E2E; Pixelscan/Iphey/browserleaks/FingerprintJS; live anti-bot panel; load/perf/security gates. |
| **security/ops** | Local API core auth hardening; JWT prod secret hard-fail; password hashing; API-key hashing; gitleaks action. | Blob/key hierarchy; local at-rest encryption; rate limits/helmet/metrics/readiness/Sentry; full-history/license/dependency audits; release signing/updater. |

---

## 3. Current Test Snapshot

Last local verification in this audit:

| Command | Result |
|---|---|
| `npm run typecheck --workspace @lobster/shared-types` | pass |
| `npm run typecheck --workspace @lobster/fingerprint` | pass |
| `npm run typecheck --workspace @lobster/engine-runner` | pass |
| `npm test --workspace @lobster/fingerprint` | pass, 44 tests |
| `npm test --workspace @lobster/engine-runner` | pass, 56 tests |
| `npm run typecheck --workspace @lobster/desktop` | pass |
| `npm test --workspace @lobster/local-api-sdk` | pass, 9 tests |
| `npm run build --workspace @lobster/desktop` | pass |
| `npx playwright test apps/desktop/e2e/ui-smoke.spec.ts --reporter=line` | pass |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | pass, 14 Rust tests |
| `node ci/validation/lobium-detect.mjs` | pass, auto-discovered `/home/ivyhfx/lobium-build/src/out/Lobium/chrome`, native surfaces 10/10, Sannysoft 0 failed |
| `LOBSTER_PRODUCT_E2E=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml product_launch_connect_stop_e2e_when_enabled -- --nocapture` | pass, launches `lobium`, verifies CDP `/json/version`, and asserts `lobium-fp.json` exists with UA/WebRTC/farbling seed fields |
| `git diff --check` | pass |

Important limitation: these do **not** prove native Lobium on a real GPU or a packaged desktop product.

---

## 4. Remaining Work Register

### Engine / Fingerprint

| ID | P | Status | Task |
|---|---|---|---|
| RG-0 | P0 | open | Provision real Linux consumer-GPU box and build/run Lobium there. |
| RG-1 | P0 | open | Run native detector/battle-test without SwiftShader; archive JSON baseline. |
| RG-2 | P0 | open | Triage real-GPU deltas vs SwiftShader. |
| HC-1 | P0 | partial | Host GPU probe script scaffold exists for renderer/vendor/caps/extensions/precision/version; real-GPU execution, persistence, and device baselines remain open. |
| HC-2 | P0 | partial | Browser-side screen/navigator/timezone/font probe scaffold exists; Rust OS/font persistence and cross-OS first-run service remain open. |
| HC-3 | P0 | partial | `deriveFingerprintFromHost` exists, is unit-tested, and `startProfile` uses a supplied host snapshot; it is not yet the default product path because no persisted host profile feeds it. |
| HC-4 | P0 | partial | Shared types and `lobium-fp.json` can carry captured WebGL extensions, shader precision, and version strings. Native hooks still need to consume those fields. |
| HC-5 | P1 | open | Renderer masking/normalization policy per OS/GPU. |
| HC-6 | P1 | open | Screen/window metric coherence. |
| ENG-7 | P0 | open | Multi-OS build hosts, rebase proof, signing/notarization. |
| ENG-4/6b | P1 | open | Media-codec/branding parity check; final licensed font bundles. |
| AND-0..9 | P1 | partial | Android Lobium track: TS Android fingerprint catalog/coherence is in place (AND-3 catalog side), and engine-runner now has Android config + ADB bridge scaffolding (AND-2/AND-4 scaffold). APK build, real device launch/CDP proof, APK config reader, host calibration, proxy/WebRTC proof, and real-device detector gate remain open. See `docs/specs/android.md`. |

Completed engine items that old docs may still list as open: **RUN-1**, **ENG-3**, **ENG-5**, **ENG-6
mechanism**, **ENG-8 scalar caps**, **ENG-10 audio byte paths**.

### Product / Security / Backend

| ID | P | Status | Task |
|---|---|---|---|
| SEC-1 | P0 | open | Client-side AES-GCM blob encryption. |
| SEC-2 | P0 | open | Key hierarchy + OS keychain wrapping. |
| SEC-12 | P0 | open | Local SQLite at-rest encryption for proxy/session secrets. |
| SEC-3b | P1 | partial | Rate limit/local API polish; core default-deny/host guard/constant-time compare is done. |
| BE-1 | P0 | open | Real S3/MinIO BlobStore with atomic conflict handling. |
| BE-2 | P0 | open | Postgres/Prisma integration suite in CI. |
| BE-3/4 | P1 | open | Blob lifecycle/quota and real Stripe webhook/subscription writes. |
| BE-5/7/9 | P1 | open | API-key guard routes, member/team removal, Docker/staging. |
| DSK-2 | P0 | open | First integrated GUI run and webview smoke. |
| DSK-5/11 | P0 | open | Bundled sidecar/engine, clean-VM installer, auto-update. |
| DSK-3 | P1 | open | Desktop single-instance plugin. |
| PROX-1/2 | P0 | open | Cookie inject/export into launched browser. |
| PROX-3 | P0 | done | Proxy testing is exposed through Tauri IPC, Add Proxy modal check, proxy-row Check buttons, local automation API `/api/v1/proxy/test`, and JS/Python SDK helpers. |
| PROX-4 | P0 | partial | Desktop Rust proxy checking supports SOCKS5 via `socks5h`; launch-path geo derivation and live proxy/WebRTC proof still need validation. |
| PROX-7/8 | P1 | open | DNS-over-proxy and kill-switch/fail-closed behavior. |
| UX-1 | P0 | done | Light/red shell, selected image logo, header notification/profile controls, and four-item sidebar are implemented in `apps/desktop/src`. |
| UX-2 | P0 | done (desktop UI) | Profiles table/search/filter/create action and launch/stop flow exist; row actions are consolidated to Launch + overflow menu with edit/clone/password/trash surface, edit profile persists general metadata, password protection hashes in SQLite, move-to-trash soft-deletes via `trashed_at`, Trash restore/permanent-delete exists, and `apps/desktop/e2e/ui-smoke.spec.ts` covers the main UI flow. |
| UX-3 | P0 | partial | Create Profile modal has General/Fingerprint/Cookies/Security/Extensions categories; cookie file/drop/paste parsing persists draft metadata, extension refs persist, fingerprint policy fields save, and stored proxy/template selectors feed profile creation. Browser cookie injection and extension install-at-launch remain. |
| UX-4 | P0 | partial | Requested fingerprint controls are represented in create/edit for desktop OS/version, user agent, screen, language/timezone/geo, CPU/RAM, renderer policy, WebRTC, hardware noise, and media devices; Android is visible as a planned separate mobile engine and is not launchable. Native consumption for client rect/media devices and host calibration still needs completion. |
| PROX-UI-1 | P0 | partial | Proxies page has My Proxies/Hive Proxy tabs, Add Proxy modal, durable SQLite add/list rows, Rust IPC proxy testing, row Check actions, and profile assignment through New Profile. Encrypted credential persistence, bulk import, and real Hive provider backend remain. |
| TPL-1 | P1 | partial | Templates page has durable SQLite list/search/create and a Create Profile action that seeds profile creation. Richer template policies, backend sync, and bulk-create remain. |
| PRICE-1 | P1 | partial | Pricing page exists with plan/usage cards; backend billing config and Stripe state remain. |
| DATA-UX-1 | P0 | partial | Shared types, local SQLite profile/proxy/template stores, desktop API, and sidecar IPC now round-trip OS version, proxy/template refs, cookie import drafts, extensions, WebRTC/noise/media/renderer policy types. Backend DTO/metadata expansion and encrypted local secret storage remain. |
| ENG-UX-1 | P0 | partial | Sidecar launch params and `lobium-fp.json` now carry OS version, WebRTC policy, hardware noise, media devices, and renderer policy. Native Lobium patches still need to consume every policy field and surface unsupported modes fail-closed. |
| IOS-0 | P0 | dropped | iOS is intentionally discarded. It must not appear as a Lobster target, template, or launch path. |

### QA / Docs

| ID | P | Status | Task |
|---|---|---|---|
| QA-1 | P0 | open | Native Lobium detector gate as a blocking real-GPU CI job. |
| QA-3 | P0 | partial | Opt-in Rust product E2E (`LOBSTER_PRODUCT_E2E=1`) creates a local SQLite `lobium` profile, launches through the shared Rust -> sidecar path, verifies CDP `/json/version`, asserts the native `lobium-fp.json` contract, and stops. Still missing clean-VM/package, real proxy, and WebRTC/proxy-egress assertions. |
| QA-4 | P0 | open | WebRTC no-leak behind a live proxy on Lobium. |
| QA-5/6 | P1 | open | Detector breadth and nightly live anti-bot panel. |
| QA-7/8 | P1 | open | Load/perf harness and expanded coherence validation. |
| DOC-4 | P1 | open | Traceability matrix: requirement -> spec -> ticket -> test/proof. |
| DOC-9 | P1 | open | Enforce status-doc update in the same PR that moves a ticket. |

---

## 5. Critical Path

The old critical path was "ENG-2 -> RUN-1 -> DSK-1." RUN-1 and the command-level part of DSK-1 are now
done. The current serial spine is:

```text
RG-0/RG-1 real-GPU native baseline
  -> HC-1..6 host-calibrated personas
  -> RG-3 cross-OS real-hardware coherence
  -> QA-1 native real-GPU CI gate
  -> DSK-5/11 signed, bundled installers
  -> QA-3 product E2E on clean machines
```

Parallel work that should continue immediately: SEC-1/2/12, BE-1/2, PROX-1/2/4/7/8, DSK-2, UX-4
follow-through, DATA-UX-1 backend/IPC completion, ENG-7 build hosts/signing, and detector breadth
procurement.

---

## 6. Risk Register

| # | Risk | Sev | Current Mitigation |
|---|---|---|---|
| 1 | Real-GPU score unknown; SwiftShader proofs can hide or create tells. | HIGH | RG-0/RG-1 first. |
| 2 | Persisted host-calibration service is absent; profiles still fall back to `pools.ts` when no host snapshot is supplied. | HIGH | Probe scaffold, typed host snapshot, `deriveFingerprintFromHost`, and `startProfile.hostCalibration` are ready; persisted first-run capture + real-GPU proof remain. |
| 3 | Native Lobium gate is not in CI. | HIGH | Promote `lobium-detect.mjs` to real-GPU CI after RG-1 script cleanup. |
| 4 | Profile/session blobs are not encrypted client-side. | HIGH | SEC-1/2 before cloud sync is sellable. |
| 5 | No durable production blob store. | HIGH | BE-1 MinIO/S3 implementation and readiness gate. |
| 6 | No signed/bundled desktop product. | HIGH | DSK-5/11 + ENG-7 + SEC-14. |
| 7 | SOCKS5 geo unsupported, causing locale/proxy mismatch. | HIGH | PROX-4; warn/fail until supported. |
| 8 | Detector matrix too narrow. | HIGH | QA-5/6 with residential proxies and vendor tenants. |
| 9 | New UI controls could imply unsupported engine behavior. | HIGH | UX-4 support badges + ENG-UX-1 launch contract; block impossible combinations. |
| 10 | Android could be misrepresented as a normal desktop Lobium/Chromium launch target. | HIGH | Android remains disabled until the APK/runner/device proof exists; iOS is dropped entirely. |
| 11 | Docs can drift quickly after engine/product work. | MED | Keep this file and `DEPENDENCIES.md` updated with every task-state change. |

---

## 7. Doc Management Rules

- `PROJECT-STATUS.md` is the live maturity source.
- `PRODUCTION-ROADMAP.md` is the phased plan from that status to beta/GA.
- Specs are build references, not live maturity unless their "Status vs target" section says so.
- Ticket rows record work history; they do not prove production maturity by themselves.
- Any PR that completes or reopens a P0/P1 task must update this file and `DEPENDENCIES.md` in the same
  change.
