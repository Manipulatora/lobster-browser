# Spec — Security & Data Protection Design

> **Scope:** product security and data protection for **Lobster Browser** (desktop agent + cloud SaaS).
> Legal, licensing, and regulatory ownership are handled by the owner separately — this document is the
> engineering-facing security architecture, not a compliance policy.
> **Audience:** both agents (Claude — security-sensitive code owner + blocking reviewer; Codex — implementer).
> **Companion docs:** [MASTER_PLAN](../MASTER_PLAN.md) (§4 Pillar 4, §7.5 "no secrets in the repo"),
> [ADR-0002 tech stack](../adr/ADR-0002-tech-stack.md), [local-automation-api contract](../contracts/local-automation-api.md).

**Status legend:** `done` (shipped in current code) · `partial` (scaffolded / stubbed / dev-only) · `planned` (designed here, not built).

The single most valuable asset we hold is a customer's **profile blob** — the cookies, local/session/IndexedDB
storage, and fingerprint seed that *are* a logged-in identity. Losing one is worse than losing a password:
it is a live, authenticated session for whatever accounts the customer runs. Everything below is organized
around protecting that asset and the credentials (proxy, account, API) that orbit it.

---

## 1. Encryption

### 1.1 What we encrypt and where the plaintext is allowed to exist

| Data class | Contains | Plaintext allowed on | Encryption | Status |
|---|---|---|---|---|
| **Profile blob** | cookies, localStorage, IndexedDB, session storage, user-data-dir snapshot, fingerprint seed | desktop agent (in memory + local disk) only | **client-side AES-256-GCM before upload**; server stores opaque bytes | `partial` (server broker `done`; **LBv1 client envelope `done`** in `@lobster/crypto` + Rust `blob_crypto`; SEC-2 hierarchy helpers `done`; membership TDK re-wrap + sync UI `planned`) |
| **Fingerprint seed** | 128-bit deterministic seed → whole fingerprint | desktop + server metadata (non-secret by itself) | stored in Postgres as metadata; also inside the encrypted blob | `done` (stored), seed is not a secret on its own |
| **Local profile catalog** | profile metadata, proxy config (incl. proxy password), fingerprint overrides | desktop disk (SQLite) | **SQLCipher / field-level AES-GCM**, key in OS keychain | `partial` (SQLite `done`, encryption `planned` — see `profile_store.rs` "LATER") |
| **Passwords** | account credentials | never stored plaintext | **bcrypt** (cost 10) one-way hash | `done` |
| **API keys** | local + backend automation secrets | shown once at creation | **hash at rest** (prefix stored for display) | `partial` (model `done`, hashing "lands Day 2") |
| **Proxy credentials** | host/port/user/pass per profile | inside profile blob + local catalog | rides profile-blob + local-store encryption | `partial` |
| **JWT signing secret / Stripe keys / S3 keys** | server secrets | secret store only | env / secret manager, never in repo | `done` (env), rotation `planned` |

**Governing rule (zero-knowledge option):** for the profile blob, the server is a **dumb, versioned,
zero-knowledge broker**. It stores opaque ciphertext keyed by `<teamId>/<profileId>` and assigns a
monotonic version; it never holds a key and never decrypts. This is already the contract in code —
`apps/backend/src/profiles/blob/blob-store.ts` documents "The store never interprets the bytes" and
`prisma/schema.prisma` stores only `encryptedBlobRef` + non-secret `metadata`. What is **not yet built**
is the client-side AES-GCM step in the desktop agent that produces those bytes — today the sync path
transports base64 payloads the agent must encrypt before it becomes truly zero-knowledge.

### 1.2 Key hierarchy (envelope encryption)

Three tiers. Each tier's key encrypts the tier below (envelope encryption), so we can rotate an upper
key without re-encrypting every blob, and revoke access at team or profile granularity.

