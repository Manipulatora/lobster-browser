# T-002 — Sidecar: real engine launch (patchright + camoufox-js)

- **Pillar/Track:** B · Engine & Fingerprint
- **Assignee:** Claude
- **Status:** ready
- **Depends on:** Day 0 sidecar skeleton (done), T-003 (fingerprint-suite) can land in parallel

## Goal

Replace `NotImplementedRunner` with a real `EngineRunner` that launches Chromium (via patchright) and
Camoufox (via camoufox-js), applies the JS-safe fingerprint surfaces cleanly, and returns working CDP
endpoints — fulfilling the [sidecar IPC contract](../contracts/sidecar-ipc.md).

## Spec

- Add deps to `packages/engine-runner`: `patchright`, `camoufox-js`, `playwright-core` (guard browser
  downloads in install; engines come from `/engines`, not npm).
- Implement `PatchrightRunner` (Chromium) and `CamoufoxRunner` (Camoufox); a `CompositeRunner`
  dispatches by `params.engine`.
- On `launch`: use `params.userDataDir` (persistent), attach `params.proxy`, apply **JS-safe** surfaces
  (UA/UA-CH, timezone, locale, geo, viewport, hardwareConcurrency, screen) via patchright isolated
  init scripts / Camoufox config. **Never** touch canvas/webgl/audio/TLS from JS/CDP. Never enable
  global `Runtime`/`Console`.
- Enforce single-active-instance per `profileId` (`already_running` error otherwise).
- Return `{ profileId, pid, ws, debuggerAddress }`.
- `stop` closes gracefully; `status` lists running engines.

## Files to touch

- `packages/engine-runner/src/runner.ts`, new `src/runners/patchright.ts`, `src/runners/camoufox.ts`,
  `src/runners/composite.ts`; `packages/engine-runner/package.json`.

## Acceptance criteria

- `launch` a Chromium profile → `chromium.connectOverCDP(ws)` succeeds and the page loads.
- `launch` a Camoufox profile → controllable via its Playwright endpoint.
- Cookies persist across relaunch (same `userDataDir`).
- No `navigator.webdriver`; patchright isolated contexts confirmed (no `Runtime.enable` tell).

## Test requirements

- Integration test: launch → connect over CDP → navigate to `about:blank` → assert title → stop.
- A CDP-cleanliness assertion (webdriver flag absent).
