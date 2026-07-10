# Project Status & Operating Manual — Lobster Browser

> **Authoritative live status.** This file records what is real in the repository, what is
> conditional/dev-only, and what remains before beta/GA. Strategy lives in
> [`MASTER_PLAN.md`](MASTER_PLAN.md); the phased host-calibrated production plan lives in
> [`PRODUCTION-ROADMAP.md`](PRODUCTION-ROADMAP.md); dependency ordering lives in
> [`DEPENDENCIES.md`](DEPENDENCIES.md).
>
> **Last audited:** 2026-07-10 — HC-4 confirmed compiled + functional in the binary
> (`ci/validation/hc4-probe.mjs` 5/5; `autoninja -n` clean) and a real-GPU zero-lies gate added
> (`ci/validation/gate.mjs` + `.github/workflows/real-gpu-gate.yml`). Prior audit 2026-07-09 after
> clientRects / mediaDevices / Linux catalogs / Android ADB launch wiring. Production launch uses direct
> native Lobium only. Patchright remains an internal validation harness. Still deferred: real-GPU
> zero-lies proof through the new gate on consumer hardware, authenticated proxy
> support in the direct/native path, cookie pre-injection without Patchright, signing certs, Windows
> Lobium/Node runtime bundle, Stripe live webhooks.
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
  layout, or a packaged engine resource, `lobium` launches use that binary directly, write
  `lobium-fp.json`, pass `--lobium-fp-config`, and thread the profile seed so canvas/WebGL/audio
  farbling seeds are distinct per profile. There is no uncustomized Chromium/Patchright fallback.
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
- **A Windows x64 installer now cross-builds from this Linux box.** The Tauri desktop shell compiles to
  `x86_64-pc-windows-msvc` (via `cargo-xwin` + LLVM `clang-cl`/`lld-link`) and bundles into an NSIS
  installer with a Linux-hosted `makensis` — no Windows machine involved. This proves the Windows
  packaging pipeline (installer + UI shell + WebView2). It does **not** yet bundle the engine/sidecar and
  is unsigned; see `docs/specs/windows-cross-build.md` for the full reproducible recipe and honest scope.
- **Client-side profile-blob encryption (SEC-1) is implemented.** `@lobster/crypto` and the desktop Rust
  `blob_crypto` module produce the normative LBv1 AES-256-GCM envelope; unit tests assert no cleartext
  cookie/domain on the wire and that tamper fails decrypt; a backend sync e2e pushes/pulls a real
  envelope opaquely. SEC-2 key hierarchy + desktop sync UI wiring remain.

What is still not real:

- **HC-4 deep-WebGL hook is now COMPILED and FUNCTIONAL in the binary (proven).** Previously listed as
  the one confirmed open tell. Build-state audit (obj + `libblink_modules.so` rebuilt after the patch;
  `autoninja -n chrome` reports nothing to do) plus an empirical sentinel probe
  (`ci/validation/hc4-probe.mjs`, 5/5 PASS) confirm the binary routes `cfg->webgl.{version,
  shadingLanguageVersion,extensions,shaderPrecision}` to JS: `gl.VERSION`, `SHADING_LANGUAGE_VERSION`,
  `getSupportedExtensions()`, the `getExtension()` allow-list guard, and `getShaderPrecisionFormat()`
  all return the configured values. The earlier "not yet compiled" claim was **stale** — a rebuild
  after the patch (2026-07-10) already included it; it simply had not been re-validated.
- **What HC-4 does NOT yet prove: real-GPU coherence.** The plumbing is live, but no run has yet shown a
  persona's claimed GPU class agreeing with *real* pixel/capability reality on consumer hardware — every
  CreepJS "zero lies" datapoint to date is still SwiftShader (`gpuMode: "software"`). That is now the job
  of the **real-GPU stealth gate** (`.github/workflows/real-gpu-gate.yml` + `ci/validation/gate.mjs`,
  see `docs/specs/real-gpu-ci.md`), which fails unless a run is real-hardware AND every situation is
  zero-lies. The RTX 5090 datapoint is also data-center-class; a mid-range consumer GPU + Windows/macOS
  baselines through that gate are still needed before an "Octo-class" claim is defensible.
