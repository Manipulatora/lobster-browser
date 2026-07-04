# Lobium hook points (the quilt series)

Each hook patch is a **small** diff into an existing Chromium file that routes a surface through
`lobium::LobiumFpConfig::Current()` (the reader in `../src/`). The insertion points + code are given
here so a build engineer finalizes them against the pinned checkout (`quilt push -f` → edit → `quilt
refresh`) — the exact line numbers shift per Chromium ref, which is why the series ships as intent +
code rather than frozen context diffs. The first two deep surfaces (WebGL vendor/renderer, canvas 2D
farbling) are BUILT + PROVEN; audio/fonts/TLS remain to author.

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

## `platform` / UA-CH / `languages` — NOT native; handled by CDP (MASTER_PLAN §5)

**Investigated and deliberately NOT hooked natively.** These are `JS-safe` value-substitution surfaces,
which §5 routes through clean CDP, not the native engine — and the sidecar already does exactly that:
[`cdp-fingerprint.ts`](../../packages/engine-runner/src/cdp-fingerprint.ts) calls
`Emulation.setUserAgentOverride` with `platform` (→ `navigator.platform`) **and** `userAgentMetadata`
(→ the `Sec-CH-UA-Platform` header + `navigator.userAgentData.platform`), which sets all of them
coherently in one call.

A native attempt confirmed this is the right layer: `navigator.platform` is **not** served by
`NavigatorID::platform()` under this Chrome (an unconditional override there had zero effect — the value
comes via the CDP/`SetNavigatorPlatformOverride` reduced-UA path), and a browser-process
`UserAgentMetadata` hook, while it *did* drive the header + `userAgentData`, only duplicated what
`setUserAgentOverride` already does. Native patching buys nothing here and risks desync. The native moat
is for surfaces CDP genuinely **cannot** reach — see below.

## Deep surfaces (the native moat) — CDP genuinely cannot reach these

JS spoofing of these is itself the tell, so they are the real native work.

### WebGL vendor/renderer — ✅ BUILT (strings), with a documented capability gap

`webgl_rendering_context_base.cc` `getParameter` overrides `UNMASKED_VENDOR_WEBGL` /
`UNMASKED_RENDERER_WEBGL` (the `WEBGL_debug_renderer_info` strings — where the real GPU actually leaks)
from `cfg->webgl.unmasked_vendor/renderer`, as an **atomic pair** (both or neither). One site covers
WebGL1 + WebGL2 (delegation) + Workers/OffscreenCanvas. The masked `GL_VENDOR`/`GL_RENDERER` stay
Chrome's constant `"WebKit"`/`"WebKit WebGL"` (overriding them would be a tell). Proven: SwiftShader →
the persona GPU, masked unchanged.

> **KNOWN LIMITATION — string-only.** Only the vendor/renderer *strings* are overridden. The rest of the
> WebGL surface still reflects the real backend: `getSupportedExtensions()`, the `MAX_*` limits,
> `getShaderPrecisionFormat()`, the WebGL2 limit block, and — the strongest tell — the **rendered-pixel
> hash** (`readPixels`/`toDataURL`). A detector can cross-check the renderer string against these. This
> is starkest on a **SwiftShader** dev backend (an RTX-3060 string next to a software rasterizer). The
> mitigation roadmap: (a) never ship SwiftShader as the real backend; (b) pin personas to the host GPU
> class in production; (c) incrementally align the extension list + key limits + precision to the claimed
> GPU class; (d) per-profile **pixel farbling** (`seeds.webgl`) so the pixel hash is stable-per-profile
> and not a known SwiftShader/host hash. (`GL_VERSION` does NOT leak the raw driver string — the
> command-buffer sanitises it — so that specific leg is not a concern.)

### Canvas 2D farbling — ✅ BUILT + PROVEN

`seeds.canvas` drives a deterministic **±1-LSB** perturbation of R/G/B (alpha untouched) applied to the
canvas **readback** surfaces by the shared skia-free kernel `lobium::FarbleCanvasRgba`
(`//components/lobium_fp/lobium_farble.cc` — raw `uint8_t*` so `lobium_fp` stays `//base`-only). The
noise is keyed on `(seed, absolute pixel coord, channel)`, the channel folded into the **hash input**
(not applied after the avalanche) so each of R/G/B is an *independent* draw over `{-1,0,+1}` — otherwise
all three derive from one mixed value and can never nudge the same direction (`dR+dG+dB` never reaches
±3), itself a seed-independent tell. Result: **stable-per-profile, distinct-per-seed, differs from host,
imperceptible.**

