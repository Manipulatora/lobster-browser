# ADR-0001 — Orchestrator architecture (custom desktop agent driving Lobium + interim Chromium)

- **Status:** Accepted
- **Date:** 2026-07-02
- **Deciders:** Owner + Claude (lead architect)

## Context

We are building a production anti-detect browser + SaaS. The deepest, most durable stealth lives at
the native (C++) engine layer, so our moat is a **dedicated Chromium-based engine, Lobium** (our own
patched build). Lobium is a multi-week build+patch effort, so we build it on a parallel track while
shipping a complete product now on a strong interim engine. The project is **open source**, so we
freely import any OSS; Donut Browser is a **reference only** for orchestrator design — we own our full
codebase.

## Decision

Ship a **thick custom desktop agent (Rust + Tauri) that orchestrates our engines**, with the full SaaS
layered on top. The Rust core is the single privileged control plane; it delegates engine
launch/control to a Node sidecar over a stable stdio JSON-RPC contract, and exposes a local automation
API (Axum) returning both Selenium and CDP endpoints.

The sidecar drives whichever engine a profile selects — **Lobium** (flagship custom build, as it comes
online) or **Chromium** (interim prebuilt, driven via patchright) — behind one interface, so Lobium
drops in transparently as its native patches land.

## Consequences

- ➕ A complete, demoable product immediately (on the interim Chromium) with a clear path to full native
  depth via Lobium.
- ➕ Clean separation: privileged control plane (Rust) vs. engine control (sidecar) vs. cloud (backend);
  new engines slot in without touching the control plane.
- ➕ Our own codebase and UI/UX (Donut reference-only) — a distinctive product, not a clone.
- ➖ The Lobium track is long-running; it must be scheduled so it never derails the v1 product milestone
  (see ADR-0004 and MASTER_PLAN §10 Track F).
