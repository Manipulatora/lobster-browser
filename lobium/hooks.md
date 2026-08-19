# Lobium hook reference

Every point where Lobium diverges from stock Chromium, why it exists, and what it does **not**
cover. The patch series (`patches/series`) is the source of truth for the code; this document is the
source of truth for the *reasoning*, and for the honest coverage boundary.

Engine: Chromium **152.0.7977.42**. Primary target: **Windows x64**.

> Findings referenced as `` `some-id` `` below are from [`../docs/ENGINE_AUDIT.md`](../docs/ENGINE_AUDIT.md),
> the adversarially-verified audit of this engine. Where a hook has a confirmed defect it is stated
> here rather than left for someone to rediscover.

---

## 1. Architecture

The rule: **every fingerprint surface is spoofed in native C++ inside Blink.** Not injected
JavaScript, not a CDP override. A JS override is detectable by `Function.prototype.toString`, by
prototype-chain inspection and by property-descriptor comparison; a CDP override applies per target,
misses workers, and mutates real state (`setDeviceMetricsOverride` actually resizes the viewport).
Native hooks change only the value a page can read.

Almost all logic lives in an **added** directory, `//components/lobium_fp/`, staged from
[`src/`](src/) by [`build.ps1`](build.ps1) / [`build.sh`](build.sh). An added directory never
conflicts on rebase. The patches under [`patches/`](patches/) are only the minimal hook points into
existing Chromium files, so tracking a new Chrome stable is days of work, not weeks.

```
  sidecar                       browser process                 renderer process
  ----------------------------  ------------------------------  ----------------------------
  writeLobiumConfig()           reads the file ONCE, caches     LobiumFpConfig::Current()
    -> <profile>/lobium-fp.json   |                               parses --lobium-fp-data once
    -> --lobium-fp-config=<path> -+-> base64 -> --lobium-fp-data  serves typed fields to hooks
```

The renderer is sandboxed and cannot open the file, so the browser forwards the contents on the
child command line — the same shape Chromium itself uses for `GaiaConfig`. Forwarding reaches worker
renderers, so `Current()` is populated for dedicated, shared and service workers.

Every hook has the same shape and the same fallback rule:

```cpp
if (const lobium::LobiumFpConfig* cfg = lobium::LobiumFpConfig::Current();
    cfg && <field is configured>) {
  return <persona value>;
}
return <real host value>;
```

**This is fail-open by construction**, and that is a deliberate, load-bearing decision with a real
cost: a config that fails to parse produces a browser that silently reports host values. The
`LOG(ERROR)` on every failure path is not a safety net in a shipping build (`log-fail-open-is-silent`,
`fail-open-is-silent-in-shipping-build`). The actual safety net is the **capability contract** below,
which runs before the browser starts.

### The capability contract

`core/capability-contract.patch` makes the executable print a versioned JSON manifest for
`--lobium-fingerprint-capabilities` and exit, before browser startup. The sidecar
(`packages/engine-runner/src/lobium-capabilities.ts`) runs the **exact binary it is about to spawn**
and refuses to launch if a capability the profile needs is absent. Filenames, version strings and a
stale sidecar manifest are all deliberately not trusted.

The list itself is **not** in the patch. It lives in `components/lobium_fp/lobium_capabilities.cc`,
beside the hooks it describes, and the patch is a single call to `CapabilityManifestJson()`. That
matters because over-reporting is the dangerous direction: the sidecar launches on the strength of
this manifest, so a build that claims a hook it does not contain silently disables spoofing the
operator believes is on. A list duplicated into a patch literal drifts in exactly that direction.

`ci/validation/patch-series.test.mjs` fails the build if the native list, the TypeScript mirror in
`packages/engine-runner/src/lobium-capabilities.ts`, and `patches/series` disagree — including a
check that every `fingerprint/` patch is covered by some capability, which is what surfaced
`screen-metrics` and `mobile-persona` as shipped-but-unrequirable surfaces.

