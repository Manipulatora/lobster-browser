# Spec — Feature Catalog (Octo-class)

> **Scope:** the complete, implementation-actionable feature catalog for **Lobster Browser** — every
> Octo-class feature area, its sub-features, competitor-parity note, priority, and current status.
> This is the product surface a "perfect" anti-detect browser + SaaS must cover, mapped onto what the
> repo already ships vs. what is planned.
>
> **Read first:** [`MASTER_PLAN.md`](../MASTER_PLAN.md) (strategy, two-engine model, terminology).
> **Sibling specs (deep dives, some pending):** `fingerprint-parameters.md` (the 50+ param model),
> `proxy.md` (proxy + geo coherence), `api-reference.md` (local automation API + SDKs). Where those
> exist they are the source of truth for their surface; this catalog links out rather than duplicating.
>
> **Terminology:** two engines behind one interface — **Lobium** (our own Chromium build, flagship;
> served by patched Chromium via patchright until the native build ships) and **Chromium** (prebuilt
> ungoogled, interim/everyday). Both present a Chrome-family fingerprint.
>
> **Status legend:** **done** (shipped + tested in-repo) · **partial** (scaffolded / first slice landed,
> gaps remain) · **planned** (designed here, not yet built). **Priority:** **P0** (v1 launch-critical) ·
> **P1** (fast-follow) · **P2** (roadmap / differentiation).
>
> **Competitor parity legend:** which incumbents already ship the feature — Octo (Octo Browser),
> ML (Multilogin), ADS (AdsPower), GL (GoLogin), Dolphin{anty}, Kameleo. "Parity" = at feature level,
> not depth.

---

## 0. How to read this catalog

Each area below has: a **sub-feature list** (concrete fields / endpoints / params), a **parity note**,
a **priority**, and a **status**. Section 13 rolls everything into one **master feature matrix**.
Sections 9–11 cover the cross-cutting product concerns (billing, desktop app, UX). Section 12 is the
phased roadmap. The doc ends with **Status vs target** (§14).

The grounding for "status" is the current tree:

- **Desktop core** (`apps/desktop/src-tauri`): SQLite profile store, profile IPC commands
  (`list/create/get/update/delete/launch/stop`), sidecar client, local Axum API.
- **Engine runner** (`packages/engine-runner`): patchright launcher, CDP fingerprint injection,
  `startProfile`, composite runner.
- **Fingerprint** (`packages/fingerprint`): seed→coherent `generateFingerprint`, coherence rules,
  overrides, real-device pools.
- **Proxy** (`packages/proxy`): parse + exit-IP geo derivation. **Cookies** (`packages/cookies`):
  Netscape + Playwright/JSON parse/serialize.
- **Backend** (`apps/backend`): NestJS auth (JWT), teams (admin/member RBAC), profiles CRUD + sync
  (push/pull encrypted blob + version conflict), S3/in-memory blob store, billing (Stripe stub).
- **Shared types** (`packages/shared-types`): `Profile`, `Fingerprint`, `ProxyConfig`, `Team`,
  `Subscription`, `ApiResponse`, `StartProfileResult`, …

---

## 1. Profiles

The crown jewel. A **profile** = a persisted identity: name + engine + OS + deterministic
fingerprint seed (+ overrides) + optional proxy + tags/folder/notes + status + team ownership/sharing.

