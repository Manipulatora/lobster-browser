# API Reference — Lobster Browser

> **Scope:** the complete programmatic surface of Lobster Browser — the **Local Automation API**
> (loopback, on the desktop agent), the **Cloud REST API** (the NestJS SaaS backend), **Webhooks**,
> the **SDKs** (Python / JS / C#), and the **MCP server** for AI agents.
> **Audience:** integration engineers, SDK authors, and the two building agents.
> **Companion contracts:** `docs/contracts/local-automation-api.md`, `docs/contracts/sidecar-ipc.md`.
> **Envelope source of truth:** `@lobster/shared-types` (`ApiResponse<T>`, `ok`/`err`, `API_OK=0`).

**Status legend (used throughout):** ✅ **done** (in code today) · 🟡 **partial** (skeleton/stub or
narrower than spec) · ⬜ **planned** (specified here, not yet built). Every endpoint table carries a
status column so this doc reflects the real surface, not an aspiration.

**Two APIs, one envelope.** Both the local and cloud APIs speak the AdsPower/Octo-compatible
`{ code, data, msg }` envelope where `code === 0` is success. This is deliberate: existing AdsPower /
GoLogin / Octo integrations port to Lobster with near-zero friction.

---

## Part 0 — Conventions shared by both APIs

### 0.1 Response envelope

Every JSON response (except the Stripe webhook receiver and CDP/WebSocket upgrades) is:

```jsonc
{
  "code": 0,            // 0 = success; non-zero = error (see error tables)
  "data": { /* ... */ },// payload on success; null on error
  "msg": "success"      // human-readable; "success" on ok, the error reason otherwise
}
```

Canonical helpers (`packages/shared-types/src/api.ts`):

```ts
ok<T>(data, msg = 'success') // → { code: 0, data, msg }
err(msg, code = 1)           // → { code, data: null, msg }
```

`code` is the **application** status. It is transported over HTTP and the two layers are
independent: a `200 OK` can still carry `code: 1` from the local API, and the cloud API maps Nest
exceptions to HTTP status codes while the body keeps the envelope. Clients MUST branch on `code`,
not solely on HTTP status.

### 0.2 Content type, encoding, time

- Requests/responses are `application/json; charset=utf-8` unless noted (Stripe webhook = raw).
- Timestamps are **ISO-8601 UTC** strings (`2026-07-02T14:33:01.000Z`).
- Binary profile blobs are **base64** strings on the wire.
- IDs are UUIDv4 strings unless a prefix is documented (e.g. API keys `lb_live_…`).

### 0.3 Idempotency & concurrency (summary; details per-endpoint)

- `GET` is always safe/idempotent.
- Blob **push** uses **optimistic concurrency** via `baseVersion` (mismatch → conflict). ✅
- An `Idempotency-Key` header for POST mutations (checkout, profile create) is ⬜ planned.

---

# Part 1 — Local Automation API

**Host process:** the Rust desktop agent (Tauri + Axum). **Bind:** `127.0.0.1` **only** (loopback;
never `0.0.0.0`). **Default port:** `53211` (`LOCAL_API_PORT` in `apps/desktop/src-tauri/src/lib.rs`).
**Base path:** `/api/v1`. **Source:** `apps/desktop/src-tauri/src/local_api.rs`.

This is the interface external automation drives — Selenium via `debuggerAddress`, Playwright /
Puppeteer via `connectOverCDP`. `start`/`stop`/`status` are delegated to the Node **engine-runner**
sidecar over stdio JSON-RPC (`docs/contracts/sidecar-ipc.md`); `list` reads the local SQLite profile
store directly.

### 1.1 Authentication

- Header: `Authorization: Bearer <LOBSTER_API_KEY>` on **every** endpoint except `/health`.
- The key is read from the `LOBSTER_API_KEY` environment variable at agent start. ✅
- **Dev fallback:** when `LOBSTER_API_KEY` is unset, the loopback-only server accepts unauthenticated
  requests (local dev convenience). In packaged builds the key is always set. ✅
- Comparison is exact-string today; constant-time comparison + multiple named keys is ⬜ planned
  (keys minted/rotated in the desktop UI, mirroring the cloud `api-keys` surface in §2.9).

### 1.2 Endpoint index

| Method | Path | Auth | Purpose | Status |
|---|---|---|---|---|
| `GET`  | `/api/v1/health` | none | Liveness of the agent + local API | ✅ done |
| `POST` | `/api/v1/profile/start` | Bearer | Launch a profile; return CDP endpoints | ✅ done |
| `POST` | `/api/v1/profile/stop` | Bearer | Stop a running profile | ✅ done |
| `GET`  | `/api/v1/profile/list` | Bearer | List local profiles (+ running flag) | ✅ done |
| `GET`  | `/api/v1/profile/status` | Bearer | Runtime status of one/all profiles | ✅ done |
| `POST` | `/api/v1/profile/create` | Bearer | Create a profile locally | ⬜ planned |
| `PATCH`| `/api/v1/profile/update` | Bearer | Edit profile fields/overrides | ⬜ planned |
| `POST` | `/api/v1/profile/delete` | Bearer | Delete a local profile | ⬜ planned |
| `POST` | `/api/v1/proxy/test` | Bearer | Test a proxy, return exit-IP geo | ✅ done |
| `POST` | `/api/v1/cookie/import` | Bearer | Import cookies into a profile | ⬜ planned |
| `GET`  | `/api/v1/cookie/export` | Bearer | Export a profile's cookies | ⬜ planned |
| `GET`  | `/api/v1/ws` (WebSocket) | Bearer | Live status/event stream | ⬜ planned |

> **Honest status:** the four `profile/*` runtime routes, `proxy/test`, and `health` are live today.
> Local profile **CRUD** and **cookie import/export** are still performed through the desktop UI / Tauri
> commands; exposing them on the loopback HTTP surface remains a follow-up so headless automation can
> manage profiles without the GUI.

### 1.3 `GET /api/v1/health` ✅

No auth. Confirms the agent and local API are up.

**Response** `200`:
```json
{ "code": 0, "data": { "status": "ok" }, "msg": "success" }
```

### 1.4 `POST /api/v1/profile/start` ✅

Look the profile up in the local store, ask the sidecar to derive its fingerprint (seed + overrides
+ best-effort proxy-exit geo) and launch the engine with a persistent `user-data-dir`, then return
both connect styles.

**Request body**
| Field | Type | Req | Notes |
|---|---|---|---|
| `profileId` | string | ✅ | Local profile id |
| `headless` | boolean | ⬜ | Default `false`; forwarded to sidecar |
| `password` | string | ⬜ | Required only when the profile has password protection enabled |

```json
{ "profileId": "b1e5…", "headless": false, "password": "optional-profile-password" }
```

**Response** `200` — `data` is `StartProfileResult` (`shared-types/src/api.ts`):
```jsonc
{
  "code": 0,
  "data": {
    "profileId": "b1e5…",
    "ws": "ws://127.0.0.1:49812/devtools/browser/6f2c…", // Playwright/Puppeteer connectOverCDP
    "debuggerAddress": "127.0.0.1:49812",                 // Selenium options.debugger_address
    "webDriver": "http://127.0.0.1:49812",                // optional http base
    "pid": 12345
  },
  "msg": "success"
}
```

**Errors**
| HTTP | code | `msg` | Cause |
|---|---|---|---|
| 401 | 1 | `unauthorized` | Missing/wrong Bearer key |
| 404 | 1 | `profile <id> not found` | Unknown `profileId` |
| 500 | 1 | `db lock` | Profile store lock poisoned |
| 500 | 1 | sidecar error text | Launch failed (e.g. `already_running`, engine missing) |

### 1.5 `POST /api/v1/profile/stop` ✅

**Request** `{ "profileId": "b1e5…" }`

**Response** `200`:
```json
{ "code": 0, "data": { "profileId": "b1e5…", "stopped": true }, "msg": "success" }
```
Errors: `401 unauthorized`; `500` with the sidecar error (e.g. profile not running).

### 1.6 `GET /api/v1/profile/list` ✅

Reads the local SQLite store (not the sidecar). Returns `LocalApiListItem[]`:
```json
{ "code": 0, "data": [ { "profileId": "b1e5…", "name": "US-affiliate-01", "running": true } ], "msg": "success" }
```
Errors: `401 unauthorized`; `500 db lock`.

### 1.7 `GET /api/v1/profile/status?profileId=<id>` ✅

`profileId` optional. With it → one profile; without it → all running (sidecar-reported).
`data` is `ProfileStatusResult`:
```json
{ "code": 0, "data": { "profileId": "b1e5…", "running": true,
  "ws": "ws://127.0.0.1:49812/devtools/browser/6f2c…", "debuggerAddress": "127.0.0.1:49812" },
  "msg": "success" }
```

### 1.8 Planned local endpoints (spec) ⬜

**`POST /api/v1/profile/create`** — mirrors the cloud `CreateProfileInput`. Production profiles use
`"engine": "lobium"` only; old `"chromium"` values are rejected or migrated.
```jsonc
// body
{ "name": "US-01", "engine": "lobium", "os": "windows",
  "fingerprintSeed": "optional-hex", "fingerprintOverrides": { /* opaque */ },
  "proxy": { "type": "socks5", "host": "1.2.3.4", "port": 1080, "username": "u", "password": "p" },
  "tags": ["affiliate"], "folder": "US", "notes": "" }
// data → the created Profile (see §2.6 schema)
```
**`PATCH /api/v1/profile/update`** — `{ "profileId", ...partial fields }` (seed immutable, as cloud).
**`POST /api/v1/profile/delete`** — `{ "profileId" }` → `{ "profileId", "deleted": true }`.

**`POST /api/v1/proxy/test`** — validate a proxy before attaching:
```jsonc
// body
{ "id": "px_1", "config": { "id": "px_1", "type": "socks5", "host": "1.2.3.4", "port": 1080, "username": "u", "password": "p" } }
// data → ProxyTestResult
{ "ok": true, "latencyMs": 312,
  "geo": { "ip": "1.2.3.4", "countryCode": "US", "city": "Ashburn",
           "timezone": "America/New_York", "asn": "AS7922", "isDatacenter": false } }
```

If `id` is supplied, the desktop updates that stored local proxy row's latest test status.

**`POST /api/v1/cookie/import`** — `{ "profileId", "cookies": [ /* Netscape/JSON cookie objects */ ] }`.
**`GET  /api/v1/cookie/export?profileId=<id>`** — `data: { "profileId", "cookies": [...] }`.
Cookie objects follow the CDP `Network.Cookie` shape (`name,value,domain,path,expires,httpOnly,secure,sameSite`).

**`GET /api/v1/ws` (WebSocket)** — after Bearer upgrade, pushes JSON events
`{ "event": "profile.started"|"profile.stopped"|"profile.error", "profileId", "ts" }` for live UIs.

### 1.9 Error codes (local API)

The local API uses a **two-value** application code today (`API_OK=0`, `API_ERR=1`) with the reason
in `msg`, plus a meaningful **HTTP** status. Fine-grained numeric codes are ⬜ planned (below) so
clients can branch without string-matching `msg`:

| Planned `code` | Meaning | Typical HTTP |
|---|---|---|
| 0 | success | 200 |
| 1 | generic error (current catch-all) | 4xx/5xx |
| 1001 | unauthorized / bad key | 401 |
| 1002 | profile not found | 404 |
| 1003 | profile already running | 409 |
| 1004 | profile not running | 409 |
| 1005 | engine/launch failure | 500 |
| 1006 | proxy test failed | 502 |
| 1007 | rate limited | 429 |

### 1.10 Rate limits (local API)

Per-key, per-endpoint token buckets are ⬜ planned (called out as a follow-up in
`local_api.rs`). Target defaults (loopback, so generous):

| Endpoint | Limit (target) |
|---|---|
| `profile/start` | 30 / min / key |
| `profile/stop` | 60 / min / key |
| `profile/list`,`status`,`health` | 300 / min / key |
| `proxy/test` | 20 / min / key |

Over-limit → HTTP `429`, `code 1007`, header `Retry-After: <seconds>`.

### 1.11 Connect recipes

**Playwright (Node):**
```js
const res = await fetch('http://127.0.0.1:53211/api/v1/profile/start', {
  method: 'POST',
  headers: { authorization: 'Bearer lb_live_…', 'content-type': 'application/json' },
  body: JSON.stringify({ profileId }),
}).then(r => r.json());
const browser = await chromium.connectOverCDP(res.data.ws);
const page = (await browser.contexts())[0].pages()[0] ?? await browser.newPage();
```

**Puppeteer (Node):**
```js
const browser = await puppeteer.connect({ browserWSEndpoint: res.data.ws });
```

**Selenium (Python):**
```python
from selenium import webdriver
opts = webdriver.ChromeOptions()
opts.debugger_address = data["debuggerAddress"]   # "127.0.0.1:49812"
driver = webdriver.Chrome(options=opts)
```

**Playwright (Python):**
```python
browser = playwright.chromium.connect_over_cdp(data["ws"])
```

---

# Part 2 — Cloud REST API (Lobster SaaS)

**Host process:** NestJS backend (`apps/backend`). **Default port:** `8080` (`PORT`).
**Transport:** HTTPS in production. **Envelope:** the same `{ code, data, msg }`.

> **Base path — honest note:** the backend does **not** set a global route prefix today
> (`main.ts` has no `setGlobalPrefix`), so live routes are `/auth/register`, `/profiles`, etc.
> This spec documents them **without** a version prefix to match the code, and recommends adopting
> `/v1` (see §5 Versioning) before public launch. Where a route is ⬜ planned it is marked as such.

### 2.1 Authentication model

- **Bearer JWT.** `POST /auth/login` and `/auth/register` return `{ user, token }`; send the token as
  `Authorization: Bearer <jwt>` on every protected route. ✅
- **Token:** HS256, TTL **7 days** (`TOKEN_TTL` in `auth.service.ts`), claims `{ sub, email }`.
  Signing secret via `JWT_SECRET` (hard-fails in prod when unset). ✅
- **Refresh tokens / rotation** (`/auth/refresh`) — ⬜ planned (7-day access token only today).
- **2FA (TOTP)** — ⬜ planned (`/auth/2fa/*`, §2.4).
- **Programmatic API keys** for server-to-server (distinct from JWT) — model exists in Prisma +
  `shared-types`; management endpoints ⬜ planned (§2.9).
- **CORS:** allowlist from `CORS_ORIGINS` (default `localhost:5173`, `localhost:3000`,
  `tauri://localhost`); credentialed, never reflect-all. ✅

### 2.2 Standard error shape

Nest exceptions are mapped to HTTP status; the body keeps the envelope. Global `ValidationPipe`
(`whitelist + forbidNonWhitelisted + transform`) rejects unknown/invalid fields with `400`.

| HTTP | When | Example `msg` |
|---|---|---|
| 400 | Validation failure (bad/extra field) | `email must be an email` |
| 401 | Missing/invalid/expired JWT | `Unauthorized` |
| 403 | Authenticated but not permitted (wrong team/role/plan cap) | `you are not a member of the requested team` |
| 404 | Resource not found / not visible to caller | `profile not found` |
| 409 | Conflict (dup email, stale `baseVersion`) | `email already registered`, `stale base version` |
| 429 | Rate limited (⬜ planned) | `too many requests` |
| 500 | Unexpected server error | `internal server error` |

```jsonc
// canonical error body
{ "code": 1, "data": null, "msg": "profile not found" }
```

### 2.3 Auth — register / login / me

| Method | Path | Auth | Body | Status |
|---|---|---|---|---|
| `POST` | `/auth/register` | none | `RegisterDto` | ✅ done |
| `POST` | `/auth/login` | none | `LoginDto` | ✅ done |
| `GET`  | `/auth/me` | Bearer | — | ✅ done |
| `POST` | `/auth/refresh` | refresh token | `{ refreshToken }` | ⬜ planned |
| `POST` | `/auth/logout` | Bearer | — | ⬜ planned |

**`POST /auth/register`** — creates the user, a **personal team**, and an **admin** membership.
```jsonc
// body (RegisterDto): password 8–128 chars, displayName ≤ 80, optional
{ "email": "dev@example.com", "password": "hunter2hunter2", "displayName": "Dev" }
// data (AuthResult)
{ "user": { "id": "u_…", "email": "dev@example.com", "displayName": "Dev",
            "createdAt": "2026-07-02T…Z" },
  "token": "eyJ…" }
```
Errors: `400` invalid body; `409 email already registered`.

**`POST /auth/login`** — `{ "email", "password" }` → same `AuthResult`. `401 invalid email or password`
(generic on purpose — never leaks which half was wrong). Returns HTTP `200`.

**`GET /auth/me`** — returns the current `User` (password hash already stripped). `401` when the token
is missing/expired or the user no longer exists.

### 2.4 Auth — 2FA (⬜ planned)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/2fa/setup` | Return a TOTP secret + `otpauth://` URI + QR |
| `POST` | `/auth/2fa/enable` | Verify a code, activate 2FA, return recovery codes |
| `POST` | `/auth/2fa/verify` | Second-factor step during login (returns the full JWT) |
| `POST` | `/auth/2fa/disable` | Turn off 2FA (requires a fresh code) |

Login flow when 2FA is on: `/auth/login` returns `{ "mfaRequired": true, "mfaToken": "…" }` (short-
lived), then `/auth/2fa/verify` `{ "mfaToken", "code" }` returns the real `AuthResult`.

### 2.5 Teams, members & roles ✅

Roles: **`admin`** | **`member`** (`shared-types` `Role`). Identity always from the JWT
(`@CurrentUser()`), never the body. Membership/role enforced in `TeamsService`.

| Method | Path | Auth | Role req | Purpose | Status |
|---|---|---|---|---|---|
| `POST` | `/teams` | Bearer | — | Create a team (caller becomes admin) | ✅ |
| `GET`  | `/teams` | Bearer | member | Teams the caller belongs to | ✅ |
| `POST` | `/teams/:teamId/members` | Bearer | admin | Invite an existing user by email | ✅ |
| `GET`  | `/teams/:teamId/members` | Bearer | member | List members | ✅ |
| `PATCH`| `/teams/:teamId/members/:userId/role` | Bearer | admin | Change a member's role | ✅ |
| `DELETE`| `/teams/:teamId/members/:userId` | Bearer | admin | Remove a member | ⬜ planned |

**Create team** — body `{ "name": "Growth" }` (≤ 80) → `Team`
`{ "id", "name", "ownerUserId", "createdAt" }`.

**Invite member** — body `{ "email": "teammate@example.com", "role": "member" }` → `Membership`
`{ "userId", "teamId", "role", "createdAt" }`. `403` if caller isn't admin; `404` if email unknown.
(Invite is currently **link-existing-user**; email-invite-to-signup is ⬜ planned.)

**Set role** — body `{ "role": "admin" }` → updated `Membership`.

### 2.6 Profiles — CRUD ✅

Every route requires JWT. Team is resolved from the caller's membership or an explicit
`?teamId=<id>` they belong to. Create is gated by the plan's profile limit (§2.11).

| Method | Path | Query | Body | Status |
|---|---|---|---|---|
| `POST` | `/profiles` | `teamId?` | `CreateProfileDto` | ✅ |
| `GET`  | `/profiles` | `teamId?` | — | ✅ |
| `GET`  | `/profiles/:id` | `teamId?` | — | ✅ |
| `PATCH`| `/profiles/:id` | `teamId?` | `UpdateProfileDto` | ✅ |
| `DELETE`| `/profiles/:id` | `teamId?` | — | ✅ |
| `POST` | `/profiles/:id/sync` | `teamId?` | `SyncProfileDto` | ✅ |
| `GET`  | `/profiles/:id/versions` | `teamId?` | — | ⬜ planned |
| `POST` | `/profiles/bulk` | `teamId?` | `{ template, count }` | ⬜ planned |
| `POST` | `/profiles/:id/clone` | `teamId?` | `{ name? }` | ⬜ planned |
| `POST` | `/profiles/:id/share` | `teamId?` | `ProfileSharing` | ⬜ planned |

**`CreateProfileDto`** (validated against `ENGINE_KINDS`/`OS_FAMILIES` — production accepts `lobium`
only):
| Field | Type | Req | Rule |
|---|---|---|---|
| `name` | string | ✅ | ≤ 120 |
| `engine` | `"lobium"` | ✅ | production engine; compatibility code may read legacy `chromium` rows but must not launch them |
| `os` | `"windows"\|"macos"\|"linux"` | ✅ | in `OS_FAMILIES` |
| `fingerprintSeed` | string | ⬜ | omit → server mints a random 128-bit hex seed |
| `fingerprintOverrides` | object | ⬜ | opaque JSON (deep validation in `@lobster/fingerprint`) |
| `tags` | string[] | ⬜ | |
| `folder` | string | ⬜ | |
| `notes` | string | ⬜ | |

```jsonc
// POST /profiles  → data: Profile
{
  "id": "p_…", "name": "US-affiliate-01",
  "engine": "lobium", "os": "windows",
  "fingerprintSeed": "9f2c…", "fingerprintOverrides": { "timezone": "America/New_York" },
  "proxy": { "id": "px_…", "type": "socks5", "host": "1.2.3.4", "port": 1080 },
  "tags": ["affiliate"], "folder": "US", "notes": "",
  "status": "idle", "ownerTeamId": "t_…",
  "sharing": { "visibleToRoles": ["admin","member"] },
  "createdAt": "2026-07-02T…Z", "updatedAt": "2026-07-02T…Z"
}
```

**`UpdateProfileDto`** — partial; `name/engine/os/fingerprintOverrides/tags/folder/notes` editable.
**`fingerprintSeed` is intentionally immutable** (the seed *is* the identity; changing it silently
swaps the whole fingerprint — create a new profile instead).

**`DELETE /profiles/:id`** → `{ "id", "deleted": true }`. (Blob deletion from S3 is a ⬜ TODO.)

### 2.7 Profiles — encrypted blob sync ✅

The desktop agent encrypts the profile payload (cookies, storage, user-data-dir snapshot)
**client-side** with its own AES key; the server stores **opaque bytes** + a per-profile integer
version and never sees plaintext.

**`POST /profiles/:id/sync`** — body `SyncProfileDto`:
| Field | Type | Req | Notes |
|---|---|---|---|
| `direction` | `"push"\|"pull"` | ⬜ | default `"push"` |
| `payload` | base64 string | push only | client-encrypted blob |
| `baseVersion` | int ≥ 0 | ⬜ | supply on push → optimistic-concurrency check |

**Push** (`data: SyncResult`):
```json
{ "profileId": "p_…", "direction": "push",
  "blobRef": "s3://lobster-profiles/t_…/p_…/3.enc", "version": 3,
  "syncedAt": "2026-07-02T…Z" }
```
- `baseVersion` present and ≠ current stored version → `409 stale base version` (pull, re-apply, retry).
- Each successful push bumps `version` by 1.

**Pull** (`payload` carries the latest blob base64; `null`/version 0 when never synced):
```json
{ "profileId": "p_…", "direction": "pull",
  "blobRef": "s3://lobster-profiles/t_…/p_…/3.enc", "version": 3,
  "payload": "BASE64…", "syncedAt": "2026-07-02T…Z" }
```

**`GET /profiles/:id/versions`** (⬜ planned) → history for rollback:
```json
{ "code": 0, "data": [ { "version": 3, "blobRef": "s3://…/3.enc", "size": 40213, "createdAt": "…Z" } ], "msg": "success" }
```

### 2.8 Proxies (⬜ planned)

A proxy store + test endpoint at the cloud tier (the desktop agent already tests locally via
`@lobster/proxy`; this brings shared/team proxies to the SaaS). Types: `http`/`https`/`socks5`.

| Method | Path | Body | Purpose |
|---|---|---|---|
| `POST` | `/proxies` | `ProxyConfig` (no id) | Add a team proxy |
| `GET`  | `/proxies` | — | List team proxies |
| `GET`  | `/proxies/:id` | — | Fetch one |
| `PATCH`| `/proxies/:id` | partial | Edit |
| `DELETE`| `/proxies/:id` | — | Remove |
| `POST` | `/proxies/:id/test` | — | Live test → `ProxyTestResult` (geo/latency) |

`ProxyConfig`: `{ id, type, host, port, username?, password?, label? }`.
`ProxyTestResult`: `{ ok, latencyMs?, geo?: GeoInfo, error? }` where `GeoInfo` carries
`{ ip, countryCode, region?, city?, timezone, latitude?, longitude?, asn?, isDatacenter? }` —
the coherence source of truth for timezone/locale auto-sync.

### 2.9 API keys (✅ done — T-021; scopes/rotation/rate-limit still planned)

Programmatic keys for the local + cloud APIs. Prisma `ApiKey` + `shared-types.ApiKey` exist; the
secret is shown **once** at creation and stored only as a hash; only the `prefix` is displayable.

| Method | Path | Role | Purpose |
|---|---|---|---|
| `POST` | `/api-keys` | admin | Mint a key → returns the full secret **once** |
| `GET`  | `/api-keys` | member | List keys (prefix + metadata only) |
| `DELETE`| `/api-keys/:id` | admin | Revoke |

```jsonc
// POST /api-keys  body { "name": "ci-runner" }
// data (secret returned ONCE):
{ "id": "k_…", "name": "ci-runner", "prefix": "lb_live_ab12",
  "secret": "lb_live_ab12_9f83…FULL", "teamId": "t_…", "createdAt": "…Z" }
// GET /api-keys  → secret never returned again:
[ { "id": "k_…", "name": "ci-runner", "prefix": "lb_live_ab12",
    "teamId": "t_…", "createdAt": "…Z", "lastUsedAt": "…Z" } ]
```
Key format: `lb_<live|test>_<prefix4>_<secret>`. The `prefix` is the safe-to-log identifier.

### 2.10 Billing 🟡

Stripe-backed, **metered on profile count**: a team's `Subscription.profileLimit` caps how many
profiles it can hold. Tiers (`PlanTier`): `free` | `pro` | `team` | `enterprise`.

| Method | Path | Auth | Body | Status |
|---|---|---|---|---|
| `POST` | `/billing/checkout` | Bearer* | `{ teamId, tier }` | 🟡 stub |
| `POST` | `/billing/webhook` | Stripe sig | raw body | 🟡 stub |
| `POST` | `/billing/portal` | Bearer | `{ teamId }` | ⬜ planned |
| `GET`  | `/billing/subscription` | Bearer | — | ⬜ planned |

\* checkout currently takes `teamId` in the body; deriving it from the JWT is a ⬜ TODO.

**`POST /billing/checkout`** — creates a Stripe Checkout session; client redirects to `url`.
```jsonc
// body
{ "teamId": "t_…", "tier": "pro" }
// data (CheckoutSession) — stubbed URL today
{ "sessionId": "cs_…", "url": "https://checkout.stripe.com/…" }
```

**`POST /billing/webhook`** — Stripe → us. **Raw body** + `Stripe-Signature` header; replies plain
`200 { "received": true, "handled": bool }` (not our envelope — the caller is Stripe). Verified with
`STRIPE_WEBHOOK_SECRET`. Handled events (target): `checkout.session.completed` (activate tier +
`profileLimit`), `customer.subscription.updated` (sync status/tier), `customer.subscription.deleted`
(downgrade to free). Signature verification + a raw-body parser for this route are ⬜ Day 2 TODOs.

`Subscription` shape: `{ teamId, tier, profileLimit, stripeCustomerId?, status }`,
`status ∈ active|past_due|canceled|trialing`.

### 2.11 Plan enforcement (profile cap) ✅

`ProfilesService.assertUnderPlanLimit` reads the team's `Subscription.profileLimit` (default free =
**5**, matching `schema.prisma`) and rejects creates at capacity with
`403 profile limit (N) reached for this team; upgrade the plan to add more`.

