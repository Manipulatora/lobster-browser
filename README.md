# 🦞 Lobster Browser

A production-grade **anti-detect browser + SaaS** — feature-comparable to Octo Browser, built as a
Rust + Tauri desktop agent that orchestrates a native-strength Lobium browser kernel, backed by a TypeScript
cloud platform.

> **Strategy:** [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md). **Current reality:**
> [`docs/PROJECT-STATUS.md`](docs/PROJECT-STATUS.md). **Production path:**
> [`docs/PRODUCTION-ROADMAP.md`](docs/PRODUCTION-ROADMAP.md).
> **GPU handoff for the next agent:** [`docs/AGENT-HANDOFF-GPU.md`](docs/AGENT-HANDOFF-GPU.md).
> **Product UI plan:** [`docs/specs/product-ui-ux-plan.md`](docs/specs/product-ui-ux-plan.md).
> Both builder agents (Claude = lead architect/reviewer, OpenAI Codex = primary implementer) must
> follow the [Agent Protocol](docs/agent-protocol.md) and [Coding Standards](docs/coding-standards.md).

## What it is

Lobster gives each browser **profile** a coherent, stable, real-looking device + network identity
(fingerprint), fully isolated from every other profile, consistent enough to pass modern anti-bot
systems. It ships as:

- a **desktop agent** (Rust + Tauri) that manages profiles/proxies and launches engines, and
- a **cloud SaaS** (TypeScript/NestJS) for auth, teams, encrypted profile sync, and billing.

The only production engine is **Lobium** — our own Chromium-based build with native fingerprinting
(50+ configurable params, canvas/WebGL/audio/TLS-JA4) and a per-profile native config channel.
Patchright is allowed only as an internal validation/test harness; it is not a product stealth layer and
not the core engine. The UI/UX is our own custom design system.

Lobster ships **open source**, so we freely import any OSS; Donut Browser and others are reference only.

## Monorepo layout

```
apps/
  desktop/            Rust + Tauri agent (src-tauri/) + React/TS UI (src/) + Axum local API
  backend/            NestJS cloud SaaS (auth, teams, sync, billing)
packages/
  shared-types/       TS types shared across front/back/api/sidecar
  fingerprint/        Seed -> coherent fingerprint model + coherence rules
  proxy/              Proxy testing + exit-IP geo derivation
  engine-runner/      Node/TS sidecar: direct native Lobium launch/control
  local-api-sdk/      Client SDK examples (js/ + python/) for the local automation API
lobium/               Lobium: Chromium build scripts, GN args, quilt patch series, config channel
engines/              Legacy/validation engine helpers; production does not fall back to Chromium
docs/                 Master plan, ADRs, agent protocol, API/IPC contracts, tickets
ci/                   Fingerprint validation harness
tests/                e2e / integration / detector validation suite
```

## Prerequisites

| Tool | Version | Used by |
|------|---------|---------|
| Node | `>=22 <25` (see `.nvmrc`) | all TS packages, backend, sidecar |
| npm | `>=10` | workspace manager |
| Rust | pinned in `rust-toolchain.toml` (currently `1.96.1`) | desktop agent (Tauri) — install via `rustup` |

> The Rust toolchain is **not** required to work on the TS packages/backend/sidecar. Install it
> (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`) when working on `apps/desktop`.

## Getting started

```bash
# Install workspace dependencies (skips heavy browser downloads on install)
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install

# Typecheck the foundational packages (no engine deps required)
npm run typecheck:core

# Build everything that can build
npm run build

# Point the sidecar at a built Lobium binary
export LOBSTER_LOBIUM_BIN=$HOME/lobium-build/src/out/Lobium/chrome
```

## Status

**Engine foundation strong; product not yet beta.** Lobium's native config channel and major
fingerprint surfaces are built and dev-proven on Chromium 152. Native Lobium is wired into the product
launch path when a built binary is discovered via `LOBSTER_LOBIUM_BIN`, `LOBSTER_LOBIUM_DIR`, the local
`~/lobium-build/src/out/Lobium/chrome` dev layout, or a packaged engine resource. If no Lobium binary is
available, launch fails clearly; there is intentionally no uncustomized Chromium/Patchright fallback.

The big missing piece is now **real-hardware, host-calibrated proof**: current detector evidence is still
SwiftShader/headless/dev-box evidence. Host-calibration types and a deterministic
`deriveFingerprintFromHost` helper exist, but there is not yet a first-run host probe/persisted host
profile or real-GPU validation. There is also no signed installer, bundled sidecar, client-side blob
encryption, durable S3 implementation, Postgres CI path, or real Stripe flow yet.

See **[`docs/PROJECT-STATUS.md`](docs/PROJECT-STATUS.md)** for the authoritative live status and
**[`docs/PRODUCTION-ROADMAP.md`](docs/PRODUCTION-ROADMAP.md)** for the path to beta/GA.