- **No persisted host calibration service yet.** `deriveFingerprint` still uses `pools.ts` when no host
  snapshot is supplied; there is no persisted first-run desktop host profile, no real-GPU host baseline,
  and no UI flow that makes host calibration the default.
- **No native Lobium CI gate.** Native launch/detector scripts exist, but `lobium-detect.mjs` is not yet
  a blocking real-GPU CI job.
- **Direct launcher operational gaps remain.** The new production path deliberately does not use
  Patchright for proxy auth, cookie pre-injection, geolocation permission grants, or JS/CDP fingerprint
  overrides. Authenticated proxies currently fail closed until a native/local proxy-auth adapter exists;
  cookie pre-injection needs a native profile-store or control-CDP implementation that is kept separate
  from fingerprint spoofing.
- **No sellable packaging/security/durability.** No signed installers, bundled sidecar, updater,
  OS-keychain key wrap, local SQLite full-DB encryption beyond field-level SEC-12, Postgres CI in
  default gates, or real Stripe. **Client-side LBv1 blob encryption (SEC-1) is now implemented** as a
  library + desktop mirror; cloud sync still needs SEC-2 key hierarchy before it is sellable.

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
| Host-calibrated GPU extensions/precision/version (HC-4) | PROVEN IN BINARY (plumbing) | Native Blink hook is compiled + functional: `ci/validation/hc4-probe.mjs` confirms `gl.VERSION`/`SHADING_LANGUAGE_VERSION`/`getSupportedExtensions()`/`getExtension()` guard/`getShaderPrecisionFormat()` all return config values (5/5). Remaining: real host probe as default source + real-GPU coherence via the real-GPU gate. |
| Multi-OS builds/signing/notarization | ABSENT | Linux/dev path only. |

### 2.2 Runner, Desktop, Backend, QA

| Area | Real Today | Still Missing |
|---|---|---|
| **fingerprint** | Deterministic seed -> coherent desktop persona; proxy geo overlay; coherence validator; Apple-Silicon arch and several cross-surface tells fixed. | Host-derived primary path; Android mobile family; real host screen/window model; richer fallback catalog. |
| **engine-runner** | `buildLaunchers` registers only direct native Lobium when discovered via `LOBSTER_LOBIUM_BIN`, `LOBSTER_LOBIUM_DIR`, local dev layout, or packaged resource; otherwise it fails clearly. The direct launcher spawns the Lobium binary, writes native config, handles process-group shutdown, returns the CDP endpoint, and does not apply fingerprint values through Patchright/JS. `startProfile` fails closed on incoherence; runner evicts crashed/closed browsers. | Native real-GPU CI; authenticated proxy adapter for direct native launches; cookie pre-injection/export in a non-spoofing control channel; packaged sidecar. |
| **desktop** | SQLite CRUD; `launch_profile`/`stop_profile` call sidecar; local API starts with generated/persisted key; light/red React shell uses image branding, header actions, and required Profiles/Proxies/Templates/Pricing IA; Profiles table/search/filter/create/launch/stop/edit/clone/password/trash/fingerprint flows exist; create-profile modal has General/Fingerprint/Cookies/Security/Extensions categories; local SQLite persists OS version, proxy/template refs, cookie import draft, extension refs, proxy catalog rows, template rows, and Argon2 password hashes; **AES-256-GCM at-rest encryption of proxy/cookie secrets (SEC-12)** and a **single-instance lock (DSK-3)**. **Windows x64 installer (NSIS) + `lobster-desktop.exe` cross-build from Linux** (Rust `x86_64-pc-windows-msvc` via `cargo-xwin` + LLVM + Linux `makensis`); see `docs/specs/windows-cross-build.md`. | First integrated `tauri dev` proof on all OSes; **bundle sidecar + a Windows Lobium engine into the installer** (DSK-5/11) + signing (SEC-14a); backend/cloud proxy/template/pricing APIs; OS-keychain key wrap (SEC-2); full engine support for every wizard field; premium UI/UX design-system pass (UI-1..8). |
| **backend** | Auth, teams/RBAC, profiles, API keys, audit, blob sync contract, plan limit; **real S3/MinIO `S3BlobStore` with atomic CAS (BE-1)**; **opt-in Postgres/Prisma integration suite, proven against a real container (BE-2)**; **SEC-1 LBv1 client encrypt proven via sync e2e** (server stays opaque); in-memory + S3 tests green (58 pass, 1 skip). | SEC-2 key hierarchy/keychain; Stripe real flow; member removal/team deletion; staging/deploy/observability. |
| **proxy/cookies** | Proxy parsing, HTTP/HTTPS exit geo, desktop Rust proxy test command for HTTP/HTTPS/SOCKS5, WebRTC launch policy, cookie parse/serialize library, **encrypted proxy credentials at rest (SEC-12)**. | Cookie inject/export on the direct native Lobium path; authenticated proxy adapter; kill-switch/DNS leak gate; live proxy WebRTC proof. |
| **QA/CI** | Format/typecheck/build/tests; Patchright live launch is retained as an internal compatibility harness; **native-Lobium launch tests, battle-test, host-calibration E2E, and full product E2E** exist where a binary/GPU is provisioned. | Native Lobium gate in CI; real-GPU CI runners; Pixelscan/Iphey/browserleaks/FingerprintJS; live anti-bot panel; load/perf/security gates. |
| **security/ops** | Local API core auth hardening; JWT prod secret hard-fail; password hashing; API-key hashing; gitleaks action; **local SQLite at-rest encryption (SEC-12)**; **client-side LBv1 AES-GCM blob envelope (SEC-1)** in `@lobster/crypto` + Rust `blob_crypto`. | Key hierarchy + OS keychain (SEC-2); rate limits/helmet/metrics/readiness/Sentry; full-history/license/dependency audits; release signing/updater. |

