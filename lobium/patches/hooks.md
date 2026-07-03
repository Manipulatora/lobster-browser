# Lobium hook points (the quilt series)

Each hook patch is a **small** diff into an existing Chromium file that routes a surface through
`lobium::LobiumFpConfig::Current()` (the reader in `../src/`). The insertion points + code are given
here so a build engineer finalizes them against the pinned checkout (`quilt push -f` → edit → `quilt
refresh`) — the exact line numbers shift per Chromium ref, which is why the series ships as intent +
code rather than frozen context diffs. Deep-surface hooks (canvas/WebGL/audio/TLS) are Phase 2.

## `core/build-gn.patch` — register the added module ✅ BUILT

`//components/lobium_fp/BUILD.gn` (added file) defines a `source_set("lobium_fp")` over
`lobium_fp_config.{h,cc}` (`public_deps`: `//base`). The hook adds that target to the deps of the
components that consume it (today `//third_party/blink/renderer/core`; `//content/browser` reads the
switch inline via `//base` and needs no dep) and adds a `core/DEPS` include-rule (`+components/lobium_fp`),
so the symbol links and `gn check` passes.

## `core/config-channel.patch` — browser reads the file, renderer reads base64 ✅ BUILT + PROVEN

The renderer is sandboxed and cannot read files, so the config takes two hops (mirroring Chromium's own
`GaiaConfig` file→switch serialization):

1. **Browser** — `RenderProcessHostImpl::PropagateBrowserCommandLineToRenderer`
   (`content/browser/renderer_host/render_process_host_impl.cc`): reads the `--lobium-fp-config` file
   **once** (cached in a `base::NoDestructor`, under `base::ScopedAllowBlocking`, off the per-spawn hot
   path), base64-encodes it, and appends `--lobium-fp-data=<b64>` to each renderer command line (with a
   Windows command-line size guard: skip + `LOG(ERROR)` instead of a launch-breaking overrun).
2. **Renderer** — `lobium::LobiumFpConfig::Current()` base64-decodes `--lobium-fp-data`, parses once,
   and exposes typed fields; every failure path `LOG(ERROR)`s (a present-but-unparseable config must
   never silently leak the host fingerprint). `--lobium-hwc=<n>` remains as a single-value POC fallback.

The **first surface** ships in this same patch:

```cpp
// third_party/blink/renderer/core/frame/navigator_concurrent_hardware.cc
unsigned NavigatorConcurrentHardware::hardwareConcurrency() const {
  if (const auto* cfg = lobium::LobiumFpConfig::Current();
      cfg && cfg->navigator.hardware_concurrency > 0) {
    return static_cast<unsigned>(cfg->navigator.hardware_concurrency);
  }
  return static_cast<unsigned>(base::SysInfo::NumberOfProcessors());  // upstream default
}
```

Because it reads the config **in C++**, there is no `Object.defineProperty` tell and no isolated-world
problem — the exact issue the interim (patchright) engine cannot solve. **Proven:** config file → `7`
(host 12), consistent across the main thread and dedicated Workers.

## `core/navigator-ua-ch.patch` — next native surfaces (NOT YET AUTHORED)

`languages` / `platform` / `deviceMemory` follow the identical `Current()` pattern in their Blink
getters; UA + `Sec-CH-UA` come from `cfg->navigator.user_agent` / `ua_brands` / `ua_platform` in the
`UserAgentMetadata` provider. `screen`/`DPR` follow the same shape (`fingerprint/screen-dpr.patch`).

## Verification (build machine)

After `build.sh --run`, launch with a config written by the sidecar and re-run
`ci/validation/run.mjs` against Lobium: `deepSurfaces.webgl.matchesClaim` flips to **true**, the
Sannysoft WebGL rows pass (drop `thresholds.sannysoft.maxFailed` 2 → 0), and CreepJS trust rises. That
harness is already wired (the detector matrix) so Lobium's arrival is objectively measurable.