| Sub-feature | Detail (fields / behavior) | Priority | Parity | Status |
|---|---|---|---|---|
| Create | `CreateProfileInput { name, engine, os, fingerprintSeed?, fingerprintOverrides?, proxy?, tags?, folder?, notes? }`; server/store fills `id/status/createdAt/updatedAt`; seed auto-generated when omitted. | P0 | all | **done** (desktop `create_profile`, backend `POST /profiles`) |
| Read / list / update / delete | Full CRUD; desktop IPC `list/get/update/delete_profile`, backend `GET/PATCH/DELETE /profiles[/:id]`. | P0 | all | **done** |
| Clone | Duplicate a profile with a **new seed + new id**, copy overrides/proxy/tags/notes; option "same fingerprint" (copy seed) vs "new fingerprint" (fresh seed). | P0 | all | **planned** |
| Bulk-create | Create N profiles from a template + a proxy list (1 proxy/profile) + a naming pattern (`{base}-{n}`); each gets an independent seed. Progress + partial-failure report. | P0 | Octo, ADS, GL, ML | **planned** |
| Import | JSON (native `Profile[]`), CSV (flat columns), and competitor formats (AdsPower/GoLogin export) mapped to `Profile`. Cookies imported via `@lobster/cookies` (Netscape + JSON). | P0 | all | **partial** (cookie layer **done**; profile import mapping **planned**) |
| Export | JSON/CSV of selected profiles (metadata + seed + overrides + proxy ref); cookies exported in Netscape/JSON. Secrets (proxy password) redacted unless "include secrets" is set. | P0 | all | **partial** (cookies **done**; profile export **planned**) |
| Transfer (encrypted package) | Portable `.lobster` package = AES-encrypted blob (cookies/storage/seed/overrides) + manifest; passphrase or team-key protected; import into another install/account. | P1 | Octo, ML | **planned** (sync blob primitives exist; package format **planned**) |
| Tags | `tags: string[]` free-form labels; multi-tag; used by filters + tag-scoped RBAC. | P0 | all | **partial** (stored in schema/store; tag UI/filter **planned**) |
| Folders | `folder?: string` single-parent grouping; drag-move; folder tree in sidebar. | P1 | Octo, ADS, GL | **partial** (field exists; UI **planned**) |
| Search | Full-text over name/notes/tags/proxy host; instant filter. | P1 | all | **planned** |
| Filters | By engine, OS, status, tag, folder, proxy country, last-launched, shared/private. | P1 | all | **planned** |
| Notes | `notes?: string` rich-ish free text per profile. | P1 | all | **partial** (field exists; editor **planned**) |
| Profile templates | Named presets: engine + OS + fingerprint constraints (OS/browser version band, screen class) + default tags/proxy pool. Feed bulk-create. | P1 | Octo, ADS | **planned** |
| Quick / disposable profiles | One-click ephemeral profile (random coherent fingerprint, no persistence, auto-deleted on close). | P2 | Kameleo, GL | **planned** |
| Single-instance lock | A profile can be **running** in only one place at a time; launching a locked profile is refused (prevents cookie/state corruption). Enforced in desktop core via status + lock. | P0 | all | **partial** (`ProfileStatus` state machine present; hard lock enforcement **planned**) |
| Status | `ProfileStatus = idle \| launching \| running \| stopping \| error`; surfaced in list + API `list/status`. | P0 | all | **done** (type + API); live transitions **partial** |
| Cookie robot / warm-up | Headless visits to a configurable site list to accrue realistic cookies/history/age before first human use; schedule + per-profile run. | P2 | ADS, GL, Dolphin | **planned** |

**Parity note:** the Profiles surface is the table-stakes battleground; incumbents differentiate on
**bulk workflows** (import/clone/templates/bulk-create) and **warm-up**. Our CRUD + fingerprint-per-seed
foundation is solid; the bulk + import/export + template layer is the biggest v1→P1 gap.

---

## 2. Browser data (per-profile persistence + sync)

Each profile owns an isolated, persistent `user-data-dir`; the sensitive slice is encrypted and
sync-able. Isolation guarantee: **profiles never share state**.

| Data type | Persistence | Sync | Priority | Parity | Status |
|---|---|---|---|---|---|
| Cookies | Per-profile user-data-dir + import/export via `@lobster/cookies` (Netscape + Playwright/JSON, session-cookie normalization, round-trip identity). | In encrypted blob | P0 | all | **done** (format layer); dir persistence **partial** |
| localStorage | Persisted in user-data-dir. | In encrypted blob | P0 | all | **partial** (persists with dir; explicit export **planned**) |
| IndexedDB | Persisted in user-data-dir. | In encrypted blob | P1 | all | **partial** |
| Bookmarks | Persisted; import/export (HTML/JSON). | In blob | P2 | Octo, ADS | **planned** |
| Extensions | Load unpacked/CRX per profile; per-profile enable set; sync of extension IDs + settings. | Blob (settings) | P1 | Octo, ML, ADS, GL | **planned** |
| History | Persisted; optional exclude-from-sync toggle. | In blob (opt) | P2 | ADS, GL | **planned** |
| Saved passwords / autofill | Per-profile credential + autofill store; encrypted; opt-in sync. | In blob (encrypted) | P2 | Octo, ADS | **planned** |

**Persistence model:** the desktop core keeps profile metadata + a cookie/storage cache in SQLite;
the full user-data-dir snapshot is the encrypted blob pushed to S3 (server stores an opaque
`encryptedBlobRef`, never plaintext). See §7 for the sync mechanics.

**Parity note:** everyone persists cookies + storage; **extensions** and **passwords/autofill** are the
premium differentiators. We have the canonical cookie layer and the encrypted-blob channel; the
per-data-type export/merge tooling is the work ahead.

