# Ticket Board — Lobster Browser

Work happens one ticket at a time (see [agent-protocol.md](../agent-protocol.md)). Claude authors
tickets; the assigned agent implements; the other agent reviews. Keep this table current.

| ID | Title | Pillar / Track | Assignee | Status |
|----|-------|----------------|----------|--------|
| T-001 | Tauri shell boots + loads React UI shell | A · Desktop | Codex | done · desktop crate builds (Rust 1.96.1 + webkit2gtk); SQLite store + Axum local API + IPC commands cargo-tested; GUI window needs a display |
| T-002 | Sidecar: real engine launch (patchright) | B · Engine | Claude | done · T-002a builders + T-002b orchestration + **T-002c real patchright launch verified**: live Chromium, `connectOverCDP`, `navigator.webdriver` stealth, status/stop; CI `engine-launch` job. Covers `chromium` + `lobium` (interim patched Chromium). JS-safe surfaces applied via **CDP** (main world) |
| T-002d | Propagate CDP fingerprint overrides to external `connectOverCDP` client pages (Target.setAutoAttach) | B · Engine | Claude | draft · launcher covers its own context's pages; external-client pages need auto-attach |
| T-003 | Fingerprint: integrate Apify fingerprint-suite behind `deriveFingerprint` | Fingerprint | Codex | done |
| T-004 | Backend: JWT auth + real data layer | C · Backend | Codex | done · bcrypt+JWT, guard, `/auth/me`, e2e; Prisma repo/module + `0001_init` migration + docker-compose (Postgres path via CI/infra), JWT hard-fails in prod |
| T-005 | Anti-detect validation harness (live detector gate) | E · QA | Claude | done · derive fp → headful (Xvfb) launch → bot.sannysoft.com; asserts UA/hardwareConcurrency/languages/timezone applied + `navigator.webdriver` absent; 2 WebGL fails expected (native surface, Lobium); CI `fingerprint-gate` blocking. Caught+fixed a real bug (CDP override, not isolated-world addInitScript) |
| T-006 | Add `apps/desktop` + `apps/backend` to root workspaces | infra | Claude | done |
| T-007 | Profile CRUD Tauri commands + single-instance lock | A · Desktop | Claude | done · real SQLite-backed create/get/update/delete/list commands (cargo-tested); single-instance launch lock lands with T-002c engine wiring |
| T-008 | Fingerprint editor UI (JS-safe surfaces) | A · Desktop | Codex | done |
| T-009 | Unit tests: fingerprint determinism/coherence + proxy parse | tests | Claude | done |
| T-013 | Backend Teams + Profiles (real, JWT-scoped, plan limit) | C · Backend | Codex | done · repos (Prisma+in-memory), @CurrentUser, team scoping, e2e |
| T-014 | Proxy: exit-IP geo derivation + proxy test (coherence auto-sync) | Proxy | Codex | done · `deriveGeoFromExitIp` (undici ProxyAgent, HTTP/HTTPS; SOCKS follow-up), `parseGeoResponse`, `testProxy`; applied to fingerprint at launch |
| T-015 | Cookie import/export (JSON + Netscape) — `@lobster/cookies` | Fingerprint | Codex | done · canonical `Cookie` + parse/serialize both formats, 8 tests |
| T-016 | Backend cloud sync (client-encrypted blob push/pull + versioning) | C · Backend | Codex | done · BlobStore (in-memory + S3 stub), push/pull, version bump, stale-baseVersion conflict, e2e |
| T-017 | Local automation API: Rust core → sidecar → real launch | A/B · Desktop | Claude | done · `SidecarClient` (spawn node, JSON-RPC, reader task), `POST /profile/start` → store → sidecar `startProfile` (derive fp from seed+overrides+geo) → CDP endpoint; Bearer auth; cargo ping/status test + Node startProfile live-launch test |
| T-010 | Lobium: build environment + first Chromium build | F · Lobium | Claude | ready |
| T-011 | Lobium: quilt series + first native patch + config channel POC | F · Lobium | Claude | ready |
| T-012 | Fingerprint: 50+ param model + Android/mobile profiles | Fingerprint | Codex | draft |
| T-018 | Fingerprint coherence & geolocation-application hardening | Fingerprint | Claude | done · [`setGeolocationOverride`](T-018-fingerprint-coherence-geolocation.md) applied (was computed but never sent) + launcher grants geo permission; clean `navigator.languages` (q-value leak fixed); init-script abort bug fixed; coherence rules incl. Win-NT↔Chrome floor, **HeadlessChrome-brand + 256 MB-desktop tells** (found by adversarial review); 94 unit tests + live gate green |
| T-018a | q-weighted `Accept-Language` HTTP header (keep clean `navigator.languages`) | Fingerprint | Claude | draft · follow-up from T-018 |
| T-019 | WebRTC leak protection + validation-gate integration | Proxy | Claude | done · [proxy-aware `--force-webrtc-ip-handling-policy`](T-019-webrtc-leak-protection.md) (`disable_non_proxied_udp` when proxied); non-vacuous gate proves the policy suppresses the STUN public-IP srflx (v4+v6) + mDNS local masking; hardened after adversarial review; 95 tests + live gate green |
| T-019a | Assert `srflx == proxy egress IP` against a live test proxy (CI secret) | Proxy · QA | Claude | draft · follow-up from T-019 |

**Status legend:** `draft` (spec not final) · `ready` (spec final, unassigned work can start) ·
`in-progress` · `in-review` · `done`.

**Statuses map to the plan** in [`../MASTER_PLAN.md` §10](../MASTER_PLAN.md). **Day 0 complete.**
**Day 1 landed** (all verifiable-here work): T-003, T-004 (auth), T-006 done; T-002a (engine launch
builders) done; desktop frontend type-clean. Remaining Day 1 items are **infra-gated** in this
environment and need a build machine: T-001 (rustup/Tauri), T-002b (browser binaries), T-005 (real
browser+GPU), T-010/T-011 (Chromium build farm). **T-010/T-011** start the parallel Lobium
track (F). Donut Browser is **reference only** — we build our own Lobium engine and UI/UX.