---

## 3. Current Test Snapshot

Last local verification in this audit:

| Command | Result |
|---|---|
| `npm run typecheck --workspace @lobster/shared-types` | pass |
| `npm run typecheck --workspace @lobster/fingerprint` | pass |
| `npm run typecheck --workspace @lobster/engine-runner` | pass |
| `npm test --workspace @lobster/fingerprint` | pass, 56 tests |
| `npm test --workspace @lobster/engine-runner` | pass, 100 tests (incl. direct native Lobium launcher + ensureHostCalibration + proxy hardening) |
| `npm run typecheck --workspace @lobster/desktop` | pass |
| `npm test --workspace @lobster/local-api-sdk` | pass, 9 tests |
| `npm run build --workspace @lobster/desktop` | pass |
| `npx playwright test apps/desktop/e2e/ui-smoke.spec.ts --reporter=line` | pass |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | pass, 18 Rust tests (incl. 4 LBv1 blob_crypto) |
| `node ci/validation/lobium-detect.mjs` (native Lobium, RTX 5090) | pass, native surfaces 10/10, Sannysoft 0 failed |
| `node ci/validation/battle-test.mjs` (native Lobium, RTX 5090) | 18/18 desktop personas pass, 6/6 Android; confirmed the deep-GPU host-leak (HC-4) |
| `node ci/validation/host-calibration-e2e.mjs` (native Lobium, RTX 5090) | pass; 4 host-derived profiles share hardware, farbling distinct + stable across relaunch |
| `npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis` | pass; produced `Lobster Browser_0.0.0_x64-setup.exe` (~4.9 MB) + `lobster-desktop.exe` (~17 MB) cross-built on Linux |
| `node ci/validation/product-e2e.mjs` (native Lobium, HEADFUL on GPU) | historical PASS on the Patchright-backed product path; must be rerun/updated for the direct native launcher because cookie pre-injection moved back to open work |
| `LOBSTER_PRODUCT_E2E=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml product_launch_connect_stop_e2e_when_enabled -- --nocapture` | pass, launches `lobium`, verifies CDP `/json/version`, and asserts `lobium-fp.json` exists with UA/WebRTC/farbling seed fields |
| `npm test --workspace @lobster/crypto` | pass, 11 tests (SEC-1 LBv1 + SEC-2 hierarchy) |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` | pass, 28 Rust tests (incl. blob_crypto HKDF/wrap + keychain LSK) |
| `npm test --workspace @lobster/backend` | pass, 60 tests (1 skip); includes SEC-1 sync, BE-5 automation whoami, BE-7 remove/leave |
| `npm test --workspace @lobster/proxy` | pass, 16+ tests (SOCKS5h geo path) |
| `git diff --check` | pass |

Important limitation: the RTX 5090 runs are local/provisioned proofs, not a blocking CI gate, not
multi-OS consumer-hardware coverage, and not a packaged clean-VM product proof.

---

## 4. Remaining Work Register

### Engine / Fingerprint

| ID | P | Status | Task |
|---|---|---|---|
| RG-0 | P0 | partial | Real GPU box provisioned (NVIDIA RTX 5090, driver 580, Linux). Confirmed Chromium-family builds reach the physical GPU headlessly via `--use-gl=angle --use-angle=vulkan` + NVIDIA Vulkan ICD; default ANGLE path can degrade to llvmpipe. Consumer GPU and cross-OS baselines remain. |
| RG-1 | P0 | mostly done | GPU flag policy centralized in `@lobster/engine-runner` `buildGpuArgs` (env `LOBSTER_GPU`/`LOBSTER_ANGLE_BACKEND`); `lobium-detect.mjs` no longer force-SwiftShader in GPU mode; `ci/validation/gpu-baseline.mjs` archives a real-GPU report and fails on software fallback. **Blocking real-GPU CI now authored**: `ci/validation/gate.mjs` (strict: rejects software renderer + any nonzero lies) + `.github/workflows/real-gpu-gate.yml` (self-hosted `gpu` runner) + `docs/specs/real-gpu-ci.md`. Verified it FAILS the current SwiftShader report. Open only: provisioning the self-hosted runner + flipping the `pull_request` trigger. |
| RG-2 | P0 | partial | Real-GPU triage done via `ci/validation/battle-test.mjs` on native Lobium (RTX 5090): 18/18 desktop personas pass applied-surface + coherence. The former HC-4 delta is now closed in the binary (see HC-4). Remaining: run the real-GPU zero-lies gate (RG-1) on the RTX 5090 + a mid-range consumer GPU + Windows/macOS baselines, and record a `GATE PASS`. |
| HC-1 | P0 | partial | Host GPU probe runs live on the real GPU via `ci/validation/host-calibration-e2e.mjs` (probe + OS fontconfig -> validated host snapshot). Windows/macOS device baselines remain open. |
| HC-2 | P0 | partial | Browser-side screen/navigator/timezone/font probe scaffold exists; cross-OS first-run live probe still open. |
| HC-3 | P0 | mostly done | `deriveFingerprintFromHost` proven E2E; `host-calibration-store` + `ensureHostCalibration` (load/probe/persist) + sidecar RPC `ensureHostCalibration`; desktop sets default `LOBSTER_HOST_CALIBRATION_FILE` under app data. Live GPU probe injection into `ensureHostCalibration` from first-run UI still open (CI e2e / injectable probe cover the path). |
| HC-4 | P0 | **done (plumbing)** | Config reader + sidecar serialize deep WebGL fields; Blink hook `fingerprint/host-gpu-profile.patch` (VERSION / SHADING_LANGUAGE_VERSION / extensions / shaderPrecision) is **compiled + functional in the binary** — `ci/validation/hc4-probe.mjs` returns 5/5 sentinel matches (incl. the `getExtension()` allow-list guard). Only real-GPU coherence (does the claimed GPU class match real reality) remains, tracked under RG-1/RG-2. |
| AND-0..9 | P1 | partial | Android ADB launch path wired: `startAndroidProfile` + desktop Launch enabled (fail-closed without a ready device). APK build, real-device detector proof, and APK-side config reader remain open. See `docs/specs/android.md`. |
| HC-5 | P1 | open | Renderer masking/normalization policy per OS/GPU. |
| HC-6 | P1 | open | Screen/window metric coherence. |
| ENG-7 | P0 | open | Multi-OS build hosts, rebase proof, signing/notarization. |
| ENG-4/6b | P1 | open | Media-codec/branding parity check; final licensed font bundles. |

Completed engine items that old docs may still list as open: **RUN-1**, **ENG-3**, **ENG-5**, **ENG-6
mechanism**, **ENG-8 scalar caps**, **ENG-10 audio byte paths**.

### Product / Security / Backend

| ID | P | Status | Task |
|---|---|---|---|
| SEC-1 | P0 | done (envelope) | Client-side AES-256-GCM **LBv1** blob encryption per `docs/specs/security.md` §1.3: `@lobster/crypto` (`encryptBlob`/`decryptBlob`/`encryptProfileBlob`) + desktop Rust `blob_crypto::BlobCipher`. Acceptance: wire bytes contain no cleartext cookie/domain; tamper/wrong-key fail closed; backend `POST /profiles/:id/sync` round-trips a real LBv1 envelope opaquely. |
| SEC-2 | P0 | partial | Key hierarchy in `@lobster/crypto` (`deriveUserMasterKey` Argon2id, `wrapKey`/`unwrapKey` LKw1, HKDF PCK/key_id, `bootstrapTeamKeys`/`unlockTeamKeys`) + Rust mirrors (`blob_crypto` HKDF/wrap + Tauri `encrypt_profile_blob`/`decrypt_profile_blob`). LSK via `keyring` (Secret Service/DPAPI/Keychain) with 0600 file fallback (`keychain.rs`). **Remaining:** cloud membership TDK re-wrap on member removal, full desktop sync UI that stores wrapped UKWK/TDK, production Argon2 cost in UI unlock flow. |
| SEC-12 | P0 | done | AES-256-GCM at-rest encryption of proxy credentials + cookie-import payloads in the SQLite stores (`src/secrets.rs` `SecretCipher`). Per-install random 32-byte key persisted 0600 (`secrets.key`), `lbsec1:<nonce‖ct>` cells, legacy-plaintext compat. Threaded through UI/local-API/sidecar launch. Tests read the raw SQLite cell and assert the password bytes are absent. `TODO(SEC-2)` OS-keychain wrap remains. |
| SEC-3b | P1 | partial | Backend: `helmet` + `express-rate-limit` in `main.ts`; `/health/ready` 503 when prod/HEALTH_REQUIRE_DB and DB down. Local API default-deny/host guard/constant-time compare already done. Sentry/metrics still open. |
| BE-1 | P0 | done | Real `S3BlobStore` (AWS SDK v3) with immutable per-version objects and atomic `If-None-Match` compare-and-set → one writer wins, the loser gets `BlobVersionConflictError`/409. Injectable `S3Client`; 8 unit tests against a fake S3 reproduce the 412 semantics (no network). Env-selected (`S3_BUCKET`), MinIO/R2-compatible. |
| BE-2 | P0 | done | Opt-in Postgres/Prisma integration spec runs `prisma migrate deploy` + all five repositories' behavioural assertions; skip-clean without `DATABASE_URL`. Proven green against a real `postgres:16` container (64/64 full-suite pass); default gate stays green. `npm run test:integration`. |
| BE-3/4 | P1 | partial | BE-3: per-push blob max size (`BLOB_MAX_BYTES`, default 25 MiB) → 413. Team total quota constant documented; full lifecycle GC still open. BE-4 Stripe live webhooks still open. |
| BE-5/7/9 | P1 | partial | BE-5: `ApiKeyGuard` + `GET /automation/whoami` (revoked key → 401, e2e). BE-7: `DELETE /teams/:id/members/:userId` + `POST /teams/:id/leave` with last-admin safety (e2e). BE-9 Docker/staging still open. |
| DSK-2 | P0 | open | First integrated GUI run and webview smoke. |
| DSK-5/11 | P0 | partial | **Linux `.deb` proven** (`docs/specs/linux-packaging.md`): shell + bundled Node 22 + self-contained sidecar (~55 MB deb); Lobium runtime packaged separately (~1 GB) and installed under `~/.local/share/lobster`. Windows NSIS still shell-only. Still open: rerun package E2E on the direct native launcher, AppImage, system-wide dpkg postinst for Lobium, bundled Node/`externalBin` polish, signing, auto-update, Windows Lobium. |
| UI-1 | P1 | done | Design-system foundation landed: `tokens.css` (light+dark), `components.css`, and `ui/` primitives (Button/Field/Badge/Modal/Toast/Theme/CommandPalette/EmptyState/Skeleton). `main.tsx` wraps ThemeProvider + ToastProvider. Legacy `styles.css` consumes tokens; remaining hex cleaned. |
| UI-2 | P1 | partial | Profiles workspace: bulk select + Launch/Stop/Move to trash, sortable Title/Status/Proxy columns, live status Badges, EmptyState + Skeleton loading. Full 1k–10k virtualization still open. |
| UI-3 | P1 | partial | Ctrl/Cmd-K command palette with nav + profile search/quick-launch; existing search/filters/tags remain. Dedicated folders UX still open. |
| UI-4 | P1 | done | Fingerprint editor shows live persona preview via `previewPersona` (UA/platform/WebGL/cores/memory), `FIELD_SUPPORT` badges, and blocks Save when `validateFingerprintCoherence` reports issues. Browser-safe `@lobster/fingerprint` alias avoids `node:crypto`. |
| UI-5 | P1 | done | First-run `OnboardingModal` when zero profiles + `lobster.onboarded` unset; explains host calibration and Create Profile CTA (Skip / Get started). |
| UI-6 | P1 | done | Post-launch `LaunchPanel` opens with CDP `ws`/`debuggerAddress` + Playwright/Puppeteer/Selenium snippets. |
| UI-7 | P1 | done | Toasts replace banners for profile/proxy/template async feedback; EmptyState + Skeleton on Profiles/Proxies/Templates; bulk bar + keyboard palette shortcut. |
| UI-8 | P1 | partial | `i18n.ts` `t()` scaffold + unhandled error hooks in `main.tsx`. Full string extraction, opt-in crash reporter, and installer artwork remain. |
| DSK-3 | P1 | done | `tauri-plugin-single-instance` registered first; a 2nd launch shows/unminimizes/focuses the existing `main` window instead of contending on port 53211 / the SQLite file. |
| PROX-1/2 | P0 | partial | Cookie parse/map/export utilities remain unit-tested, but launch-time cookie pre-injection was previously wired through the Patchright context and is now open for the direct native Lobium path. Replacement must use native profile storage or a clearly separated control-CDP channel, never a Patchright production fallback. |
| PROX-3 | P0 | done | Proxy testing is exposed through Tauri IPC, Add Proxy modal check, proxy-row Check buttons, local automation API `/api/v1/proxy/test`, and JS/Python SDK helpers. |
| PROX-4 | P0 | mostly done | Launch-path `deriveGeoFromExitIp` now supports SOCKS5 via `socks-proxy-agent` (socks5h remote DNS). Live residential-proxy WebRTC proof still open (QA-4). |
| PROX-7/8 | P1 | partial | Chromium fail-closed args (`--disable-quic`, AsyncDns/DoH upgrade off) emitted when proxied via `buildProxyHardeningArgs`. OS-level firewall kill-switch still documented gap. |
| UX-1 | P0 | done | Light/red shell, selected image logo, header notification/profile controls, and four-item sidebar are implemented in `apps/desktop/src`. |
| UX-2 | P0 | done (desktop UI) | Profiles table/search/filter/create action and launch/stop flow exist; row actions are consolidated to Launch + overflow menu with edit/clone/password/trash surface, edit profile persists general metadata, password protection hashes in SQLite, move-to-trash soft-deletes via `trashed_at`, Trash restore/permanent-delete exists, and `apps/desktop/e2e/ui-smoke.spec.ts` covers the main UI flow. |
| UX-3 | P0 | partial | Create Profile modal has General/Fingerprint/Cookies/Security/Extensions categories; cookie file/drop/paste parsing persists draft metadata, extension refs persist, fingerprint policy fields save, and stored proxy/template selectors feed profile creation. Browser cookie injection and extension install-at-launch remain. |
| UX-4 | P0 | mostly done | Create-profile Fingerprint matrix: read-only OS-derived UA; Win/macOS Intel/Arm/Linux/Android; screens (Retina); fonts + persona modes; verified WebGL catalogs (PCI IDs + Linux Mesa); Android device type/model from Play CSV; noise/media. Linux font/WebGL catalogs enabled. HC-4 / clientRects / mediaDevices hooks authored (Lobium rebuild required for binary proof). Provenance: `docs/specs/fingerprint-catalog-provenance.md`. |
| PROX-UI-1 | P0 | partial | Proxies page has My Proxies/Hive Proxy tabs, Add Proxy modal, durable SQLite add/list rows, Rust IPC proxy testing, row Check actions, and profile assignment through New Profile. Encrypted credential persistence, bulk import, and real Hive provider backend remain. |
| TPL-1 | P1 | partial | Templates page has durable SQLite list/search/create and a Create Profile action that seeds profile creation. Richer template policies, backend sync, and bulk-create remain. |
| PRICE-1 | P1 | partial | Pricing page exists with plan/usage cards; backend billing config and Stripe state remain. |
| DATA-UX-1 | P0 | partial | Shared types, local SQLite profile/proxy/template stores, desktop API, and sidecar IPC now round-trip OS version, proxy/template refs, cookie import drafts, extensions, WebRTC/noise/media/renderer policy types. Backend DTO/metadata expansion and encrypted local secret storage remain. |
| ENG-UX-1 | P0 | mostly done | Sidecar/`lobium-fp.json` carries OS-derived UA, screen (+ Retina DPR), fonts, verified WebGL preset, WebRTC policy, hardware-noise-gated farbling seeds (incl. clientRects), mediaDevices policy, Android device fields. Native patches authored for HC-4 + clientRects + mediaDevices; Lobium rebuild required to prove. |
| IOS-0 | P0 | dropped | iOS is intentionally discarded. It must not appear as a Lobster target, template, or launch path. |

### QA / Docs

| ID | P | Status | Task |
|---|---|---|---|
| QA-1 | P0 | partial | Opt-in GitHub Actions job `lobium-detect` (gated by `vars.LOBSTER_ENABLE_LOBIUM_DETECT`); skip-clean without binary. Promote to blocking on self-hosted GPU runners. |
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

Parallel work that should continue immediately: SEC-2 (key hierarchy/keychain on top of SEC-1),
DSK-5/11 sidecar bundling, PROX-4/7/8, DSK-2, UX-4 follow-through, DATA-UX-1 backend/IPC completion,
ENG-7 build hosts/signing, and detector breadth procurement.

---

## 6. Risk Register

| # | Risk | Sev | Current Mitigation |
|---|---|---|---|
| 1 | Real-GPU score unknown; SwiftShader proofs can hide or create tells. | HIGH→MED | GPU pipeline now proven reachable (RTX 5090 via ANGLE/Vulkan); harness records renderer provenance and fails on software fallback. Still need blocking native-Lobium CI + mid-range consumer-GPU baseline. |
| 2 | Persisted host-calibration service is absent; profiles still fall back to `pools.ts` when no host snapshot is supplied. | HIGH | Probe scaffold, typed host snapshot, `deriveFingerprintFromHost`, and `startProfile.hostCalibration` are ready; persisted first-run capture + real-GPU proof remain. |
| 3 | Native Lobium gate is not in CI. | HIGH | Promote `lobium-detect.mjs` to real-GPU CI after RG-1 script cleanup. |
| 4 | Profile/session blobs need key hierarchy before cloud sync is sellable. | HIGH | SEC-1 LBv1 envelope done; SEC-2 key hierarchy/keychain before GA sync. |
| 5 | No durable production blob store. | HIGH | BE-1 MinIO/S3 implementation and readiness gate. |
| 6 | No signed/bundled desktop product. | HIGH | DSK-5/11 + ENG-7 + SEC-14. |
| 7 | SOCKS5 geo unsupported, causing locale/proxy mismatch. | HIGH | PROX-4; warn/fail until supported. |
| 8 | Detector matrix too narrow. | HIGH | QA-5/6 with residential proxies and vendor tenants. |
| 9 | New UI controls could imply unsupported engine behavior. | HIGH | UX-4 support badges + ENG-UX-1 launch contract; block impossible combinations. |
| 10 | Android could be misrepresented as a normal desktop Lobium launch target. | HIGH | Desktop Lobium still refuses Android UA spoof; Launch routes to ADB/APK (`startAndroidProfile`) and fails closed without a ready device. iOS is dropped entirely. |
| 11 | Docs can drift quickly after engine/product work. | MED | Keep this file and `DEPENDENCIES.md` updated with every task-state change. |

---

## 7. Doc Management Rules

- `PROJECT-STATUS.md` is the live maturity source.
- `PRODUCTION-ROADMAP.md` is the phased plan from that status to beta/GA.
- Specs are build references, not live maturity unless their "Status vs target" section says so.
- Ticket rows record work history; they do not prove production maturity by themselves.
- Any PR that completes or reopens a P0/P1 task must update this file and `DEPENDENCIES.md` in the same
  change.
