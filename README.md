# 🦞 Lobster Browser

A production-grade **anti-detect browser + SaaS** — feature-comparable to Octo Browser, built as a
Rust + Tauri desktop agent that orchestrates native-strength browser engines, backed by a TypeScript
cloud platform.

> **Single source of truth:** [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md).
> Both builder agents (Claude = lead architect/reviewer, OpenAI Codex = primary implementer) must
> follow the [Agent Protocol](docs/agent-protocol.md) and [Coding Standards](docs/coding-standards.md).

## What it is

Lobster gives each browser **profile** a coherent, stable, real-looking device + network identity
(fingerprint), fully isolated from every other profile, consistent enough to pass modern anti-bot
systems. It ships as:

- a **desktop agent** (Rust + Tauri) that manages profiles/proxies and launches engines, and
- a **cloud SaaS** (TypeScript/NestJS) for auth, teams, encrypted profile sync, and billing.

The flagship engine is **Lobium** — our own Chromium-based build with native fingerprinting (50+
configurable params, canvas/WebGL/audio/TLS-JA4) — built on a parallel track. Until the custom build
ships, Lobium is served by a patched Chromium via patchright. Alongside it, the product runs on a
prebuilt (ungoogled) **Chromium** driven via patchright as the interim/everyday engine. The UI/UX is
our own custom design system.

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
  engine-runner/      Node/TS sidecar: launch/control Lobium + Chromium
  local-api-sdk/      Client SDK examples (js/ + python/) for the local automation API
lobium/               Lobium: Chromium build scripts, GN args, quilt patch series, config channel
engines/              Download-on-first-run scripts for the interim Chromium (binaries NOT committed)
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

# Download the pinned interim browser engine (ungoogled-chromium)
node engines/download-engines.mjs
```

## Status

**Native Lobium engine built; product wiring in progress.** A from-source Chromium 152 fork with ~10
native fingerprint surfaces is built and proven **on SwiftShader** (real-GPU validation pending); the
TypeScript orchestrator + NestJS backend are built with ~160 green tests. The engine is **not yet wired
into the product launch path**, cloud blobs are **not yet encrypted**, and there is **no signed
installer** — see the honest, detailed breakdown, critical path, and risk register in
**[`docs/PROJECT-STATUS.md`](docs/PROJECT-STATUS.md)** (the authoritative live tracker).
See [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md) for strategy and [`docs/tickets/`](docs/tickets/) for the
work board.