`font-isolation` is emitted only under `BUILDFLAG(IS_WIN)`, and `requiredLobiumCapabilities` asks for
it only on `win32`. A Linux build genuinely does not contain the DirectWrite hooks; claiming
otherwise would be the same lie in a different place.

> **Reproducibility gate.** `npm run gate:series` replays the whole series into a scratch tree built
> from pristine git blobs and diffs the result against the checkout. Everything else in CI checks
> that the patches are well *formed*; this checks that applying them yields the binary that was
> actually tested. Without it, a hook present in the checkout but missing from its patch ships a
> clean build with the hook gone — while the manifest still advertises it, because the manifest lives
> in the staged module rather than in a patch.

---

## 2. Hook reference

Line numbers are the post-patch positions at 152.0.7977.42 and drift on every rebase; the enclosing
function is the stable anchor.

### Core

| Patch | File · function | What it does |
| --- | --- | --- |
| `core/build-gn.patch` | `components/embedder_support/BUILD.gn` · `static_library("user_agent")` | dep on `//components/lobium_fp` |
| | `content/renderer/BUILD.gn` · `target("renderer")` | same |
| | `third_party/blink/common/BUILD.gn` · `source_set("common")` | same — owns `approximated_device_memory.cc` |
| | `third_party/blink/renderer/core/BUILD.gn` · `component("core")` | same |
| | `third_party/blink/renderer/modules/BUILD.gn` · `component("modules")` | same — owns WebGL and WebAudio |
| `core/capability-contract.patch` | `chrome/app/chrome_main.cc` | prints the contract and exits, before browser startup |
| `core/config-channel.patch` | `content/browser/renderer_host/render_process_host_impl.cc` · `PropagateBrowserCommandLineToRenderer` | reads `--lobium-fp-config` once, forwards base64 `--lobium-fp-data`, size-guarded |
| `core/navigator-ua-ch.patch` | `components/embedder_support/user_agent_utils.cc` · `GetUserAgentFromCommandLine`, `GetPlatformForUAMetadata` | the HTTP `User-Agent` header **and** `Sec-CH-UA*` metadata, browser-side — the deepest shared source, so navigations, subresources and all three worker types agree |
| | `blink/renderer/core/execution_context/navigator_base.cc` · `NavigatorBase::NavigatorBase` | `navigator.userAgent` + `navigator.platform` in every context, workers included |
| | `blink/renderer/core/frame/navigator_concurrent_hardware.cc` | `navigator.hardwareConcurrency` |
| | `blink/common/device_memory/approximated_device_memory.cc` · `Initialize` | `navigator.deviceMemory` **and** the `Device-Memory` client hint from one source, so they cannot disagree |
| | `blink/renderer/core/events/navigator_events.cc` | `navigator.maxTouchPoints` (stored as an optional, so a configured `0` overrides the host rather than reading as "unset") |

### Fingerprint surfaces

