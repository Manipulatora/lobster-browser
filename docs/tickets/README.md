# Ticket Board — Lobster Browser

Work happens one ticket at a time (see [agent-protocol.md](../agent-protocol.md)). Claude authors
tickets; the assigned agent implements; the other agent reviews. Keep this table current.

| ID | Title | Pillar / Track | Assignee | Status |
|----|-------|----------------|----------|--------|
| T-001 | Tauri shell boots + loads React UI shell | A · Desktop | Codex | done · desktop crate builds (Rust 1.96.1 + webkit2gtk); SQLite store + Axum local API + IPC commands cargo-tested; GUI window needs a display |
| T-002 | Sidecar: real engine launch (patchright) | B · Engine | Claude | done · T-002a builders + T-002b orchestration + **T-002c real patchright launch verified**: live Chromium, `connectOverCDP`, `navigator.webdriver` stealth, status/stop; CI `engine-launch` job. Covers `chromium` + `lobium` (interim patched Chromium) |
| T-003 | Fingerprint: integrate Apify fingerprint-suite behind `deriveFingerprint` | Fingerprint | Codex | done |
| T-004 | Backend: JWT auth + real data layer | C · Backend | Codex | done · bcrypt+JWT, guard, `/auth/me`, e2e; Prisma repo/module + `0001_init` migration + docker-compose (Postgres path via CI/infra), JWT hard-fails in prod |
| T-005 | Validation harness: host CreepJS/Sannysoft + score scraper | E · QA | Claude | ready · needs a real browser+GPU |
| T-006 | Add `apps/desktop` + `apps/backend` to root workspaces | infra | Claude | done |
| T-007 | Profile CRUD Tauri commands + single-instance lock | A · Desktop | Claude | done · real SQLite-backed create/get/update/delete/list commands (cargo-tested); single-instance launch lock lands with T-002c engine wiring |
| T-008 | Fingerprint editor UI (JS-safe surfaces) | A · Desktop | Codex | done |
| T-009 | Unit tests: fingerprint determinism/coherence + proxy parse | tests | Claude | done |
| T-013 | Backend Teams + Profiles (real, JWT-scoped, plan limit) | C · Backend | Codex | done · repos (Prisma+in-memory), @CurrentUser, team scoping, e2e |
| T-010 | Lobium: build environment + first Chromium build | F · Lobium | Claude | ready |
| T-011 | Lobium: quilt series + first native patch + config channel POC | F · Lobium | Claude | ready |
| T-012 | Fingerprint: 50+ param model + Android/mobile profiles | Fingerprint | Codex | draft |

**Status legend:** `draft` (spec not final) · `ready` (spec final, unassigned work can start) ·
`in-progress` · `in-review` · `done`.

**Statuses map to the plan** in [`../MASTER_PLAN.md` §10](../MASTER_PLAN.md). **Day 0 complete.**
**Day 1 landed** (all verifiable-here work): T-003, T-004 (auth), T-006 done; T-002a (engine launch
builders) done; desktop frontend type-clean. Remaining Day 1 items are **infra-gated** in this
environment and need a build machine: T-001 (rustup/Tauri), T-002b (browser binaries), T-005 (real
browser+GPU), T-010/T-011 (Chromium build farm). **T-010/T-011** start the parallel Lobium
track (F). Donut Browser is **reference only** — we build our own Lobium engine and UI/UX.