```
 Password ──KDF(Argon2id)──▶  User Master Key (UMK)         [derived, never stored]
                                    │ wraps
                                    ▼
                             User Key-Wrapping Key (UKWK)    [stored wrapped by UMK]
                                    │ unwraps
                                    ▼
   per Team:  Team Data Key (TDK)   [stored wrapped, one copy per member's UKWK]
                                    │ derives / wraps
                                    ▼
   per Profile:  Profile Content Key (PCK)  ── AES-256-GCM ──▶  profile blob ciphertext
```

| Key | Derivation / source | Lifetime | Wrapped by | Status |
|---|---|---|---|---|
| **UMK** — User Master Key | `Argon2id(password, salt, m=64MiB, t=3, p=1)` → 32 bytes | ephemeral (session only, never persisted) | — | `partial` (`@lobster/crypto` `deriveUserMasterKey`) |
| **UKWK** — User Key-Wrapping Key | random 32 bytes at signup | account life (rotates on password change) | UMK (AES-256-GCM key-wrap) | `partial` (`wrapKey`/`bootstrapTeamKeys`) |
| **TDK** — Team Data Key | random 32 bytes per team | team life | **each member's** UKWK (one wrapped copy per membership row) | `partial` (wrap helpers done; server membership rows + re-wrap on remove `planned`) |
| **PCK** — Profile Content Key | random 32 bytes per profile, OR `HKDF(TDK, profileId)` | profile life | TDK | `partial` (`deriveProfileContentKey` TS+Rust) |
| **Local Store Key (LSK)** | random 32 bytes, per install | install life | **OS keychain** | `partial` (`keychain.rs` keyring + file fallback) |

**Sharing model:** when a profile is shared with a teammate, we do **not** re-encrypt the blob. The
teammate already holds the **TDK** (a copy wrapped to their UKWK was created when they joined the team),
so they can unwrap the PCK and decrypt. Removing a member: re-wrap a fresh TDK to the remaining members
and re-encrypt future blob versions under the new TDK (forward secrecy for that team).

**Password change / recovery tension:** because UMK derives from the password, a forgotten password with
no recovery material means unrecoverable blobs (true zero-knowledge). We therefore offer, per team, a
choice (see §1.4): (a) **zero-knowledge** (no recovery — UKWK only wrapped by UMK), or (b) **recoverable**
(UKWK additionally escrowed under a KMS-held key so a support-driven reset can re-wrap). The team picks
its risk posture; the default for `free`/`pro` is recoverable, for `enterprise` is zero-knowledge.

### 1.3 Algorithms & formats (normative)

- **Symmetric:** AES-256-GCM. 96-bit random nonce per encryption, **never reused under a key**. 128-bit tag.
- **Blob envelope format** (client-produced, server-opaque):
  ```
  magic="LBv1" (4B) | key_id (16B) | alg (1B: 0x01=A256GCM) | nonce (12B) | ciphertext (…) | tag (16B)
  ```
  `key_id` identifies which PCK/TDK version decrypts it, so a rotated key still decrypts old versions.
- **KDF:** Argon2id (password → UMK) with per-user random 16-byte salt; parameters versioned so we can raise cost later.
- **Key wrapping:** AES-256-GCM with the wrapping key (RFC-5649 AES-KW acceptable as an alternative).
- **Hashing:** bcrypt cost 10 for passwords (`done`); **argon2id** is the target if we standardize KDF + hashing on one primitive.
- **Randomness:** OS CSPRNG only (`getrandom`/`crypto.randomBytes`/`ring`). Never `Math.random`, never seeded RNG for keys.
- **Nonce discipline:** counter or random-96 per key; on any key we approach 2³² messages, rotate the key.

### 1.4 Optional per-team KMS / BYOK

`planned`. Enterprise teams can bind their TDK-wrapping to an external KMS (AWS KMS, GCP KMS, HashiCorp
Vault Transit) instead of (or in addition to) member-UKWK wrapping:

- **Envelope with KMS:** TDK is generated locally, then `Encrypt`ed by the team's KMS key (a "data key"
  pattern). The wrapped TDK is stored; unwrap requires a KMS `Decrypt` call the team authorizes via their
  cloud IAM. Revoking the KMS grant instantly locks all that team's blobs.
