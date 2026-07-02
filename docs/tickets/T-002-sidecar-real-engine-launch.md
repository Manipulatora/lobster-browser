# T-002 — Sidecar: real engine launch (patchright)

- **Pillar/Track:** B · Engine & Fingerprint
- **Assignee:** Claude
- **Status:** ready
- **Depends on:** Day 0 sidecar skeleton (done), T-003 (fingerprint-suite) can land in parallel

## Goal

Replace `NotImplementedRunner` with a real `EngineRunner` that launches Chromium via patchright — both
the `chromium` interim engine and `lobium` (served by a patched Chromium via patchright until the
native build ships) — applies the JS-safe fingerprint surfaces cleanly, and returns working CDP
endpoints — fulfilling the [sidecar IPC contract](../contracts/sidecar-ipc.md).

## Spec

- Add deps to `packages/engine-runner`: `patchright`, `playwright-core` (guard browser downloads in
  install; engines come from `/engines`, not npm).
- Implement a `PatchrightRunner` (drives Chromium); a `CompositeRunner` dispatches by `params.engine`
  (`chromium` | `lobium`).
- On `launch`: use `params.userDataDir` (persistent), attach `params.proxy`, apply **JS-safe** surfaces
  (UA/UA-CH, timezone, locale, geo, viewport, hardwareConcurrency, screen) via patchright isolated
  init scripts. **Never** touch canvas/webgl/audio/TLS from JS/CDP. Never enable global
  `Runtime`/`Console`.
- Enforce single-active-instance per `profileId` (`already_running` error otherwise).
- Return `{ profileId, pid, ws, debuggerAddress }`.
- `stop` closes gracefully; `status` lists running engines.

## Files to touch

- `packages/engine-runner/src/runner.ts`, new `src/runners/patchright.ts`,
  `src/runners/composite.ts`; `packages/engine-runner/package.json`.

## Acceptance criteria

- `launch` a `chromium` profile → `chromium.connectOverCDP(ws)` succeeds and the page loads.
- `launch` a `lobium` profile → connects the same way (interim patched Chromium via patchright).
- Cookies persist across relaunch (same `userDataDir`).
- No `navigator.webdriver`; patchright isolated contexts confirmed (no `Runtime.enable` tell).

## Test requirements

- Integration test: launch → connect over CDP → navigate to `about:blank` → assert title → stop.
- A CDP-cleanliness assertion (webdriver flag absent).
