# Project Status & Operating Manual — Lobster Browser

> **Authoritative live status.** This file records what is real in the repository, what is
> conditional/dev-only, and what remains before beta/GA. Strategy lives in
> [`MASTER_PLAN.md`](MASTER_PLAN.md); the phased host-calibrated production plan lives in
> [`PRODUCTION-ROADMAP.md`](PRODUCTION-ROADMAP.md); dependency ordering lives in
> [`DEPENDENCIES.md`](DEPENDENCIES.md).
>
> **Last audited:** 2026-07-09 after a broad Phase 3 productization pass: **SEC-2** key hierarchy
> (`@lobster/crypto` keys + Rust keychain LSK wrap + Tauri encrypt/decrypt commands), **HC-3**
> `ensureHostCalibration` + desktop default `LOBSTER_HOST_CALIBRATION_FILE`, **PROX-4** SOCKS5h geo,
> **PROX-7/8** Chromium fail-closed args, **BE-3/5/7** blob size quota + ApiKeyGuard automation routes +
> member remove/leave, **SEC-3b** helmet/rate-limit + `/health/ready`, **DSK-5** sidecar resource
> bundling plumbing, and **QA-1** opt-in lobium-detect CI job. Still deferred: HC-4 Blink rebuild,
> signing certs, Windows Lobium/Node runtime bundle, Stripe live webhooks.
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

- **Real-GPU proof now exists on native Lobium (RTX 5090), with one confirmed open tell.** The engine
  launches on the physical GPU (no SwiftShader) and 18/18 desktop personas across Windows/macOS/Linux
  apply their JS-safe + string surfaces coherently (`battle-test.mjs`). The confirmed remaining tell is
  the **deep-GPU host leak (HC-4)**: `getSupportedExtensions()`/`getShaderPrecisionFormat()`/`gl.VERSION`
  betray the real host GPU because the native Blink hook that consumes the (now-serialized, now-parsed)
  config fields is not yet compiled into the binary. The RTX 5090 is also data-center-class; a mid-range
  consumer GPU + Windows/macOS baselines are still needed before an "Octo-class" claim is defensible.
- **No persisted host calibration service yet.** `deriveFingerprint` still uses `pools.ts` when no host
  snapshot is supplied; there is no persisted first-run desktop host profile, no real-GPU host baseline,
  and no UI flow that makes host calibration the default.
- **No native Lobium CI gate.** CI runs patched Chromium through `ci/validation/run.mjs`; the native
  `lobium-detect.mjs` script exists but is not a blocking real-GPU CI job.
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
| Host-calibrated GPU extensions/precision/version | SCAFFOLDED | Shared types, host-derived fingerprint helper, and Lobium config serialization can carry extension lists, shader precision, and GL version strings. Actual host probe + native consumption remain open. |
| Multi-OS builds/signing/notarization | ABSENT | Linux/dev path only. |

### 2.2 Runner, Desktop, Backend, QA

