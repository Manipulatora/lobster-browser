# Detailed Specifications — Lobster Browser

This directory holds the **production-depth specs** that sit under [`../MASTER_PLAN.md`](../MASTER_PLAN.md).
The master plan is the strategy and the 10-day shape; these documents are the *executable detail* an
agent needs to implement a subsystem without re-deriving decisions. Read the master plan first, then
the spec for the subsystem you're building.

> ⚠️ **These specs' "Status vs target" tags are STALE (~end of Day 4) and several are wrong** (e.g.
> `lobium-build.md` says nothing native is built; `fingerprint-parameters.md` describes the removed Apify
> architecture and claims canvas/WebGL/audio are unbuilt). For the **authoritative current state**, read
> **[`../PROJECT-STATUS.md`](../PROJECT-STATUS.md)**. Reconciling each spec to reality is tracked as
> **DOC-1** in the PROJECT-STATUS register. Treat the specs as the *build-to target*, not the status.

For the honest current state see [`../PROJECT-STATUS.md`](../PROJECT-STATUS.md); the older Day-4 snapshot
is [`../GAP-ANALYSIS.md`](../GAP-ANALYSIS.md).

## Convention: "Status vs target"

Every spec is written to the **full Octo-class target** and tags each item **done · partial · planned**
against the code that existed at ~end of Day 4 (**now stale — see PROJECT-STATUS**), and closes with a
*Status vs target* note. So each doc is simultaneously (a) the spec to build to and (b) a (dated) map of
the remaining distance.

## The specs

| Spec | Covers | Primary track / owner |
|---|---|---|
| [`feature-catalog.md`](feature-catalog.md) | Every product feature (11 areas + Lobium) with sub-features, P0/P1/P2 priority, competitor-parity note, and status; billing plan/tier matrix + metering axes; desktop screen inventory + key flows; the master feature matrix; the phased Phase 1→2→3 roadmap | Product / all tracks |
| [`fingerprint-parameters.md`](fingerprint-parameters.md) | The **~90-parameter** catalog across 18 surfaces (past the advertised 50+); the coherence engine as a 29-rule constraint set; the seed→config pipeline + determinism invariants; native-Lobium vs interim JS-safe mapping; the 11-panel editor UI grouping | B · Fingerprint (Claude) |
| [`data-model.md`](data-model.md) | Full cloud Postgres schema (6 built + 9 planned tables, DDL-level) + local SQLite schema; the three encryption boundaries; data lifecycle (retention, export, GDPR erasure); Prisma migration strategy | C · Backend (Codex) |
| [`api-reference.md`](api-reference.md) | The local automation API (per-endpoint schemas, error codes, connect recipes) + the cloud REST API (auth, teams, profiles, sync, billing) + webhooks + SDKs + the MCP server + versioning policy | D · Automation (Claude/Codex) |
| [`security.md`](security.md) | The 3-tier key hierarchy + AES-GCM blob envelope + zero-knowledge model; auth upgrade path (refresh rotation, 2FA, SSO, API-key scoping); RBAC permission matrix; threat model; secrets, supply-chain, and anti-abuse | Security (Claude) |
| [`lobium-build.md`](lobium-build.md) | The custom-Chromium build pipeline (toolchain, pinned ref, rebase cadence, GN args); the ordered native **patch series** (one per fingerprint domain, incl. TLS/JA4 + HTTP/2); the config-channel wire protocol; multi-OS signing + auto-update; the Android variant | F · Lobium (Claude) |
| [`proxy.md`](proxy.md) | Proxy type matrix (HTTP/SOCKS5/SSH/TOR); chaining + rotation + pools; provider integrations; testing + IP-quality; the geo-coherence pipeline; leak protection; the SOCKS-in-launcher fix | Proxy (Codex) |
| [`qa-testing.md`](qa-testing.md) | The 7-layer testing pyramid; the detector matrix + `thresholds.json` target schema; live anti-bot testing; the coherence validator rule set; **performance targets + non-functional requirements / SLOs**; release-gate → CI mapping | E · QA (Claude) |
| [`observability-ops.md`](observability-ops.md) | Structured logging + metrics + tracing + error tracking; backend deployment (Dockerfile, environments, migrate-deploy); backups/DR + RTO/RPO; rate limiting + queues; desktop signing + auto-update; release process; monitoring/alerting/SLOs; billing ops | Ops (Claude/Codex) |

## How these feed the plan

- New **tickets** (`../tickets/`) are cut from the *planned* items in these specs — the spec is the
  ticket's reference, so ticket bodies stay short.
- The **non-functional targets** (perf, scale, uptime, RTO/RPO) live in `qa-testing.md` §6–§7 and are
  summarized in [`../MASTER_PLAN.md` §15](../MASTER_PLAN.md).
- The **risk/gap register** in [`../MASTER_PLAN.md` §16](../MASTER_PLAN.md) is the condensed, prioritized
  view of the *planned* work these specs enumerate; `../GAP-ANALYSIS.md` is the narrative behind it.
