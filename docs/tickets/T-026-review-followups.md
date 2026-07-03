# T-026 — Full-codebase review follow-ups (deferred findings)

A whole-codebase adversarial review (8 lanes, findings verified) surfaced **25 confirmed** defects.
The HIGH anti-detect/security/correctness ones + cheap wins are fixed directly (see the commit that
references this ticket). The items below are **deferred** because they need more design or DB-level
work than a point fix; tracked here so they aren't lost.

## Deferred — HIGH

- **T-026a · Single-instance lock never releases when the browser is closed/crashes.**
  `engine-runner` `CompositeRunner` marks a profile `running` and only clears it on an explicit `stop()`.
  If the user closes the window or the engine crashes, the profile is stuck "running" forever (can't
  relaunch). Fix: plumb a browser-exit signal (patchright `context.on('close')` / handle `close`) into
  the runner so it auto-reconciles the active-instance map. `packages/engine-runner/src/runners/composite.ts` + `patchright-launcher.ts`.

- **T-026b · Desktop local automation API is unauthenticated by default (default-allow).**
  `local_api.rs` `authorized()` allows all requests when `LOBSTER_API_KEY` is unset — so any local
  process (or a DNS-rebinding web page hitting `127.0.0.1:53211`) can start/stop profiles and read proxy
  credentials. Fix: **default-deny** — on first run generate a random key, persist it 0600 in the app-data
  dir, surface it in the UI for automation clients, and load it when the env var is unset; add
  Origin/Host checks against DNS rebinding. (Compose with the backend `ApiKey.verify()` from T-021.)

## Deferred — MEDIUM

- **T-026c · Popup/child pages briefly expose the real navigator** before the async per-page CDP
  fingerprint override lands (patchright's `page` event is post-hoc/fire-and-forget). Fix: browser-level
  `Target.setAutoAttach({autoAttach, waitForDebuggerOnStart})` so overrides are installed before any new
  target runs script. (Related to T-002d.)
- **T-020a · Plan-limit TOCTOU** (already filed) — concurrent create/bulk/import can exceed a team's
  limit; needs a serializable transaction / per-team advisory lock on the Postgres path.

## Deferred — LOW

- Default-team ("first team") resolution is positional and orders differently across the in-memory vs
  Prisma repos — make it deterministic (resolve the user's owned personal team explicitly).
- `bulkCreate`/`importBundle` create rows in a non-transactional loop — a mid-batch failure leaves
  partial state; wrap in a single `prisma.$transaction`.
- Desktop local-API handler errors bypass the `{code,data,msg}` envelope and body-parsing runs before
  the auth check — parse manually after `authorized()` and return the envelope on failure.

## Refuted (no action)

3 lower-confidence findings were adversarially **refuted** during verification and dropped.
