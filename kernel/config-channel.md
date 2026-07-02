# Kernel config channel — how per-profile fingerprint params reach the kernel natively

The orchestrator must set all 50+ fingerprint parameters **natively** (no JS tell). The kernel reads a
per-profile fingerprint config at launch and applies it in C++.

## Approach (decided in T-011)

- The `@lobster/shared-types` `Fingerprint` model is serialized to a **per-profile config** and passed
  to the kernel via one of: a dedicated command-line switch (`--lobster-fp-config=<path>`), an env var,
  or a small local IPC — chosen in T-011 for security + size.
- The kernel parses it once at startup and feeds each subsystem (navigator, screen, WebGL, canvas seed,
  audio seed, timezone/locale, WebRTC policy, TLS profile).
- Values are **stable per profile** (seeded) and **coherent** (one real machine).

## Contract stability

The param model is the same one used by the editor UI and the sidecar — it lives in
`@lobster/shared-types`, so the UI, orchestrator, and kernel never drift. Changes go through a
shared-types ticket first (see agent-protocol §7).