- **BYOK config** (per team): `{ provider, keyArn/keyUri, roleArn/credentialsRef, region }`. Credentials
  are a server secret (§3), never in the blob path.
- Trade-off surfaced in UI: KMS = central revocation + audit, but the KMS operator can technically unwrap
  (not pure zero-knowledge). Pure zero-knowledge = member-key wrapping only.

### 1.5 At-rest

| Store | At-rest protection | Status |
|---|---|---|
| **Postgres** | Managed-disk encryption (provider-level, AES-256) + column-level note: no plaintext secrets live here — only hashes, wrapped keys, `encryptedBlobRef`, non-secret metadata | `partial` (deploy-time) |
| **S3 / object store** | Blob bytes already client-encrypted; **additionally** enable SSE-S3 / SSE-KMS as defense-in-depth. Bucket: private ACL, block-public-access on, versioning on, TLS-only bucket policy | `partial` (bytes-opaque model `done`, bucket hardening `planned`) |
| **Local SQLite** | SQLCipher (page-level AES) **or** field-level AES-GCM on the secret columns (`proxy`, `fingerprint_overrides` if sensitive, cookie/storage cache); LSK from OS keychain | `planned` |
| **OS keychain** | LSK stored in: macOS Keychain, Windows DPAPI / Credential Manager, Linux Secret Service (libsecret) / kernel keyring fallback | `planned` |

### 1.6 In-transit

- **All cloud traffic:** TLS 1.2+ (prefer 1.3), HSTS on the API domain, modern cipher suites only, no
  downgrade. `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (`planned`).
- **Desktop ↔ cloud:** HTTPS with cert validation on; pin the API's leaf/intermediate as a hardening
  follow-up (`planned`).
- **Local automation API:** loopback HTTP is acceptable because it never leaves `127.0.0.1` (§4); no TLS
  needed on loopback, but Bearer auth + origin checks compensate.
- **Sidecar IPC:** newline-delimited JSON-RPC over the child process's stdin/stdout — never a network
  socket, so it is not remotely reachable (`done`, see `sidecar.rs`).

---

## 2. Authentication & Authorization

### 2.1 Current state (code) vs target

| Mechanism | Current | Target | Status |
|---|---|---|---|
| Password hashing | bcrypt cost 10, plaintext never stored, hash stripped from all responses | keep; consider argon2id | `done` |
| Token | single **HS256 JWT, 7-day expiry**, `{sub,email}` claims | short-lived access + rotating refresh | `partial` |
| Secret handling | `JWT_SECRET` **hard-fails in production** if unset; dev-only fallback outside prod | + rotation, asymmetric option | `done` |
| Guard | `JwtAuthGuard` verifies signature+expiry, re-checks user exists, attaches public user | keep + scope/role checks | `done` |
| Input validation | global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) | keep | `done` |
| CORS | explicit allowlist + credentials, never reflect-all | keep, tighten prod origins | `done` |
| 2FA / SSO / API-key scoping / session mgmt | — | designed below | `planned` |

### 2.2 JWT access + refresh rotation (`planned`, replaces the 7-day token)

- **Access token:** JWT, **15-minute** TTL, HS256 today (migrate to RS256/EdDSA so verifiers never hold a
  signing key). Claims: `sub` (userId), `email`, `sid` (session id), `iat`, `exp`, `jti`. No roles baked
  in — roles are resolved per-request from membership so a role change takes effect immediately.
- **Refresh token:** opaque high-entropy random (32 bytes), stored **hashed** server-side in a `Session`
  row, **30-day** sliding TTL. Sent as an `HttpOnly; Secure; SameSite=Strict` cookie for the web
  dashboard; stored in the OS keychain for the desktop agent.
- **Rotation (one-time-use):** every refresh call issues a new refresh token and **invalidates the old**.
  **Reuse detection:** presenting an already-rotated refresh token means theft → revoke the entire session
  family (all descendants) and force re-login. Standard refresh-token-rotation defense.
- **Endpoints:**
  | Endpoint | Purpose |
  |---|---|
  | `POST /auth/register` | create account (+ personal team + admin membership) — `done` |
  | `POST /auth/login` | password (+ 2FA) → access + refresh — `done` (2FA `planned`) |
  | `POST /auth/refresh` | rotate refresh → new access + refresh — `planned` |
  | `POST /auth/logout` | revoke current session — `planned` |
  | `GET /auth/me` | current user — `done` |

### 2.3 Session & device management (`planned`)

`Session` model (new): `{ id, userId, refreshTokenHash, device, ip, userAgent, createdAt, lastSeenAt, expiresAt, revokedAt }`.

- **List/revoke:** `GET /auth/sessions` (list active devices), `DELETE /auth/sessions/:id` (revoke one),
  `POST /auth/sessions/revoke-all` (log out everywhere — also triggered by password change).
- **Device binding:** desktop agent registers a `deviceId` (random, stored in keychain) so a lost laptop
  can be revoked without touching other devices.
- **Global kill switch:** revoking a session immediately blocks its refresh; access tokens still validate
  until their 15-min expiry (acceptable) — for instant cutoff, high-value endpoints check a `sid` denylist
  (short-TTL cache).

### 2.4 Two-factor authentication (`planned`)

- **TOTP** (RFC 6238): 30-second window, SHA-1, 6 digits; provisioning via `otpauth://` URI + QR in the
  UI. Server stores the TOTP secret **encrypted** (under a server secret, not the user's UMK — must be
  usable at login before UMK exists).
