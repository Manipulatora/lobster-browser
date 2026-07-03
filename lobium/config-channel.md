# Lobium config channel — how per-profile fingerprint params reach Lobium natively

The orchestrator must set all 50+ fingerprint parameters **natively** (no JS tell). Lobium reads a
per-profile fingerprint config at launch and applies it in C++.

## Approach (decided + implemented, T-011 POC)

- **Transport: a per-profile config file + a command-line switch.** The sidecar writes
  `<userDataDir>/lobium-fp.json` (0600) and launches Lobium with `--lobium-fp-config=<path>`. A file
  (not an env var / argv blob) keeps the ~KB payload off the process table and off `/proc`.
- **Sidecar side (done, tested):** `packages/engine-runner/src/lobium-config.ts` —
  `buildLobiumConfig(fingerprint, {proxy, seed})` → `writeLobiumConfig()` → `lobiumConfigArg()`. It
  serializes the resolved `Fingerprint` + deterministic per-profile farbling seeds (canvas/webgl/audio)
  + a `net` envelope (WebRTC policy; type/host/port — **never** credentials).
- **Native side (build-machine artifact):** `lobium/src/lobium_fp_config.{h,cc}` parses it once at
  startup (`LobiumFpConfig::Current()`); the `core/*` hook patches route navigator/UA-CH (and, in
  Phase 2, screen/WebGL/canvas/audio/TLS) through it — natively, with no JS tell.
- Values are **stable per profile** (seeded) and **coherent** (one real machine). The JSON shape is the
  single source of truth both sides serialize/parse (`lobium-config.ts` ⇄ `lobium_fp_config.cc`).

## Contract stability

The param model is the same one used by the editor UI and the sidecar — it lives in
`@lobster/shared-types`, so the UI, orchestrator, and Lobium never drift. Changes go through a
shared-types ticket first (see agent-protocol §7).