| Patch | File · function | What it does |
| --- | --- | --- |
| `fingerprint/canvas-farbling.patch` | `core/html/canvas/html_canvas_element.cc` · `ToDataURLInternal`, `toBlob` | farbles a private RGBA8888/unpremultiplied copy of the snapshot |
| | same · `Snapshot` | **deliberately NOT farbled** — it is the shared source-image path (`drawImage`, `createImageBitmap`, `texImage2D`), so farbling here would perturb ordinary rendering and double-apply |
| | `core/offscreencanvas/offscreen_canvas.cc` · `convertToBlob` | the worker encode path; without it a worker leaks the true canvas hash while `getImageData` returns farbled pixels |
| | `modules/canvas/canvas2d/base_rendering_context_2d.cc` · `getImageDataInternal` | farbles the fresh ImageData allocation, using a **one-pixel apron** read from the snapshot so the decision cannot depend on the requested rectangle |
| `fingerprint/webgl-surfaces.patch` | `modules/webgl/webgl_rendering_context_base.cc` · `getParameter` (×3) | `UNMASKED_VENDOR/RENDERER` as an atomic pair; scalar `MAX_*` caps |
| | same · `ReadPixelsHelper` | bottom-up pixel farbling, keyed top-down so it agrees with `toDataURL` |
| `fingerprint/host-gpu-profile.patch` | same file | `VERSION`, `SHADING_LANGUAGE_VERSION`, `getSupportedExtensions`, `getExtension`, `getShaderPrecisionFormat` |
| | same · `getExtension` | refuses names outside the persona list, picking `extensions2` on a WebGL2 context and matching case-insensitively — both because `getSupportedExtensions` and `ExtensionTracker::MatchesName` do, and a disagreement between the two calls is the contradiction the list exists to avoid |
| `fingerprint/webgl-runtime-safety.patch` | same · `getParameter`, `getShaderPrecisionFormat`, `getSupportedExtensions` | clamps configured values to what the backend can actually execute |
| `fingerprint/webgl-bypass-closures.patch` | same · `ReadPixelsHelper` | the farble gate keys on **effective geometry**, so a no-op `PACK_ROW_LENGTH` no longer switches farbling off; user framebuffers are now covered too |
| | same · `getSupportedExtensions` | picks `extensions` or `extensions2` by context type — a WebGL1 list handed to a WebGL2 context collapsed to the few names common to both |
| `fingerprint/webgl2-surfaces.patch` | `modules/webgl/webgl2_rendering_context_base.cc` · `getParameter` | `MAX_*_UNIFORM_COMPONENTS` / `MAX_VARYING_COMPONENTS` derived as 4× the persona's vector limits, which is how ANGLE's D3D11 backend derives them |
| `fingerprint/webgpu-adapter.patch` | `modules/webgpu/gpu_adapter.cc` · `GPUAdapter::GPUAdapter` | `adapter.info` vendor/architecture/device/description/driver, and `adapter_type_` because `isFallbackAdapter` is derived from it |
| | same · `MakeFeatureNameSet`, `limits_` | `adapter.features` and `adapter.limits` brought onto the same device, **downward only** — see the ceiling rule in `lobium_webgpu.h` |
| `fingerprint/native-timezone.patch` | `core/timezone/timezone_controller.cc` · `OnTimeZoneChange` | the persona timezone, applied where the browser's `TimeZoneMonitor` push lands — an earlier adoption at renderer start is overwritten by that push |
| `fingerprint/windows-font-isolation.patch` | `components/services/font_data/font_data_service_impl.cc` · `MatchFamilyName` | **the** by-name lookup as of M152 — every `font-family:` resolution and the width-measurement probe |
| | same · `LegacyMakeTypeface` | the GDI-compatible by-name route to the same thing |
| | same · `MatchLocalFont` | `src: local("ArialMT")`, filtered on the PostScript name (see `FontUniqueNameAllowed`) |
| | same · `GetAllFamilyNames` | enumeration, kept in agreement with what `MatchFamilyName` resolves |
| | `content/browser/renderer_host/dwrite_font_proxy_impl_win.cc` · `FindFamily`, `MatchUniqueFont` | the pre-M152 equivalents. Still hooked: they serve single-process mode and any build with `kFontDataServiceAllWebContents` off |
| | same · `GetLocalFontCollection` | sideloads the profile's font pack, built **once per process** and shared across renderers |
| | `content/browser/font_access/font_enumeration_data_source_win.cc` · `GetFonts` | Local Font Access (`navigator.fonts.query`) filtered to the same set |

