# Data Model — Lobster Browser

> **Scope:** the full persistence model for Lobster Browser — the cloud Postgres schema, the local
> desktop SQLite schema, how the two reconcile, where the encryption boundaries sit, the data
> lifecycle (retention / soft-delete / export / GDPR deletion), and the migration strategy.
> **Audience:** both agents (Claude + Codex) building the backend, the desktop core, and sync.
> **Relationship to other docs:** this is the detailed spec under §4 Pillar 4 and §9 S7 of
> `docs/MASTER_PLAN.md`. It refines the domain contracts in `@lobster/shared-types` and the current
> Prisma schema (`apps/backend/prisma/schema.prisma`) + local store
> (`apps/desktop/src-tauri/src/profile_store.rs`).
> **Status convention:** every entity and column is tagged **done** (in code today), **partial**
> (a subset exists — narrower than this spec), or **planned** (specced here, not yet built).

---

## 0. Design principles

1. **Team is the ownership unit.** Every user-owned resource (profile, api key, subscription, audit
   entry) hangs off a `Team`, never directly off a `User`. Every user gets a personal team at
   register time (`AuthService.register`), so "solo user" is just "team of one". *(done)*
2. **The server is zero-knowledge about profile payloads.** Postgres stores profile *metadata* and a
   *reference* to a client-encrypted blob; the plaintext cookies/storage/user-data-dir never touch
   the server. The desktop agent holds the AES key. *(done — `Profile.encryptedBlobRef` + `BlobStore`)*
3. **Deterministic fingerprints, not stored fingerprints.** A profile persists a `fingerprintSeed`
   (128-bit hex) plus small user `overrides`; the full 50+ param fingerprint is *derived* from the
   seed by the fingerprint engine, never materialized as a row. This keeps the DB small and the
   fingerprint reproducible on any machine. *(done)*
4. **Offline-first desktop.** The desktop SQLite catalog is the source of truth for *launching*;
   cloud is the source of truth for *sharing + backup*. Sync reconciles them. *(partial — local store
   done, sync client planned)*
5. **Additive, reversible migrations.** Prisma Migrate with immutable, ordered SQL migrations; no
   destructive change without a paired backfill. *(partial — one migration exists)*
6. **Soft-delete before hard-delete.** User-facing deletes are soft (tombstone) so sync can propagate
   the deletion and so a GDPR/export window exists; a scheduled job hard-deletes after retention.
   *(planned)*

---

## 1. Entity–relationship overview

```
                         ┌───────────┐
                         │   User    │  (global identity, email-unique)
                         └─────┬─────┘
                owns (1) ┌─────┴──────────────┐ member-of (M:N via Membership)
                         ▼                    ▼
                   ┌───────────┐        ┌────────────┐
                   │   Team    │◄───────┤ Membership │──► User
                   │  (tenant) │  1   M │ (role)     │
                   └─────┬─────┘        └────────────┘
        ┌────────┬───────┼─────────┬──────────┬───────────┬──────────────┐
        ▼        ▼       ▼         ▼          ▼           ▼              ▼
  ┌─────────┐┌───────┐┌───────┐┌────────┐┌──────────┐┌───────────┐┌──────────────┐
  │ Profile ││ApiKey ││ Proxy ││Invita- ││Subscrip- ││ AuditLog  ││WebhookEndpoint│
  │         ││       ││       ││ tion   ││ tion(1:1)││           ││              │
  └────┬────┘└───────┘└───┬───┘└────────┘└────┬─────┘└───────────┘└──────────────┘
       │ 1                │ referenced-by       │ 1
       │                  │ Profile.proxyId     ▼
       ▼ M                ▼               ┌───────────┐
  ┌──────────┐      (Profile.proxyId)     │UsageMeter │ (M per team, per metric/period)
  │BlobVersion│                           └───────────┘
  │(encrypted)│
  └──────────┘

  ┌───────────┐        ┌──────────┐
  │  Session  │──► User │  Device  │──► User / Team   (auth + device registry)
  └───────────┘        └──────────┘

  FingerprintConfig = { Profile.fingerprintSeed + Profile.fingerprintOverrides (JSON) }
                      — NOT a separate table; derived by the fingerprint engine.
```

**Cardinalities**

| Relationship | Type | Notes |
|---|---|---|
| User → Team (owner) | 1 : M | `Team.ownerUserId`. A user may own several teams. |
| User ↔ Team | M : N | via `Membership` (composite PK `userId,teamId`). |
| Team → Profile | 1 : M | `Profile.ownerTeamId`, cascade delete. |
| Team → ApiKey | 1 : M | cascade delete. |
| Team → Proxy | 1 : M | *(planned)* proxies are team-scoped, reusable across profiles. |
| Profile → Proxy | M : 1 (optional) | `Profile.proxyId` references a `Proxy`, or proxy is inline in blob. |
| Team → Invitation | 1 : M | *(planned)* pending email invites. |
| Team → Subscription | 1 : 1 | `Subscription.teamId` is PK. |
| Team → UsageMeter | 1 : M | *(planned)* one row per (metric, period). |
| Profile → BlobVersion | 1 : M | *(planned as table)* today: a single `encryptedBlobRef` + versions in the blob store. |
| Team → AuditLog | 1 : M | *(planned)* append-only. |
| User → Session | 1 : M | *(planned)* today JWT is stateless (7-day TTL). |
| User/Team → Device | 1 : M | *(planned)* registered desktop installs. |
| Team → WebhookEndpoint | 1 : M | *(planned)* outbound event delivery. |

---

## 2. Cloud Postgres schema (backend)

Conventions used below:

- **PKs** are `TEXT` UUIDv4 (`@default(uuid())`) except join/1:1 tables that use natural composite or
  FK-as-PK. IDs may carry a type prefix in application code (e.g. `prf_…`, `lb_live_…`) but are stored
  as plain text.
- **Timestamps** are `TIMESTAMP(3)` (Prisma `DateTime`), UTC. `createdAt @default(now())`,
  `updatedAt @updatedAt`.
