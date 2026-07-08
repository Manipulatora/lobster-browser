# Reproducible Lobium build — clone → fetch → patch → build

This document proves that **the Lobium fork is fully contained in this repo**: everything needed to
reconstruct the customized browser lives under [`lobium/`](.). Anyone with a build machine can go from a
clean `git clone` to the same patched Chromium binary, deterministically, from a pinned Chromium ref.

## What "the fork is in the repo" means (and what is NOT)

A Chromium fork is **not a copy of Chromium**. The Chromium source is ~37 GB with its own 20-year git
history; committing it is neither possible in a normal repo nor how any fork works (Brave, Vivaldi,
ungoogled-chromium, Opera all do the same thing we do). **The fork IS the customization**, and 100% of
it is here:

| In this repo (the fork) | File(s) |
|---|---|
| Build pipeline (fetch → sync → patch → gn → ninja) | [`build.sh`](build.sh), [`rebase.sh`](rebase.sh) |
| GN build args | [`gn-args.gn.example`](gn-args.gn.example) |
| Patch series (apply order) | [`patches/series`](patches/series) |
| The actual source changes (hook points) | [`patches/core/*.patch`](patches/core/) |
| Added-file C++ (config reader) | [`src/lobium_fp_config.{h,cc}`](src/), [`src/BUILD.gn`](src/BUILD.gn) |
| Config channel schema/contract | [`config-channel.md`](config-channel.md) |
| Hook-point catalogue | [`patches/hooks.md`](patches/hooks.md) |

**NOT in the repo, fetched at build time:** the base Chromium checkout (`fetch chromium`). This is
correct and intentional — the pinned ref below reproduces the exact base every time.

## Pinned base

```
Chromium ref (tag):  152.0.7928.0        # lobium/build.sh CHROMIUM_REF (default)
```

The active patch series is authored against this exact ref. Most first-party logic lives in added files
under `components/lobium_fp`; the quilt patches are the minimal Chromium hook points listed in
[`patches/series`](patches/series).

## Prerequisites (build machine)

