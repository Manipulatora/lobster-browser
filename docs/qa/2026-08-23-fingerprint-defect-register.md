# Fingerprint defect register — 2026-08-23

Every entry was found by auditing a fingerprint domain against an authoritative source (Chromium,
ANGLE, Dawn, or a platform vendor's published list), then put through an adversarial verifier whose
job was to *refute* it. 94 claims were raised across two waves; 40 survived verification as
page-observable defects, and 19 were refuted. The refutations are recorded too, because "we checked
and it is fine" is worth as much as a fix.

## Fixed

| Domain | Defect | Correct value | Source |
|---|---|---|---|
| WebRTC | `--force-webrtc-ip-handling-policy` ignored by `chrome/` builds, so srflx candidates carrying the real public IP escaped on every launch | `--webrtc-ip-handling-policy` | `chrome/browser/prefs/chrome_command_line_pref_store.cc` |
| WebRTC | `disabled` threw a product-identifying `NotSupportedError`; real Chrome never throws there | construct normally, surface no candidate | — |
| WebRTC | `proxy_only` rewrote `iceTransportPolicy`, contradicting the page's own dictionary | echo the requested value | `rtc_peer_connection.cc` `getConfiguration()` |
| WebRTC | `groupId` derived from the profile seed, so it never rotated | its own rotating salt | Chrome renews the media-device salt |
| WebGL | Windows ANGLE device ids four hex digits | eight, zero-padded, uppercase | `gl::FmtHex` over a `UINT` |
| WebGL | `MAX_VIEWPORT_DIMS` 16384 on D3D11 | 32767 | `D3D11_VIEWPORT_BOUNDS_MAX` |
| WebGL | `MAX_VARYING_VECTORS` 31 on macOS | 30 | `DisplayMtl.mm` `31 - 1` |
| WebGL | `MAX_VERTEX_UNIFORM_VECTORS` 4096 on Linux | 1024 | `renderergl_utils.cpp` `std::min(1024, …)` |
| WebGL | 4096 on Windows NVIDIA | 4095 | `skipVSConstantRegisterZero`, NVIDIA-only |
| WebGL | macOS withheld `EXT_disjoint_timer_query` | expose it | `disjointTimerQueryEXT = true`, unconditional |
| WebGL | Apple Silicon stripped BC/S3TC | keep both families | BC formats are `#if TARGET_OS_OSX` |
| WebGL | Linux renderers carried a bare PCI id | per-driver shapes | pci.ids codenames + Mesa/NVIDIA formats |
| WebGPU | `ada-lovelace`, `xe`, `apple-silicon`, `unknown` | `lovelace`, `gen-12hp`/`gen-12lp`, `metal-3`, `""` | Dawn `gpu_info.json` + its generator casing |
| Fonts | Windows list was the *Font Name* column: 506 faces, 336 style-suffixed | the *Family* column: 141 (Win11) / 137 (Win10), 63 base | MS Learn table headers |
| Fonts | macOS list was full names with version tokens (2565 rows) | 369 families, document-support excluded, per release | Apple support pages |
| Navigator | Android UA leaked the real version and model | frozen `Linux; Android 10; K` | `user_agent_utils.cc:318` |
| Navigator | `deviceMemory` capped at 8, floored at 4 | `[2, 32]` desktop, `[1, 8]` Android | `ApproximatedDeviceMemory`, crbug.com/454354290 |
| Navigator | the engine clamped by the BUILD's platform, not the persona's | follow `uaMobile` | — |
| Locale | `navigator.languages` always two entries | Chromium's per-locale default (2–6, usually 4) | `IDS_ACCEPT_LANGUAGES` |
| Locale | region-qualified heads (`ja-JP`) | bare where Chromium is bare (`ja`, `ar`, `fa`, `lt`) | same |
| Screen | base M1/M2 on a 14" panel, base M3 on a 16" | Air 13" / Air 13.6" / Pro 14" | Apple's chip/chassis matrix |
| Screen | Windows 11 persona reserving a Windows 10 taskbar | 48 CSS px | shell work area, scale-invariant in DIP |
| Android | Pixel 9 carried Pixel 8's panel | 412x924 | DevTools `EmulatedDevices.ts` |
| Android | Redmi/POCO matched no template, drawing a random vendor's GPU | alias to Xiaomi; `Build.MANUFACTURER` = Xiaomi | Play "Retail Branding" is not the manufacturer |
| Media | camera labels missing ` (vid:pid)` | append it (not on Android) | `GetNameAndModel()` |
| Media | Android label said `camera2 N` | `camera N` | `VideoCaptureCamera2.java` |
| Canvas | readback forced to sRGB | keep the source colour space | `image_data_buffer.cc` |
| Layout | `IntersectionObserver` rects unfarbled | same kernel, seed and policy as `getBoundingClientRect` | the two ARE the same rect to a page |

## Refuted — checked, and correct as they stand

`availTop` 25px (the claim's premise was false), `Math.round` CSS sizing (nothing measurable
differs), geolocation accuracy 100m (the proposed value was not better sourced), Linux Intel ASTC
(the "correct" claim was over-broad), WebGPU device-id width (gated off for shipping profiles),
Android form-factors (fail-closed, unreachable), device counts (a default, not a fixture), Android
build incrementals (real values), Apple downloadable fonts (the proposed rule was wrong for half the
claim), Accept-Language q floor (Chromium's own floor differs from the claim), locale tags such as
`en-SG` (real), WebGL2 draft extensions (registered by default), and the `deviceMemory` sub-claims
that the ladder should keep 0.25/0.5.

## Known, unfixed, and why

- **Android tablets have no hardware templates.** A tablet model therefore cannot resolve real
  hardware, and derivation FAILS CLOSED rather than shipping a rotated phone. Fixing it needs
  curated per-device panel/SoC data this catalog does not carry, and inventing it would repeat the
  defect class above.
- **Pixel 10 has no template** for the same reason: its build id is not sourceable here.
- **`getCapabilities()` returns nothing** for persona devices. The fix is mechanical but large
  (constructing the mojom capability structs) and needs its own build cycle.
- **`navigator.gpu` is undefined on a GPU-less host.** `--enable-unsafe-webgpu` is on Chromium's
  bad-flags list, so this needs a native fix rather than a flag.
