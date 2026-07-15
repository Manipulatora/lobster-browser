# 🦞 Lobster Browser

A production-grade **anti-detect browser + SaaS**, feature-comparable to Octo Browser / Multilogin: a
Rust + Tauri desktop agent that manages profiles and proxies and launches **Lobium**, our own
Chromium-based browser kernel with native, per-profile fingerprinting.

Each browser **profile** gets a coherent, stable, real-looking device + network identity, fully isolated
from every other profile, consistent enough to pass modern anti-bot systems. Fingerprints are applied
**inside the engine (C++)**, never by a JavaScript/CDP overlay.

**Documentation is exactly three files:**
- **This README** — what it is, architecture, layout, quick start.
- [`docs/ENGINEERING.md`](docs/ENGINEERING.md) — the engine, the fingerprint model, the anti-detect
  design, and the top-1% roadmap.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — building Lobium, installing the product, validation gates,
  and the runtime contracts.

## Architecture

```
User ── Tauri desktop app (Rust core + React/TS UI)
          │  spawns + JSON-RPC over stdio
          ▼
        engine-runner sidecar (Node/TS)  ── generates --lobium-fp-config, manages proxy, injects cookies
          │  spawns the native binary; drives it via a first-party raw-DevTools CDP client (cdp-client.ts)
          ▼
        Lobium  (Chromium 152 fork, C++)  ── applies the fingerprint natively at the Blink surface
```

The deep anti-detect is native (the Chromium fork). The sidecar is orchestration only and never
fingerprints over the wire. The optional cloud backend (NestJS) handles auth, teams, encrypted profile
sync, and billing. **Lobium is the only shipping engine** (`ENGINE_KINDS = ['lobium']`); there is no
uncustomized-Chromium fallback — if no Lobium binary is found, launch fails clearly.

## Monorepo layout

```
apps/
  desktop/     Rust + Tauri agent (src-tauri/) + React/TS UI (src/) + local automation API
  backend/     NestJS cloud SaaS (auth, teams, sync, billing)
packages/
  shared-types/    TS types shared across front/back/sidecar
  fingerprint/     seed → coherent device fingerprint (thousands of real, coherent classes)
  engine-runner/   the sidecar: launch, cdp-client, cookie inject, mobile emulation, host calibration
  proxy/           proxy testing + exit-IP geo derivation
  cookies/         Netscape/JSON cookie parse + validate
  crypto/          at-rest encryption helpers
  local-api-sdk/   client SDK (js/ + python/) for the local automation API
lobium/            Chromium fork build scripts, GN args, quilt patch series, native config-channel spec
ci/validation/     the anti-detect validation harnesses + real-GPU gate
```

`components/lobium_fp/` (inside the Chromium source tree) is the native fingerprint config parser/applier.

## Prerequisites

| Tool | Version | Used by |
|------|---------|---------|
| Node | `>=22 <25` (`.nvmrc`) | all TS packages, backend, sidecar |
| npm  | `>=10` | workspace manager |
| Rust | pinned in `rust-toolchain.toml` | desktop agent (Tauri) — install via `rustup` |

The Rust toolchain is only needed for `apps/desktop`; the TS packages/backend/sidecar build without it.

## Quick start

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install   # workspace deps
npm run build                                    # build all packages
npm test                                         # unit tests

# Point the sidecar at a built Lobium binary (see docs/OPERATIONS.md to build one)
export LOBSTER_LOBIUM_BIN=$HOME/lobium-build/src/out/LobiumOfficial/chrome

npm run -w apps/desktop dev                       # run the desktop app
```

Building the Lobium engine, installing the packaged product, and running the anti-detect validation
gates are all covered in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## License & sourcing

Ships open source; freely imports OSS. Other anti-detect browsers are reference only.
