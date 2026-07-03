# Lobium

Our own **Chromium-based browser build** — the flagship engine and the product's moat. It patches
fingerprint surfaces **natively** (no JS/CDP tell) and exposes a per-profile config channel for the
50+ fingerprint parameters. See [ADR-0004](../docs/adr/ADR-0004-lobium.md) and
[MASTER_PLAN §10 Track F](../docs/MASTER_PLAN.md).

> Lobium is a **parallel, longer-horizon track**. The product ships and stays fully usable on the
> interim prebuilt Chromium (driven via patchright) while Lobium matures into the default engine.

## ✅ Proven end-to-end (T-010 + T-011 POC)

Chromium **152.0.7928.0** was fetched, configured, and compiled from source (~6.5 h stock on a 12-core
box), then a native fingerprint patch was applied and **incrementally rebuilt in ~2 min**. Result,
verified live:

| launch | `navigator.hardwareConcurrency` |
|---|---|
| stock (no flag) | **12** (host cores) |
| `--lobium-hwc=99` | **99** |
| `--lobium-hwc=4` | **4** |

The value is decided in **C++ inside Blink** ([`patches/core/hardware-concurrency-poc.patch`](patches/core/hardware-concurrency-poc.patch)),
so there is **no JS/CDP tell** — the exact capability the interim engine cannot provide, and the same
hook shape the deep surfaces (canvas/WebGL/audio) need. This confirms the whole Lobium approach compiles
and works; the remaining effort is breadth (the full patch series via the config channel) + a build farm
for release binaries, not feasibility.

## Layout

```
lobium/
  build.sh            # scaffold build driver (fetch Chromium, sync, gn gen, ninja) — dry-run by default
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

## Native patch domains (target)

navigator/UA-CH · screen/DPR · timezone/locale · fonts · hardwareConcurrency/deviceMemory ·
**canvas/WebGL/AudioContext farbling (seeded per profile)** · WebGL vendor/renderer · WebRTC IP ·
**BoringSSL TLS/JA3/JA4 + HTTP/2 SETTINGS/header-order**.

## v1 (10-day) scope

Build env up → first successful build → quilt series initialized → first native patch (navigator/UA-CH)
→ one param wired end-to-end via the config channel (POC). Tickets: **T-010**, **T-011**.
