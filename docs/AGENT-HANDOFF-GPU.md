# Agent Handoff — GPU Machine

> Snapshot for the next agent after moving Lobster Browser to a real GPU machine.
> Date: 2026-07-08. This is a handoff document, not a marketing status page.

## Read This First

The project is in an active engineering state. The worktree is expected to be dirty because UI, engine,
Android, host-calibration, proxy/template stores, docs, and validation work have been landing in parallel.

Do not run destructive cleanup commands. In particular, do not use `git reset --hard`, `git checkout --`,
or broad "restore everything" commands unless the user explicitly asks for that. Start with:

```bash
git status --short
git diff --stat
```

The next useful machine is a real consumer-GPU machine. Avoid data-center GPUs such as T4, A10, A100,
L4, V100 as the main proof target because they create unrealistic user-device signals. A Linux box with
RTX 3060 / GTX 1660 class hardware is enough to start. Windows and macOS machines are still required
later for release confidence.

## Product Identity

Lobster Browser is an anti-detect browser desktop product with:

- Tauri/Rust desktop shell.
- React/TypeScript UI.
- Node/TypeScript engine-runner sidecar.
- Custom Chromium family called Lobium.
- Local automation API and SDKs.
- Future cloud backend for auth, teams, sync, billing, audit, and blob storage.

The UI branding in current source uses Octium/Lobster assets, a light theme, red primary color, and an
image-based lobster/Chrome-inspired icon. iOS has been intentionally discarded. Android is a separate
APK/device track, not a desktop spoofing mode.

## Authoritative Docs To Read

Read these in order:

1. `docs/AGENT-HANDOFF-GPU.md` - this file.
2. `docs/PROJECT-STATUS.md` - live status and operating manual.
3. `docs/PRODUCTION-ROADMAP.md` - phased path to beta/GA.
4. `docs/DEPENDENCIES.md` - dependency ordering.
5. `docs/specs/fingerprint-parameters.md` - fingerprint model and engine contract.
6. `docs/specs/android.md` - Android-only track after iOS was dropped.
7. `docs/contracts/sidecar-ipc.md` - sidecar launch/stop contract.
8. `docs/specs/product-ui-ux-plan.md` - declared UI/UX requirements.
9. `docs/tickets/README.md` - work register.

Useful code entry points:

- `packages/fingerprint/src/host-calibration.ts`
- `packages/engine-runner/src/host-calibration-probe.ts`
- `packages/engine-runner/src/start-profile.ts`
- `packages/engine-runner/src/runners/lobium-launcher.ts`
- `packages/fingerprint/src/android.ts`
- `packages/engine-runner/src/android-config.ts`
- `packages/engine-runner/src/android-bridge.ts`
- `ci/validation/lobium-detect.mjs`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/features/profiles/NewProfileForm.tsx`
- `apps/desktop/src/features/fingerprint/FingerprintEditor.tsx`
- `apps/desktop/src-tauri/src/lib.rs`

## Last Known Verification

These checks were green before this handoff, after the Android and host-calibration scaffolding work:

```bash
npm run typecheck --workspace @lobster/shared-types
npm run test --workspace @lobster/fingerprint
npm run test --workspace @lobster/engine-runner
npm run typecheck --workspace @lobster/desktop
npm run build --workspace @lobster/desktop
npm test --workspace @lobster/local-api-sdk
git diff --check
```

Last known counts:

- `@lobster/fingerprint`: 51 tests passed.
- `@lobster/engine-runner`: 71 tests passed.
- `@lobster/local-api-sdk`: 9 tests passed.

If the GPU machine is a fresh environment, install with:

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
```

Then rerun the verification commands above before doing GPU-specific work.

## Current Reality By Subsystem

### Desktop UI

Implemented in source:

- Light/white app shell with red primary theme.
- Header with logo/brand area and right-side controls.
- Sidebar information architecture for Profiles, Proxies, Templates, and Pricing.
- Profiles table with search/filter/create.
- Row action pattern: launch button plus three-dot menu.
- Three-dot menu surface for edit, clone, set/remove password, and move to trash.
- New Profile modal with General, Fingerprint, Cookies, Security, and Extensions categories.
- Fingerprint fields for OS/version, user agent, screen, languages, timezone, geo, WebRTC, CPU, RAM,
  renderer policy, hardware noise, and media devices.
- Cookie import draft support through file/drop/paste parsing.
- Extension reference support by Chrome Web Store link.
- Proxy and template SQLite-backed local stores.
- Pricing page scaffold.

Still missing or not proven:

