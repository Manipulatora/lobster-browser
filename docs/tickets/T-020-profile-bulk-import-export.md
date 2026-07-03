# T-020 — Profile bulk-create + import / export / transfer

**Pillar:** 1 · Profiles · **Assignee:** Claude · **Status:** done · **Day:** 5

Completes the Day 5 profile-management surface: create many profiles at once, and move profiles between
teams/accounts via a portable, **secret-free** bundle.

## What shipped

- **`POST /profiles/bulk`** `{ count (1–50), namePrefix, engine, os, tags?, folder? }` → creates `count`
  profiles, **each with its own unique seed** (never a shared identity). The whole batch is plan-limit-checked
  up front, so an over-limit batch is rejected wholesale (no partial creation).
- **`GET /profiles/export`** → `ProfileExportBundle` (`{ version, exportedAt, profiles[] }`). Each entry is a
  **secret-free** `ProfileExport`: only `fingerprintSeed` + non-secret metadata — **never** the encrypted
  blob, `ownerTeamId`, ids, or runtime status. (Route declared **before** `GET /profiles/:id` so the literal
  path isn't captured as an id.)
- **`POST /profiles/import`** `ProfileExportBundle` → re-creates each profile under the caller's team,
  **preserving `fingerprintSeed`** so the coherent fingerprint identity transfers across teams/accounts.
  Batch plan-limit-checked. **Transfer** = export from team A + import into team B.
- New shared types: `ProfileExport`, `ProfileExportBundle`.

## Verification

- Backend e2e: bulk (unique seeds + wholesale over-limit 403 with no partial rows); export is secret-free
  (asserts no encrypted blob / ids); import into a second team transfers seed identity + isolation holds.
- 44 backend tests green; typecheck + prettier clean.

## Known limitation → follow-up

- **T-020a — plan-limit TOCTOU.** The batch limit check is check-then-act; concurrent bulk/import/create
  calls could momentarily exceed a team's limit under real load. The atomic fix is DB-level (a serializable
  transaction or a per-team advisory lock around count-then-insert) and is only exercised on the Postgres
  path, so it's deferred to T-020a (the in-memory dev/test path is effectively serialized).

## Follow-ups

- **T-020a:** atomic plan-limit enforcement (serializable txn / advisory lock) on the Postgres path.
- Bulk-create with a per-profile proxy assignment (round-robin from a proxy pool) once the proxy store lands.
- Desktop UI wiring for bulk + import/export (file picker → bundle).
