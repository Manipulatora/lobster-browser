# ADR-0004 — Lobium (our own Chromium-based engine)

- **Status:** Accepted, updated 2026-07-09 for Lobium-only production runtime
- **Date:** 2026-07-02
- **Deciders:** Owner + Claude

## Context

The moat of an Octo-class anti-detect browser is a **dedicated, natively-patched Chromium engine** —
JS/CDP spoofing of deep surfaces (canvas/WebGL/audio/TLS) leaves tells, so the strongest players patch
the engine in C++. The owner wants this as a core product capability, not a deferral.

## Decision

Build **Lobium** — our own Chromium-based browser build — as the only production browser runtime.

- **Base & pipeline:** fork Chromium via `depot_tools`; manage changes as an **ungoogled-style quilt
  patch series** under `/lobium/patches`. GN/ninja builds with `ccache`/reclient on a dedicated build
  machine/CI (compiles are long).
- **Native patch domains:** navigator/UA-CH, screen/DPR, timezone/locale, fonts, `hardwareConcurrency`/
  `deviceMemory`, **canvas/WebGL/AudioContext farbling (seeded per profile)**, WebGL vendor/renderer,
  WebRTC IP handling, and **BoringSSL TLS/JA3/JA4 + HTTP/2 SETTINGS/header-order**.
- **Config channel:** a per-profile fingerprint config (the 50+ param model from `@lobster/shared-types`)
  passed into Lobium (command-line switch / config file / dedicated IPC) so the orchestrator sets all
  params **natively** — no JS tell.
- **Real-system fingerprints:** Lobium's values come from real-device datasets, kept coherent and stable
  per profile.
- **Direct launcher:** production starts the native Lobium binary directly and exposes CDP only for
  automation/control. Patchright is an internal test harness, not the product engine.
- **Android:** an Android Lobium APK/device-runner variant follows once the desktop build is solid.

## Current scope boundary

The original v1 POC scope is complete enough that Lobium is no longer a parallel aspiration. The current
engineering target is production hardening:

- direct native launch as the default and only product path,
- no uncustomized Chromium fallback,
- all fingerprint fields consumed through `lobium-fp.json`,
- host-calibrated real-GPU proof,
- multi-OS signed Lobium builds,
- Android Lobium as a separate APK/device-runner track.

## Consequences

- ➕ A genuine, tell-free native engine — the durable competitive moat.
- ➕ The sidecar contract stays stable while the implementation becomes Lobium-native.
- ➖ Significant build infrastructure + a permanent upstream-rebase cost; must be resourced and must not
  be replaced by a weaker Patchright/Chromium runtime.
