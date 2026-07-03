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

Two more surfaces ship in the same patch (both **proven**, both adversarially reviewed):

- **`navigator.deviceMemory` + the `Device-Memory` / `Sec-CH-Device-Memory` client-hint header** — hooked
  at their SINGLE shared source `ApproximatedDeviceMemory::GetApproximatedDeviceMemory()`
  (`third_party/blink/common/device_memory/approximated_device_memory.cc`), so the JS getter and the HTTP
  header always report the identical value (the review caught that hooking only the JS getter left the
  header leaking the host value — a cross-surface tell). The configured value is snapped to a bucket this
  build actually emits (nearest power-of-two GB, clamped to desktop `[2,32]` / Android `[1,8]`). Proven:
  config `16` → JS **and** header report `16` (host `32`); `1→2`, `6→4`, `32→32`.
- **`navigator.maxTouchPoints`** (`third_party/blink/renderer/core/events/navigator_events.cc`) — overrides
  on the optional's `has_value()` so a desktop persona can force `0`. Coherent for a desktop persona
  (`0`) on a non-touch host; full touch coherence (ontouchstart / TouchEvent / CSS pointer-media) is a
  WebPreferences follow-up.

## `core/navigator-ua-ch.patch` — next native surfaces (NOT YET AUTHORED)

`platform` and `languages` are **deferred here on purpose**: each is coupled to an HTTP header
(`Sec-CH-UA-Platform` + `navigator.userAgentData.platform`; `Accept-Language`) and a lone JS-getter
override would *desync* them — the same class of bug the review caught for deviceMemory. They land in a
dedicated coherent patch: `platform` follows the `Current()` pattern in `NavigatorID::platform()` **plus**
the browser-process `UserAgentMetadata` (so `Sec-CH-UA-Platform` and `navigator.userAgentData.platform`
agree); `languages` overrides `Navigator::GetAcceptLanguages()` so `navigator.languages` and the
`Accept-Language` header agree. `screen`/`DPR` follow the same `Current()` shape (`fingerprint/screen-dpr.patch`).

## Verification (build machine)

After `build.sh --run`, launch with a config written by the sidecar and re-run
`ci/validation/run.mjs` against Lobium: `deepSurfaces.webgl.matchesClaim` flips to **true**, the
Sannysoft WebGL rows pass (drop `thresholds.sannysoft.maxFailed` 2 → 0), and CreepJS trust rises. That
harness is already wired (the detector matrix) so Lobium's arrival is objectively measurable.
