# T-022 — Action logs / audit trail

**Pillar:** 4 · Cloud SaaS (Action logs) · **Assignee:** Claude (impl by workflow agent) · **Status:** done · **Day:** 6

A team-scoped, append-only history of who did what — one of the named Octo-class pillars.

## What shipped — `src/audit/`

- **`AuditLog`** shared type + Prisma model (`audit_logs`, `@@index([teamId, createdAt])`, Team relation
  `onDelete: Cascade`).
- **`AuditService.record({ teamId, actorUserId?, action, targetType, targetId?, metadata? })`** — the stable
  contract other modules call. **Fail-safe by design:** the repo write is wrapped in try/catch and any error
  is swallowed, so a failed audit write can **never** break the primary business operation. Never throws.
- **`GET /audit?limit=&before=`** — the team's feed, **newest-first**, cursor-paginated (`before` = exclusive
  ISO-8601 `createdAt` cursor; `limit` clamped to [1, 200], default 50). Read-only — there is no write
  endpoint; entries are appended internally by the acting modules.
- Repo-factory (in-memory + Prisma); team-scoped via `TEAMS_REPOSITORY`. Exports `AuditService`.

## Instrumented events

- **Profiles:** `profile.create`, `profile.update` (changed field names only), `profile.bulk_create` (count),
  `profile.import` (count), `profile.delete`, `profile.sync` (push only; version). Metadata is non-secret
  (name/engine/os/count/field-names) — never a blob, secret, or field value.
- **API keys:** `apikey.create` (name/prefix), `apikey.revoke`.

## Adversarial review (fixed)

A multi-agent review found the paginated feed could **silently drop entries sharing a `createdAt`
millisecond**: it ordered by `(createdAt DESC, id DESC)` but paged with a **timestamp-only** cursor, so
boundary-ms siblings vanished from the feed — a data-integrity bug for an append-only log. Fixed with a
proper **keyset cursor** carrying `(createdAt, id)` (opaque base64url token via `encodeAuditCursor`), in
both the in-memory and Prisma repos, plus a malformed-cursor → **400** (was a 500 / silent wrong page).
New tests: lossless pagination across a same-millisecond burst; bad-cursor 400.

## Verification

- 5 audit e2e (record → `GET /audit` newest-first with metadata; team isolation; `limit` + `before` cursor;
  `record` is void/never-throws; 401) + a profiles integration test (create/bulk visible via `GET /audit`).

## Follow-ups

- Instrument **teams** (member invite / role change) and **auth** (login / key-verify) events.
- Immutable retention + export (`docs/specs/observability-ops.md`); actor display-name enrichment.