### 2.12 Audit / action logs (✅ done — T-022; `GET /audit` cursor feed; `/audit/:id` still planned)

Immutable trail of profile/team/API/billing actions.

| Method | Path | Role | Purpose |
|---|---|---|---|
| `GET` | `/audit` | admin | List events (filter + paginate) |
| `GET` | `/audit/:id` | admin | One event |

Event: `{ id, teamId, actorUserId, action, targetType, targetId, metadata, ip, ts }`.
Actions e.g. `profile.created`, `profile.synced`, `member.invited`, `role.changed`,
`apikey.created`, `billing.subscription.updated`. Query: `?action=&actorUserId=&from=&to=&cursor=&limit=`.

### 2.13 Usage / metering (⬜ planned)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/usage` | Current team usage vs plan caps |
| `GET` | `/usage/history` | Time-series (profiles, API calls, launches) |

```jsonc
// GET /usage
{ "teamId": "t_…", "period": "2026-07",
  "profiles": { "used": 4, "limit": 5 },
  "apiCalls": { "used": 12043, "limit": 100000 },
  "launches": { "used": 318 } }
```

### 2.14 Pagination, filtering, sorting (cloud collections)

List endpoints today (`/teams`, `/profiles`, `/teams/:id/members`) return **full arrays** (small,
team-scoped). Before scale, adopt **cursor pagination** (⬜ planned), uniformly:

- Query: `?limit=<1..100, default 50>&cursor=<opaque>&sort=<field>&order=asc|desc` plus per-resource
  filters (`?tags=`, `?folder=`, `?engine=`, `?q=` for profiles).
- Response `data` becomes:
```jsonc
{ "items": [ /* … */ ], "nextCursor": "eyJ…" | null, "hasMore": true }
```
Cursors are opaque, forward-only, and encode the sort key + tiebreaker id.

### 2.15 Idempotency & rate limits (cloud)

- **Idempotency:** send `Idempotency-Key: <uuid>` on `POST /profiles`, `/billing/checkout`,
  `/api-keys` (⬜ planned) — the server returns the original result for a repeated key for 24h.
  Blob push already has optimistic concurrency via `baseVersion` ✅.
- **Rate limits (⬜ planned)**, per authenticated principal (JWT sub or API key), sliding window:

| Group | Limit (target) |
|---|---|
| `/auth/*` (login/register) | 10 / min / IP |
| Read (`GET`) | 600 / min / principal |
| Write (`POST/PATCH/DELETE`) | 120 / min / principal |
| `/profiles/:id/sync` | 60 / min / principal |
| `/billing/webhook` | unlimited (Stripe; signature-gated) |

Over-limit → `429`, envelope `code 1`, headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset`, `Retry-After`.

---

# Part 3 — Webhooks

### 3.1 Inbound — Stripe → Lobster 🟡

`POST /billing/webhook` (§2.10). Raw body + `Stripe-Signature`; verified with
`STRIPE_WEBHOOK_SECRET`; plain `200` ack. This is the only inbound webhook today.

### 3.2 Outbound — Lobster → customer endpoints (⬜ planned)

Let teams subscribe their own systems to Lobster events.

**Management**
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/webhooks` | Register `{ url, events[], secret? }` |
| `GET`  | `/webhooks` | List endpoints |
| `DELETE`| `/webhooks/:id` | Remove |
| `POST` | `/webhooks/:id/test` | Send a `ping` event |