- **Soft-delete** columns are `deletedAt TIMESTAMP(3) NULL` (planned across user-owned tables).
- All FKs to `Team`/`User` are `ON DELETE CASCADE` unless noted (team deletion removes its resources).

### 2.1 `users` — global identity *(done)*

| Column | Type | Key / Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK | UUIDv4. |
| `email` | TEXT | UNIQUE (`users_email_key`) | Stored trimmed+lowercased (`AuthService.normalizeEmail`). |
| `displayName` | TEXT NULL | | Optional. |
| `passwordHash` | TEXT NULL | | bcrypt cost 10 (`BCRYPT_COST`). **Backend-only; never serialized to the client** (`toPublicUser` strips it). Null allows future OAuth/OTP-only accounts. |
| `createdAt` | TIMESTAMP(3) | DEFAULT now() | |
| `deletedAt` | TIMESTAMP(3) NULL | | *(planned)* soft-delete tombstone. |
| `emailVerifiedAt` | TIMESTAMP(3) NULL | | *(planned)* email/OTP verification. |
| `mfaSecret` | TEXT NULL | | *(planned)* TOTP secret, encrypted at rest. |

**Relations:** `ownedTeams Team[]` (as owner), `memberships Membership[]`.
**Indexes:** unique on `email`. *(planned: partial index `WHERE deletedAt IS NULL`.)*

```sql
CREATE TABLE "users" (
  "id"            TEXT NOT NULL,
  "email"         TEXT NOT NULL,
  "displayName"   TEXT,
  "passwordHash"  TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- planned: "deletedAt" TIMESTAMP(3), "emailVerifiedAt" TIMESTAMP(3), "mfaSecret" TEXT,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
```

### 2.2 `teams` — tenant / ownership unit *(done)*

| Column | Type | Key / Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `name` | TEXT | | Personal team default: `"{displayName|email}'s Team"`. |
| `ownerUserId` | TEXT | FK → users.id, `ON DELETE RESTRICT` | Owner cannot be deleted while owning a team (must transfer first). |
| `createdAt` | TIMESTAMP(3) | DEFAULT now() | |
| `deletedAt` | TIMESTAMP(3) NULL | | *(planned)* |

**Indexes:** `teams_ownerUserId_idx`. **Relations:** memberships, profiles, apiKeys, subscription (1:1), proxies*(planned)*, invitations*(planned)*, auditLogs*(planned)*, usageMeters*(planned)*.

### 2.3 `memberships` — user ↔ team join with role *(done)*

| Column | Type | Key / Constraint | Notes |
|---|---|---|---|
| `userId` | TEXT | PK part, FK → users.id CASCADE | |
| `teamId` | TEXT | PK part, FK → teams.id CASCADE | |
| `role` | `Role` enum | DEFAULT `member` | `admin` \| `member`. |
| `createdAt` | TIMESTAMP(3) | DEFAULT now() | |

**PK:** `(userId, teamId)`. **Index:** `memberships_teamId_idx` (list members of a team).
**Authz:** listing members requires membership; invite + role change require `admin` (`TeamsService`).
**Planned granular RBAC** (MASTER_PLAN §11.4) would add `permissions JSONB` and tag-scoping here or in
a sibling `MembershipScope` table.

### 2.4 `invitations` — pending email invites *(planned)*

Today `TeamsService.inviteMember` only works for **already-registered** users (looks up by email,
409 if already a member). This table adds true pending invites for non-registered emails.

| Column | Type | Key / Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `teamId` | TEXT | FK → teams.id CASCADE, INDEX | |
| `email` | TEXT | INDEX (normalized) | Invitee, may not yet have a `User`. |
| `role` | `Role` enum | DEFAULT `member` | Role granted on accept. |
| `token` | TEXT | UNIQUE | Opaque, high-entropy; sent in the invite link; **stored hashed**. |
| `invitedByUserId` | TEXT | FK → users.id | Actor (admin). |
| `status` | `InvitationStatus` enum | DEFAULT `pending` | `pending` \| `accepted` \| `revoked` \| `expired`. |
| `expiresAt` | TIMESTAMP(3) | | e.g. now()+7d. |
| `acceptedAt` | TIMESTAMP(3) NULL | | Set on accept → creates a `Membership`. |
| `createdAt` | TIMESTAMP(3) | DEFAULT now() | |

**Constraint:** partial unique `(teamId, email) WHERE status = 'pending'` — one live invite per email
per team.

### 2.5 `profiles` — profile metadata (no secrets) *(done, extended fields planned)*

Only metadata + the deterministic seed + a reference to the encrypted blob live here. Secrets
(cookies/storage/user-data-dir) are in the client-encrypted blob (§4).

| Column | Type | Key / Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK | App-level prefix `prf_…` (local store) / bare UUID (backend). |
| `name` | TEXT | | |
| `fingerprintSeed` | TEXT | NOT NULL | Lowercase hex, 128-bit. Immutable after creation. Unique per profile (never a shared constant — enforced in service layer, not a DB constraint). |
| `encryptedBlobRef` | TEXT NULL | | S3 object key / URI of the client-encrypted blob; null until first sync push. |
| `metadata` | JSONB | DEFAULT `'{}'` | Non-indexed shared-types fields: `engine`, `os`, `tags`, `folder`, `notes`, `sharing`, `fingerprintOverrides`, inline `proxy`. See §2.5.1. |
| `ownerTeamId` | TEXT | FK → teams.id CASCADE, INDEX | Maps to shared-types `Profile.ownerTeamId`. |
| `createdAt` | TIMESTAMP(3) | DEFAULT now() | |
| `updatedAt` | TIMESTAMP(3) | @updatedAt | |
| `engine` | TEXT | *(planned promote from metadata)* | `lobium` \| `chromium` — promote to a column to index/filter. |
| `os` | TEXT | *(planned promote)* | `windows` \| `macos` \| `linux`; Android planned in a separate mobile profile/runner model; iOS discarded. |
| `osVersion` | TEXT NULL | *(planned)* | Explicit OS/platform version selected by the profile wizard. |
| `status` | TEXT | *(planned)* | `idle` \| `launching` \| `running` \| `stopping` \| `error` — runtime status is really a **desktop/local** concern; cloud may keep a cached last-known value. |
| `proxyId` | TEXT NULL | FK → proxies.id, *(local done, cloud planned)* | Replaces inline proxy for shared/reusable proxies. |
| `templateId` | TEXT NULL | FK → profile_templates.id, *(local done, cloud planned)* | Records which template seeded the profile, if any. |
| `blobVersion` | INT | DEFAULT 0, *(planned)* | Denormalized current blob version (mirror of blob store head). |
| `deletedAt` | TIMESTAMP(3) NULL | *(planned)* | Soft-delete tombstone; sync propagates. |