- **Recovery codes:** 10 single-use codes, shown once, stored **hashed** (bcrypt/argon2). Using one burns it.
- **Enforcement:** per-user opt-in; **team-admin can require 2FA** for all members (`team.require2fa`).
- **Endpoints:** `POST /auth/2fa/setup` → secret+QR, `POST /auth/2fa/verify` (activate), `POST /auth/2fa/disable`,
  and `login` gains a second step: password OK → `mfaRequired: true` + short-lived `mfaToken` → `POST /auth/2fa/login`.
- **Step-up auth:** sensitive actions (export blob, rotate keys, change billing, disable 2FA) may require a
  fresh 2FA challenge even within a session.

### 2.5 SSO — SAML 2.0 / OIDC (`planned`, enterprise)

- **OIDC** (Google Workspace, Okta, Azure AD, Auth0): authorization-code + PKCE. Map IdP `sub`+`email` to a
  Lobster user; **JIT provisioning** into the team bound to that IdP domain.
- **SAML 2.0** for enterprises that require it: SP-initiated, signed assertions, per-team IdP metadata
  (`entityId`, ACS URL, x509 signing cert).
- **Domain claim + enforced SSO:** an enterprise team can claim an email domain and force SSO-only login
  (disable password login) for members in that domain.
- **SCIM** (later): automated user provisioning/deprovisioning from the IdP.
- Zero-knowledge tension: SSO users have no password → no UMK. For those teams, TDK wrapping falls back to
  KMS/escrow (§1.4) since we cannot derive a user key from a password.

### 2.6 API keys — scoping, rotation, storage

Current (`partial`): `ApiKey` model persists a display **prefix** + a **hash of the secret**; the plaintext
is returned exactly once at creation. Real hashing is flagged "lands Day 2." The **local automation API**
(`local_api.rs`) checks a single Bearer `LOBSTER_API_KEY` and, when unset, allows loopback dev.

Target:

- **Format:** `lb_live_<random>` / `lb_test_<random>`; store `prefix` (e.g. `lb_live_ab12`) + `SHA-256(secret)`
  (or argon2). Never store or log the full secret. Constant-time comparison on verify.
- **Scopes** (least privilege — new field `scopes: string[]`):
  | Scope | Grants |
  |---|---|
  | `profiles:read` | list/status |
  | `profiles:write` | create/update/delete/clone |
  | `profiles:launch` | start/stop (drive engines) |
  | `blobs:sync` | push/pull encrypted blobs |
  | `team:read` | read team/members |
  | `billing:read` | read subscription |
