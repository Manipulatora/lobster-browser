# ADR-0003 — Three-engine strategy (Lobster Kernel flagship + Camoufox + Chromium)

- **Status:** Accepted
- **Date:** 2026-07-02
- **Deciders:** Owner + Claude

## Context

The owner wants a **dedicated Chromium-based kernel** (the Octo model) as the product's engine — our
own patched build with native fingerprinting and 50+ configurable parameters. A production kernel is a
multi-week build+patch effort, so we need engines that make the product complete and usable while the
kernel matures.

## Decision

Support **three engines behind one sidecar interface**:

- **Lobster Kernel (flagship):** our own Chromium fork (via `depot_tools` + GN/ninja, an ungoogled-style
  quilt patch series). Native control of all deep surfaces (canvas/WebGL/audio/fonts/WebRTC) + BoringSSL
  **TLS/JA3/JA4 + HTTP/2** matching, plus a per-profile config channel exposing 50+ params. Built on a
  parallel track (MASTER_PLAN §10 Track F); becomes the **default engine** as its patches land.
- **Camoufox (High-Stealth, interim):** genuine native-patched Firefox for the hardest targets today.
- **ungoogled-Chromium (default, interim):** broad Chrome-family coverage via patchright; JS-safe
  surfaces applied through clean isolated-context CDP init scripts (never deep surfaces from JS).

Interim engines are pinned & vendored (downloaded on first run). Fingerprints are **real-system**
(real-device datasets), seeded, coherent, and stable per profile — the same 50+ param model consumed by
the editor UI, the sidecar, and the kernel config channel.

## Consequences

- ➕ Complete, high-stealth product immediately (Camoufox) + broad coverage (Chromium) + a growing
  native moat (Kernel).
- ➕ Engine-agnostic control plane — the kernel replaces the interim Chromium transparently.
- ➖ Three engines to integrate; mitigated by the single sidecar contract and shared fingerprint model.
- ➖ Until the kernel's TLS/JA4 patches land, steer the hardest targets to Camoufox (genuine stack).