**Indexes:** `profiles_ownerTeamId_idx`. *(planned: `(ownerTeamId, deletedAt)`, GIN on `metadata->'tags'` for tag search, `(ownerTeamId, folder)`.)*

#### 2.5.1 `Profile.metadata` JSON shape *(done — grab-bag)*

```jsonc
{
  "engine": "lobium",                   // EngineKind; production-only value
  "os": "windows",                      // OsFamily
  "osVersion": "Windows 11 23H2",        // optional explicit platform version
  "tags": ["us", "fb-ads"],             // string[]
  "folder": "Client A",                 // string | null
  "notes": "warm-up done 2026-06",      // string | null
  "templateId": "tpl_1",                // optional template source
  "sharing": { "visibleToRoles": ["admin", "member"] },  // ProfileSharing
  "fingerprintOverrides": {             // FingerprintOverrides — see §2.6
    "navigator": { "hardwareConcurrency": 8 },
    "screen": { "devicePixelRatio": 2 },
    "locale": { "timezone": "America/New_York" },
    "fonts": ["Arial", "Helvetica"],
    "webrtc": { "mode": "proxy" },
    "hardwareNoise": { "webgl": true, "canvas": true, "audio": true, "clientRects": false },
    "mediaDevices": { "cameras": 1, "microphones": 1, "speakers": 2 }
  },
  "proxy": {                            // inline ProxyConfig is still allowed for launch convenience
    "id": "px_1", "type": "socks5", "host": "…", "port": 1080,
    "username": "…", "password": "…", "label": "US residential"
  },
  "extensions": [
    { "source": "chromeWebStore", "url": "https://chromewebstore.google.com/detail/..." }
  ],
  "cookiesImport": { "source": "file", "format": "json", "status": "pending" }
}
```

> Note the **proxy password lives in `metadata` JSON today** — see §4.4 for the required fix (proxy
> credentials must move into the encrypted blob or a secret-scoped column; they are secrets).

### 2.6 FingerprintConfig — the 50+ param model *(done as seed+overrides; NOT a table)*

There is **no `fingerprint_configs` table**, and by design there should not be one for the derived
values. A profile's fingerprint is fully described by:

- **`fingerprintSeed`** (`Profile.fingerprintSeed`, TEXT hex) — the deterministic input, and
- **`fingerprintOverrides`** (`metadata.fingerprintOverrides` JSON) — user edits layered on top.

The fingerprint engine (`packages/fingerprint`, consuming `@lobster/shared-types`) expands
`seed → Fingerprint` deterministically, then applies overrides. The 50+ params are grouped as:

| Group (shared-types type) | Representative fields | Where enforced (MASTER_PLAN §5) |
|---|---|---|
| `NavigatorFingerprint` | `userAgent`, `platform`, `languages[]`, `hardwareConcurrency`, `deviceMemory`, `maxTouchPoints`, `uaBrands[]`, `uaPlatform`, `uaPlatformVersion`, `uaMobile`, `uaFullVersion` | native Lobium; CDP harness is internal/test-only |
| `ScreenFingerprint` | `width`, `height`, `availWidth`, `availHeight`, `colorDepth`, `devicePixelRatio` | native Lobium |
| `WebGlFingerprint` | `vendor`, `renderer`, `unmaskedVendor`, `unmaskedRenderer`, optional scalar `caps`, captured `extensions[]`, `shaderPrecision`, `version`, `shadingLanguageVersion` | native Lobium; host-calibration probe/consumption still pending |
| `LocaleFingerprint` | `timezone`, `locale`, `acceptLanguage`, `geolocation{lat,lon,accuracy}` | derived from proxy exit IP, consumed by native Lobium + network headers |
| `fonts` | `string[]` matched to OS | native Lobium |
| deep surfaces (not in override model) | canvas farbling, audio DSP hash, TLS/JA3/JA4, HTTP/2, WebRTC policy | **native only** (Lobium); never spoofed from JS |

**Persistence rule:** only the seed + `FingerprintOverrides` (a `Partial<>` of the above) are stored.
`FingerprintOverrides` = `Partial<{ navigator, screen, locale }>` + `fonts: string[]`. Deep surfaces
are intentionally **not** user-overridable (coherence guarantee).

The 2026-07-07 product UI requirements add new override/policy clusters that should be modeled before
their controls become enabled in the UI:

- `osVersion` / platform-version policy.
- `webgl` renderer policy and host-calibrated renderer mode.
- `webrtc` mode and leak policy.
- `hardwareNoise` for WebGL, canvas, audio, and client rects.
- `mediaDevices` counts and stable generated IDs.
- extension references and cookie import draft/result metadata.

> **If a future feature needs to pin exact resolved values** (e.g. imported real-device captures),
> add a `fingerprint_snapshots` table: `id, profileId FK, seed, resolvedConfig JSONB, source, createdAt`
> — but treat it as a cache, not the source of truth. *(planned, optional)*

### 2.7 `proxies` — team-scoped reusable proxies *(local done; cloud planned)*

Cloud profiles can still store an inline `ProxyConfig` in `Profile.metadata`. The desktop app now also
has a local `proxies` table and `Profile.proxyId`, which enables local reuse, testing history, and profile
assignment. Cloud/team-scoped proxies remain planned.