**Event catalogue**
| Event | Fires when |
|---|---|
| `profile.created` / `profile.updated` / `profile.deleted` | Profile CRUD |
| `profile.synced` | A blob push bumps the version |
| `profile.started` / `profile.stopped` | Local agent runtime transitions (relayed) |
| `member.invited` / `role.changed` / `member.removed` | Team membership changes |
| `subscription.updated` | Tier/status change from billing |
| `apikey.created` / `apikey.revoked` | Key lifecycle |

**Delivery envelope** (POSTed to the subscriber):
```jsonc
{ "id": "evt_…", "type": "profile.synced", "createdAt": "2026-07-02T…Z",
  "teamId": "t_…", "data": { /* resource snapshot */ } }
```

**Signature.** Header `Lobster-Signature: t=<unix>,v1=<hex>` where
`v1 = HMAC_SHA256(secret, "<t>.<rawBody>")` (Stripe-style). Reject if `|now - t| > 5 min` or the HMAC
mismatches. **Retries:** exponential backoff (e.g. 1m, 5m, 30m, 2h, 6h) up to ~24h; endpoints
auto-disabled after sustained failures. Consumers should be **idempotent** on `event.id`.

---

# Part 4 — SDKs

### 4.1 Current surface (local API only)

Shipping today under `packages/local-api-sdk` — thin, dependency-light clients over the **local**
automation API (not the cloud API yet).