- Full integrated `tauri dev` proof on all target OSes.
- Signed installer, updater, bundled sidecar, and bundled engine.
- Encrypted local secrets.
- Backend/cloud-backed proxy/template/pricing state.
- Browser runtime support for every UI field.

### Desktop Fingerprint Engine

Strong foundation, not production complete.

Implemented:

- Deterministic seed-to-fingerprint flow.
- Coherent Windows/macOS/Linux catalog.
- Proxy geo overlay.
- Coherence validator.
- Native Lobium config writer/reader path through `lobium-fp.json` and `--lobium-fp-config`.
- Per-profile farbling seeds for canvas/WebGL/audio.
- Native/dev coverage for major navigator, screen, WebGL, canvas, and audio surfaces.
- Private fontconfig hook when a font pack exists.
- Host calibration shared types and derivation helper.
- `startProfile` can derive from a supplied `hostCalibration` snapshot.

Not done/proven:

- Real-GPU detector proof.
- Persisted first-run host calibration service.
- Product default path passing a stored host profile into `startProfile`.
- Native consumption of all captured WebGL extensions, precision buckets, GL version strings, client
  rects, codecs, voices, WebGPU, TLS/JA4, HTTP/2, and full media-device policy.
- Cross-OS real machine proof on Windows, macOS, and Linux.
- Final licensed font bundles and metrics.
- Blocking native detector CI.

### Host Calibration

Recent non-GPU work landed:

- `packages/shared-types/src/ipc.ts` includes optional `StartProfileParams.hostCalibration`.
- `packages/engine-runner/src/start-profile.ts` uses `deriveFingerprintFromHost` when a host snapshot is
  provided, validates OS match, rejects software renderer profiles, and falls back to catalog derivation
  when absent.
- `packages/engine-runner/src/host-calibration-probe.ts` contains browser-side probe scaffolding for
  navigator, screen, timezone, WebGL caps/extensions/precision/version, and `queryLocalFonts`.
- `packages/fingerprint/src/host-calibration.ts` contains deterministic host-derived fingerprint logic
  and validation.

The missing production work is the persisted first-run service:

1. Launch an unspoofed calibration browser on the user's real machine.
2. Capture the host profile using browser probes plus OS/Rust APIs.
3. Persist it locally.
4. Feed it into every profile launch.
5. Recalibrate when GPU/OS/screen/font facts change.

### Android

Current policy:

- iOS is dropped.
- Android remains a separate mobile engine track.
- Desktop Lobium must not pretend to be Android.

Implemented scaffolding:

- `PLANNED_MOBILE_OS_FAMILIES = ['android']`.
- Android shared types including device fingerprint, Android version/API, build fingerprint, mobile
  screen/DPR, touch, fonts, RAM, renderer, and UA model.
- Android catalog/coherence in `packages/fingerprint/src/android.ts` and `packages/fingerprint/src/pools.ts`.
- Android Lobium config builder in `packages/engine-runner/src/android-config.ts`.
- ADB bridge command planning in `packages/engine-runner/src/android-bridge.ts`.

Still missing:

- Actual Android Lobium APK config reader.
- APK build pipeline.
- Real device launch/CDP proof.
- Android host calibration.
- Android proxy/WebRTC leak validation.
- Real-device detector matrix.

Android does not need the desktop GPU machine to continue, but it does need real Android devices later.

### Backend, Security, Cloud

Partially implemented:

- Auth, teams/RBAC, profiles, API keys, audit, blob sync contract, plan limits.
- Local automation API default-deny behavior, loopback host guard, and constant-time token compare.
- API SDK examples/tests.

Still missing:

- Real S3/MinIO blob store.
- Postgres/Prisma CI path.
- Client-side AES-GCM profile/session blob encryption.
- OS keychain wrapping and local SQLite at-rest encryption.
- Real Stripe flow.
- Observability, deployment, rate limits, and release hardening.

## GPU Machine First Tasks

Do these before writing new engine logic.

1. Preserve the current state.

```bash
git status --short
git diff --stat
```

If the user allows it, create a checkpoint branch or commit before large GPU work. If not, continue
carefully without reverting unrelated changes.