| Column | Type | Key / Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK | `px_…`. |
| `teamId` | TEXT | FK → teams.id CASCADE, INDEX | |
| `type` | `ProxyType` enum | | `http` \| `https` \| `socks5`. |
| `host` | TEXT | | |
| `port` | INT | | |
| `username` | TEXT NULL | | Credential — see §4.4 (must be secret-scoped/encrypted). |
| `passwordEnc` | BYTEA NULL | | **Encrypted** password (not plaintext). |
| `label` | TEXT NULL | | |
| `lastGeo` | JSONB NULL | | Cached `GeoInfo` from last test (ip, countryCode, timezone, asn, isDatacenter…). |
| `lastTestedAt` | TIMESTAMP(3) NULL | | |
| `lastLatencyMs` | INT NULL | | |
| `createdAt`/`updatedAt` | TIMESTAMP(3) | | |

**Index:** `proxies_teamId_idx`. **Coherence:** `lastGeo.timezone` is the source of truth for a
profile's timezone/locale cluster (MASTER_PLAN §5 rule).

### 2.8 `api_keys` — programmatic access *(done)*

| Column | Type | Key / Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `prefix` | TEXT | | Human-visible, e.g. `lb_live_ab12`. Safe to display. |
| `hashedKey` | TEXT | | Hash of the full secret (bcrypt/argon2 — real hashing Day 2). Plaintext shown **once** at creation. |
| `name` | TEXT | | Label. |
| `teamId` | TEXT | FK → teams.id CASCADE, INDEX | |
| `createdAt` | TIMESTAMP(3) | DEFAULT now() | |
| `lastUsedAt` | TIMESTAMP(3) NULL | | Updated on use (for rotation hygiene). |
| `scopes` | JSONB | *(planned)* | e.g. `["profiles:read","profiles:launch"]`. |
| `revokedAt` | TIMESTAMP(3) NULL | *(planned)* | Soft-revoke without deleting the audit trail. |
| `expiresAt` | TIMESTAMP(3) NULL | *(planned)* | Optional TTL. |

**Index:** `api_keys_teamId_idx`. *(planned: unique index on `prefix` for O(1) lookup on auth.)*
**Lookup on auth:** find by `prefix`, then `compare(secret, hashedKey)`.

### 2.9 `subscriptions` — billing state (1:1 team) *(done; usage table planned)*

| Column | Type | Key / Constraint | Notes |
|---|---|---|---|
| `teamId` | TEXT | **PK** + FK → teams.id CASCADE | One subscription per team. |
| `tier` | `PlanTier` enum | DEFAULT `free` | `free` \| `pro` \| `team` \| `enterprise`. |
| `profileLimit` | INT | DEFAULT 5 | Metered limit (must match `DEFAULT_FREE_PROFILE_LIMIT = 5`). |
| `status` | `SubscriptionStatus` enum | DEFAULT `trialing` | `active` \| `past_due` \| `canceled` \| `trialing`. |
| `stripeCustomerId` | TEXT NULL | | Stripe Customer. |
| `createdAt`/`updatedAt` | TIMESTAMP(3) | | |
| `stripeSubscriptionId` | TEXT NULL | *(planned)* | Stripe Subscription id. |
| `currentPeriodEnd` | TIMESTAMP(3) NULL | *(planned)* | Renewal boundary. |
| `seats` | INT | *(planned)* | For seat-based tiers. |

**Enforcement:** `ProfilesService.assertUnderPlanLimit` reads `profileLimit` (or default 5) and blocks
creation at capacity. *(done)*

#### 2.9.1 `plans` — plan catalog *(planned, optional)*

Tier limits are currently hardcoded/defaulted. A `plans` reference table can externalize them:
`tier PK, displayName, profileLimit, apiRpm, seats, stripePriceId, monthlyPriceCents`. Until then,
`PRICE_ID_BY_TIER` lives in config (`BillingService`).

#### 2.9.2 `usage_meters` — metered usage *(planned)*

Billing is "metered on profile count" but there is no meter table; usage is computed live
(`findAllByTeam(team).length`). For Stripe metered billing + historical usage:

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `teamId` | TEXT FK → teams.id CASCADE, INDEX | |
| `metric` | `UsageMetric` enum | `profiles` \| `api_requests` \| `active_sessions` \| `sync_bytes`. |
| `periodStart` / `periodEnd` | TIMESTAMP(3) | Billing window. |
| `value` | BIGINT | Aggregated quantity. |
| `reportedToStripeAt` | TIMESTAMP(3) NULL | Idempotency for `meterEvents.create`. |

**Unique:** `(teamId, metric, periodStart)`.

### 2.10 `profile_blob_versions` — encrypted blob version history *(planned as table; versions live in the blob store today)*

Today the blob store (`BlobStore`) owns versioning: it stores opaque bytes keyed by
`<teamId>/<profileId>` and returns a monotonically increasing `version`; `Profile.encryptedBlobRef`
points at the latest (`s3://lobster-profiles/{teamId}/{profileId}/{version}.enc`). To index versions,
support conflict UX, and expire old versions, promote them to a table:

| Column | Type | Key / Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `profileId` | TEXT | FK → profiles.id CASCADE, INDEX | |
| `version` | INT | | Monotonic per profile; `(profileId, version)` UNIQUE. |
| `blobRef` | TEXT | | S3 object key of the encrypted bytes at this version. |
| `sizeBytes` | INT | | Ciphertext size (for `sync_bytes` metering + quota). |
| `sha256` | TEXT | | Digest of **ciphertext** (integrity, dedupe) — never of plaintext. |
| `createdByDeviceId` | TEXT NULL | FK → devices.id | Which install pushed it. |
| `createdAt` | TIMESTAMP(3) | DEFAULT now() | |

**Concurrency:** push carries `baseVersion`; a mismatch with the current head is a **409** (client must
pull → merge → retry). *(done in `ProfilesService.push`)* **Retention:** keep the latest N (e.g. 10)
versions; prune older via lifecycle job (§5).