**JavaScript** (`js/index.js`, ESM) ✅
```js
import { LobsterClient } from '@lobster/local-api-sdk';
const client = new LobsterClient({ port: 53211, apiKey: 'lb_live_…' });
const { ws, debuggerAddress } = await client.start('profile-id');
const browser = await chromium.connectOverCDP(ws);
await client.stop('profile-id');
// also: client.status(id), client.list()
```
Methods: `start(profileId)`, `stop(profileId)`, `status(profileId)`, `list()`. Throws on `code !== 0`.

**Python** (`python/lobster_client.py`, stdlib-only) ✅
```python
from lobster_client import LobsterClient
client = LobsterClient(api_key="lb_live_…", port=53211)
data = client.start("profile-id")            # {"ws": ..., "debuggerAddress": ...}
# Selenium: opts.debugger_address = data["debuggerAddress"]
# Playwright: playwright.chromium.connect_over_cdp(data["ws"])
client.stop("profile-id")
```
Methods: `start(profile_id, headless=False)`, `stop`, `status`, `list`. Raises `LobsterApiError`.

### 4.2 Official SDKs — target surface (⬜ planned)

Richer, published clients that cover **both** APIs with retries, typed models, and pagination.

| Lang | Package | Covers | Status |
|---|---|---|---|
| Python | `lobster-browser` (PyPI) | local + cloud, typed, retries | ⬜ planned |
| JS/TS | `@lobster/sdk` (npm) | local + cloud, typed, retries | ⬜ planned |
| C# | `Lobster.Sdk` (NuGet) | local + cloud | ⬜ planned |

