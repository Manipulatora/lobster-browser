# ADR-0002 — Tech stack

- **Status:** Accepted
- **Date:** 2026-07-02
- **Deciders:** Owner + Claude

## Decision

| Layer | Choice |
|-------|--------|
| Desktop shell | **Rust + Tauri 2**, React + TypeScript + Vite, **our own design system (custom UI/UX)** |
| Local store | **SQLite** (rusqlite), AES-encrypted blobs |
| Local automation API | **Rust Axum** HTTP+WS on a fixed loopback port (default 53211) |
| Engine runner (sidecar) | **Node/TS**, patchright (Chromium) + camoufox-js (Camoufox), Playwright base. Python fallback for Camoufox behind the same IPC contract. |
| Fingerprint generation | **Apify fingerprint-suite** (`fingerprint-generator` + `fingerprint-injector`) |
| **Lobster Kernel** (flagship) | **Chromium fork** via `depot_tools` + GN/ninja + quilt patch series; native fingerprinting + BoringSSL TLS/JA4 + per-profile config channel (see ADR-0004) |
| Interim engines | **Camoufox** (High-Stealth) + **ungoogled-chromium** (default), pinned & vendored |
| Proxy tooling | Per-profile HTTP/SOCKS5; **mitmproxy** for header/geo canonicalization |
| Backend | **TypeScript + NestJS**, Postgres (Prisma), S3-compatible object storage |
| Billing | **Stripe**, metered on profile count |

**Languages total: Rust + TypeScript** (Python only as a contained Camoufox fallback).

## Rationale

- Rust+Tauri matches the owner's choice and the proven orchestrator pattern (Donut is reference only —
  we own our codebase and design system); small binary, strong system-level control, memory-safe core.
- TypeScript across frontend + backend + sidecar maximizes AI-agent velocity and shares types via
  `@lobster/shared-types`.
- Each language has exactly one role; boundaries are documented contracts so the two agents build in
  parallel without collisions.

## Consequences

- The desktop app requires the Rust toolchain (`rust-toolchain.toml` pins 1.83.0); the TS packages,
  backend, and sidecar do not.
- Three runtimes coexist; discipline on the IPC/API contracts is essential (see `docs/contracts/`).
