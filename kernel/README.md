# Lobster Kernel

Our own **Chromium-based browser build** — the flagship engine and the product's moat. It patches
fingerprint surfaces **natively** (no JS/CDP tell) and exposes a per-profile config channel for the
50+ fingerprint parameters. See [ADR-0004](../docs/adr/ADR-0004-lobster-kernel.md) and
[MASTER_PLAN §10 Track F](../docs/MASTER_PLAN.md).

> The kernel is a **parallel, longer-horizon track**. The product ships and stays fully usable on the
> interim engines (Camoufox + ungoogled-Chromium) while the kernel matures into the default engine.

## Layout

```
kernel/
  build.sh            # scaffold build driver (fetch Chromium, sync, gn gen, ninja) — dry-run by default
  gn-args.gn.example  # example GN build args
  patches/            # quilt-style patch series applied on top of the pinned Chromium ref
    series            # ordered list of patches (ungoogled model)
    README.md
  config-channel.md   # spec: how per-profile 50+ params reach the kernel natively
```

## Build (high level)

1. Install `depot_tools`; `fetch chromium`; pin a Chromium ref.
2. `apply patches/series` (quilt).
3. `gn gen out/Lobster --args="$(cat gn-args.gn.example)"`; `autoninja -C out/Lobster chrome`.
4. Package + (later) sign for each OS.

Compiles are long — run on a dedicated build machine / self-hosted CI with `ccache`/reclient.

## Native patch domains (target)

navigator/UA-CH · screen/DPR · timezone/locale · fonts · hardwareConcurrency/deviceMemory ·
**canvas/WebGL/AudioContext farbling (seeded per profile)** · WebGL vendor/renderer · WebRTC IP ·
**BoringSSL TLS/JA3/JA4 + HTTP/2 SETTINGS/header-order**.

## v1 (10-day) scope

Build env up → first successful build → quilt series initialized → first native patch (navigator/UA-CH)
→ one param wired end-to-end via the config channel (POC). Tickets: **T-010**, **T-011**.