**Shared design:** `code !== 0` → typed exception (`LobsterApiError { code, msg }`); auto-retry on
`429`/`5xx` with backoff honoring `Retry-After`; cloud client carries the JWT and refreshes it
(when refresh lands); cursor iteration helpers for list endpoints.

**Target C# sketch**
```csharp
var client = new LobsterClient(new() { ApiKey = "lb_live_…", Port = 53211 });
var res = await client.Profiles.StartAsync("profile-id");
// res.Ws → connectOverCDP;  res.DebuggerAddress → Selenium
await client.Profiles.StopAsync("profile-id");
```
**Target cloud (TS)**
```ts
const cloud = new LobsterCloud({ token });
const { items, nextCursor } = await cloud.profiles.list({ teamId, tags: ['affiliate'] });
await cloud.profiles.sync(id, { direction: 'push', payload, baseVersion });
```

---

# Part 5 — MCP Server (for AI agents) ⬜ planned

A **Model Context Protocol** server wrapping the **local** automation API so AI agents (Claude, and
any MCP-capable client) can drive Lobster profiles as first-class tools. It runs alongside the
desktop agent, holds the `LOBSTER_API_KEY`, and exposes typed tools over stdio/SSE. (Called out as a
Phase-2 item in the local-API contract and the MASTER_PLAN roadmap.)