- **Rotation:** `POST /api-keys/:id/rotate` issues a new secret, keeps the old valid for a grace window
  (default 24h) then auto-revokes — zero-downtime rotation. `lastUsedAt` (already in schema) surfaces stale keys.
- **Revocation:** `DELETE /api-keys/:id` immediate. Team-scoped: keys belong to a team, not a user, so a
  departing member's automation can be handed off.
- **Expiry:** optional `expiresAt`; warn in UI before expiry.

### 2.7 RBAC permission matrix

Current: two roles — `admin`, `member` (`shared-types` `Role`, Prisma `Membership.role`). Access is
**team-scoped** end to end: every profile/blob operation resolves the caller's membership and rejects
cross-team access (`ProfilesService.resolveTeamId`). Target adds `owner` and (roadmap) tag-scoped grants.

| Action | owner¹ | admin | member | viewer² |
|---|:--:|:--:|:--:|:--:|
| View team profiles | ✓ | ✓ | ✓ | ✓ |
| Create / edit / delete profile | ✓ | ✓ | ✓ | ✗ |
| Launch profile / drive automation | ✓ | ✓ | ✓ | ✗ |
| Sync (push/pull) encrypted blob | ✓ | ✓ | ✓ | ✗ |
| Export / import / transfer profile | ✓ | ✓ | scoped³ | ✗ |
| Invite / remove members | ✓ | ✓ | ✗ | ✗ |
| Change member roles | ✓ | ✓⁴ | ✗ | ✗ |
| Manage API keys | ✓ | ✓ | ✗ | ✗ |
| Manage billing / subscription | ✓ | ✗ | ✗ | ✗ |
| Configure SSO / 2FA policy / KMS | ✓ | ✗ | ✗ | ✗ |
| View audit log | ✓ | ✓ | ✗ | ✗ |
| Delete team | ✓ | ✗ | ✗ | ✗ |

¹ `owner` = `Team.ownerUserId` (`planned` as distinct role) · ² `viewer` (`planned`) · ³ member export
gated by team policy · ⁴ admins cannot elevate above their own role or change the owner.

