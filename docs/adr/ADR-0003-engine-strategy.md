# ADR-0003 — Lobium-only production engine

- **Status:** Accepted, supersedes the earlier two-engine/interim-Chromium strategy
- **Date:** 2026-07-09
- **Deciders:** Owner + Claude + Codex

## Context

The target product must be comparable to Octo Browser at the engine layer. That means the browser
identity cannot depend on Patchright, Playwright, JS init scripts, or an uncustomized Chromium binary as
the production stealth mechanism. Those tools are useful for testing and automation, but they are not a
browser kernel.

The earlier plan accepted an interim patched Chromium path so the product could move while Lobium was
being built. That trade-off is now rejected by product direction: **Lobium is the only product engine**.

## Decision

Production profiles launch **only native Lobium**, our own Chromium fork, through the direct native
launcher in `packages/engine-runner/src/runners/lobium-launcher.ts`.

The sidecar may expose CDP endpoints for user automation and debugging, but it must not use CDP or JS
injection as the production fingerprint-spoofing layer. The sidecar writes `lobium-fp.json`, passes
`--lobium-fp-config=<path>`, launches the Lobium binary directly, and returns the browser's
`DevToolsActivePort` endpoint.

Patchright is allowed only for:

- internal validation harnesses,
- compatibility/regression tests,
- experimental comparison against a Chrome-family binary.

Patchright is not allowed for:

- default launchers,
- production profile launches,
- fallback when Lobium is missing,
- deep fingerprint behavior,
- claiming Octo-class engine parity.

If Lobium is not provisioned, launch fails with an actionable "engine not provisioned" error. It must not
fall back to uncustomized Chromium.

## Consequences

- The architecture now matches the intended Octo-class model: a proprietary/custom Chromium kernel owns
  fingerprint behavior natively.
- The product can be less convenient in dev/CI because a Lobium binary is required for real launches.
  That inconvenience is intentional; it prevents false confidence from a weaker runtime.
- Authenticated proxy support must be implemented through a native/local proxy-auth adapter. The direct
  launcher currently fails closed when proxy credentials are present, instead of silently delegating to
  Patchright.
- Cookie import/export and other operational CDP features must be kept conceptually separate from
  fingerprint spoofing. CDP can be used for control/automation, not for identity.
- Docs and tests must treat Patchright references as internal/harness-only unless explicitly marked
  historical.