- **[depot_tools](https://chromium.googlesource.com/chromium/tools/depot_tools)** on `PATH`
  (`fetch`, `gclient`, `gn`, `autoninja`).
- **~150 GB free disk** (checkout ~37 GB + build output), **~16 GB+ RAM**, a multi-core CPU.
- **Hours of compile time** on a first build (the proven build: ~6.5 h on 12 cores; incremental
  rebuilds after a patch change: ~2 min). Use `ccache` / `reclient` to speed it up.
- Linux build deps: `src/build/install-build-deps.sh` (run once, via `gclient runhooks`).

This **cannot** run in a small sandbox — that is expected, not a limitation of the repo.

## Build steps

The one-liner — [`build.sh`](build.sh) automates every step below (dry-run by default; `--run` to execute):

```bash
cd lobium
CHROMIUM_REF=152.0.7928.0 ./build.sh          # prints the exact plan (dry run)
CHROMIUM_REF=152.0.7928.0 ./build.sh --run    # executes on a build machine
```

What it does, step by step (reproduce by hand if you prefer):

1. **Fetch Chromium** (first run only) and sync to the pinned ref:
   ```bash
   mkdir -p chromium && cd chromium
   fetch --nohooks chromium
   cd src
   git fetch --tags
   gclient sync --nohooks --revision src@152.0.7928.0
   gclient runhooks          # pulls the clang toolchain, sysroots, etc.
   ```
2. **Stage the Lobium added files** into the source tree (they never conflict on rebase):
   ```bash
   mkdir -p components/lobium_fp
   cp ../../src/* components/lobium_fp/
   ```
3. **Apply the patch series** (the minimal hook points into existing Chromium files):
   ```bash
   QUILT_PATCHES=../../patches QUILT_SERIES=../../patches/series quilt push -a
   ```
   (For a narrow config-channel smoke, `core/build-gn.patch` + `core/config-channel.patch` are the core
   hooks; the full product path uses the whole `series`.)
4. **Configure (GN)** with the Lobium args:
   ```bash
   gn gen out/Lobium --args="$(grep -v '^#' ../../gn-args.gn.example | tr '\n' ' ')"
   ```
5. **Build**:
   ```bash
   autoninja -C out/Lobium chrome
   ```

Result: `out/Lobium/chrome` (the proven POC binary was 172 MB). Rebrand + sign in the packaging step.

### Two GN configurations

- **[`gn-args.gn.example`](gn-args.gn.example)** — the **release/distribution** config
  (`is_official_build=true`, proprietary codecs, PGO-ready). Use this for shipping binaries.
- The **proven POC** used a **fast dev** config for quick iteration
  (`is_component_build=true`, no symbols, `dcheck_always_on=false`, `use_remoteexec=false`). Faster
  incremental builds; not for distribution. Either config applies the same patches identically.

## Verify the customization actually took effect

The point of a native patch is that it changes behavior with **no JS-detectable tell**. Verify both the
production **config-file** channel and the single-value POC switch:

```bash
# A config file the sidecar would write (navigator.hardwareConcurrency = 7):
echo '{"version":1,"navigator":{"hardwareConcurrency":7}}' > /tmp/lobium-fp.json
PROBE='data:text/html,<title>_</title><script>document.title=navigator.hardwareConcurrency</script>'
title() { out/Lobium/chrome --headless=new --no-sandbox --disable-gpu "$@" --dump-dom "$PROBE" \
            2>/dev/null | grep -oP '<title>\K[0-9]+'; }

title                                    # baseline  → host CPU count (e.g. 12)
title --lobium-fp-config=/tmp/lobium-fp.json   # config FILE → 7   (the production path)
title --lobium-hwc=99                    # POC switch → 99
title --lobium-fp-config=/no/such.json   # bad file  → host value + a LOG(ERROR) on stderr
```

Proven on the 152.0.7928.0 build: baseline `HWC=12`; the config **file** yields `7` (consistently on
the main thread AND in a dedicated Worker — no cross-context tell); the `--lobium-hwc` POC yields its
value; a missing/invalid/incompatible file falls back to the host value and logs `Lobium: … reporting
HOST fingerprint values.` Because the value is computed in C++ inside Blink,
`navigator.hardwareConcurrency.toString` and the property descriptor are untouched — nothing for a
detector to catch, unlike a JS/CDP override.

## Patch status (honest)

| Patch | Status |
|---|---|
| `core/build-gn.patch` — registers `//components/lobium_fp` in the build graph | ✅ **Built** on 152.0.7928.0 |
| `core/config-channel.patch` — browser reads `--lobium-fp-config`, forwards base64 `--lobium-fp-data`; renderer/browser code reads `LobiumFpConfig::Current()` | ✅ **Built + dev-proven** for the folded native surface set. `--lobium-hwc` retained as a single-value POC fallback. |
| `fingerprint/audio-context.patch`, `fingerprint/audio-worklet-tap.patch`, `fingerprint/screen-dpr.patch` | ✅ **Built + dev-proven** on SwiftShader/dev runs. |
| WebGL pixel farbling / scalar caps / UA header metadata | ✅ **Implemented in the folded active patches**; no longer a separate "not authored" item. |
| Fonts | **Conditional packaging surface**: launcher writes private fontconfig when `LOBSTER_FONTS_DIR` is provisioned; final licensed bundles/resources still open. |
| Real-GPU + host calibration | 🔜 **Open production proof**: shared types/config can now carry host extensions/precision/version and `deriveFingerprintFromHost` exists; the real host probe, native consumption, consumer-GPU validation, and product-primary wiring remain open. |

## Rebasing onto a newer Chrome stable

[`rebase.sh`](rebase.sh) bumps `CHROMIUM_REF`, re-syncs, and `quilt push`es the series against the new
tree so conflicts surface per-hook. Because nearly all logic lives in **added files** under
`components/lobium_fp/` (which never conflict) and the in-tree hooks are deliberately tiny, tracking
Chrome stable within days stays feasible — the Octo-class moat requirement.