---

## 3. Fingerprints

Real-system, 50+ parameters, per-profile stable and coherent. Deep surfaces are **native in Lobium**;
JS-safe surfaces are applied via clean CDP on the interim Chromium. **Full parameter reference:
`fingerprint-parameters.md`** (this section is the feature-level summary).

| Sub-feature | Detail | Priority | Parity | Status |
|---|---|---|---|---|
| Real-system source | Values drawn from real-device datasets (fingerprint-suite + pools); statistically real, internally coherent. | P0 | Octo, ML, Kameleo | **done** (`generateFingerprint`, pools, coherence tests) |
| Deterministic + stable | Per-profile hex **seed** → deterministic fingerprint; stable across restarts. | P0 | all | **done** (`FingerprintSeed`, seeded PRNG) |
| Coherence enforcement | UA ↔ OS ↔ WebGL ↔ screen ↔ hardware ↔ fonts ↔ locale all describe one machine; validated by coherence rules + CI detector gate. | P0 | Octo, ML | **partial** (rules + tests **done**; CI detector gate **partial**) |
| 50+ configurable params | One shared config model (`Fingerprint`/`FingerprintOverrides`) consumed by editor UI, sidecar, and the Lobium config channel. Groups: navigator/UA-CH, screen, WebGL, fonts, hardware, locale/timezone, audio, WebRTC, canvas, TLS/JA4, WebGPU, media/codecs. | P0 | Octo, ML, Kameleo | **partial** (JS-safe surfaces modeled; deep/native surfaces **planned** via Lobium) |
| Fingerprint editor UI | Per-group form; blank field = "no override" (keep seed-derived); parses non-blank into `FingerprintOverrides`. Currently: engine, OS, `navigator.platform`, languages, locale, timezone, hardwareConcurrency (+ growing). | P0 | all | **partial** (`FingerprintEditor.tsx` first params) |
| Overrides layer | User overrides applied on top of seed-derived values (`FingerprintOverrides` = partial navigator/screen/locale/fonts). | P0 | all | **done** (`overrides.ts` + tests) |
| Mobile / Android | Mobile fingerprint profile type: mobile UA, `maxTouchPoints`, mobile GPU, screen/orientation, `deviceMemory`, `uaMobile=true`. | P1 | Dolphin, GL, Kameleo | **planned** (fields exist in navigator model; profile type + native mobile variant **planned**) |
| Deep surfaces native (Lobium) | Canvas farbling, WebGL vendor/renderer + pixel hash, AudioContext DSP, font metrics, TLS JA3/JA4 + HTTP/2 — enforced natively, no JS tell. | P0 (moat) | Octo, ML | **planned** (Lobium track; interim = best-effort) |
| WebRTC leak policy | ICE public IP == proxy IP (native in Lobium; policy on interim). | P0 | all | **partial** |
| Regenerate fingerprint | Re-seed a profile (new coherent identity) while keeping name/tags/proxy. | P1 | all | **planned** |

**Parity note:** the depth here is the entire moat. Interim JS-safe substitution reaches AdsPower/GoLogin
tier; **native Lobium** is what reaches Octo/Multilogin/Kameleo tier. The parameter model is shared and
ready; native enforcement is the multi-week Lobium effort.

---

## 4. Proxy management

Per-profile network identity; geo drives fingerprint coherence. **Full reference: `proxy.md`.**

| Sub-feature | Detail | Priority | Parity | Status |
|---|---|---|---|---|
| Types | `ProxyConfig { type: http \| https \| socks5, host, port, username?, password?, label? }`. | P0 | all | **done** (type + parser) |
| Per-profile attach | Inline proxy or a reference id resolved from the proxy store; applied at launch. | P0 | all | **partial** (field on `Profile`; store/attach **partial**) |
| Test / IP-check | `ProxyTestResult { ok, latencyMs?, geo?, error? }`; geo = `GeoInfo { ip, countryCode, region, city, timezone, lat/long, asn, isDatacenter }`. | P0 | all | **partial** (geo derivation package **done**; UI test button **planned**) |
| Geo-sync (coherence) | Auto-derive timezone / locale / `navigator.languages` / `Accept-Language` / geolocation from the **exit IP**; the top coherence rule. | P0 | Octo, ML | **partial** (`packages/proxy` geo; wired into launch **partial**) |
| Quality signals | Surface `isDatacenter` + ASN as warnings (residential/mobile preferred). | P1 | Octo, ML | **partial** (fields present; UI surfacing **planned**) |
| Proxy store / library | Named, reusable proxy entries; bulk paste (`host:port:user:pass`); assign to many profiles. | P1 | all | **planned** |
| Rotation | Rotating/backconnect endpoints; per-request or per-session; sticky sessions. | P2 | ADS, GL, Dolphin | **planned** |
| Providers integration | Built-in provider API import (bring-your-own key), one-click add. | P2 | ADS, GL | **planned** |
| Proxy marketplace / resale | In-app proxy purchase. | P2 | ADS, GL, Dolphin | **planned** (roadmap) |