### 2.11 `audit_logs` — action trail *(done — T-022; model + team-scoped cursor feed + instrumented events)*

Append-only record of profile / team / API / billing actions.

| Column | Type | Key / Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `teamId` | TEXT | FK → teams.id CASCADE, INDEX | Scope. |
| `actorUserId` | TEXT NULL | FK → users.id | Null for system/webhook actors. |
| `actorApiKeyId` | TEXT NULL | FK → api_keys.id | Set when the actor is an API key. |
| `action` | TEXT | INDEX | e.g. `profile.create`, `profile.launch`, `profile.share`, `member.invite`, `apikey.create`, `subscription.upgrade`. |
| `targetType` | TEXT | | `profile` \| `team` \| `membership` \| `api_key` \| `subscription`. |
| `targetId` | TEXT NULL | | |
| `metadata` | JSONB | DEFAULT `'{}'` | Non-secret context (old/new values, ip, userAgent). |
| `ip` | INET NULL | | Request IP. |
| `createdAt` | TIMESTAMP(3) | DEFAULT now(), INDEX | |

**Index:** `(teamId, createdAt DESC)`, `(teamId, action)`. **Immutability:** no `UPDATE`/`DELETE` in the
app path; a DB trigger or app rule blocks mutation. Full immutable audit + export is a §11 roadmap item.

### 2.12 `sessions` — refresh/session registry *(planned; JWT is stateless today)*

Auth issues a 7-day stateless JWT (`TOKEN_TTL='7d'`, `JwtPayload{sub,email}`); there is no server-side
session row, so tokens cannot be revoked before expiry. A session table enables logout-everywhere,
refresh rotation, and device binding.

| Column | Type | Key / Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `userId` | TEXT | FK → users.id CASCADE, INDEX | |
| `refreshTokenHash` | TEXT | UNIQUE | Hash of the refresh token (rotated on use). |
| `deviceId` | TEXT NULL | FK → devices.id | Binds session to a device. |
| `userAgent` | TEXT NULL | | |
| `ip` | INET NULL | | |
| `expiresAt` | TIMESTAMP(3) | | |
| `revokedAt` | TIMESTAMP(3) NULL | | Logout / compromise. |
| `lastSeenAt` | TIMESTAMP(3) | | |
| `createdAt` | TIMESTAMP(3) | DEFAULT now() | |

### 2.13 `devices` — registered desktop installs *(planned)*

Supports single-active-instance semantics across machines, per-device sync cursors, and the
per-install AES key reference.

| Column | Type | Key / Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK | `dev_…`. |
| `userId` | TEXT | FK → users.id CASCADE, INDEX | Owner. |
| `teamId` | TEXT NULL | FK → teams.id | Primary team context. |
| `name` | TEXT | | e.g. hostname / OS label. |
| `platform` | TEXT | | `windows` \| `macos` \| `linux`. |
| `appVersion` | TEXT | | Desktop agent version. |
| `keyReference` | TEXT NULL | | **Reference/id** of the per-install AES key (in OS keychain) — never the key itself (§4). |
| `publicKey` | TEXT NULL | | For future device-to-device key exchange (per-team KMS, §11). |
| `lastSyncAt` | TIMESTAMP(3) NULL | | Sync cursor timestamp. |
| `revokedAt` | TIMESTAMP(3) NULL | | Deauthorize a lost machine. |
| `createdAt` | TIMESTAMP(3) | DEFAULT now() | |

### 2.14 `webhook_endpoints` — outbound event delivery *(planned)*

Lets a team subscribe to events (profile changes, member changes, billing). Distinct from the
**inbound** Stripe webhook, which is a single backend route (`BillingService.handleWebhook`), not a row.

| Column | Type | Key / Constraint | Notes |
|---|---|---|---|
| `id` | TEXT | PK | |
| `teamId` | TEXT | FK → teams.id CASCADE, INDEX | |
| `url` | TEXT | | HTTPS destination. |
| `secret` | TEXT | | HMAC signing secret (stored hashed/encrypted). |
| `events` | JSONB | | Subscribed event types, e.g. `["profile.updated","member.added"]`. |
| `active` | BOOLEAN | DEFAULT true | |
| `lastDeliveryAt` | TIMESTAMP(3) NULL | | |
| `failureCount` | INT | DEFAULT 0 | Auto-disable after threshold. |
| `createdAt` | TIMESTAMP(3) | DEFAULT now() | |

Optional companion `webhook_deliveries` (id, endpointId, eventType, payload, statusCode, attempt,
nextRetryAt) for retry/backoff bookkeeping. *(planned)*

### 2.15 Enum catalog

| Enum | Values | Status |
|---|---|---|
| `Role` | `admin`, `member` | done |
| `PlanTier` | `free`, `pro`, `team`, `enterprise` | done |
| `SubscriptionStatus` | `active`, `past_due`, `canceled`, `trialing` | done |
| `ProxyType` | `http`, `https`, `socks5` | planned (type exists in shared-types) |
| `InvitationStatus` | `pending`, `accepted`, `revoked`, `expired` | planned |
| `UsageMetric` | `profiles`, `api_requests`, `active_sessions`, `sync_bytes` | planned |
| `ProfileStatus` (app-level) | `idle`, `launching`, `running`, `stopping`, `error` | done (runtime, local) |

---

## 3. Local SQLite schema (desktop)

Owned by `apps/desktop/src-tauri/src/profile_store.rs` (rusqlite, WAL). Offline-first: this is the
source of truth for **launching** engines without the cloud.

### 3.1 `profiles` (local) *(done)*