**Enforcement points:** (1) NestJS guard resolves membership+role per request; (2) service layer re-checks
team ownership on every entity (defense in depth — never trust the client's `teamId`); (3) row scoping in
repositories (`findById(teamId, id)`). Roles are resolved live (not from JWT claims) so a demotion is
instant.

---

## 3. Secrets Management

- **Source of truth:** environment variables / a secret manager, **never the repo**. `.env` and `.env.*`
  are gitignored (`!.env.example` kept); `*.pem`, `*.key`, `secrets/` gitignored (`done`).
- **`.env.example`** holds placeholders only, with explicit "do not put real secrets here" warnings (`done`).
- **Server secrets inventory:** `JWT_SECRET` (hard-fails in prod if unset — `done`), `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `DATABASE_URL`, plus (planned) KMS
  creds, SSO IdP secrets, TOTP-encryption key.
- **Production secret store (`planned`):** AWS Secrets Manager / SSM Parameter Store / Vault, injected at
  deploy — not baked into images. Least-privilege IAM per service.
- **Rotation policy (`planned`):**
  | Secret | Rotation | Method |
  |---|---|---|
  | `JWT_SECRET` | 90 days / on suspicion | dual-secret window (accept old+new during rollover); migrate to RS256 key rotation via `kid` |
  | Stripe keys | on suspicion | Stripe dashboard + redeploy |
  | S3 / DB creds | 90 days | rotate in secret store, rolling restart |
  | KMS grants | continuous | IAM-managed |
- **No secrets in logs:** structured logging (`tracing` / Nest logger) must never log tokens, keys,
  passwords, cookies, or blob bytes. Redaction filter on log fields (`authorization`, `password`,
  `payload`, `*key*`, `*secret*`) — `planned` as a lint/runtime guard.
- **CI:** secrets provided via GitHub Actions secrets; **gitleaks** blocks any accidental commit (`done`).

---

## 4. Local Automation API Hardening

The local API (`apps/desktop/src-tauri/src/local_api.rs`, Axum) is the highest-value local attack surface:
it can launch/stop/list profiles and, through them, drive authenticated sessions.

| Control | Design | Status |
|---|---|---|
| **Loopback-only bind** | binds `127.0.0.1:53211` explicitly (`SocketAddr::from(([127,0,0,1], port))`) — never `0.0.0.0`; unreachable from the network | `done` |
| **Bearer auth** | every endpoint except `/health` requires `Authorization: Bearer <LOBSTER_API_KEY>`; constant-time compare (`planned` — today `==`) | `partial` |
| **Dev bypass** | when no key is configured, loopback dev is allowed — **must be closed for packaged builds** (agent generates a key on first run, stores it in the OS keychain, and the API refuses unauthenticated requests) | `partial` |
| **Origin / DNS-rebinding defense** | reject requests whose `Origin`/`Host` is not `127.0.0.1`/`localhost:<port>` — blocks a malicious website from reaching the loopback API via DNS rebinding | `planned` |
| **Rate limiting** | per-key + per-endpoint token bucket (e.g. `start` 10/min, `list` 60/min) to blunt runaway automation / local brute force | `planned` |
| **No CORS for browsers** | the API is for local tools, not web pages — do **not** send permissive CORS headers; combined with the origin check this stops browser-based callers | `planned` |
| **Minimal error leakage** | errors return `{code:1, msg}` without stack traces / paths | `done` |
| **Key surface** | key never printed to logs; rotate via UI; scoped keys (§2.6) limit what a leaked key can do | `partial` |

**DNS-rebinding note:** a website cannot read cross-origin responses from `127.0.0.1` by default, but
`no-cors` requests can still *trigger* side effects. Bearer auth (a secret the site cannot know) is the
primary defense; the `Origin`/`Host` allowlist is defense in depth.

---

## 5. Threat Model

### 5.1 Assets

| Asset | Why it matters |
|---|---|
| **Profile blobs** (cookies/storage/seed) | live authenticated sessions — the crown jewel |
| **Proxy credentials** | paid resource + deanonymization if leaked |
| **Fingerprint config/seed** | the coherence recipe; leak weakens stealth but seed alone ≠ identity |
| **Account credentials / tokens** | access to everything above |
| **API keys** | programmatic control of profiles |
| **Billing / PII** | email, Stripe customer id |

### 5.2 Adversaries & attack surfaces

| Adversary | Goal | Surface |
|---|---|---|
| **Anti-bot vendor / target site** | detect + link profiles (fingerprint/leak correlation) | the browser itself (WebRTC, canvas, TLS tells) |
| **Network attacker (MITM)** | steal tokens/blobs in transit | TLS to cloud, proxy path |
| **Blob exfiltrator** | steal profile blobs at rest | S3, Postgres, backups, a compromised server |
| **Credential thief** | steal passwords/tokens/API keys | login, JWT, local keychain, phishing |
| **Malicious local software** | reach the loopback API / read local store | local API, SQLite file, keychain |
| **Malicious website** | DNS-rebind to the local API | loopback API |
| **Insider / departing member** | exfiltrate team profiles | RBAC, sharing, audit |
| **Supply-chain attacker** | inject code via a dependency | npm/cargo deps, CI |
| **Abusive customer** | use profiles for fraud/ATO/spam | product-level AUP hooks (§8) |

### 5.3 Threats → mitigations

| Threat | Mitigation | Status |
|---|---|---|
| **Fingerprint leak / correlation** | native Lobium fingerprinting, coherent real-system params, WebRTC-behind-proxy, artifact-free control CDP, CI detector gate (see MASTER_PLAN §5–6) | tracked in fingerprint spec |
| **WebRTC/DNS IP leak** | ICE == proxy IP (native Lobium + launch policy); DNS via proxy | `partial` |
| **Token theft** | short access TTL + rotating refresh + reuse detection + revocation; HttpOnly/Secure cookies; keychain on desktop | `planned` |
| **Blob exfiltration from server** | **client-side AES-GCM (zero-knowledge)** — stolen S3/PG bytes are useless without team keys | `partial` (server-opaque `done`; LBv1 envelope `done`; SEC-2 key hierarchy `planned`) |
| **Blob exfiltration from disk** | local store encryption + keychain-held LSK; single-active-instance lock | `planned` |
| **Proxy-cred theft** | credentials only inside encrypted blob + encrypted local store; never logged | `partial` |
| **Credential stuffing / brute force** | bcrypt (slow), rate limit + lockout on login, 2FA, generic error messages (already generic in `auth.service.ts`) | `partial` |
| **MITM** | TLS 1.2+/HSTS, cert validation, (planned) pinning | `partial` |
| **Local API abuse by other software** | loopback-only + Bearer + origin check + rate limit + scopes | `partial` |
| **Privilege escalation / cross-team access** | per-request membership resolution + service-layer re-check + row scoping | `done` |
| **Forged JWT** | prod hard-fail on missing secret; asymmetric signing (planned); short TTL | `partial` |
| **Supply-chain** | pinned deps, lockfiles, SBOM, secret scan, review (§7) | `partial` |
| **Stripe webhook spoofing** | signature verification with raw body | `partial` (raw-body wiring TODO) |

### 5.4 Explicit non-goals / accepted risks

- A user who fully controls their own machine can read their own plaintext blobs (by design — it's their data).
- Pure zero-knowledge teams accept **unrecoverable** data if all members lose their password with no escrow.
- We do not defend against a compromised OS/kernel on the user's machine (out of scope).

---

## 6. Data Protection Features

| Feature | Design | Status |
|---|---|---|
| **Retention** | configurable per team: profile blobs kept N versions (default 10) / N days; billing records per legal minimums; logs 90 days hot + archive | `planned` |
| **Right to erasure / account deletion** | `DELETE /account` → cascade delete memberships, profiles, blobs (S3 objects + versions), sessions, API keys; Prisma `onDelete: Cascade` already models team→children cascades | `partial` (cascades `done`, erasure endpoint `planned`) |
| **Profile deletion** | delete row + tombstone the blob key + purge S3 versions; local `delete` already removes the row | `partial` |
| **Export** | per-profile JSON/CSV + **encrypted transfer package** (blob re-wrapped to a recipient key or a passphrase); account-level data export (profiles metadata, audit, billing) | `partial` (design in MASTER_PLAN §4) |
| **Audit log** | append-only record of profile/team/API/auth actions: `{actor, action, target, teamId, ip, ua, at}`; skeleton exists, immutable + exportable is the target | `partial` |
| **Data residency** | choose blob-store region per team (`S3_REGION` already parameterized in `s3-blob-store.ts`); EU-only bucket + EU DB option for enterprise | `planned` |
| **Backups** | encrypted, versioned, tested restore; blobs already client-encrypted so backups inherit zero-knowledge | `planned` |
| **PII minimization** | store only email + display name + Stripe id; no card data (Stripe holds it) | `done` |

**Audit event catalog (target):** `auth.login`, `auth.login.failed`, `auth.2fa.enabled`, `auth.session.revoked`,
`profile.created/updated/deleted/launched`, `profile.exported/transferred`, `blob.synced`, `member.invited/removed`,
`role.changed`, `apikey.created/rotated/revoked`, `billing.changed`, `kms.configured`.

---

## 7. Supply-Chain Security

| Control | Design | Status |
|---|---|---|
| **Lockfiles pinned** | `package-lock.json` (npm) + `Cargo.lock` committed; CI installs from lock (`npm install --no-audit`) | `done` |
| **Secret scanning** | gitleaks job blocks merges on any committed secret | `done` |
| **Dependency review** | new/updated deps reviewed in PR; prefer well-maintained, minimal-transitive packages; both agents cross-review | `partial` |
| **Vulnerability scanning** | `npm audit` + `cargo audit` (RustSec) in CI as a gate; Dependabot/Renovate for updates | `planned` |
| **SBOM** | generate CycloneDX SBOM (npm + cargo) per release; publish with artifacts | `planned` |
| **Dependency updates** | automated PRs (Dependabot/Renovate), grouped, gated by full CI incl. fingerprint validation | `planned` |
| **Build integrity** | pinned toolchains (`rust-toolchain.toml`, `.nvmrc`); reproducible-ish builds; sign desktop installers (Win Authenticode / macOS notarization — MASTER_PLAN §10 Day 8) | `partial` |
| **Engine provenance** | Lobium built from our own pinned source + patch series; packaged binaries are signed/checksummed and never committed to git | `partial` |
| **CI hardening** | least-privilege `GITHUB_TOKEN`, no secrets exposed to fork PRs, `concurrency` cancels superseded runs | `partial` |
| **Third-party OSS attribution** | keep attribution files when importing OSS (MASTER_PLAN §7.5) | `done` |

**Notable dependency trust anchors:** Chromium/depot_tools/Lobium patch tooling, `fingerprint-suite`
(fallback/catalog data), `patchright` for internal tests only, `bcryptjs`, `@nestjs/jwt`, `rusqlite`,
Tauri. Each is a supply-chain trust decision; pin versions and review upgrades deliberately.

---

## 8. Anti-Abuse / AUP Hooks

Product-level mechanisms so the platform can enforce an Acceptable-Use Policy (the policy text itself is
owner/legal-owned; these are the **engineering hooks**).

| Hook | Design | Status |
|---|---|---|
| **Signup abuse controls** | email verification, disposable-domain blocklist, optional CAPTCHA, per-IP signup rate limit | `planned` |
| **Rate / volume limits** | per-plan caps: profile count (**live** — `Subscription.profileLimit`, enforced in `ProfilesService.assertUnderPlanLimit`), API RPM, concurrent launches | `partial` |
| **Abuse signals** | detect mass-account patterns, sudden blob-sync spikes, credential-stuffing-like automation; feed a risk score | `planned` |
| **Enforcement actions** | soft (warn/throttle), hard (suspend team, disable API keys, freeze launches) with an audit trail | `planned` |
| **Reporting / takedown** | abuse-report intake endpoint + admin console to investigate + act | `planned` |
| **Billing-linked gating** | `past_due`/`canceled` subscription status can restrict launches/sync | `partial` (status modeled) |
| **Immutable evidence** | abuse actions logged to the append-only audit trail (§6) for dispute handling | `partial` |

We deliberately do **not** inspect blob plaintext for abuse detection — that would break the
zero-knowledge guarantee. Anti-abuse operates on **metadata and behavior** (rates, counts, timing,
account graph), never decrypted content.

---

## Status vs target

**Solid foundations are already in place:** passwords are bcrypt-hashed and never leak; JWT auth with a
production hard-fail on a missing secret; team-scoped RBAC enforced at guard + service + row layers; the
cloud blob store is architected as a **zero-knowledge, versioned broker** that only ever holds opaque
bytes + `encryptedBlobRef`; the local automation API is loopback-only with Bearer auth; input validation,
a CORS allowlist, gitignored secrets, and a gitleaks CI gate all ship today.

**The security-critical gaps to close** are, in priority order: (1) the **client-side AES-GCM + key
hierarchy** so "zero-knowledge" is real end to end (server is ready; the desktop crypto and local-store /
keychain encryption are the missing half); (2) **refresh-token rotation + session/device revocation**
(today a single 7-day token); (3) **API-key hashing + scoping + rate limiting** and closing the local-API
dev bypass in packaged builds; (4) **2FA**, then **SSO/KMS** for enterprise; (5) supply-chain depth
(SBOM, `cargo/npm audit` gates, automated updates) and the erasure/retention/audit data-protection
surface. None of these change the architecture described here — they are the implementation of it. This
spec is the target; the code notes above mark honestly what is `done`, `partial`, and `planned`.