> **Do not assume DWriteFontProxy is the Windows font path.** It is what every older source and
> every guide describes, and the first version of this patch hooked only it — with literally zero
> effect: measured in-browser, every installed family still resolved while the config listed three.
> `content::InitializeFontIntegration` routes the renderer to `font_data_service::FontDataManager`
> because `kFontDataServiceAllWebContents` is `FEATURE_ENABLED_BY_DEFAULT` on Windows. This is
> exactly the class of mistake the in-browser oracle gate exists to catch; a source-only review
> would have called the patch complete.
| `fingerprint/audio-context.patch` | `modules/webaudio/offline_audio_context.cc` · `FireCompletionEvent` | farbles the finished offline result **in place, once**, so `getChannelData`, `copyFromChannel` and `event.renderedBuffer` agree by construction |
| | `modules/webaudio/realtime_analyser.cc` · `GetFloat/ByteFrequencyData`, `GetFloat/ByteTimeDomainData` | perturbs only the JS-visible destination; the byte paths farble the float values and *then* quantise, so the byte path stays the exact quantisation of the float path |
| `fingerprint/audio-worklet-tap.patch` | `modules/webaudio/audio_worklet_global_scope.h` + `offline_audio_worklet_thread.cc` | a default-false `is_offline_context_` flag only the offline thread sets |
| | `modules/webaudio/audio_worklet_processor.cc` · `CopyPortToArrayBuffers`, `Process` | farbles `process(inputs)` for offline worklets only |
| | `modules/webaudio/script_processor_node.cc` · `DispatchEvent` | farbles `AudioProcessingEvent.inputBuffer` for offline contexts only |
| `fingerprint/screen-dpr.patch` | `core/frame/screen.cc` · `GetRect`, `colorDepth`, `isExtended` | one shared hook keeps `width/height/avail*` coherent |
| | `core/frame/local_dom_window.cc` · `devicePixelRatio` | the JS getter |
| | `core/css/media_values.cc` · `CalculateDevicePixelRatio` | the CSS resolution path, so `matchMedia` agrees with the getter |
| `fingerprint/media-values-device-size.patch` | `core/css/media_values.cc` | `(device-width)` / `(device-height)` agree with `screen.*` |
| `fingerprint/locale-geolocation.patch` | `core/frame/navigator_language.cc` | `language`/`languages` in every context including service workers |
| | `content/renderer/render_thread_impl.cc` · `Init` | applies the ICU locale **before** Blink/V8 init |
| | `core/geolocation/geolocation.cc` | configured coordinates, only after Chromium's normal secure-context + permission flow succeeds |
| `fingerprint/client-rects.patch` | `core/dom/element.cc` · `getClientRects`, `GetBoundingClientRect` | sub-pixel noise keyed on the rect's **values**, so coincident geometry stays coincident. The bounding box is the **union of the farbled rects**, never a separately farbled union, so `getBoundingClientRect() == union(getClientRects())` still holds for a multi-line inline |
| `fingerprint/media-devices.patch` | `modules/mediastream/media_devices.cc` · `DevicesEnumerated` | persona camera/mic/speaker counts, shaped by the browser's own permission answer: one all-empty entry per kind until the frame holds the capture permission, then hashed ids **with** OS-shaped labels and shared mic/speaker `groupId`s |
| `fingerprint/mobile-persona.patch` | `modules/plugins/dom_plugin_array.cc` | suppresses the desktop PDF plugin surface when the config declares `uaMobile` |
| `fingerprint/webrtc-policy.patch` | `modules/peerconnection/rtc_peer_connection.cc` | four observably distinct policies; `disabled` throws `NotSupportedError` |

### Branding

Cosmetic only, no fingerprint effect: `account-menu-trim`, `omnibox-profile-chip`,
`product-icon-lobster`, `signin-disable`, `ntp-branding`, `profile-lockdown` (removes guest mode and
profile creation from the browser UI — Lobium manages profiles itself), and `device-frame`.

> `branding/device-frame.patch` is **incomplete and Linux-only**. Every hook is
> `#if BUILDFLAG(IS_LINUX)`, the created `lobium_device_frame_view.cc` is in no GN target so it is
> never compiled, and it calls `content::SetLobiumDeviceEmulationScale()` from a header that does
> not exist. It applies cleanly and does nothing. On Windows an Android profile therefore gets a
> desktop-sized viewport (`device-frame-linux-only-mobile-viewport`).

---

## 3. The shared kernels

`//components/lobium_fp/` is a `//base`-only leaf, deliberately skia-free so it can be linked from
Blink core, Blink common, Blink modules and `content/renderer` without dragging graphics types
around. Hooks pass raw buffers in.