```sql
CREATE TABLE IF NOT EXISTS profiles (
    id                     TEXT PRIMARY KEY,          -- prf_<uuid>
    name                   TEXT NOT NULL,
    engine                 TEXT NOT NULL,             -- EngineKind: lobium | chromium
    os                     TEXT NOT NULL,             -- OsFamily: windows | macos | linux
    os_version             TEXT,
    fingerprint_seed       TEXT NOT NULL,             -- lowercase hex (32 chars), immutable
    fingerprint_overrides  TEXT,                      -- JSON: FingerprintOverrides
    proxy                  TEXT,                      -- JSON: ProxyConfig (incl. credentials — see §4.4)
    proxy_id               TEXT,
    template_id            TEXT,
    cookies_import         TEXT,                      -- JSON: CookieImportDraft
    extensions             TEXT,                      -- JSON: BrowserExtensionRef[]
    tags                   TEXT NOT NULL DEFAULT '[]',-- JSON: string[]
    folder                 TEXT,
    notes                  TEXT,
    status                 TEXT NOT NULL DEFAULT 'idle', -- ProfileStatus
    password_hash          TEXT,                      -- Argon2 hash; never serialized
    trashed_at             TEXT,                      -- soft-delete marker; active lists filter NULL
    created_at             TEXT NOT NULL,             -- ISO-8601
    updated_at             TEXT NOT NULL              -- ISO-8601
);
```

**Differences vs cloud `profiles`:** local **flattens** `engine`/`os`/`status`/`tags`/`proxy` into
columns (cloud folds most into `metadata` JSON); local keeps `status` (runtime) while cloud does not;
local has no `ownerTeamId`/`encryptedBlobRef` yet (added when sync lands). Active local profile lists
filter `trashed_at IS NULL`; move-to-trash is a soft delete, and desktop now exposes trash listing,
restore, and permanent-delete paths over Tauri IPC. Profile password protection stores only an Argon2 hash
and serializes `passwordProtected: boolean`. Both share the immutable `fingerprint_seed` contract and the
unique-seed-per-profile rule.

### 3.2 `proxies` (local) *(done; credentials still need encryption)*

```sql
CREATE TABLE IF NOT EXISTS proxies (
    id               TEXT PRIMARY KEY,
    source           TEXT NOT NULL,             -- mine | hive
    label            TEXT NOT NULL,
    config           TEXT NOT NULL,             -- JSON: ProxyConfig (incl. credentials — see §4.4)
    location         TEXT,
    timezone         TEXT,
    latency_ms       INTEGER,
    status           TEXT NOT NULL,             -- ready | warning | testing | error
    rotate_url       TEXT,
    last_checked_at  TEXT,
    last_error       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
```

The desktop `test_proxy` command updates `status`, latency, location/timezone, and last error for stored
rows after an HTTP/HTTPS/SOCKS5 check.

### 3.3 `profile_templates` (local) *(done)*

```sql
CREATE TABLE IF NOT EXISTS profile_templates (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    engine                  TEXT NOT NULL,
    os                      TEXT NOT NULL,
    os_version              TEXT,
    preset_parameters       TEXT NOT NULL DEFAULT '[]',
    proxy_id                TEXT,
    proxy_label             TEXT,
    proxy_detail            TEXT,
    fingerprint_overrides   TEXT,
    cookies_import          TEXT,
    extensions              TEXT,
    tags                    TEXT NOT NULL DEFAULT '[]',
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
);
```

### 3.4 Cached encrypted blobs (local) *(planned)*

The user-data-dir / cookies / storage are the actual browser payload. Plan:

- **On disk:** each profile has a persistent `user-data-dir` under the app data folder
  (`<appdata>/profiles/<id>/`), the real working copy the engine launches against. *(persistence is a
  Pillar 1 requirement; wiring is in progress.)*
- **`blob_cache` table** *(planned)* to track the encrypted snapshot synced with cloud:

```sql
CREATE TABLE IF NOT EXISTS blob_cache (
    profile_id     TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    local_version  INTEGER NOT NULL DEFAULT 0,   -- last version produced locally
    synced_version INTEGER NOT NULL DEFAULT 0,   -- last version confirmed pushed/pulled from cloud
    blob_ref       TEXT,                          -- s3://… of the last synced version
    ciphertext_sha256 TEXT,                       -- digest of last encrypted snapshot
    dirty          INTEGER NOT NULL DEFAULT 0,   -- 1 = local changes not yet pushed
    last_synced_at TEXT                           -- ISO-8601
);
```

### 3.5 `settings` / `kv` (local) *(planned)*

App-level key/value: signed-in user + JWT (stored in OS keychain, not SQLite), backend base URL,
selected team, local automation API port (default `127.0.0.1:53211`), engine paths, last sync cursor,
telemetry opt-in. Secrets (JWT, AES key material) go to the OS keychain (macOS Keychain / Windows
Credential Manager / libsecret), **referenced** from SQLite, never stored in it.

```sql
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL   -- JSON; NON-SECRET values only
);
```

### 3.6 Reconciliation / sync with cloud *(design; client planned, server done)*

The backend sync endpoint (`POST /profiles/:id/sync`, `SyncProfileDto`) is **built**: push/pull an
opaque base64 client-encrypted blob with optimistic concurrency (`baseVersion` → 409 on mismatch).
The desktop **sync client** that drives it is planned. Model:

1. **Metadata sync (rows).** Profile metadata (name, engine, os, tags, folder, notes, overrides,
   proxy ref, sharing) reconciles as structured fields. Conflict rule: **last-writer-wins per field**
   using `updated_at`; identity fields (`id`, `fingerprint_seed`) are immutable and never merged.
2. **Blob sync (payload).** The encrypted user-data-dir snapshot syncs via the blob channel with
   monotonic versions. Flow:
   - **Push:** local encrypts the snapshot → `POST sync {direction:'push', payload, baseVersion:synced_version}`.
     200 → store returned `version` as `synced_version`, clear `dirty`. 409 → pull first.
   - **Pull:** `POST sync {direction:'pull'}` → decrypt `payload`, replace local user-data-dir,
     set `synced_version = version`.
   - **Conflict:** blobs are opaque, so no field merge is possible → **whole-blob last-writer-wins**
     with a user prompt ("cloud is newer — keep cloud / keep local / clone"). Cloning creates a new
     profile (new id, same seed) to preserve both.