**Exposed tools** (map 1:1 to §1 endpoints + light ergonomics):
| Tool | Args | Returns | Backed by |
|---|---|---|---|
| `lobster_list_profiles` | — | `[{ profileId, name, running }]` | `GET /profile/list` |
| `lobster_start_profile` | `{ profileId, headless?, password? }` | `{ ws, debuggerAddress, pid }` | `POST /profile/start` |
| `lobster_stop_profile` | `{ profileId }` | `{ stopped }` | `POST /profile/stop` |
| `lobster_profile_status` | `{ profileId? }` | status object | `GET /profile/status` |
| `lobster_create_profile` | `CreateProfileInput` | `Profile` | `POST /profile/create` |
| `lobster_test_proxy` | `ProxyConfig` | `ProxyTestResult` | `POST /proxy/test` |
| `lobster_export_cookies` / `lobster_import_cookies` | `{ profileId, … }` | cookie set / ack | cookie routes |

**Design notes:** read-only tools (`list`, `status`) are annotated safe/idempotent; `start`/`stop`/
`create`/`delete` are annotated as side-effecting so agent hosts can gate them. The server surfaces
`{ code, msg }` errors as MCP tool errors verbatim. Auth is inherited from the local agent (loopback
+ `LOBSTER_API_KEY`); the MCP server never accepts remote connections.

