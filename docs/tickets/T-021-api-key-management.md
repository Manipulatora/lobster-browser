# T-021 — API-key management

**Pillar:** 3/4 · Automation + Cloud SaaS · **Assignee:** Claude (impl by workflow agent) · **Status:** done · **Day:** 6

Team-scoped programmatic credentials for the automation API, stored securely (hashed, never recoverable).

## What shipped — `src/api-keys/`

- **`POST /api-keys`** `{ name }` → `{ apiKey, secret }`. The full **secret** (`lb_live_` + 48 hex) is returned
  **exactly once**; the server persists only the display **prefix** (`lb_live_ab12cd34`) + **`sha256(secret)`** —
  the plaintext is unrecoverable afterwards.
- **`GET /api-keys`** → the team's keys, **display fields only** (never the secret or its hash).
- **`DELETE /api-keys/:id`** → revoke; a key in another team is indistinguishable from missing (both 404, so
  ids can't be probed cross-team).
- **`verify(secret)`** service method → `sha256` → lookup by hash → stamps `lastUsedAt` → returns
  `{ teamId, apiKeyId } | null`. This is the entry point a future local-automation-API guard uses to
  authenticate programmatic requests. Exported from the module.
- Repo-factory (in-memory + Prisma over the existing `ApiKey` model); team-scoped via `TEAMS_REPOSITORY`.
- Every creation/revocation is written to the **audit trail** (T-022).

## Security properties

- The `hashedKey` never crosses the HTTP boundary — the service's `toApiKey()` strips it from every response.
- Secrets are compared only as `sha256` hashes; the plaintext is held transiently at creation and discarded.

## Verification

- 9 e2e tests: one-time-secret + format, list hides secret/hash, revoke + re-revoke 404, per-team isolation,
  name validation (400), `verify()` success/`lastUsedAt`/unknown, revoked-no-longer-verifies, 401s.

## Follow-ups (per `docs/specs/security.md`)

- **Scopes** (read/launch/manage) + per-key rate limits; key **rotation**; expiry.
- Wire `verify()` into the desktop **local automation API** Bearer check (replace the single env key).
