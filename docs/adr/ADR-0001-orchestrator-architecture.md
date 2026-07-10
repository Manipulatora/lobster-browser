# ADR-0001 — Orchestrator architecture (custom desktop agent driving Lobium)

- **Status:** Accepted; engine-selection portions superseded by [ADR-0003](ADR-0003-engine-strategy.md)
- **Date:** 2026-07-02
- **Deciders:** Owner + Claude (lead architect)

## Context

We are building a production anti-detect browser + SaaS. The deepest, most durable stealth lives at
the native (C++) engine layer, so our moat is a **dedicated Chromium-based engine, Lobium** (our own
patched build). The project is **open source**, so we freely import OSS where useful; Donut Browser is
a **reference only** for orchestrator design — we own our full codebase.

## Decision

Ship a **thick custom desktop agent (Rust + Tauri) that orchestrates Lobium**, with the full SaaS
layered on top. The Rust core is the single privileged control plane; it delegates engine
launch/control to a Node sidecar over a stable stdio JSON-RPC contract, and exposes a local automation
API (Axum) returning both Selenium and CDP endpoints.

The sidecar direct-spawns **Lobium**, writes the per-profile native config, and returns CDP endpoints for
automation/control. Patchright/Chromium may exist only inside internal test harnesses; they are not
profile-selectable production engines.

## Consequences

- ➕ A clear control-plane boundary around the native Lobium engine; product behavior cannot silently
  downgrade to a weaker browser.
- ➕ Clean separation: privileged control plane (Rust) vs. engine control (sidecar) vs. cloud (backend);
  new engines slot in without touching the control plane.
- ➕ Our own codebase and UI/UX (Donut reference-only) — a distinctive product, not a clone.
- ➖ Lobium provisioning/build/signing is on the critical path for any production launch (see ADR-0004 and
  PRODUCTION-ROADMAP).
