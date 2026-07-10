# T-026 — Full-codebase review follow-ups (deferred findings)

A whole-codebase adversarial review (8 lanes, findings verified) surfaced **25 confirmed** defects.
The HIGH anti-detect/security/correctness ones + cheap wins are fixed directly (see the commit that
references this ticket). The items below are **deferred** because they need more design or DB-level
work than a point fix; tracked here so they aren't lost.

## Reconciled 2026-07-06

Several findings below were fixed or downgraded after this ticket was written. Keep this file as the
reasoning trail; use `PROJECT-STATUS.md` for current priority.

## Deferred / Resolved

- **T-026a · RESOLVED — runner active map evicts on browser close/crash.**
  `CompositeRunner` now registers `handle.onClose` and removes the profile if the same handle closes.
  Desktop app single-instance is still a separate DSK-3 task.

- **T-026b · CORE RESOLVED — local API default-deny + Host guard + constant-time compare.**
  The desktop now provisions a per-install key when `LOBSTER_API_KEY` is unset, the API denies when no key
  is configured, and non-loopback Host values are rejected. Residual work: rate limiting and a UI/settings
  surface for automation clients to view/rotate the local key.

## Deferred — MEDIUM

- **T-026c · DOWNGRADED for native Lobium.**
  The native config channel must reach popup renderers before first script. CDP auto-attach can still be
  used to observe/control the test, but production timezone/locale/geo correctness must come from native
  Lobium config, not an interim override race.
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