**Parity note:** bring-your-own proxy + test + geo-sync is table stakes and largely in place at the
package level; **rotation pools, provider integrations, and marketplace** are the up-market extensions.

---

## 5. Teams & collaboration

Multi-seat orgs with shared profiles, roles, and auditability.

| Sub-feature | Detail | Priority | Parity | Status |
|---|---|---|---|---|
| Teams | `Team { id, name, ownerUserId }`; a user can belong to many. | P0 | all | **done** (`POST/GET /teams`) |
| Roles (base) | `Role = admin \| member`; enforced end-to-end (invite/setRole = admin-only; list = members). | P0 | all | **done** (`TeamsService` RBAC + tests) |
| Invitations | Invite existing user by email + role → `Membership`. Email-based invite links for non-users. | P0 | all | **partial** (invite-existing **done**; email/link invite **planned**) |
| Membership mgmt | List members; change role; remove member; transfer ownership. | P0 | all | **partial** (`listMembers`/`setRole` **done**; remove/transfer **planned**) |
| Granular RBAC | Beyond admin/member: per-capability permissions (create/launch/edit/delete/share/export/automate). | P1 | Octo, ML | **planned** |
| Tag-scoped access | Scope a member's visibility/actions to specific tags/folders. | P1 | Octo, ML | **planned** |
| Per-profile sharing | `ProfileSharing { visibleToRoles }`; extend to explicit per-user/per-role grants + per-profile passwords. | P0/P1 | Octo, ML, ADS | **partial** (`sharing` field on `Profile`; explicit grants/password **planned**) |
| Profile transfer (org) | Move profile ownership between teams/members. | P1 | Octo, ML | **planned** |
| Seats | Plan-bounded member count; seat enforcement on invite. | P1 | all | **planned** (tie to Subscription) |
| Activity / audit log | Immutable log of profile/team/API actions (who, what, when, from where); filter + export. | P0/P1 | Octo, ML, ADS | **done (T-022)** — team-scoped cursor feed + instrumented profile/api-key events; filter/export + teams/auth events still planned |

**Parity note:** admin/member + shared profiles is in place. The enterprise wedge — **granular RBAC,
tag-scoped access, per-profile passwords, and immutable audit export** — is the P1 build that unlocks
larger accounts.

---

## 6. Automation

First-class programmatic control. **Full reference: `api-reference.md`.**