3. **Single-active-instance.** A profile must not be launched on two machines with divergent blobs;
   `devices` + a launch lock (or a `lockedByDeviceId`/`lockedUntil` on the profile) prevents split-brain.
   *(planned; local single-instance lock is a Pillar 1 requirement.)*
4. **Deletion propagation.** A soft-delete (`deletedAt`) syncs as a tombstone so the other side hides
   then hard-deletes after retention; a pure local delete without cloud tombstone would resurrect on
   next pull.
5. **Sync cursor.** `devices.lastSyncAt` (cloud) + `settings.last_sync_cursor` (local) bound
   incremental pulls (`GET /profiles?updatedSince=…`). *(planned)*

---

## 4. Encryption boundaries

The core guarantee (MASTER_PLAN §9 S7, schema header comment): **the server is zero-knowledge about
profile payloads.**

### 4.1 What is client-encrypted (server sees ciphertext only) *(done for blob path)*

| Data | At rest | Key holder |
|---|---|---|
| Cookies, localStorage, IndexedDB, session, full user-data-dir snapshot | AES-encrypted **on the desktop** before upload; stored as opaque bytes in S3 (`BlobStore` never decrypts) | Desktop per-install AES key (OS keychain). Per-team KMS keys are the §11 zero-knowledge roadmap. |
| Blob transport | base64 over HTTPS; server stores decoded bytes opaquely | same |

The blob store contract is explicit: *"The server is a dumb, zero-knowledge broker… It NEVER decrypts."*

### 4.2 What is server-plaintext (operational metadata) *(done)*

Non-secret and needed for indexing/authz/UX: `users.email`, `displayName`, team/membership/role,
`profiles.name`, `fingerprintSeed`, `metadata` (engine/os/tags/folder/notes/sharing/overrides),
`encryptedBlobRef`, subscription/billing fields, api key `prefix`, audit metadata.

> **`fingerprintSeed` is intentionally server-plaintext.** It is not a credential — it is a random
> derivation input. The *fingerprint* is only sensitive as a linkage signal, and it is reproducible
> from the seed by design (needed for cloud-run profiles later). Overrides likewise are non-secret.

### 4.3 Server-side hashed (one-way, never reversible) *(done)*

| Data | Transform | Notes |
|---|---|---|
| `users.passwordHash` | bcrypt cost 10 | Never serialized to clients. |
| `api_keys.hashedKey` | hash (bcrypt/argon2; real hashing Day 2) | Plaintext returned once at creation; only `prefix` is displayable. |
| `invitations.token`, `sessions.refreshTokenHash`, `webhook_endpoints.secret` *(planned)* | hash/encrypt | High-entropy tokens stored hashed. |

### 4.4 Known gap — proxy credentials *(gap to fix)*

Proxy `username`/`password` currently live in **plaintext JSON**: `Profile.metadata.proxy` (cloud) and
`profiles.proxy` TEXT (local). These are **secrets** and violate the zero-knowledge boundary on the
cloud side. Required fix (tracked here, not yet implemented):

- **Cloud:** move proxy credentials into the client-encrypted blob, **or** a dedicated
  `proxies.passwordEnc BYTEA` column encrypted with a server KMS key (weaker than zero-knowledge but
  acceptable for a shared team proxy). Prefer the blob for personal proxies, the encrypted column for
  team-shared proxies.
- **Local:** encrypt the `proxy` credential fields with the per-install AES key at rest.

### 4.5 Key management *(design)*

- **Desktop per-install AES key:** generated on first run, stored in the OS keychain; SQLite/DB hold
  only a `keyReference` (`devices.keyReference`), never key bytes.
- **Transport:** TLS/HTTPS everywhere (auth, blob, billing).
- **JWT signing secret:** `JWT_SECRET` from config; hard-fails in production if unset (`resolveJwtSecret`).
- **Roadmap (§11):** per-team KMS keys → true zero-knowledge team sharing (envelope encryption: a
  team data key wrapped per member device public key; server stores only wrapped keys).

---

## 5. Data lifecycle

| Stage | Policy | Status |
|---|---|---|
| **Create** | Row + (on first launch/sync) encrypted blob. Unique `fingerprintSeed` enforced in service. | done |
| **Update** | `updatedAt` bumped; blob version incremented on push. | done |
| **Soft-delete** | `deletedAt` set; hidden from lists; tombstone syncs to other devices; blob retained for the retention window (export/undo). | planned |
| **Hard-delete** | Scheduled job removes soft-deleted rows past retention **and** their S3 blobs (`TODO(Day 2): also delete the encrypted blob from S3` in `ProfilesService.remove`). | partial (row delete done; blob GC + soft-delete planned) |
| **Cascade** | Deleting a `Team` cascades to profiles/apiKeys/subscription/(proxies/invitations/audit); deleting a `User` cascades memberships/sessions but is **RESTRICTed** while they own a team. | done (defined FKs) |
| **Blob version pruning** | Keep latest N (e.g. 10) `profile_blob_versions`; prune older. | planned |
| **Session/token expiry** | JWT auto-expires at 7d; sessions/refresh rotation revocable. | partial (JWT TTL done; session revoke planned) |
| **Audit retention** | Append-only; retained per plan (e.g. 90d free / longer paid); export before purge. | planned |

### 5.1 Retention windows (defaults, planned)

| Data | Retention |
|---|---|
| Soft-deleted profile rows + blobs | 30 days, then hard-delete |
| Old blob versions (beyond latest N) | pruned on next sync / nightly job |
| Audit logs | 90 days (free) / 1 year (paid) |
| Sessions | 7 days past `expiresAt` |
| Canceled subscription team data | 60 days grace, then per GDPR request |

### 5.2 Export *(planned; import/export is Pillar 1)*

- **Profiles:** JSON/CSV export of metadata + optional encrypted-transfer package (blob + wrapped key)
  for cross-account/org transfer (MASTER_PLAN §1). CSV omits secrets.