Hooked at **four** readback entries so every path a fingerprinter can read is farbled identically and
exactly once:

- **`getImageData`** — `modules/canvas/canvas2d/base_rendering_context_2d.cc`. Perturbs the private,
  freshly-allocated `ImageData` pixmap (RGBA8888/unpremultiplied — never the live canvas) in place at
  origin `(sx,sy)`, so a sub-rect read matches the full-canvas read pixel-for-pixel.
- **`toDataURL`** and **`toBlob`** — `core/html/canvas/html_canvas_element.cc`, via the
  `LobiumFarbleReadback(Snapshot(...))` helper (reads the snapshot into a private
  RGBA8888/unpremultiplied `SkBitmap`, farbles at `(0,0)`, returns an `UnacceleratedStaticBitmapImage`).
- **`OffscreenCanvas.convertToBlob`** — `core/offscreencanvas/offscreen_canvas.cc`. A *separate* encode
  path; without it a worker's `convertToBlob` would leak the true host hash while `getImageData` on the
  same canvas returns farbled pixels — a cross-surface tell.

Farbling is deliberately **NOT** applied in `HTMLCanvasElement::Snapshot()`. Snapshot is also the shared
source-image path (`GetSourceImageForCanvas` → `drawImage` / `createImageBitmap` / WebGL `texImage2D`),
so farbling there would perturb ordinary compositing **and** double-apply with the `getImageData` hook.
Proven by the drawImage regression probe: `drawImage(A→B)+getImageData(B)` **equals**
`direct-draw(D)+getImageData(D)` (`MATCH=true`) — i.e. `drawImage` copies unfarbled pixels and
`getImageData` farbles exactly once. All hooks are guarded `IsRenderingContext2D()` so WebGL canvases
stay on the WebGL pixel path (coherent with `gl.readPixels`) rather than being made inconsistent by
2D-canvas noise. **Proven** (Chromium 152, SwiftShader): baseline `461f6aa5` → seed-A `625d2eaf` (stable
across reads) → seed-B `2c485d78` (distinct) for `getImageData`; the same three-way result on
`toDataURL`, `toBlob`, and `OffscreenCanvas.convertToBlob`; worker OffscreenCanvas `getImageData`
consistent with the main thread.

> **KNOWN LIMITATION — position-keyed noise.** Because the perturbation is keyed on absolute coordinate,
> a detector that draws the SAME content at many offsets and takes the per-pixel **mode** across offsets
> could average the ±1 noise away. Real fingerprinters draw their probe once at a fixed position, so this
> is the same theoretical limit Brave's farbling accepts. The obvious fix (a per-read sub-seed) is
> deliberately deferred: it would break **within-session read stability** — repeated reads of the same
> canvas must return the identical hash, which detectors also check — so it would trade one tell for a
> worse one. Revisit only with a scheme that is per-*content* rather than per-*read*.

### Still to author

WebGL **pixel farbling** + capability alignment (the limitation above), `fingerprint/audio-context.patch`
(seeded DSP), `fingerprint/fonts.patch`, and the net layer (`net/webrtc-ip-policy`, `net/tls-ja3-ja4`,
`net/http2-settings-order`). `screen`/`DPR` is a borderline JS-safe surface
(`fingerprint/screen-dpr.patch`) that can go either way. Each deep surface reads
`lobium::LobiumFpConfig::Current()->{seeds,webgl,...}` via the same proven config channel.

## Verification (build machine)

After `build.sh --run`, launch with a config written by the sidecar and re-run
`ci/validation/run.mjs` against Lobium: `deepSurfaces.webgl.matchesClaim` flips to **true**, the
Sannysoft WebGL rows pass (drop `thresholds.sannysoft.maxFailed` 2 → 0), and CreepJS trust rises. That
harness is already wired (the detector matrix) so Lobium's arrival is objectively measurable.