| Area | Real Today | Still Missing |
|---|---|---|
| **fingerprint** | Deterministic seed -> coherent desktop persona; proxy geo overlay; coherence validator; Apple-Silicon arch and several cross-surface tells fixed. | Host-derived primary path; Android mobile family; real host screen/window model; richer fallback catalog. |
| **engine-runner** | `buildLaunchers` prefers native Lobium when discovered via `LOBSTER_LOBIUM_BIN`, `LOBSTER_LOBIUM_DIR`, local dev layout, or packaged resource and falls back loudly/cleanly; per-profile config and font env hooks; `startProfile` fails closed on incoherence; runner evicts crashed/closed browsers. | Native real-GPU CI; `pid` still 0 due persistent-context API; popup gate for CDP-only tz/locale/geo; packaged sidecar. |
| **desktop** | SQLite CRUD; `launch_profile`/`stop_profile` call sidecar; local API starts with generated/persisted key; light/red React shell uses image branding, header actions, and required Profiles/Proxies/Templates/Pricing IA; Profiles table/search/filter/create/launch/stop/edit/clone/password/trash/fingerprint flows exist; create-profile modal has General/Fingerprint/Cookies/Security/Extensions categories; local SQLite persists OS version, proxy/template refs, cookie import draft, extension refs, proxy catalog rows, template rows, and Argon2 password hashes; **AES-256-GCM at-rest encryption of proxy/cookie secrets (SEC-12)** and a **single-instance lock (DSK-3)**. **Windows x64 installer (NSIS) + `lobster-desktop.exe` cross-build from Linux** (Rust `x86_64-pc-windows-msvc` via `cargo-xwin` + LLVM + Linux `makensis`); see `docs/specs/windows-cross-build.md`. | First integrated `tauri dev` proof on all OSes; **bundle sidecar + a Windows Lobium/interim engine into the installer** (DSK-5/11) + signing (SEC-14a); backend/cloud proxy/template/pricing APIs; OS-keychain key wrap (SEC-2); full engine support for every wizard field; premium UI/UX design-system pass (UI-1..8). |
| **backend** | Auth, teams/RBAC, profiles, API keys, audit, blob sync contract, plan limit; **real S3/MinIO `S3BlobStore` with atomic CAS (BE-1)**; **opt-in Postgres/Prisma integration suite, proven against a real container (BE-2)**; **SEC-1 LBv1 client encrypt proven via sync e2e** (server stays opaque); in-memory + S3 tests green (58 pass, 1 skip). | SEC-2 key hierarchy/keychain; Stripe real flow; member removal/team deletion; staging/deploy/observability. |
| **proxy/cookies** | Proxy parsing, HTTP/HTTPS exit geo, desktop Rust proxy test command for HTTP/HTTPS/SOCKS5, WebRTC launch policy, cookie parse/serialize library; **cookie inject/export into the launched context (PROX-1/2)**; **encrypted proxy credentials at rest (SEC-12)**. | Kill-switch/DNS leak gate; live proxy WebRTC proof. |
| **QA/CI** | Format/typecheck/build/tests; patched Chromium live launch; interim Sannysoft/WebRTC gate; **native-Lobium multi-OS battle-test, host-calibration E2E, and full product E2E on the real GPU**. | Native Lobium gate in CI; real-GPU CI runners; Pixelscan/Iphey/browserleaks/FingerprintJS; live anti-bot panel; load/perf/security gates. |
| **security/ops** | Local API core auth hardening; JWT prod secret hard-fail; password hashing; API-key hashing; gitleaks action; **local SQLite at-rest encryption (SEC-12)**; **client-side LBv1 AES-GCM blob envelope (SEC-1)** in `@lobster/crypto` + Rust `blob_crypto`. | Key hierarchy + OS keychain (SEC-2); rate limits/helmet/metrics/readiness/Sentry; full-history/license/dependency audits; release signing/updater. |

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
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | pass, 18 Rust tests (incl. 4 LBv1 blob_crypto) |
| `node ci/validation/lobium-detect.mjs` (native Lobium, RTX 5090) | pass, native surfaces 10/10, Sannysoft 0 failed |
| `node ci/validation/battle-test.mjs` (native Lobium, RTX 5090) | 18/18 desktop personas pass, 6/6 Android; confirmed the deep-GPU host-leak (HC-4) |
| `node ci/validation/host-calibration-e2e.mjs` (native Lobium, RTX 5090) | pass; 4 host-derived profiles share hardware, farbling distinct + stable across relaunch |
| `npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis` | pass; produced `Lobster Browser_0.0.0_x64-setup.exe` (~4.9 MB) + `lobster-desktop.exe` (~17 MB) cross-built on Linux |
| `node ci/validation/product-e2e.mjs` (native Lobium, HEADFUL on GPU) | **PASS** — creates a profile, launches native Lobium through the real sidecar `startProfile` path, injects imported cookies, navigates a live site, screenshots the painted window, round-trips cookie export, and stops |
| `LOBSTER_PRODUCT_E2E=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml product_launch_connect_stop_e2e_when_enabled -- --nocapture` | pass, launches `lobium`, verifies CDP `/json/version`, and asserts `lobium-fp.json` exists with UA/WebRTC/farbling seed fields |
| `npm test --workspace @lobster/crypto` | pass, 11 tests (SEC-1 LBv1 + SEC-2 hierarchy) |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` | pass, 28 Rust tests (incl. blob_crypto HKDF/wrap + keychain LSK) |
| `npm test --workspace @lobster/backend` | pass, 60 tests (1 skip); includes SEC-1 sync, BE-5 automation whoami, BE-7 remove/leave |
| `npm test --workspace @lobster/engine-runner` | pass, 95 tests (incl. ensureHostCalibration + proxy hardening) |
| `npm test --workspace @lobster/proxy` | pass, 16+ tests (SOCKS5h geo path) |
| `git diff --check` | pass |

Important limitation: these do **not** prove native Lobium on a real GPU or a packaged desktop product.

---

## 4. Remaining Work Register

### Engine / Fingerprint

| ID | P | Status | Task |
|---|---|---|---|
| RG-0 | P0 | partial | Real GPU box provisioned (NVIDIA RTX 5090, driver 580, Linux). Confirmed Chromium reaches the physical GPU headlessly via `--use-gl=angle --use-angle=vulkan` + NVIDIA Vulkan ICD; default ANGLE path degrades to llvmpipe. Native Lobium still not built on this host. |
| RG-1 | P0 | partial | GPU flag policy centralized in `@lobster/engine-runner` `buildGpuArgs` (env `LOBSTER_GPU`/`LOBSTER_ANGLE_BACKEND`); `lobium-detect.mjs` no longer force-SwiftShaders in GPU mode; new `ci/validation/gpu-baseline.mjs` archives a real-GPU report and fails on software fallback. First real-GPU baseline captured on the interim Chromium (`ci/validation/reports/`). Native-Lobium real-GPU baseline still open. |
| RG-2 | P0 | partial | Real-GPU triage done via `ci/validation/battle-test.mjs` on native Lobium (RTX 5090): 18/18 desktop personas pass applied-surface + coherence; the confirmed delta is the deep-GPU host leak (see HC-4). Mid-range consumer-GPU + Windows/macOS baselines remain. |
| HC-1 | P0 | partial | Host GPU probe runs live on the real GPU via `ci/validation/host-calibration-e2e.mjs` (probe + OS fontconfig -> validated host snapshot). Windows/macOS device baselines remain open. |
| HC-2 | P0 | partial | Browser-side screen/navigator/timezone/font probe scaffold exists; cross-OS first-run live probe still open. |
| HC-3 | P0 | mostly done | `deriveFingerprintFromHost` proven E2E; `host-calibration-store` + `ensureHostCalibration` (load/probe/persist) + sidecar RPC `ensureHostCalibration`; desktop sets default `LOBSTER_HOST_CALIBRATION_FILE` under app data. Live GPU probe injection into `ensureHostCalibration` from first-run UI still open (CI e2e / injectable probe cover the path). |
| HC-4 | P0 | partial | `lobium-fp.json` carries WebGL extensions/shaderPrecision/version (sidecar serialize + unit test), and the native config **reader** (`lobium/src/lobium_fp_config.{h,cc}`) now parses them. Confirmed necessary by `battle-test.mjs` (18 personas leaked one identical host extension set). Remaining: the Blink hook `host-gpu-profile.patch` (getParameter/getSupportedExtensions/getShaderPrecisionFormat) + a build-VPS rebuild. |
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
| SEC-1 | P0 | done (envelope) | Client-side AES-256-GCM **LBv1** blob encryption per `docs/specs/security.md` §1.3: `@lobster/crypto` (`encryptBlob`/`decryptBlob`/`encryptProfileBlob`) + desktop Rust `blob_crypto::BlobCipher`. Acceptance: wire bytes contain no cleartext cookie/domain; tamper/wrong-key fail closed; backend `POST /profiles/:id/sync` round-trips a real LBv1 envelope opaquely. |
| SEC-2 | P0 | partial | Key hierarchy in `@lobster/crypto` (`deriveUserMasterKey` Argon2id, `wrapKey`/`unwrapKey` LKw1, HKDF PCK/key_id, `bootstrapTeamKeys`/`unlockTeamKeys`) + Rust mirrors (`blob_crypto` HKDF/wrap + Tauri `encrypt_profile_blob`/`decrypt_profile_blob`). LSK via `keyring` (Secret Service/DPAPI/Keychain) with 0600 file fallback (`keychain.rs`). **Remaining:** cloud membership TDK re-wrap on member removal, full desktop sync UI that stores wrapped UKWK/TDK, production Argon2 cost in UI unlock flow. |
| SEC-12 | P0 | done | AES-256-GCM at-rest encryption of proxy credentials + cookie-import payloads in the SQLite stores (`src/secrets.rs` `SecretCipher`). Per-install random 32-byte key persisted 0600 (`secrets.key`), `lbsec1:<nonce‖ct>` cells, legacy-plaintext compat. Threaded through UI/local-API/sidecar launch. Tests read the raw SQLite cell and assert the password bytes are absent. `TODO(SEC-2)` OS-keychain wrap remains. |
| SEC-3b | P1 | partial | Backend: `helmet` + `express-rate-limit` in `main.ts`; `/health/ready` 503 when prod/HEALTH_REQUIRE_DB and DB down. Local API default-deny/host guard/constant-time compare already done. Sentry/metrics still open. |
| BE-1 | P0 | done | Real `S3BlobStore` (AWS SDK v3) with immutable per-version objects and atomic `If-None-Match` compare-and-set → one writer wins, the loser gets `BlobVersionConflictError`/409. Injectable `S3Client`; 8 unit tests against a fake S3 reproduce the 412 semantics (no network). Env-selected (`S3_BUCKET`), MinIO/R2-compatible. |
| BE-2 | P0 | done | Opt-in Postgres/Prisma integration spec runs `prisma migrate deploy` + all five repositories' behavioural assertions; skip-clean without `DATABASE_URL`. Proven green against a real `postgres:16` container (64/64 full-suite pass); default gate stays green. `npm run test:integration`. |
| BE-3/4 | P1 | partial | BE-3: per-push blob max size (`BLOB_MAX_BYTES`, default 25 MiB) → 413. Team total quota constant documented; full lifecycle GC still open. BE-4 Stripe live webhooks still open. |
| BE-5/7/9 | P1 | partial | BE-5: `ApiKeyGuard` + `GET /automation/whoami` (revoked key → 401, e2e). BE-7: `DELETE /teams/:id/members/:userId` + `POST /teams/:id/leave` with last-admin safety (e2e). BE-9 Docker/staging still open. |
| DSK-2 | P0 | open | First integrated GUI run and webview smoke. |
| DSK-5/11 | P0 | partial | **Linux `.deb` proven** (`docs/specs/linux-packaging.md`): shell + bundled Node 22 + self-contained sidecar (~55 MB deb); Lobium runtime packaged separately (~1 GB) and installed under `~/.local/share/lobster`. Create→launch→CDP proven via installed GUI + local API + `product-e2e`. Windows NSIS still shell-only. Still open: AppImage, system-wide dpkg postinst for Lobium, bundled Node/`externalBin` polish, signing, auto-update, Windows Lobium. |
| UI-1 | P1 | done | Design-system foundation landed: `tokens.css` (light+dark), `components.css`, and `ui/` primitives (Button/Field/Badge/Modal/Toast/Theme/CommandPalette/EmptyState/Skeleton). `main.tsx` wraps ThemeProvider + ToastProvider. Legacy `styles.css` consumes tokens; remaining hex cleaned. |
| UI-2 | P1 | partial | Profiles workspace: bulk select + Launch/Stop/Move to trash, sortable Title/Status/Proxy columns, live status Badges, EmptyState + Skeleton loading. Full 1k–10k virtualization still open. |
| UI-3 | P1 | partial | Ctrl/Cmd-K command palette with nav + profile search/quick-launch; existing search/filters/tags remain. Dedicated folders UX still open. |
| UI-4 | P1 | done | Fingerprint editor shows live persona preview via `previewPersona` (UA/platform/WebGL/cores/memory), `FIELD_SUPPORT` badges, and blocks Save when `validateFingerprintCoherence` reports issues. Browser-safe `@lobster/fingerprint` alias avoids `node:crypto`. |
| UI-5 | P1 | done | First-run `OnboardingModal` when zero profiles + `lobster.onboarded` unset; explains host calibration and Create Profile CTA (Skip / Get started). |
| UI-6 | P1 | done | Post-launch `LaunchPanel` opens with CDP `ws`/`debuggerAddress` + Playwright/Puppeteer/Selenium snippets. |
| UI-7 | P1 | done | Toasts replace banners for profile/proxy/template async feedback; EmptyState + Skeleton on Profiles/Proxies/Templates; bulk bar + keyboard palette shortcut. |
| UI-8 | P1 | partial | `i18n.ts` `t()` scaffold + unhandled error hooks in `main.tsx`. Full string extraction, opt-in crash reporter, and installer artwork remain. |
| DSK-3 | P1 | done | `tauri-plugin-single-instance` registered first; a 2nd launch shows/unminimizes/focuses the existing `main` window instead of contending on port 53211 / the SQLite file. |
| PROX-1/2 | P0 | done | Cookie inject/export into the launched context: `@lobster/engine-runner` `cookie-inject.ts` parses a profile's `CookieImportDraft` (Netscape or JSON, auto-detected) and loads it over CDP (`Network.setCookies`, `replace` clears first) at launch, and `exportCookies`/`exportCookiesJson` reads the jar back. Wired through `LaunchContext` → patchright launcher; unit-tested (8) and proven in `ci/validation/product-e2e.mjs` (injected session cookie present in the live jar + export round-trip). |
| PROX-3 | P0 | done | Proxy testing is exposed through Tauri IPC, Add Proxy modal check, proxy-row Check buttons, local automation API `/api/v1/proxy/test`, and JS/Python SDK helpers. |
| PROX-4 | P0 | mostly done | Launch-path `deriveGeoFromExitIp` now supports SOCKS5 via `socks-proxy-agent` (socks5h remote DNS). Live residential-proxy WebRTC proof still open (QA-4). |
| PROX-7/8 | P1 | partial | Chromium fail-closed args (`--disable-quic`, AsyncDns/DoH upgrade off) emitted when proxied via `buildProxyHardeningArgs`. OS-level firewall kill-switch still documented gap. |
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
| 1 | Real-GPU score unknown; SwiftShader proofs can hide or create tells. | HIGH→MED | GPU pipeline now proven reachable (RTX 5090 via ANGLE/Vulkan); harness records renderer provenance and fails on software fallback. Still need a native-Lobium build + mid-range consumer-GPU baseline. |
| 2 | Persisted host-calibration service is absent; profiles still fall back to `pools.ts` when no host snapshot is supplied. | HIGH | Probe scaffold, typed host snapshot, `deriveFingerprintFromHost`, and `startProfile.hostCalibration` are ready; persisted first-run capture + real-GPU proof remain. |
| 3 | Native Lobium gate is not in CI. | HIGH | Promote `lobium-detect.mjs` to real-GPU CI after RG-1 script cleanup. |
| 4 | Profile/session blobs need key hierarchy before cloud sync is sellable. | HIGH | SEC-1 LBv1 envelope done; SEC-2 key hierarchy/keychain before GA sync. |
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
