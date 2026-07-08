# Lobium

Our own **Chromium-based browser build** — the flagship engine and the product's moat. It patches
fingerprint surfaces **natively** (no JS/CDP tell) and exposes a per-profile config channel for the
50+ fingerprint parameters. See [ADR-0004](../docs/adr/ADR-0004-lobium.md) and
[MASTER_PLAN §10 Track F](../docs/MASTER_PLAN.md).

> Lobium is a **parallel, longer-horizon track**. The product ships and stays fully usable on the
> interim prebuilt Chromium (driven via patchright) while Lobium matures into the default engine.

## Current status

Chromium **152.0.7928.0** was fetched, configured, and compiled from source (~6.5 h stock on a 12-core
box). The native fingerprint **config channel** is built, and the product launch path can now reach native
Lobium when a built binary is provided through `LOBSTER_LOBIUM_BIN`, `LOBSTER_LOBIUM_DIR`, the local
`~/lobium-build/src/out/Lobium/chrome` dev layout, or a packaged engine resource.

Native/dev-proven surfaces now include:

| Surface group | Status |
|---|---|
| Config channel | Browser reads `--lobium-fp-config`, forwards base64 `--lobium-fp-data`, renderer reads `lobium::LobiumFpConfig::Current()`. |
| Navigator / UA | UA/platform/hardwareConcurrency/deviceMemory/maxTouchPoints in main + workers; native UA header and Sec-CH-UA metadata. |
| WebGL | Vendor/renderer, scalar caps, and pixel farbling (`readPixels` + WebGL canvas readback path). |
| Canvas | 2D readback farbling across the main readback paths. |
| Audio | Offline/analyser/worklet/SPN farbling, including byte paths. |
| Screen | Geometry/DPR/colorDepth/availTop hooks. |
| Fonts | Private fontconfig launch env when `LOBSTER_FONTS_DIR` is provisioned; final licensed bundles still need packaging. |

Important caveat: current native detector proof is **SwiftShader/dev proof**, not real consumer-GPU proof.
The next engine milestone is RG-1/HC-1..6 from [`../docs/PRODUCTION-ROADMAP.md`](../docs/PRODUCTION-ROADMAP.md):
real-GPU baseline, then host-calibrated personas.

## Layout

```
lobium/
  build.sh            # build driver (fetch Chromium, sync, gn gen, ninja) — dry-run by default
  gn-args.gn.example  # example GN build args
  patches/            # quilt-style patch series applied on top of the pinned Chromium ref
    series            # ordered list of patches (ungoogled model)
    README.md
  config-channel.md   # spec: how per-profile 50+ params reach Lobium natively
```

## Build (high level)

1. Install `depot_tools`; `fetch chromium`; pin a Chromium ref.
2. `apply patches/series` (quilt).
3. `gn gen out/Lobium --args="$(cat gn-args.gn.example)"`; `autoninja -C out/Lobium chrome`.
4. Package + (later) sign for each OS.

Compiles are long — run on a dedicated build machine / self-hosted CI with `ccache`/reclient.

**Full, reproducible instructions:** [REPRODUCIBLE_BUILD.md](REPRODUCIBLE_BUILD.md) — clone → fetch the
pinned Chromium ref → apply `patches/` → build the exact binary, with a step to **verify** the native
override took effect. The `core/build-gn.patch` + `core/config-channel.patch` in this repo are verified
to apply cleanly to a pristine `152.0.7928.0` tree, so `lobium/` alone reconstructs the fork (the 37 GB
base Chromium is fetched, never committed — as with every Chromium fork).

## Native patch domains (target)

navigator/UA-CH · screen/DPR · timezone/locale · fonts · hardwareConcurrency/deviceMemory ·
**canvas/WebGL/AudioContext farbling (seeded per profile)** · WebGL vendor/renderer · WebRTC IP ·
**BoringSSL TLS/JA3/JA4 + HTTP/2 SETTINGS/header-order**.

## Next scope

Real-GPU baseline -> host calibration -> multi-OS builds/signing. The old "first native patch POC" scope is
complete; current work is production proof and release engineering, not basic feasibility.