| Sub-feature | Detail | Priority | Parity | Status |
|---|---|---|---|---|
| Local API | Axum HTTP/WS on loopback (`127.0.0.1:53211`), `/api/v1`, `{code,data,msg}` envelope, Bearer key. | P0 | all | **done** (`local_api.rs`) |
| Core endpoints | `POST /profile/start` → `StartProfileResult { ws, debuggerAddress, webDriver?, pid }`; `POST /profile/stop`; `GET /profile/list`; `GET /profile/status`; `GET /health`. | P0 | Octo, ADS | **done** |
| Profile CRUD over API | Create/update/delete/list profiles programmatically (AdsPower/Octo-compatible). | P1 | ADS, Octo | **partial** (`list` live; create/update/delete over local API **planned**) |
| Auth + rate limits | Bearer `LOBSTER_API_KEY`; per-endpoint/per-key rate limiting. | P0/P1 | all | **partial** (Bearer **done**; per-key rate limit **planned**) |
| Selenium | `debuggerAddress` returned for `ChromeOptions`. | P0 | all | **done** (contract + recipe) |
| Playwright | `ws` for `connectOverCDP`. | P0 | all | **done** |
| Puppeteer | `browserWSEndpoint` = `ws`. | P0 | all | **done** (same ws) |
| SDKs | Python + JS clients; C# planned. | P0/P2 | ADS, GL | **partial** (`local-api-sdk` Py + JS **done**; C# **planned**) |
| MCP server | MCP wrapper exposing start/stop/list/status + profile ops to AI agents. | P2 | (new/differentiator) | **planned** |
| Headless | `headless` flag on `start`. | P1 | all | **partial** (flag in contract) |
| Cloud-run | Launch/drive a profile in the cloud (browser not on the user's machine). | P2 | Octo, ML, GL | **planned** |
| Human-like input | Non-linear mouse paths + realistic timing library for automation. | P1 | Dolphin, Kameleo | **done (T-024)** — seeded Bézier mouse paths + typing cadence + CDP dispatch (`humanize`); correlated tremor still planned |
| Scenario / RPA | Visual no-code automation builder (steps, loops, variables, data sources). | P2 | ADS, Dolphin, GL | **planned** |
| Sync automation | Batch-open/close, group actions, synchronized multi-profile input. | P2 | ADS, GL | **planned** |

**Parity note:** the connect surface (Selenium + Playwright + Puppeteer via one `start` call) matches
AdsPower/Octo with near-zero porting friction — a genuine strength today. **RPA builder, human-like
input, cloud-run, and MCP** are the roadmap differentiators.

---

## 7. Cloud & sync

Encrypted, versioned, restorable cloud state; the server is zero-plaintext.

| Sub-feature | Detail | Priority | Parity | Status |
|---|---|---|---|---|
| Encrypted sync | Client-side AES-encrypted profile blob (cookies/storage/seed) → S3; Postgres stores only `encryptedBlobRef` + non-secret metadata. | P0 | Octo, ML, ADS, GL | **done** (push/pull; blob store S3 + in-memory) |
| Push / pull | `POST /profiles/:id/sync { direction: push\|pull, payload?, baseVersion? }`. | P0 | all | **done** |
| Versioning + conflict | Optimistic concurrency: `baseVersion` mismatch on push → **409**; monotonic version per profile. | P0 | Octo, ML | **done** |
| Conflict resolution UX | Surface conflicts in desktop; choose keep-local / keep-remote / merge. | P1 | ML | **planned** |
| Backup / restore | Full-account export of all encrypted blobs + metadata; restore into a fresh install. | P1 | Octo, ADS | **planned** |
| Cloud-run profiles | Server-hosted browser sessions; simultaneous-launch metering. | P2 | Octo, ML, GL | **planned** |
| Zero-knowledge / per-team KMS | Per-team key management so even the operator cannot decrypt. | P2 | ML | **planned** |

**Parity note:** encrypted, versioned sync with server-opaque blobs already matches the incumbents'
core promise. **Cloud-run and per-team KMS** are the up-market roadmap.

---

## 8. Billing & plans

Stripe-metered subscriptions with feature gates + usage limits. (Backend is a **stub** today —
`BillingService.createCheckoutSession` / `handleWebhook` return placeholders; Stripe SDK is a
declared dep, wiring pending.)

### 8.1 Plan / tier matrix

`PlanTier = free \| pro \| team \| enterprise` (in `shared-types` + Prisma enum). Proposed gates/limits:

| Capability | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| Profiles (`profileLimit`) | 10 | 100 | 500 (pooled) | Custom |
| Seats | 1 | 1 | Up to 10 | Custom |
| Engines | Chromium | Lobium + Chromium | Lobium + Chromium | + mobile/beta |
| Fingerprint editor | Basic params | Full 50+ | Full 50+ | Full 50+ |
| Proxy store / bulk | — | ✓ | ✓ | ✓ + provider integrations |
| Encrypted cloud sync | Manual, 1 device | ✓ | ✓ | ✓ + per-team KMS |
| Team sharing / RBAC | — | — | admin/member | Granular RBAC + tag-scoped |
| Audit log | — | 7-day | 90-day | Immutable + export |
| Local automation API | ✓ (low RPM) | ✓ | ✓ | ✓ (high RPM) |
| API rate (RPM) | 30 | 120 | 300 | Custom |
| Cloud-run minutes | — | — | Add-on | Included pool |
| Support | Community | Email | Priority | SLA + CSM |
| Price (indicative) | $0 | $/mo | $$/mo | Contact |

### 8.2 Metering axes

| Axis | Meter | Enforcement point |
|---|---|---|
| Profiles | `Subscription.profileLimit` vs provisioned count | On create (backend) |
| Seats | plan seat cap vs memberships | On invite |
| API rate | RPM per key/plan | Local API + backend gateway |
| Cloud minutes | metered usage records → Stripe meter events | Cloud-run service |

### 8.3 Lifecycle

| Sub-feature | Detail | Priority | Parity | Status |
|---|---|---|---|---|
| Checkout | `POST /billing/checkout { teamId, tier }` → Stripe Checkout session URL. | P0 | all | **partial** (stub URL; real Stripe **planned**) |
| Webhooks | `POST /billing/webhook` (raw body + signature verify) → activate/sync/downgrade on `checkout.session.completed` / `subscription.updated` / `.deleted`. | P0 | all | **partial** (stub ack; verification **planned**) |
| Trials | `SubscriptionStatus.trialing`; time-boxed trial with feature access. | P1 | all | **partial** (status enum exists) |
| Upgrade / downgrade | Proration; immediate gate changes; profile-count guardrails on downgrade. | P1 | all | **planned** |
| Dunning | `past_due` handling: retries, grace period, soft-lock, notifications. | P1 | all | **planned** (status enum exists) |
| Usage UI | Show current usage vs limits; upgrade CTA when near cap. | P1 | all | **planned** |

**Parity note:** metering-on-profile-count matches the market's simplest model; the **multi-axis
metering (seats/RPM/cloud minutes)** and **dunning** are what a production SaaS needs and are the
main billing gap (currently stubbed).

---

## 9. Desktop app

Cross-platform Tauri agent (Rust core + React/TS custom UI).

| Sub-feature | Detail | Priority | Parity | Status |
|---|---|---|---|---|
| Multi-OS | Windows (first), macOS (Intel + ARM), Linux. | P0/P1 | all | **partial** (Tauri shell boots; packaging per-OS **planned**) |
| Installer / packaging | Signed installers; bundle sidecar; engine download-on-first-run (binaries not committed). | P0 | all | **planned** (Day 8) |
| Auto-update | Delta updates + signature check; channel (stable/beta). | P1 | all | **planned** |
| Onboarding | First-run: sign-in, create first profile, attach proxy, launch. | P0 | all | **planned** |
| Settings | Engine paths, default engine/OS, local API port + key, proxy defaults, telemetry opt-in, theme, language. | P1 | all | **partial** (Settings nav item exists) |
| i18n | Localized UI (EN first; RU/ZH/… next — the incumbents' key markets). | P2 | Octo, ADS, GL | **planned** |
| Accessibility | Keyboard nav, focus states, ARIA, contrast; screen-reader labels. | P1 | (differentiator) | **partial** (semantic form labels present) |
| Telemetry (opt-in) | Anonymous, opt-in usage/crash reporting; off by default. | P2 | some | **planned** |
| Licensing / activation | Account-bound activation; offline grace; device binding. | P1 | Octo, ML | **planned** |
| Single-instance lock | One profile → one running session (see §1). | P0 | all | **partial** |

**Parity note:** Tauri gives us a smaller, faster agent than the Electron-based incumbents — a real UX
edge — but **packaging, auto-update, onboarding, i18n, and licensing** are still to build.

---

## 10. UX / UI

Fully custom design system (not derived from any competitor). Sidebar shell already scaffolds the
top-level information architecture: **Profiles · Proxies · Automation · Team · Settings**.

### 10.1 Screen inventory

| Screen | Purpose | Status |
|---|---|---|
| App shell / sidebar nav | Profiles · Proxies · Automation · Team · Settings; active-view routing. | **done** |
| Profiles list | Grid/table of profiles: name, engine, OS, status, proxy geo, tags; row actions (launch/stop/clone/edit/delete). | **partial** (`ProfileList` + `ProfilesView`) |
| New / edit profile | Create + edit form; engine/OS pickers, proxy attach, tags/folder/notes. | **partial** (`NewProfileForm`) |
| Fingerprint editor | Per-group param editor; blank = seed-derived. | **partial** (`FingerprintEditor`) |
| Proxy manager | Proxy store, add/paste, test button + geo result, quality warnings. | **planned** (nav item exists) |
| Automation | API key management, local API status/port, connect recipes, SDK links. | **planned** (nav item exists) |
| Team | Members, roles, invitations, sharing, audit log. | **planned** (nav item exists) |
| Settings | App/engine/API/telemetry/theme/language. | **planned** (nav item exists) |
| Onboarding / sign-in | Auth + first-profile wizard. | **planned** |
| Billing / plan | Current plan, usage vs limits, upgrade/checkout. | **planned** |

### 10.2 Key user flows

1. **Onboarding:** launch → sign-in/register (`/auth`) → create team → create first profile → attach
   proxy → launch → connected browser. (Auth **done**; wizard **planned**.)
2. **Create profile:** New profile → name/engine/OS → (auto seed) → optional overrides in fingerprint
   editor → attach proxy (geo auto-derived) → save. (**partial**.)
3. **Launch:** select profile → launch → status `launching→running`; single-instance lock; stop.
   (**partial** — API + status **done**, UI wiring **partial**.)
4. **Proxy-attach:** add/select proxy → test (`ProxyTestResult`) → geo drives locale/timezone/languages
   coherence → bound to profile. (Geo derivation **done**; UI **planned**.)
5. **Team-invite:** admin → Team → invite by email + role → member joins → shared profiles visible.
   (Backend **done**; UI **planned**.)
6. **Sync:** edit profile locally → push encrypted blob (`/profiles/:id/sync`) → pull on another
   device; conflict → 409 → resolve. (Push/pull/conflict **done**; resolution UX **planned**.)

### 10.3 Design-system principles

- **Own system, not a clone:** custom tokens (color/spacing/typography), components, and iconography.
- **Coherence-forward UI:** surface the "one device story" — show when fingerprint + proxy geo agree
  (green) or drift (warning).
- **Density with clarity:** power-user tables (hundreds of profiles) + calm defaults; keyboard-first.
- **Honest status:** explicit engine badge (Lobium vs Chromium), profile status, sync state.
- **Safe by default:** blank override = seed-derived; destructive actions confirmed; secrets masked.
- **Accessible:** semantic labels, focus rings, contrast, ARIA on all interactive controls.

**Parity note:** UX is a chosen battleground — incumbents' UIs are dense and dated. A distinctive,
fast, accessible design system is a differentiator, not just parity.

---

## 11. Cross-cutting: QA / anti-detect validation

Not a user feature but a product guarantee (MASTER_PLAN Pillar 6). Detector matrix — CreepJS,
Pixelscan, Sannysoft, Iphey, browserleaks, FingerprintJS + WebRTC-leak + coherence — as an objective
**CI gate**. Status: **partial** (validation harness scaffolded; full matrix + gate maturing).

---

## 12. Phased product roadmap

### Phase 1 — Launch (v1, the 10-day product)
Profiles CRUD + clone + bulk-create + import/export; real-system fingerprints (seed-stable, coherent) +
editor over JS-safe surfaces; per-profile proxy + test + geo-sync; single-instance lock + status;
local automation API (start/stop/list/status → Selenium + Playwright + Puppeteer) + Bearer auth +
Py/JS SDK; encrypted cloud sync (push/pull + version conflict); auth + teams (admin/member) + profile
sharing; Stripe billing metered on profiles; Windows installer + engine download-on-first-run;
detector-matrix CI gate; **Lobium build pipeline + first native patch + config-channel POC**.

### Phase 2 — Depth & teams
Extensions + bookmarks + history + passwords persistence/sync; profile templates + folders/search/
filters UI; granular RBAC + tag-scoped access + per-profile passwords + immutable audit export;
proxy store + rotation + provider integrations; per-key API rate limiting + profile CRUD over API +
C# SDK + **MCP server**; multi-axis billing (seats/RPM) + trials/dunning + usage UI; macOS + Linux
packaging + auto-update + onboarding wizard + Settings/i18n; conflict-resolution UX + backup/restore.
**Lobium:** progressive native coverage (canvas/WebGL/audio farbling), becomes selectable default.

### Phase 3 — Scale & moat
Cloud-run profiles + simultaneous-launch metering + cloud phones; mobile/Android Lobium variant;
human-like input library + no-code RPA/scenario builder + sync automation; disposable profiles +
cookie robot/warm-up; proxy marketplace/rotation pools; per-team KMS / zero-knowledge sync;
full native 50+ param enforcement + TLS/JA3/JA4 + HTTP/2 + WebGPU; multi-OS signed Lobium builds +
notarization + continuous Chrome-stable rebase → **Lobium is the default engine**.

---

## 13. Master feature matrix

| Feature area | Sub-features | Priority | Competitor parity | Status |
|---|---|---|---|---|
| **Profiles** | create, read/update/delete, clone, bulk-create, import, export, transfer, tags, folders, search, filters, notes, templates, quick/disposable, single-instance lock, status, cookie-robot/warm-up | P0–P2 | Octo/ML/ADS/GL/Dolphin/Kameleo | **partial** (CRUD **done**; bulk/import/export/templates/warm-up **planned**) |
| **Browser data** | cookies, localStorage, IndexedDB, bookmarks, extensions, history, passwords/autofill — persist + sync | P0–P2 | all | **partial** (cookies **done**; storage **partial**; rest **planned**) |
| **Fingerprints** | real-system source, seed-stable, coherence, 50+ params, editor UI, overrides, mobile/Android, native deep surfaces, WebRTC policy, regenerate | P0–P1 | Octo/ML/Kameleo (depth) | **partial** (JS-safe **done/partial**; native/mobile **planned**) |
| **Proxy** | types, per-profile attach, test/IP-check, geo-sync, quality signals, store/library, rotation, providers, marketplace | P0–P2 | all | **partial** (parse+geo **done**; store/rotation/providers **planned**) |
| **Teams** | teams, roles, invitations, membership mgmt, granular RBAC, tag-scoped access, per-profile sharing/password, transfer, seats, audit log | P0–P1 | Octo/ML/ADS | **partial** (teams+admin/member+sharing field **done**; RBAC/audit/seats **planned**) |
| **Automation** | local API, core endpoints, profile CRUD over API, auth+rate limits, Selenium/Playwright/Puppeteer, SDKs (Py/JS/C#), MCP, headless, cloud-run, human-like input, RPA, sync automation | P0–P2 | Octo/ADS/GL/Dolphin | **partial** (API+connect+Py/JS SDK **done**; MCP/RPA/cloud-run/C# **planned**) |
| **Cloud/sync** | encrypted sync, push/pull, versioning/conflict, conflict UX, backup/restore, cloud-run, per-team KMS | P0–P2 | Octo/ML/ADS/GL | **partial** (sync+versioning **done**; backup/cloud-run/KMS **planned**) |
| **Billing & plans** | tier matrix (free/pro/team/enterprise), feature gates, metering (profiles/RPM/seats/cloud-min), checkout, webhooks, trials, upgrade/downgrade, dunning, usage UI | P0–P1 | all | **partial** (types+plan model **done**; Stripe **stubbed/planned**) |
| **Desktop app** | multi-OS, installer, auto-update, onboarding, settings, i18n, accessibility, telemetry, licensing, single-instance | P0–P2 | all | **partial** (shell **done**; packaging/update/onboarding/i18n/licensing **planned**) |
| **UX/UI** | screen inventory, key flows, custom design system | P0–P1 | (differentiator) | **partial** (shell + profiles/fp editor **partial**; proxy/team/automation/settings/billing screens **planned**) |
| **QA/validation** | detector matrix CI gate, WebRTC-leak, coherence | P0 | (guarantee) | **partial** |
| **Lobium (engine)** | native build pipeline, quilt patch series, config channel, native deep-surface enforcement, TLS/JA4, mobile variant, multi-OS signed builds | P0 (moat) | Octo/ML | **planned/partial** (build-env + first-patch tickets; native coverage **planned**) |

---

## 14. Status vs target

**Where we are.** The **spine of an Octo-class product is real and in-tree**: profile CRUD with a
deterministic, coherent, real-system fingerprint per seed; a working local automation API that hands
back both a Selenium `debuggerAddress` and a Playwright/Puppeteer CDP `ws` from one `start` call;
encrypted, versioned cloud sync with optimistic-concurrency conflict detection; JWT auth with teams
and admin/member RBAC + a profile-sharing field; the canonical cookie import/export layer; proxy
parsing + exit-IP geo derivation; and Python + JS SDKs. The desktop shell and the first fingerprint-
editor and profiles screens exist. This is a genuinely usable core, honest about running on the interim
Chromium.

**Where the gaps are.** The bulk of Octo-parity **breadth** is still **planned**: bulk-create / clone /
templates / import-export of profiles; extensions / bookmarks / history / passwords persistence;
proxy store / rotation / providers; granular RBAC + tag-scoped access + per-profile passwords +
immutable audit; MCP / RPA / human-like input / cloud-run; multi-axis billing (Stripe is currently a
**stub**) with trials/dunning; desktop packaging / auto-update / onboarding / i18n / licensing; and the
Proxy/Team/Automation/Settings/Billing screens. The **depth** that is the moat — **native deep-surface
fingerprinting in Lobium** (canvas/WebGL/audio farbling + TLS/JA4 + HTTP/2, mobile variant) — is on the
parallel Lobium track, currently at build-environment + first-patch + config-channel-POC stage.

**Net:** foundations and the highest-friction integration surfaces (fingerprint coherence, dual-mode
automation connect, encrypted sync) are **done or partial and solid**; the remaining work is
**breadth of features + native engine depth**, sequenced across Phases 1→3 above. The product is
honestly a **strong v1 core** today, not yet full Octo-class parity — and the roadmap closes that gap
in a deliberate order, with Lobium turning parity into a durable moat.
