# ADR-0004 — The Lobster Kernel (our own Chromium-based engine)

- **Status:** Accepted
- **Date:** 2026-07-02
- **Deciders:** Owner + Claude

## Context

The moat of an Octo-class anti-detect browser is a **dedicated, natively-patched Chromium engine** —
JS/CDP spoofing of deep surfaces (canvas/WebGL/audio/TLS) leaves tells, so the strongest players patch
the engine in C++. The owner wants this as a core product capability, not a deferral.

## Decision

Build the **Lobster Kernel** — our own Chromium-based browser build — as a first-class, parallel track.

- **Base & pipeline:** fork Chromium via `depot_tools`; manage changes as an **ungoogled-style quilt
  patch series** under `/kernel/patches`. GN/ninja builds with `ccache`/reclient on a dedicated build
  machine/CI (compiles are long).
- **Native patch domains:** navigator/UA-CH, screen/DPR, timezone/locale, fonts, `hardwareConcurrency`/
  `deviceMemory`, **canvas/WebGL/AudioContext farbling (seeded per profile)**, WebGL vendor/renderer,
  WebRTC IP handling, and **BoringSSL TLS/JA3/JA4 + HTTP/2 SETTINGS/header-order**.
- **Config channel:** a per-profile fingerprint config (the 50+ param model from `@lobster/shared-types`)
  passed into the kernel (command-line switch / config file / dedicated IPC) so the orchestrator sets all
  params **natively** — no JS tell.
- **Real-system fingerprints:** kernel values come from real-device datasets, kept coherent and stable
  per profile.
- **Mobile:** an Android/mobile kernel variant follows once the desktop kernel is solid.

## v1 (10-day) scope for the kernel
Build environment up, first successful Chromium build, quilt series initialized, first native patch
(navigator/UA-CH), and one fingerprint param wired end-to-end through the config channel (POC). Full
native coverage + TLS/JA4 + multi-OS signed builds continue beyond v1 until the kernel becomes default.

## Consequences

- ➕ A genuine, tell-free native engine — the durable competitive moat.
- ➕ Engine-agnostic architecture means it ships incrementally behind the same sidecar interface.
- ➖ Significant build infrastructure + a permanent upstream-rebase cost; must be resourced and must not
  derail the v1 product (which runs on interim engines meanwhile).