- **Account/GDPR export:** machine-readable bundle of all rows a user/team owns (profiles metadata,
  memberships, audit, billing history) — blobs stay encrypted (user holds the key).

### 5.3 GDPR-style deletion *(planned)*

- **Right to erasure:** `DELETE /account` → soft-delete user; cascade soft-delete personal-team
  resources; enqueue hard-delete of rows + S3 blobs after a short legal-hold window; scrub PII
  (`email`, `displayName`) to a tombstone; **audit logs anonymized** (replace `actorUserId` with a
  non-reversible pseudonym) rather than deleted, to preserve team-side integrity.
- **Owner transfer required:** a user owning a team must transfer ownership (FK `ON DELETE RESTRICT`)
  before erasure — or the team is deleted with them if they are its only member.
- **Blob erasure is definitive:** because the server only ever held ciphertext, deleting the S3 object
  is complete erasure (no plaintext copy exists server-side).

---

## 6. Migrations strategy (Prisma Migrate)

- **Tool:** Prisma Migrate. Schema of record: `apps/backend/prisma/schema.prisma`. Applied migrations
  are immutable, ordered SQL under `prisma/migrations/<timestamp|nnnn>_<name>/migration.sql`, tracked
  by `_prisma_migrations` + `migration_lock.toml` (provider = postgresql). Current baseline:
  `0001_init` (users, teams, memberships, profiles, api_keys, subscriptions + 3 enums). *(done)*
- **Dev loop:** `prisma migrate dev --name <change>` (generates + applies + regenerates client).
  **CI/prod:** `prisma migrate deploy` (applies pending, never generates). Both agents run
  `prisma generate` after pulling schema changes.
- **Additive-first rule:** prefer nullable-add / new-table / new-index. A rename or type change is a
  **three-step expand→migrate→contract**: (1) add new column nullable + backfill, (2) dual-write /
  switch reads, (3) drop the old column in a later migration. Never drop-and-recreate a column with data.
- **Backfills:** data migrations that move data (e.g. hoisting `engine`/`os` out of `metadata` into
  columns, or inline proxies into a `proxies` table) ship as an idempotent SQL step in the same
  migration or a paired script gated in CI.
- **Enums:** add values with `ALTER TYPE … ADD VALUE` (Postgres can't remove enum values in a
  transaction) — new enums (`ProxyType`, `InvitationStatus`, `UsageMetric`) land as their tables land.
- **Local SQLite versioning:** rusqlite has no Prisma; `SCHEMA` is `CREATE TABLE IF NOT EXISTS`
  (idempotent). Introduce a `PRAGMA user_version` + ordered in-code migration steps as the local schema
  grows (`blob_cache`, `settings`, `ownerTeamId`/`encryptedBlobRef` columns). *(planned)*
- **Shared-types as the anti-drift contract:** Postgres columns, the local SQLite columns, and the
  wire types all mirror `@lobster/shared-types`. A schema change starts there, then Prisma + rusqlite
  follow. The schema header comment enforces this ("so the Postgres tables never drift from the
  TypeScript wire types").
- **Rollback:** forward-only; a bad migration is fixed by a new compensating migration (plus restore
  from backup for data loss). Keep migrations small and reviewable (one concern each).

### 6.1 Planned migration sequence (indicative)

| # | Migration | Adds |
|---|---|---|
| 0001 | `init` | users, teams, memberships, profiles, api_keys, subscriptions *(done)* |
| 0002 | `soft_delete_and_audit` | `deletedAt` on user-owned tables; `audit_logs` + indexes |
| 0003 | `proxies` | `proxies` table + `ProxyType`; `Profile.proxyId`; backfill inline proxies |
| 0004 | `blob_versions` | `profile_blob_versions`; `Profile.blobVersion` |
| 0005 | `invitations` | `invitations` + `InvitationStatus` |
| 0006 | `sessions_devices` | `sessions`, `devices` |
| 0007 | `billing_usage` | `usage_meters` + `UsageMetric`; extend `subscriptions` |
| 0008 | `webhooks` | `webhook_endpoints` (+ `webhook_deliveries`) |
| 0009 | `profile_columns` | promote `engine`/`os`/`status` from `metadata` to columns + GIN tag index |

---

## 7. Status vs target

**Built (done):** the tenant core — `users`, `teams`, `memberships` (RBAC admin/member),
`profiles` (seed + JSON metadata + encrypted-blob ref), `api_keys` (prefix + hash), `subscriptions`
(profile-count limit enforced) — plus the **zero-knowledge blob sync** path (push/pull, monotonic
versions, optimistic-concurrency 409), bcrypt password hashing, stateless 7-day JWTs, and the local
SQLite profile/proxy/template catalog (WAL, unique-seed contract, immutable seed, profile soft-delete,
Argon2 local profile password flag). Migration baseline `0001_init` is in place. Encryption boundaries are
correctly drawn for the profile blob (client-encrypted, server never decrypts).

**Partial:** blob versions live in the blob store but not as an indexed Postgres table; usage is
computed live rather than metered into rows; S3 is a stub (in-memory store active); blob GC on profile
delete is a `TODO`; local↔cloud sync client is unbuilt (server endpoint done); local store lacks
`ownerTeamId`/`encryptedBlobRef`/blob cache; local proxy credentials are not encrypted yet.

**Planned (specced here, not yet built):** `invitations` (true pending invites), cloud/team `proxies` table,
cloud `profile_templates`, `profile_blob_versions`, `usage_meters` (+ `plans`), `audit_logs`, `sessions`, `devices`,
`webhook_endpoints`; soft-delete + tombstone sync; retention/GDPR jobs; per-team KMS zero-knowledge
keys; granular RBAC.

**Known gap to close:** proxy credentials are stored plaintext in profile metadata/JSON and local
`proxies.config` (§4.4) — they are secrets and must move into the encrypted blob or an encrypted column
before team-shared proxies ship. This is the one place the current model breaches the zero-knowledge
posture.
