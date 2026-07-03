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

The active patch ([`patches/core/hardware-concurrency-poc.patch`](patches/core/hardware-concurrency-poc.patch))
is authored, refreshed, and compile-verified against this exact ref.

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
   mkdir -p third_party/lobium-fp
   cp ../../src/* third_party/lobium-fp/
   ```
3. **Apply the patch series** (the minimal hook points into existing Chromium files):
   ```bash
   QUILT_PATCHES=../../patches QUILT_SERIES=../../patches/series quilt push -a
   ```
   (Equivalently: `git apply ../../patches/core/hardware-concurrency-poc.patch` — the patch is verified
   to apply cleanly to a pristine 152.0.7928.0 tree.)
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

The point of a native patch is that it changes behavior with **no JS-detectable tell**. Verify:

```bash
# Baseline — reports the host CPU count:
out/Lobium/chrome --headless=new --dump-dom \
  'data:text/html,<script>document.title=navigator.hardwareConcurrency</script>'

# Overridden natively — reports 99 regardless of host:
out/Lobium/chrome --lobium-hwc=99 --headless=new --dump-dom \
  'data:text/html,<script>document.title=navigator.hardwareConcurrency</script>'
```

Proven live during the POC build: baseline `HWC=12` → `--lobium-hwc=99` ⇒ `99` → `--lobium-hwc=4` ⇒ `4`.
Because the value is computed in C++ inside Blink, `navigator.hardwareConcurrency.toString` and the
property descriptor are untouched — there is nothing for a detector to catch, unlike a JS/CDP override.

## Patch status (honest)

| Patch | Status |
|---|---|
| `core/hardware-concurrency-poc.patch` — hook (A) `--lobium-hwc` | ✅ **Built + proven end-to-end** on 152.0.7928.0 |
| `core/hardware-concurrency-poc.patch` — hook (B) `--lobium-fp-config` file read | ⚠️ **Compiles + links**, but the getter runs in the **renderer** process whose sandbox blocks file reads, so it falls back to the host value. Production design: read `lobium-fp.json` in the **browser** process and plumb resolved values via switches/mojo (or have the sidecar resolve the file and pass scalars). Next Lobium step. |
| everything under `patches/` marked `NOT YET AUTHORED` / Phase 2 | 🔜 deep surfaces (canvas/WebGL/audio/fonts/WebGPU) + net (WebRTC/TLS-JA4/HTTP2) — the native moat |

## Rebasing onto a newer Chrome stable

[`rebase.sh`](rebase.sh) bumps `CHROMIUM_REF`, re-syncs, and `quilt push`es the series against the new
tree so conflicts surface per-hook. Because nearly all logic lives in **added files** under
`third_party/lobium-fp/` (which never conflict) and the in-tree hooks are deliberately tiny, tracking
Chrome stable within days stays feasible — the Octo-class moat requirement.