2. Verify dependencies and baseline tests.

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
npm run typecheck --workspace @lobster/shared-types
npm run test --workspace @lobster/fingerprint
npm run test --workspace @lobster/engine-runner
npm run typecheck --workspace @lobster/desktop
npm run build --workspace @lobster/desktop
git diff --check
```

3. Locate Lobium.

Use one of:

```bash
export LOBSTER_LOBIUM_BIN=/absolute/path/to/chrome
export LOBSTER_LOBIUM_DIR=/absolute/path/to/chromium/src
```

The launcher also knows the prior local development layout:

```text
/home/ivyhfx/lobium-build/src/out/Lobium/chrome
```

On the new GPU machine this path may not exist. Prefer explicit `LOBSTER_LOBIUM_BIN` until the new
layout is clear.

4. Run the native detector on the real GPU.

```bash
node ci/validation/lobium-detect.mjs
```

Expected outcome for the next phase is not "perfect score immediately." The first goal is to produce a
dated real-GPU baseline report that proves whether the engine is using the physical GPU and records true:

- WebGL vendor/renderer.
- WebGL extension list.
- WebGL caps and precision.
- GL/GLSL version strings.
- Canvas hash.
- WebGL pixel hash.
- Audio hash.
- User agent and UA-CH behavior.
- WebRTC/IP leak behavior if a proxy is configured.

If the report shows SwiftShader, software rendering, or headless-only signals, stop and fix launch flags
or GPU environment before tuning fingerprints.

5. Capture host calibration from the same machine.

Use the existing scaffold:

- `probeHostCalibration(page, { os, arch })`
- `deriveFingerprintFromHost(...)`
- `validateHostCalibrationProfile(...)`

Then implement the missing product path:

- desktop first-run probe,
- persisted host profile,
- pass `hostCalibration` into sidecar `startProfile`,
- reject/repair stale or software-rendered host profiles.

## Priority Remaining Work

### P0: Real-GPU And Host Calibration

- Provision real consumer-GPU Linux machine.
- Build or locate Lobium on that machine.
- Run `ci/validation/lobium-detect.mjs` without unsafe SwiftShader.
- Archive the first real-GPU report.
- Implement persisted host calibration.
- Make host-derived fingerprinting the default product path.
- Keep catalog-derived personas only as fallback/CI path.
- Extend native Lobium to consume captured extension lists, precision buckets, GL/GLSL strings, and
  remaining policy fields.

### P0: Product Safety

- Encrypt local SQLite secrets, especially proxy credentials/session material.
- Implement client-side profile blob encryption.
- Bundle sidecar and engine with desktop app.
- Add signed installers and updater.
- Run clean-machine product E2E.

### P0: Runtime Feature Completion

- Cookie inject/export into launched browser context.
- Extension install/load from saved extension references.
- WebRTC no-leak proof behind real proxy.
- DNS/proxy fail-closed behavior.
- Engine support badges or launch blocking for UI fields not yet honored natively.

### P1: Android

- Build Android Lobium APK.
- Implement Android APK config reader.
- Push per-profile config through ADB/app-private storage.
- Start/stop Android profile with CDP forwarding.
- Validate on real Android devices across Pixel/Samsung/OnePlus/Xiaomi classes.

### P1: Backend/Cloud

- Real S3/MinIO implementation.
- Postgres/Prisma CI suite.
- Stripe webhook and subscription writes.
- Team member removal and key rotation.
- Observability and staging deployment.

### P1: Cross-OS

- Windows Lobium build and real Windows GPU detector report.
- macOS Apple Silicon build and detector report.
- Linux signed/package path.
- Cross-OS updater and signing.

## Known Traps

- Do not treat Android as just another desktop UA profile. It needs an Android APK/device path.
- Do not claim Windows/macOS/Linux fingerprinting is "complete" until it passes on real machines with
  real GPUs.
- Do not use arbitrary foreign GPU renderer strings on desktop. The current architecture is
  host-calibrated plus farbled; deep GPU surfaces should inherit from the real machine.
- Do not rely on SwiftShader/headless detector reports for production claims.
- Do not add UI controls that imply engine behavior unless the sidecar/native engine can honor them or
  the product clearly disables/blocks unsupported combinations.
- Do not reset the dirty worktree.

## Definition Of Done For The Next Phase

The next agent should aim for this concrete end state:

- Baseline tests still pass.
- Lobium launches on a real consumer GPU without SwiftShader.
- A real-GPU detector report is saved and summarized in docs.
- Host calibration captures real GPU/screen/navigator/timezone/font facts.
- A profile launch can use persisted host calibration by default.
- Two profiles on the same host share real hardware facts but have distinct, stable farbling hashes.
- Any remaining detector failures are listed as ranked engineering tasks.

Once that is true, update:

- `docs/PROJECT-STATUS.md`
- `docs/PRODUCTION-ROADMAP.md`
- `docs/DEPENDENCIES.md`
- this handoff document if another machine/session transfer is expected.
