# Gap Analysis & Self-Assessment — Lobster Browser

> ⚠️ **HISTORICAL SNAPSHOT (~end of Day 4).** For the **current** status and the prioritized
> remaining-work breakdown, see **[`PROJECT-STATUS.md`](PROJECT-STATUS.md)** — it supersedes this doc for
> "where are we now." Much of "gap #1: Lobium not built" is now **done**: Lobium is built from source with
> major native surfaces and a native detector script, still pending real-GPU/host-calibrated proof. This doc is kept for the reasoning trail and its
> mapping of gaps -> detailed specs, which remain useful. The body below is not authoritative for current
> maturity; several historical rows still describe the pre-Lobium state.
>
> An honest mid-sprint review (~end of Day 4). It reminisces the path built so far, confirms what is
> genuinely solid, and admits the gaps between "green demo" and a **perfect Octo-class product**. It
> then maps every gap to the detailed spec that now closes it ([`docs/specs/`](specs/)) and to a
> phased path. This is the "admit the gaps" companion to [`MASTER_PLAN.md`](MASTER_PLAN.md).

---

## 1. The path so far (what is actually built + verified)

Everything below is **verified green** (typecheck + tests + the live detector gate), not aspirational.

| Area | Built | Verification |
|---|---|---|
| Monorepo + foundations | npm workspaces, `shared-types`, CI (build/typecheck/test/secret-scan + fingerprint gate) | Day 0 |
| Fingerprint engine | `deriveFingerprint` on Apify **real-device** data, deterministic (seeded), coherent; `applyGeoToFingerprint`, `applyOverrides`, `validateFingerprintCoherence` | 10 tests |
| Engine launch | **real patched Chromium** via patchright; `CompositeRunner` (single-instance, status/stop); JS-safe surfaces applied via **CDP** (not isolated-world) | engine-runner 12 tests incl. **2 live launches** |
| Anti-detect validation | harness: derive fp → **headful (Xvfb) launch** → **bot.sannysoft.com** → asserts UA/hardwareConcurrency/languages/timezone applied + `navigator.webdriver` absent; CI gate | **verdict: pass** (2 WebGL fails expected) |
| Desktop core (Rust/Tauri) | SQLite profile store + CRUD Tauri commands; **local automation API** (Axum) → `SidecarClient` (JSON-RPC to the Node sidecar) → `startProfile` (derive fp from seed) → real CDP endpoint; Bearer auth | cargo 4 tests (incl. sidecar bridge) + fmt/clippy clean |
| Backend (NestJS) | bcrypt+JWT auth + guard + `/auth/me`; **teams + memberships + roles**; **profiles** (repo factory, team-scoped, plan limit, unique seeds); **cloud sync** (client-encrypted blob push/pull + versioning + conflict); Prisma schema + `0001_init` migration + docker-compose | 27 tests |
| Proxy | `deriveGeoFromExitIp` (through the proxy, undici), `parseGeoResponse`, `testProxy` | 14 tests |
| Cookies | `@lobster/cookies` — Netscape + Playwright/CDP JSON parse/serialize | 8 tests |
| Engine strategy | **two engines**: `lobium` (our custom Chromium build — flagship) + `chromium` (interim); Camoufox dropped | ADR-0003/0004 |

**Totals: ~75 automated tests green + a live detector gate.** The architecture (engine-agnostic control plane, TS derive → CDP apply, Rust ↔ sidecar) is sound and the validation gate already earned its keep (it caught a real `hardwareConcurrency` isolation-world bug that the CDP fix closed).

---

## 2. What is genuinely solid (confirmed)

- **Engine-agnostic architecture** — Lobium drops in behind the same sidecar contract without touching the control plane.
- **Coherence-first fingerprinting** — real-device data + a validator + a seeded, stable, deterministic model.
- **The validation gate is real** — headful, live detector, asserts the fingerprint *actually applied* (not just "a browser launched").
- **End-to-end automation path** — `POST /profile/start` → store → sidecar → real Chromium → CDP `ws`/`debuggerAddress`, all verified.
- **Honest interim posture** — we never spoof deep surfaces from JS; the harness reports the WebGL gap rather than hiding it.

---

## 3. Honest gaps (green demo → perfect product)

Ranked by impact on being an **Octo-class** product.