- **`lobium_fp_config.{h,cc}`** — the config reader. `Current()` is a `base::NoDestructor` static
  parsed once per process.
- **`lobium_farble.{h,cc}`** — canvas pixels and client rects. Three properties it must have, each
  with the oracle that breaks it if absent, are documented at the top of the header: read-rectangle
  independence, idempotence, and known-input fidelity.
- **`lobium_audio_farble.{h,cc}`** — the audio sample kernel.
- **`lobium_media_devices.{h,cc}`** — reproduces Chrome's own device-id construction: HMAC-SHA256
  **keyed on the origin**, hex-lowercase, 64 characters, with separate salt domains for `deviceId`
  and `groupId` so one cannot be derived from the other. Keying on the origin is what stops the ids
  correlating a visitor across sites. Also carries the per-OS device labels, because Chrome never
  returns a populated `deviceId` beside an empty `label`. Pulls in `//crypto` as a private `deps` —
  the header exposes only `std::string`, so consumers do not inherit it.
- **`lobium_webgpu.{h,cc}`** — the WebGPU adapter's capability ceilings and its feature allow-rule.
  Both are one-directional: limits are only lowered and features only removed, because
  `adapter.limits` is what `requestDevice()` validates `requiredLimits` against and `adapter.features`
  the set it will accept, so raising either turns a passive tell into a failing call.
- **`lobium_fonts.{h,cc}`** — the font-set policy: case-insensitive membership (CSS family matching
  is case-insensitive, so a case-sensitive filter is bypassed by lowercasing the probe), Chromium's
  own last-resort families always allowed, and the pack enumeration sorted for launch-to-launch
  stability.
- **`lobium_capabilities.{h,cc}`** — the capability manifest, single-sourced beside the hooks.

`lobium_fp_config.cc` also carries `StripBrowserOnlyKeys`, which removes `fonts` and `fontPackDir`
from the copy forwarded to renderers. The browser reads the config file directly and is not size
bound; the renderer receives it base64 on a command line Windows caps at 32767 characters. Exceeding
the engine's 28 KiB guard makes the browser skip the switch entirely, so renderers report the **host**
platform and hardware concurrency — a total spoofing failure caused by a field no renderer reads.

That command line is also **locally readable**: `/proc/<pid>/cmdline` on Linux, any process-listing
tool on Windows. A page cannot reach argv, so no site can detect or read the persona this way, but
anyone else on the machine can — coordinates, timezone, screen, GPU and device counts included. On a
shared or multi-tenant host, treat the persona as visible to every local user. A shared-memory handle
or an inherited pipe would close this and remove the size guard at the same time; both are the same
piece of work, and neither is done.

---

## 4. Coverage: what is spoofed

