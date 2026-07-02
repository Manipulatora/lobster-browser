# ADR-0003 — Two-engine strategy (Lobium + Chromium)

- **Status:** Accepted
- **Date:** 2026-07-02
- **Deciders:** Owner + Claude

## Context

The owner wants a **dedicated Chromium-based engine** (the Octo model) as the product's engine — our
own patched build (**Lobium**) with native fingerprinting and 50+ configurable parameters. A production
build is a multi-week build+patch effort, so we need an interim engine that makes the product complete
and usable while Lobium matures.

## Decision

Support **two engines behind one sidecar interface**:

- **Lobium (flagship):** our own Chromium fork (via `depot_tools` + GN/ninja, an ungoogled-style quilt
  patch series). Native control of all deep surfaces (canvas/WebGL/audio/fonts/WebRTC) + BoringSSL
  **TLS/JA3/JA4 + HTTP/2** matching, plus a per-profile config channel exposing 50+ params. Built on a
  parallel track (MASTER_PLAN §10 Track F); becomes the **default engine** as its patches land. Until
  the custom build ships, Lobium is served by a patched Chromium via patchright.
- **Chromium (interim, everyday):** a prebuilt (ungoogled) Chromium driven via patchright for broad
  Chrome-family coverage. JS-safe surfaces are applied through clean isolated-context CDP init scripts
  (never deep surfaces from JS); deep surfaces (canvas/WebGL/audio/TLS) are **best-effort** until Lobium
  ships and handles them natively.

The interim Chromium is pinned & vendored (downloaded on first run). Fingerprints are **real-system**
(real-device datasets), Chrome-family, seeded, coherent, and stable per profile — the same 50+ param
model consumed by the editor UI, the sidecar, and the Lobium config channel.

## Consequences

- ➕ A complete, usable product immediately (interim Chromium) + a growing native moat (Lobium).
- ➕ Engine-agnostic control plane — Lobium replaces the interim Chromium transparently.
- ➖ Two engines to integrate; mitigated by the single sidecar contract and shared fingerprint model.
- ➖ Until Lobium's native patches (incl. TLS/JA4) land, the deep surfaces on interim Chromium are
  best-effort rather than tell-free.