1. **Lobium real-hardware proof is not done** — the moat exists on the dev path, but current native proof is still SwiftShader/headless. The remaining engine gap is real consumer-GPU validation, host calibration, native CI, multi-OS builds, and TLS/JA4/HTTP2 depth. → [`specs/lobium-build.md`](specs/lobium-build.md), [`PRODUCTION-ROADMAP.md`](PRODUCTION-ROADMAP.md).
2. **Fingerprint production model is not host-calibrated yet** — the fallback catalog/coherence path is real, and major native deep surfaces now exist, but `deriveFingerprint` still does not derive from a captured host profile. → [`specs/fingerprint-parameters.md`](specs/fingerprint-parameters.md), [`PRODUCTION-ROADMAP.md`](PRODUCTION-ROADMAP.md).
3. **Security & key management** — "AES blobs" is conceptual. **Client-side encryption, per-team key hierarchy, zero-knowledge, 2FA, session/device management, SSO** are not implemented. → [`specs/security.md`](specs/security.md).
4. **Proxy depth** — HTTP/HTTPS geo works; **SOCKS5 in the launcher, chaining, rotation, providers, IP-reputation, DNS-over-proxy, kill-switch** are not, and the geo→fingerprint sync is wired but not live-tested (no real proxy in the sandbox). → [`specs/proxy.md`](specs/proxy.md).
5. **Cloud runtime not exercised** — the Prisma/Postgres path is wired + migrated but only runs where a DB exists; **billing metering is minimal**, **RBAC is coarse** (admin/member), no granular/tag-scoped perms. → [`specs/data-model.md`](specs/data-model.md), [`specs/feature-catalog.md`](specs/feature-catalog.md).
6. **Desktop app lifecycle** — no GUI run yet; **packaging, code-signing, notarization, auto-update, onboarding, i18n, crash reporting, telemetry** are absent. The UI's Launch button routes to the local API (not yet a shared in-process sidecar). → [`specs/observability-ops.md`](specs/observability-ops.md).
7. **Observability / ops / deployment** — no logging/metrics/tracing/error-tracking, no backend deploy pipeline, backups/DR, rate-limiting, or monitoring. → [`specs/observability-ops.md`](specs/observability-ops.md).
8. **Testing breadth** — strong unit/integration + **one** detector (Sannysoft). Missing **CreepJS/Pixelscan/Iphey/browserleaks**, **live anti-bot** (Cloudflare/DataDome/Akamai/Kasada), **load/perf/security** tests, and NFR targets. → [`specs/qa-testing.md`](specs/qa-testing.md).
9. **Browser data breadth** — cookies (format) done; **localStorage/IndexedDB, extensions, bookmarks, history, autofill** persistence/sync are not; no cookie-robot/warm-up. → [`specs/feature-catalog.md`](specs/feature-catalog.md).
10. **Android fingerprints** — TypeScript catalog/coherence exists, but Android is still not a
    launchable product path. Android is an Android-only APK/device-runner track, not a generic mobile
    bucket. → [`specs/android.md`](specs/android.md).
11. **Automation breadth** — local API done; **official SDKs (Py/JS/C#), MCP server, cloud-run, human-like input, RPA** are not. → [`specs/api-reference.md`](specs/api-reference.md).

---

## 4. Why the PLAN itself needed enrichment

The master plan was strong on *strategy* but thin on *executable depth*. The following did not exist and are now written as detailed specs under [`docs/specs/`](specs/):

| Missing detail | Now specified in |
|---|---|
| The actual **50+ fingerprint parameter catalog** + coherence engine | `specs/fingerprint-parameters.md` |
| Full **data model** (cloud + local schemas, encryption boundaries, lifecycle) | `specs/data-model.md` |
| Full **API spec** (local + cloud REST + webhooks + SDK + MCP) | `specs/api-reference.md` |
| **Security & key-management** design (client-side crypto, 2FA, threat model) | `specs/security.md` |
| Detailed **Lobium build & native patch series** + config-channel protocol | `specs/lobium-build.md` |
| **Proxy subsystem** depth (types, chaining, rotation, providers, leaks) | `specs/proxy.md` |
| **Testing strategy + non-functional requirements** (perf/scale/SLOs) | `specs/qa-testing.md` |
| **Observability, deployment, ops, release** | `specs/observability-ops.md` |
| Complete **feature catalog** + plan matrix + phased roadmap + UX flows | `specs/feature-catalog.md` |

---

## 5. Path to a perfect product (phased)

- **Finish the sprint's product surface (Days 5–10):** billing/metering, granular RBAC + audit, localStorage/extension sync, SOCKS proxy + rotation, packaging + signing + auto-update, SDKs, the full detector matrix, and observability basics.
- **Phase 2 — the moat (Lobium):** stand up the build, land the native patch series (canvas/WebGL/audio, then **TLS/JA4 + HTTP2**), wire the config channel to all 50+ params, make Lobium the default engine, multi-OS signed builds + rebase automation.
- **Phase 3 — scale & depth:** cloud-run profiles, Android Lobium/device runner, proxy marketplace, MCP + official SDKs, granular org/RBAC, enterprise SSO, human-like input, higher-scale billing.

Each phase's features and their acceptance criteria are enumerated in [`specs/feature-catalog.md`](specs/feature-catalog.md); the non-functional targets are in [`specs/qa-testing.md`](specs/qa-testing.md).
