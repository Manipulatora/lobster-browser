# T-002 — Sidecar: real engine launch (historical Patchright harness)

> **Superseded production architecture:** ADR-0003 now makes Lobium the only production engine.
> This ticket records the original Patchright launch harness and is retained for history/internal tests.
> Current production work is RUN-3/direct native Lobium launch: direct-spawn Lobium, write
> `lobium-fp.json`, expose CDP for control only, and never use Patchright as the product stealth layer.

- **Pillar/Track:** B · Engine & Fingerprint
- **Assignee:** Claude
- **Status:** done · historical harness; superseded for production by RUN-3 / ADR-0003
- **Depends on:** Day 0 sidecar skeleton (done), T-003 (fingerprint-suite) can land in parallel

## Goal

Historical goal: replace `NotImplementedRunner` with a real launch harness that launched Chromium via
Patchright and returned working CDP endpoints. This was useful to prove orchestration and validation
plumbing. It is no longer the product launch architecture.

Current production goal: fulfill the [sidecar IPC contract](../contracts/sidecar-ipc.md) through direct
native Lobium only. Fingerprint surfaces are consumed via Lobium native config, while CDP endpoints are
returned for automation/control.

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
- Historical harness: `launch` a `lobium`-labelled profile connected the same way. Production now uses
  direct native Lobium only.
- Cookies persist across relaunch (same `userDataDir`).
- No `navigator.webdriver`; patchright isolated contexts confirmed (no `Runtime.enable` tell).

## Test requirements

- Integration test: launch → connect over CDP → navigate to `about:blank` → assert title → stop.
- A CDP-cleanliness assertion (webdriver flag absent).
