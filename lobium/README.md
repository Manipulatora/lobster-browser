# Lobium

Our own **Chromium-based browser build** — the flagship engine and the product's moat. It patches
fingerprint surfaces **natively** (no JS/CDP tell) and exposes a per-profile config channel for the
50+ fingerprint parameters. See [ADR-0004](../docs/adr/ADR-0004-lobium.md) and
[MASTER_PLAN §10 Track F](../docs/MASTER_PLAN.md).

> Lobium is a **parallel, longer-horizon track**. The product ships and stays fully usable on the
> interim prebuilt Chromium (driven via patchright) while Lobium matures into the default engine.

## ✅ Proven end-to-end (T-010 + T-011)

Chromium **152.0.7928.0** was fetched, configured, and compiled from source (~6.5 h stock on a 12-core
box), then the native fingerprint **config channel** + first surfaces were applied and **incrementally
rebuilt in ~2 min** each. The per-profile config **file** now drives three navigator surfaces natively
(no JS/CDP tell), all verified live on the built binary (host: 12 cores / 32 GB):

| surface | result from the config file |
|---|---|
| `navigator.hardwareConcurrency` | file `7` → **7**, main thread **and** Worker (no cross-context tell); `--lobium-hwc=99` POC → **99** |
| `navigator.deviceMemory` **+ the `Device-Memory` client-hint HTTP header** | file `16` → **16** on **both** the JS getter and the HTTP header (host `32`) — hooked at their single shared source, so they can't disagree. Off-spec values snap to a bucket this build emits: `1→2`, `6→4`, `32→32` |
| `navigator.maxTouchPoints` | file `5` → **5**; a desktop persona can force **0** (optional sentinel) |
| missing / invalid config file | host value + a `LOG(ERROR)` — never a *silent* host-leak |

Values are decided in **C++ inside Blink** via `lobium::LobiumFpConfig::Current()`
([`core/config-channel.patch`](patches/core/config-channel.patch) + [`core/build-gn.patch`](patches/core/build-gn.patch)).
The renderer is sandboxed and can't read files, so the browser process reads the file and forwards its
base64 as `--lobium-fp-data` (Chromium's own `GaiaConfig` pattern). Each surface was **adversarially
reviewed** — that's how the deviceMemory bucket range and the client-hint-header coupling were caught and
fixed. `navigator.platform` / `navigator.languages` are deliberately deferred (they need coherent HTTP
headers — Sec-CH-UA-Platform / Accept-Language). Remaining effort is breadth (more surfaces, each a small
`Current()` hook; then the deep canvas/WebGL/audio surfaces) + a build farm for release binaries, not
feasibility.

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

**Full, reproducible instructions:** [REPRODUCIBLE_BUILD.md](REPRODUCIBLE_BUILD.md) — clone → fetch the
pinned Chromium ref → apply `patches/` → build the exact binary, with a step to **verify** the native
override took effect. The `core/build-gn.patch` + `core/config-channel.patch` in this repo are verified
to apply cleanly to a pristine `152.0.7928.0` tree, so `lobium/` alone reconstructs the fork (the 37 GB
base Chromium is fetched, never committed — as with every Chromium fork).

## Native patch domains (target)

navigator/UA-CH · screen/DPR · timezone/locale · fonts · hardwareConcurrency/deviceMemory ·
**canvas/WebGL/AudioContext farbling (seeded per profile)** · WebGL vendor/renderer · WebRTC IP ·
**BoringSSL TLS/JA3/JA4 + HTTP/2 SETTINGS/header-order**.

## v1 (10-day) scope

Build env up → first successful build → quilt series initialized → first native patch (navigator/UA-CH)
→ one param wired end-to-end via the config channel (POC). Tickets: **T-010**, **T-011**.
