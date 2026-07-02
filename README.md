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

The flagship engine is the **Lobster Kernel** — our own Chromium-based build with native
fingerprinting (50+ configurable params, canvas/WebGL/audio/TLS-JA4) — built on a parallel track. Until
it's the default, the product runs on two interim engines: **ungoogled-Chromium** (default, via
patchright) and **Camoufox** (High-Stealth mode). The UI/UX is our own custom design system.

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
  engine-runner/      Node/TS sidecar: launch/control Kernel + Camoufox + Chromium
  local-api-sdk/      Client SDK examples (js/ + python/) for the local automation API
kernel/               Lobster Kernel: Chromium build scripts, GN args, quilt patch series, config channel
engines/              Download-on-first-run scripts for interim engines (binaries NOT committed)
docs/                 Master plan, ADRs, agent protocol, API/IPC contracts, tickets
ci/                   Fingerprint validation harness
tests/                e2e / integration / detector validation suite
```

## Prerequisites

| Tool | Version | Used by |
|------|---------|---------|
| Node | `>=22 <25` (see `.nvmrc`) | all TS packages, backend, sidecar |
| npm | `>=10` | workspace manager |
| Rust | `1.83.0` (see `rust-toolchain.toml`) | desktop agent (Tauri) — install via `rustup` |
| Python | `3.12` | Camoufox fallback sidecar only |

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

# Download the pinned browser engines (Camoufox + ungoogled-chromium)
node engines/download-engines.mjs
```

## Status

**Day 0 — Foundations.** Repo, workspace, docs, CI skeleton, and package scaffolds are in place.
See [`docs/MASTER_PLAN.md` §10](docs/MASTER_PLAN.md) for the 10-day plan and
[`docs/tickets/`](docs/tickets/) for the current work board.