| Surface | Where |
| --- | --- |
| `navigator.userAgent` / `platform` / `hardwareConcurrency` / `deviceMemory` / `maxTouchPoints` | native, all contexts |
| HTTP `User-Agent` header, `Sec-CH-UA*`, `userAgentData`, `getHighEntropyValues` | native, browser-side |
| `navigator.language` / `languages`, `Accept-Language`, ICU locale | native |
| `screen.*`, `devicePixelRatio`, `matchMedia` resolution + device-width/height | native |
| Canvas 2D readback (`getImageData`, `toDataURL`, `toBlob`, `convertToBlob`) | native, seeded |
| WebGL 1 vendor/renderer/caps/version/GLSL/extensions/precision, pixel readback | native, seeded |
| WebGL 2 extension list (its own, not WebGL1's) + the uniform/varying component limits | native |
| `navigator.gpu` `adapter.info` + `isFallbackAdapter`, plus `adapter.limits`/`features` clamped to that GPU's class | native |
| Timezone (ICU default, window **and** workers) — the only route that works on Windows | native |
| Installed font set on Windows: CSS matching, `src: local()`, and Local Font Access | native, browser-process |
| Web Audio: offline result, analyser float **and** byte paths, offline worklet + SPN taps | native, seeded |
| `getClientRects` / `getBoundingClientRect` | native, seeded |
| `mediaDevices.enumerateDevices` | native |
| WebRTC IP-handling policy | native |
| Geolocation (after a real permission grant) | native |

## 5. Coverage: what is **not** spoofed

Read this section before claiming a profile is undetectable.

| Surface | Status |
| --- | --- |
| **WebGPU `adapter.limits`/`features` on a backend weaker than the persona** | clamped, not lifted. The limits that separate hardware classes are lowered to the persona's class and the texture-compression families its GPU would not have are dropped (see §2), so a strong host no longer leaks through a modest persona. The reverse cannot be fixed here: a persona claiming a discrete card on a software backend still reports that backend's smaller limits, because raising one is validated by the very next `requestDevice()` |
| **WebGL2 feature-level constants** (`MAX_3D_TEXTURE_SIZE`, `MAX_ARRAY_TEXTURE_LAYERS`, `MAX_DRAW_BUFFERS`, `MAX_COLOR_ATTACHMENTS`, `MAX_TEXTURE_LOD_BIAS`) | **deliberately** left honest. On D3D11 these are functions of the feature level, not the GPU — `GetMaximum3DTextureSize` and friends switch on `D3D_FEATURE_LEVEL` alone — so every real Windows machine reports the same values and spoofing them could only introduce a difference where none exists |
| **Fonts the persona claims but the host lacks** | the DirectWrite filter can only *subtract*. Adding requires the font pack to be provisioned and named in `fontPackDir`; without a pack the measurable set is host ∩ persona, which is narrower than claimed. Tracked by the `fonts-persona-families-resolve` oracle |
| `window.outerWidth/Height`, `screenX/Y` | host values |
| `screen.isExtended`, `getScreenDetails()` | host multi-monitor state, no permission prompt |
| `screen.orientation` | host values |
| CSS colour-gamut / dynamic-range / HDR media features | host display, contradicting the spoofed `screen.colorDepth` |
| `speechSynthesis.getVoices()` | host SAPI/OneCore voices — a hard Windows tell |
| `navigator.storage.estimate()` | derived from real free disk, identical across every profile on the box |
| `navigator.connection`, `getBattery()`, `getGamepads()`, `keyboard.getLayoutMap()`, `hid`/`serial`/`usb` | host values |
| `performance.memory`, `performance.now()` resolution | host/V8 values |
| `AudioContext.sampleRate`, `destination.maxChannelCount`, `baseLatency`, `outputLatency` | host audio device |
| System-preference media queries, CSS system colours, `font: caption` | host desktop settings |
| Widevine / EME | `enable_widevine` is off in this build, so a persona claiming the "Google Chrome" brand cannot do Widevine |
| TLS/JA4 ClientHello, HTTP/2 SETTINGS order | not started (`net/` patches unwritten) |

---

## 6. Rebasing onto a new Chrome

1. `scripts/track-upstream.mjs` — confirms the candidate is a real released build, never a canary.
2. `scripts/bump-engine-version.mjs --tarball … --sha256 …` — bumps `build.sh`, `build.ps1`,
   `pools.ts` and the manifest atomically. `ci/validation/version-coherence.test.mjs` fails if they
   ever disagree.
3. `gclient sync --revision src@<tag>`.
4. `lobium/build.ps1 -Run -Stop patch -Force` — applies the series and reports the failures.
5. For each rejecting patch: fix the source in the checkout with an editor, then
   `node lobium/regen-patch.mjs <patch>` to fold the edit back in. It refuses to regenerate a patch
   that shares a file with another patch, because `git diff` would absorb the other's hunks.
6. `node --test ci/validation/patch-series.test.mjs` — the structural gate: no duplicated hunk, no
   malformed header, LF-only, ASCII-only added source, chains in the right order.

**Never validate a patch in isolation.** Several hook the same upstream file and are cut against the
tree with the earlier ones applied, so they cannot apply to a pristine checkout. The constrained
chains are listed in `patches/series`.
