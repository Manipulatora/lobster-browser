# Lobium config channel — how per-profile fingerprint params reach Lobium natively

The orchestrator must set all 50+ fingerprint parameters **natively** (no JS tell). Lobium reads a
per-profile fingerprint config at launch and applies it in C++.

## Approach (decided + implemented + **PROVEN** on Chromium 152)

The renderer is sandboxed and **cannot read files**, so the config takes a two-hop path — the same
pattern Chromium itself uses for `GaiaConfig` (a file switch the renderer can't read, which the browser
serializes into a command-line switch for the child):

1. **Sidecar → browser: a per-profile config file.** `packages/engine-runner/src/lobium-config.ts`
   (`buildLobiumConfig(fingerprint, {proxy, seed})` → `writeLobiumConfig()` → `lobiumConfigArg()`)
   writes `<userDataDir>/lobium-fp.json` (0600) and launches Lobium with `--lobium-fp-config=<path>`.
   It serializes the resolved `Fingerprint` + deterministic per-profile farbling seeds
   (canvas/webgl/audio) + a `net` envelope (WebRTC policy; proxy type/host/port — **never** credentials).
   A file (not an argv blob) keeps the payload off the *launch* command line.
2. **Browser → renderer: base64 in a switch.** In the browser process (unsandboxed),
   `RenderProcessHostImpl::PropagateBrowserCommandLineToRenderer` reads the file and appends
   `--lobium-fp-data=<base64>` to each renderer's command line — see `core/config-channel.patch`.
3. **Renderer: parse once, read typed.** `lobium/src/lobium_fp_config.{h,cc}` (staged as the added
   directory `//components/lobium_fp/`, wired into blink `core` by `core/build-gn.patch`) base64-decodes
   `--lobium-fp-data`, parses the JSON **once** (cached via `base::NoDestructor`), and exposes typed
   fields via `LobiumFpConfig::Current()`. The `core/*` hook patches route surfaces through it — natively,
   with no JS tell.

**Status:** proven end-to-end on 152.0.7928.0 — `navigator.hardwareConcurrency` reads the value from the
config **file** (7, vs host 12), consistently across the main thread and dedicated Workers, with graceful
fallback to the host value on a missing/invalid/incompatible file. `navigator_concurrent_hardware.cc` is
the first surface reading `Current()`; screen/WebGL/canvas/audio/TLS follow the same one-line hook shape.

Values are **stable per profile** (seeded) and **coherent** (one real machine). The JSON shape is the
single source of truth both sides serialize/parse (`lobium-config.ts` ⇄ `lobium_fp_config.cc`), and the
config `version` (currently 1) is asserted on both sides so a schema bump can't be misapplied.

## Contract stability

The param model is the same one used by the editor UI and the sidecar — it lives in
`@lobster/shared-types`, so the UI, orchestrator, and Lobium never drift. Changes go through a
shared-types ticket first (see agent-protocol §7).