**Agent recipe:** `lobster_start_profile` → hand `ws` to a Playwright-MCP / browser tool →
automate → `lobster_stop_profile`. This makes every Lobster profile a durable, fingerprint-coherent
identity an agent can pick up and put down.

---

# Part 6 — Versioning & deprecation policy

- **Local API:** path-versioned at `/api/v1`. ✅ Breaking changes ship under `/api/v2` with `v1`
  supported through a deprecation window; additive fields are non-breaking and may land in `v1`.
- **Cloud API:** no prefix today (honest note in §2). **Target:** adopt `/v1` before public launch;
  same path-version policy as the local API. New optional fields are backward-compatible; removing
  or renaming a field, or changing a type/semantics, is breaking and requires a new version.
- **Deprecation window:** ≥ **90 days** for a documented breaking change. Deprecated routes return a
  `Deprecation: true` + `Sunset: <date>` header (⬜ planned) and are announced in the changelog.
- **Envelope stability:** the `{ code, data, msg }` contract and `code === 0 = success` are **frozen**
  across versions — SDKs and third-party integrations depend on it.
- **Error-code stability:** once assigned, a numeric `code` (§1.9) keeps its meaning; new conditions
  get new codes rather than reusing old ones.
- **SDK semver:** SDK majors track API majors; a `v1` SDK targets `/v1`.

---

## Status vs target

**Live today (✅):** the four local `profile/*` runtime routes + `health`; the cloud
`auth` (register/login/me), `teams` (create/list/invite/list-members/set-role),
`profiles` full CRUD + encrypted `sync` (push/pull with optimistic concurrency), plan-cap
enforcement, `health`; the shared `{ code, data, msg }` envelope everywhere; and the two minimal
local-API SDKs (JS + Python). The Prisma models for `ApiKey`, `Subscription`, `Membership`, etc. are
in place.

**Partial (🟡):** billing — `checkout` and `webhook` exist as **stubs** (fake Checkout URL,
unverified webhook, `teamId` from body); Stripe wiring, signature verification, and raw-body parsing
are the immediate next steps. Local API auth is a single-key exact-match with a dev-open fallback.

**Planned (⬜):** local profile CRUD / proxy-test / cookie import-export / WS over HTTP; fine-grained
local error codes + rate limits; cloud `/auth/refresh` + 2FA, `proxies`, `api-keys` management,
`billing/portal` + `subscription`, `audit`, `usage`; cursor pagination + filtering; idempotency keys
and cloud rate limits; the `/v1` cloud prefix; outbound webhooks with HMAC signatures; the official
typed Py/JS/C# SDKs; and the MCP server.

This is the AdsPower/Octo-compatible surface a serious integrator expects — the runtime and data-plane
core is real and drivable end-to-end today; the management, metering, and agent-ergonomics layers are
specified above and land on the tracks in the MASTER_PLAN.
