# SPEC — Fingerprint Parameters (the crown-jewel catalog)

> **Scope:** the definitive, implementation-actionable catalog of every configurable fingerprint
> parameter Lobster exposes, grouped by browser surface, plus the coherence engine that ties them
> together, the real-system sourcing model, the seed→config pipeline, the editor-UI grouping, and the
> per-parameter mapping to **Lobium native patches**. Historical/CDP mappings are retained only to explain
> the internal validation harness and migration gaps.
> **Read first:** [`docs/MASTER_PLAN.md`](../MASTER_PLAN.md) §5–§6 (fingerprint engine + coherence bar)
> and the current model in [`packages/shared-types/src/fingerprint.ts`](../../packages/shared-types/src/fingerprint.ts)
> and [`packages/fingerprint`](../../packages/fingerprint).
> **Owner:** Claude (fingerprint-coherence model). **Status:** authoritative for the parameter model;
> honest about what is enforced today vs planned. See **Status vs target** at the end.

This is the "50+ configurable parameters" pillar (MASTER_PLAN §1, Pillar 1). Governing principle,
unchanged from the plan: **coherence beats coverage** — every surface must describe *one* plausible
real machine, drawn from real-device data, **stable per profile**, and (for the geo cluster) aligned
to the proxy exit IP.

---

## 0. Legends

### 0.1 Method (how a parameter is enforced)

| Method | Meaning |
|---|---|
| **native-Lobium** | Enforced inside our own Chromium build (Lobium) at the C++/engine layer — no JS tell. This is the production requirement for profile-visible fingerprint values. |
| **JS-safe-CDP** | Legacy/internal-harness value substitution over CDP (`Emulation.*`) and/or a main-world init script. It can support regression tests and migration comparison, but is **not** a production stealth layer. Never used for canvas/WebGL/audio/TLS. |
| **network** | Applied at the proxy/header layer (mitmproxy + request-header canonicalization) — e.g. `Accept-Language`, `Sec-CH-UA-*` request headers, TLS. |
| **real-value** | Left as the engine's real value on purpose (it already matches a coherent real device, or spoofing it is a bigger tell than leaving it). |

### 0.2 Status (what is true in the repo today)

| Status | Meaning |
|---|---|
| **done** | Implemented and exercised end-to-end in the path named by the method. A `JS-safe-CDP` row marked done is harness/migration proof, not proof of production native enforcement. |
| **partial** | Modeled in `@lobster/shared-types` and/or partially wired, but not yet fully enforced or validated. |
| **planned** | In the parameter model as a target; production enforcement lands on the Lobium native track. |

### 0.3 Priority

`P0` ship-blocking for a credible anti-detect story · `P1` important for realism/coverage · `P2`
long-tail hardening. Mirrors MASTER_PLAN §5's priority column.

### 0.4 What exists today (grounding)

- **`Fingerprint` model** (`fingerprint.ts`): `navigator`, `screen`, `webgl`, `locale`, `fonts`,
  plus `os`/`arch`. `FingerprintOverrides` allows per-section user edits.
- **Derivation** (`derive.ts`): seed → FNV-1a → mulberry32 → one coherent device from the built-in
  catalog (`pools.ts`), then apply overrides + proxy-geo overlay. _(Superseded: the earlier
  Apify `fingerprint-generator` + 32-candidate pool was removed in commit 9499136 — see
  [PROJECT-STATUS](../PROJECT-STATUS.md). The internal catalog is now the source of truth.)_
- **Geo overlay** (`coherence.ts` → `applyGeoToFingerprint`): rewrites timezone/locale/languages/
  Accept-Language (+ geolocation) from the proxy `GeoInfo`.
- **Coherence gate** (`coherence.ts` → `validateFingerprintCoherence`): 7 hard checks (see §3).
- **Production application** (`engine-runner/src/runners/lobium-launcher.ts` + `lobium-config.ts`):
  direct-spawn Lobium, write `lobium-fp.json`, pass `--lobium-fp-config`, and let native patches consume
  profile-visible values.
- **Internal harness application** (`engine-runner/src/launch.ts` + `cdp-fingerprint.ts`):
  `buildCdpEmulation` + `buildFingerprintInitScript` can still apply migration values over CDP for
  regression tests. This path must not be used as the product stealth layer.

**Applied in the legacy/internal CDP harness (`applyCdpFingerprint`), harness-verified:** `userAgent`,
`Sec-CH-UA` metadata (brands/fullVersion/platform/platformVersion/architecture/model/mobile),
`languages` (clean list) + `acceptLanguage`, `platform`, `timezone`, `locale` (best-effort),
`hardwareConcurrency`, and **`geolocation`** (`setGeolocationOverride`, T-018). The residual
init-script surfaces `deviceMemory`/`maxTouchPoints` are native-authoritative only when Lobium consumes
them through its config channel. Everything else in this catalog is `partial`/`planned` until native
Lobium consumption and detector proof exist.

---

## 1. Master catalog — every parameter by surface

Columns for every table: **Parameter | Type / range | Method | Coherence constraints | Mobile
variant | Priority | Status**. "Constraints" reference the coherence rule IDs in §3 (e.g. `C-UA-OS`).

### 1.1 navigator / User-Agent / User-Agent Client Hints

The identity surface. `NavigatorFingerprint` in `fingerprint.ts` covers the starred rows; the rest
are targets (Chrome exposes them, so they must be coherent even where we don't yet override them).

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| `navigator.userAgent` ★ | string | JS-safe-CDP (`setUserAgentOverride`) + network header | `C-UA-OS` `C-UA-VER` `C-UA-CH` | `...; Android 14; Pixel 8) ... Mobile Safari` | P0 | **done** |
| `navigator.appVersion` | string (UA minus `Mozilla/`) | JS-safe-CDP (derived from UA) | must equal `userAgent.slice(8)` | mobile UA tail | P1 | partial |
| `navigator.platform` ★ | enum: `Win32` / `MacIntel` / `Linux x86_64` / `Linux aarch64` | JS-safe-CDP + init script | `C-PLAT-OS` | `Linux armv8l` / `Linux aarch64` | P0 | **done** |
| `navigator.vendor` | `"Google Inc."` (Chrome) / `""` | JS-safe-CDP (init) | must be `Google Inc.` for Chromium; empty for Firefox-class | same | P1 | partial |
| `navigator.vendorSub` | `""` | real-value | always empty on Chromium | same | P2 | planned |
| `navigator.product` | `"Gecko"` | real-value | constant across browsers | same | P2 | planned |
| `navigator.productSub` | `"20030107"` (Chrome) / `"20100101"` (FF) | JS-safe-CDP (init) | `C-UA-CH` (engine family) | same | P1 | planned |
| `navigator.appName` | `"Netscape"` | real-value | constant | same | P2 | planned |
| `navigator.appCodeName` | `"Mozilla"` | real-value | constant | same | P2 | planned |
| `navigator.languages` ★ | `string[]` BCP-47 | CDP UA-override (clean list) + network | `C-LANG-LOCALE` `C-GEO` | same | P0 | **done** (q-value leak fixed, T-018) |
| `navigator.language` | string = `languages[0]` | CDP UA-override | must equal `languages[0]` | same | P0 | **done** |
| `navigator.hardwareConcurrency` ★ | int 2–32 (typ. 4/8/12/16) | JS-safe-CDP (`setHardwareConcurrencyOverride`) | `C-CPU-MEM` `C-CPU-DEVICE` | 4–8 | P1 | **done** |
| `navigator.deviceMemory` ★ | enum GiB: 0.25/0.5/1/2/4/8 (capped at 8) | JS-safe-CDP (init) | `C-CPU-MEM` | ≤4 | P1 | partial (CDP harness only; native Lobium must be authoritative; value now spec-capped, T-018) |
| `navigator.maxTouchPoints` ★ | int (0 desktop, 5 mobile) | JS-safe-CDP (init) | `C-TOUCH` (must be >0 iff mobile) | 5 | P1 | partial (CDP harness only; native Lobium must be authoritative) |
| `navigator.oscpu` | string (Firefox only; `undefined` on Chrome) | real-value | must be `undefined` on Chromium | n/a | P2 | planned |
| `navigator.doNotTrack` | `null` / `"1"` / `"0"` | JS-safe-CDP (init) | stable per profile; usually `null` | same | P2 | planned |
| `navigator.webdriver` | bool → **must be `false`/absent** | native-Lobium / JS-safe-CDP | hard tell if `true` (`C-AUTOMATION`) | same | P0 | **done** (via `--disable-blink-features=AutomationControlled` + patchright) |
| `navigator.pdfViewerEnabled` | bool (`true` on desktop Chrome) | real-value | `true` desktop, `false` typical mobile | `false` | P2 | planned |
| `navigator.cookieEnabled` | bool `true` | real-value | constant | same | P2 | real-value |
| `Sec-CH-UA` (brands) ★ | list `{brand,version}` incl. GREASE | JS-safe-CDP (`userAgentMetadata.brands`) + network | `C-UA-CH` `C-UA-VER` `C-GREASE` | same brands, `mobile=?1` | P0 | **done** |
| `Sec-CH-UA-Mobile` ★ | `?0` / `?1` | JS-safe-CDP (`userAgentMetadata.mobile`) + network | `C-TOUCH` (`?1` iff mobile) | `?1` | P0 | **done** |
| `Sec-CH-UA-Platform` ★ | `"Windows"`/`"macOS"`/`"Linux"`/`"Android"` | JS-safe-CDP + network | `C-PLAT-OS` | `"Android"` | P0 | **done** |
| `Sec-CH-UA-Platform-Version` ★ | string e.g. `"15.0.0"` / `"14.5.0"` | JS-safe-CDP + network | `C-OSVER` (matches OS build) | Android API ver | P0 | **done** |
| `Sec-CH-UA-Full-Version-List` ★ | list incl. full Chrome ver | JS-safe-CDP (`userAgentMetadata.fullVersion`) + network | `C-UA-VER` | same | P0 | **done** |
| `Sec-CH-UA-Arch` | `"x86"` / `"arm"` | JS-safe-CDP (`userAgentMetadata.architecture`) + network | `C-ARCH` (matches `fp.arch`) | `"arm"` | P1 | **done** (from `fp.arch`) |
| `Sec-CH-UA-Bitness` | `"64"` / `"32"` | JS-safe-CDP + network | `C-ARCH` | `"64"` | P1 | partial (constant `64`; not yet in metadata) |
| `Sec-CH-UA-Model` | string (`""` desktop, device on mobile) | JS-safe-CDP (`userAgentMetadata.model`) + network | `""` desktop; real device on mobile | `"Pixel 8"` etc. | P1 | **done** (empty desktop) |
| `Sec-CH-UA-WoW64` | `?0` / `?1` | JS-safe-CDP + network | `?0` unless 32-on-64 | `?0` | P2 | planned |

### 1.2 screen / window / matchMedia

`ScreenFingerprint` covers the starred rows. Window/orientation/matchMedia are targets.

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| `screen.width` ★ | int px (desktop ≥1024) | native-Lobium / JS-safe-CDP + `--window-size` | `C-SCREEN-AVAIL` `C-SCREEN-DPR` | portrait dims | P1 | partial (window-size arg only) |
| `screen.height` ★ | int px (desktop ≥600) | native-Lobium / JS-safe-CDP + `--window-size` | `C-SCREEN-AVAIL` | portrait dims | P1 | partial |
| `screen.availWidth` ★ | int ≤ width | native-Lobium / JS-safe-CDP | `C-SCREEN-AVAIL` (≤ width) | = width | P1 | partial |
| `screen.availHeight` ★ | int ≤ height (minus taskbar/menubar) | native-Lobium / JS-safe-CDP | `C-SCREEN-AVAIL` | ≈ height − status/nav bar | P1 | partial |
| `screen.availLeft` / `availTop` | int (0 typical) | native-Lobium | 0 unless multi-monitor offset | 0 | P2 | planned |
| `screen.colorDepth` ★ | 24 / 30 | JS-safe-CDP (init) | must equal `pixelDepth` | 24 | P1 | partial |
| `screen.pixelDepth` | 24 / 30 | JS-safe-CDP (init) | must equal `colorDepth` | 24 | P1 | planned |
| `devicePixelRatio` ★ | 1 / 1.25 / 1.5 / 2 / 2.625 / 3 | native-Lobium / JS-safe-CDP | `C-SCREEN-DPR` (macOS Retina=2; mobile 2.6–3.5) | 2.6–3.5 | P1 | partial |
| `screen.orientation.type` | `landscape-primary` (desktop) / `portrait-primary` | native-Lobium | must match width/height ratio + mobile | `portrait-primary` | P1 | planned |
| `screen.orientation.angle` | 0 / 90 / 180 / 270 | native-Lobium | 0 desktop; 0/90 mobile | 0 | P2 | planned |
| `window.innerWidth`/`innerHeight` | int (viewport) | native-Lobium / launch viewport | ≤ avail dims; consistent with DPR | device viewport | P1 | partial |
| `window.outerWidth`/`outerHeight` | int (window incl. chrome) | native-Lobium | ≥ inner; ≤ screen | = screen (mobile) | P2 | planned |
| `window.screenX`/`screenY` | int | native-Lobium | within virtual screen | 0 | P2 | planned |
| `matchMedia('prefers-color-scheme')` | `light` / `dark` | native-Lobium / JS-safe-CDP (`Emulation.setEmulatedMedia`) | stable per profile | same | P2 | planned |
| `matchMedia('color-gamut')` | `srgb` / `p3` | native-Lobium | matches claimed display (`p3` on Retina) | `p3` | P2 | planned |
| `matchMedia('resolution')` (dppx) | matches `devicePixelRatio` | native-Lobium | must equal DPR | DPR | P2 | planned |

### 1.3 WebGL / WebGL2

`WebGlFingerprint` carries vendor/renderer/unmasked. Everything numeric/extension/pixel is a **deep
surface** → native-Lobium; never JS-spoofed (MASTER_PLAN §5 rule 1).

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| `VENDOR` (masked, `getParameter 0x1F00`) | string e.g. `"Google Inc. (NVIDIA)"` | native-Lobium | `C-GPU-OS` | mobile GPU vendor | P0 | partial (modeled) |
| `RENDERER` (masked, `0x1F01`) | ANGLE string | native-Lobium | `C-GPU-OS` (`C-D3D`: Direct3D only on Windows) | Adreno/Mali/Apple | P0 | partial (modeled) |
| `UNMASKED_VENDOR_WEBGL` (`0x9245`) | string | native-Lobium | must equal a coherent real vendor | mobile vendor | P0 | partial (mirrors vendor) |
| `UNMASKED_RENDERER_WEBGL` (`0x9246`) | string | native-Lobium | `C-GPU-OS` `C-D3D` | mobile renderer | P0 | partial (mirrors renderer) |
| `VERSION` (`0x1F02`) | `"WebGL 1.0 (OpenGL ES 2.0 Chromium)"` | native-Lobium | matches engine family | same | P1 | planned |
| `SHADING_LANGUAGE_VERSION` | `"WebGL GLSL ES 1.0 ..."` | native-Lobium | matches VERSION | same | P1 | planned |
| supported extensions list (`getSupportedExtensions`) | string[] (~30–50) | native-Lobium | set matches GPU+driver+OS | mobile ext set | P1 | planned |
| numeric params (MAX_TEXTURE_SIZE, MAX_VIEWPORT_DIMS, MAX_RENDERBUFFER_SIZE, MAX_*_UNIFORM_VECTORS, ALIASED_LINE/POINT range, MAX_TEXTURE_IMAGE_UNITS, MAX_VERTEX_ATTRIBS, …) | ints/tuples | native-Lobium | values consistent with the claimed GPU | mobile caps | P1 | planned |
| `getShaderPrecisionFormat` (rangeMin/Max, precision) | ints | native-Lobium | consistent with GPU precision | mobile precision | P2 | planned |
| **pixel hash / readPixels** (rendered-image fingerprint) | bytes → hash | native-Lobium **farbling** (seeded, per-profile, session-stable) | deterministic per profile; never per-call noise (`C-STABLE`) | seeded | P0 | planned |
| WebGL2 params (MAX_3D_TEXTURE_SIZE, MAX_ARRAY_TEXTURE_LAYERS, MAX_DRAW_BUFFERS, transform-feedback caps, …) | ints | native-Lobium | consistent with GPU | mobile caps | P1 | planned |
| `getContextAttributes` (antialias, alpha, depth, …) | bools | native-Lobium | consistent defaults | same | P2 | planned |

### 1.4 Canvas 2D / OffscreenCanvas

Deep surface → native-Lobium seeded farbling. **Never** spoofed from JS.

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| `HTMLCanvasElement.toDataURL` output | PNG/JPEG bytes → hash | native-Lobium farbling (seeded) | `C-STABLE` (deterministic per profile); coherent with GPU/OS text stack | seeded | P0 | planned |
| `CanvasRenderingContext2D.getImageData` | pixel bytes | native-Lobium farbling (seeded) | must match `toDataURL` under same seed | seeded | P0 | planned |
| `measureText` / `TextMetrics` (width, actualBoundingBox*, font ascent/descent) | floats | native-Lobium | consistent with font list + OS text renderer (`C-FONT-OS`) | mobile metrics | P1 | planned |
| `OffscreenCanvas` (2D/WebGL) parity | same as above | native-Lobium | must equal main-thread canvas under same seed (`C-WORKER`) | seeded | P1 | planned |
| Worker-context canvas parity | same | native-Lobium | worker and window must agree (`C-WORKER`) | seeded | P1 | planned |
| `toBlob` parity | bytes | native-Lobium | must equal `toDataURL` | seeded | P2 | planned |

### 1.5 AudioContext

Deep surface → native-Lobium.

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| `AudioContext.sampleRate` | 44100 / 48000 | native-Lobium | stable per profile; matches platform default | 48000 | P0 | planned |
| `AudioContext.baseLatency` | float sec (~0.005–0.02) | native-Lobium | consistent with sampleRate/OS audio stack | mobile latency | P1 | planned |
| `AudioContext.outputLatency` | float sec | native-Lobium | ≥ baseLatency | mobile | P2 | planned |
| `destination.maxChannelCount` | 2 / 6 / 8 | native-Lobium | matches claimed audio device | 2 | P2 | planned |
| **DSP hash** (OfflineAudioContext oscillator→compressor→FFT sum) | float → hash | native-Lobium noise (seeded) | `C-STABLE` (deterministic per profile) | seeded | P0 | planned |
| `AnalyserNode` frequency data fingerprint | Float32Array | native-Lobium | consistent with DSP hash under same seed | seeded | P1 | planned |

### 1.6 Fonts

`fonts: string[]` exists on `Fingerprint` (matched to OS in `pools.ts` / generator). Enumeration and
metrics enforcement is native-Lobium.

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| Installed-font list (enumeration) | string[] | native-Lobium | `C-FONT-OS` (list matches OS: Segoe/Calibri=Win, Helvetica Neue/SF=mac, DejaVu/Liberation=Linux) | Roboto/Noto (Android) | P1 | partial (modeled) |
| Font-metrics probe (`measureText` per font / `document.fonts.check`) | floats/bool | native-Lobium | present iff font in list (`C-FONT-METRIC`) | mobile fonts | P1 | planned |
| Font smoothing / subpixel rendering signature | rendered pixels | native-Lobium | consistent with OS + canvas farbling | mobile | P2 | planned |

### 1.7 WebRTC

`network` + native-Lobium. Modeled as a profile **policy** (see editor grouping §6); no field on
`Fingerprint` yet.

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| WebRTC mode | enum: `proxy` (ICE==exit IP) / `real` / `disabled` / `manual` | native-Lobium / network | `C-WEBRTC` (public IP == proxy exit IP) | same | P0 | planned |
| Public IP policy | proxy exit IP only; no host candidate | native-Lobium / network | must not leak real/local IP | same | P0 | planned |
| Local IP / mDNS | masked (`.local` mDNS) or suppressed | native-Lobium | no private RFC1918 leak | same | P0 | planned |
| `enumerateDevices` (mic/cam/speaker) | list `{kind,label,deviceId,groupId}` | native-Lobium / JS-safe-CDP | count+labels coherent per profile; `deviceId` stable per profile | mobile device set | P1 | planned |

### 1.8 Timezone / locale / geolocation (the geo cluster)

`LocaleFingerprint` + `applyGeoToFingerprint`. **The single most important coherence rule** — all
derive from the proxy exit IP.

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| `timezone` (IANA) | e.g. `America/New_York` | JS-safe-CDP (`setTimezoneOverride`) + native-Lobium | `C-GEO` (matches proxy geo) | same | P0 | **done** |
| `locale` (BCP-47) | e.g. `en-US` | JS-safe-CDP (`setLocaleOverride`, best-effort) | `C-LANG-LOCALE` `C-GEO` | same | P0 | **done** |
| `acceptLanguage` (header + `navigator.languages` src) | q-weighted list | JS-safe-CDP + network | `C-ACCEPT-LANG` (leads with locale) | same | P0 | **done** |
| `geolocation` (lat/lon/accuracy) | floats | JS-safe-CDP (`setGeolocationOverride`) + native-Lobium | `C-GEO` (within proxy country/city) | same | P1 | **done** (sent by `applyCdpFingerprint`; live-gate verified via `getCurrentPosition`, T-018) |
| `Intl.DateTimeFormat().resolvedOptions()` (timeZone, locale, calendar, numberingSystem) | strings | JS-safe-CDP (follows locale/tz overrides) | must equal `timezone`/`locale` (`C-INTL`) | same | P1 | partial |
| `Intl.NumberFormat` / collation quirks | formatting | native-Lobium / real-value | consistent with locale | same | P2 | planned |

### 1.9 Media codecs

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| `HTMLMediaElement.canPlayType` matrix (H.264, HEVC, AV1, VP9, AAC, Opus, FLAC, …) | `"probably"`/`"maybe"`/`""` | native-Lobium | matches browser build + OS codecs (`C-CODEC-OS`) | mobile codec set | P1 | planned |
| `MediaSource.isTypeSupported` matrix | bool | native-Lobium | consistent with `canPlayType` | mobile | P1 | planned |
| `mediaCapabilities.decodingInfo` (supported/smooth/powerEfficient) | bools | native-Lobium | consistent with GPU/codec support | mobile | P2 | planned |

### 1.10 speechSynthesis

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| `speechSynthesis.getVoices()` | list `{name,lang,localService,default,voiceURI}` | native-Lobium | voice set + langs match OS (`C-VOICE-OS`) | mobile TTS voices | P2 | planned |

### 1.11 Battery

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| `getBattery()` (charging, level, chargingTime, dischargingTime) | bool/float | native-Lobium | plausible values, session-stable; API absent on some builds | discharging, <1.0 | P2 | planned |

### 1.12 Sensors

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| DeviceOrientation/DeviceMotion presence | absent (desktop) / present (mobile) | native-Lobium | present iff mobile (`C-SENSOR`) | present + live values | P2 | planned |
| Accelerometer/Gyroscope/Magnetometer (Generic Sensor API) | presence + readings | native-Lobium | present iff mobile | present | P2 | planned |
| AmbientLight/Proximity | presence | native-Lobium | present iff mobile | present | P2 | planned |

### 1.13 Permissions

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| `permissions.query(...)` state shape (notifications, geolocation, camera, mic, …) | `granted`/`denied`/`prompt` | native-Lobium / JS-safe-CDP | notifications default `prompt`; must not contradict `Notification.permission` (`C-PERM`) | same | P2 | planned |
| `Notification.permission` | `default`/`granted`/`denied` | native-Lobium | consistent with `permissions.query('notifications')` | same | P2 | planned |

### 1.14 clientRects / DOMRect

Deep surface → native-Lobium seeded noise.

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| `getClientRects` / `getBoundingClientRect` sub-pixel values | floats | native-Lobium noise (seeded) | `C-STABLE`; consistent with DPR + font metrics | seeded | P1 | planned |
| `Range.getBoundingClientRect` (text measurement) | floats | native-Lobium noise (seeded) | must agree with element rects | seeded | P2 | planned |

### 1.15 plugins / mimeTypes

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| `navigator.plugins` | list (5 PDF entries on modern Chrome desktop) | native-Lobium / JS-safe-CDP | present iff `pdfViewerEnabled`; empty on mobile (`C-PLUGIN`) | empty | P2 | planned |
| `navigator.mimeTypes` | list (`application/pdf`, `text/pdf`) | native-Lobium / JS-safe-CDP | mirrors `plugins` | empty | P2 | planned |

### 1.16 WebGPU

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| `GPUAdapter.requestAdapterInfo` (vendor, architecture, device, description) | strings | native-Lobium | matches WebGL GPU identity (`C-GPU-CONSISTENCY`) | mobile GPU | P2 | planned |
| `GPUAdapter.limits` (maxTextureDimension, maxBufferSize, workgroup sizes, …) | ints | native-Lobium | consistent with the claimed GPU | mobile limits | P2 | planned |
| `GPUAdapter.features` set | string set | native-Lobium | consistent with GPU/driver | mobile features | P2 | planned |
| WebGPU availability | present/absent | native-Lobium | present iff claimed browser+OS supports it | varies | P2 | planned |

### 1.17 Math / libm / Intl numerics

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| Transcendental `Math` results (sin/cos/tan/exp/log/atanh at edge inputs) | float (libm signature) | native-Lobium / real-value | signature matches claimed OS libm (`C-LIBM-OS`) | mobile libm | P2 | planned |
| `Intl` formatting edge quirks (currency spacing, RTL marks) | strings | real-value / native-Lobium | consistent with locale | same | P2 | planned |

### 1.18 Storage / network / gamepads

| Parameter | Type / range | Method | Coherence constraints | Mobile variant | Priority | Status |
|---|---|---|---|---|---|---|
| `navigator.storage.estimate()` quota | int bytes | native-Lobium | plausible vs deviceMemory/disk; stable per profile (`C-QUOTA`) | smaller quota | P2 | planned |
| `navigator.connection` (effectiveType, rtt, downlink, saveData) | enum/ints/bool | native-Lobium / JS-safe-CDP | consistent with proxy network class; `4g` typical | `4g`/`3g` | P2 | planned |
| `navigator.getGamepads()` | array (empty typical) | native-Lobium | empty unless simulated | empty | P2 | planned |
| `navigator.userAgentData.getHighEntropyValues()` | object (arch, bitness, model, platformVersion, fullVersionList, wow64) | JS-safe-CDP (`userAgentMetadata`) + native | all fields coherent with UA-CH rows above (`C-UA-CH`) | mobile values | P0 | partial (metadata set; not all high-entropy fields wired) |

**Parameter count:** ~90 discrete parameters across 18 surfaces — comfortably the advertised "50+".

---

## 2. Real-system sourcing

### 2.1 Primary source — internal coherent catalog (`pools.ts`)

> ⚠️ **SUPERSEDED (historical).** The Apify `fingerprint-generator` / `fingerprint-suite` design below
> was **removed in commit 9499136**. The current source of truth is the internal `pools.ts` catalog
> (deterministic FNV-1a → mulberry32), which owns the device model and drops the supply-chain +
> shared-distribution tell. This subsection is retained only for the reasoning trail; see
> [PROJECT-STATUS](../PROJECT-STATUS.md) for reality.

- `generate.ts` constructs one `FingerprintGenerator` (loads a Bayesian network of **real-device**
  co-occurrence statistics). We query it with `{operatingSystems:[os], browsers:['chrome'],
  devices:['desktop'], locales:['en-US']}`.
- Because the network samples via `Math.random`, we wrap each derive in `withSeededMathRandom(seed)`
  (mulberry32 seeded from `hashStringToUint32(seed)`), making the whole draw **deterministic per
  seed** → stable identity across restarts.
- The network occasionally emits an incoherent sample (e.g. a macOS UA with a Linux platform), so we
  draw a **pool of 32** and take the first that passes `isSelectable` (coherent + realistic desktop
  screen + non-empty fonts + valid Sec-CH-UA brand contract). Empirically 24 already yields a
  coherent candidate for 100% of seeds; 32 is margin.

### 2.2 Fallback — built-in device templates (`pools.ts`)

Small hand-curated, individually-coherent `DEVICE_TEMPLATES` for Windows/macOS/Linux (platform,
UA token, fonts, WebGL vendor/renderer, screens, hardwareConcurrency, deviceMemory) + `CHROME_VERSIONS`.
Used only if the generator throws or (astronomically unlikely) the whole pool is unusable, so derive
**never fails**. Every template entry is itself coherent.

### 2.3 Datasets still needed (planned)

The generator does not cover the deep/long-tail surfaces. To source those we need real-device
datasets for: GPU→(WebGL params, extensions, WebGPU limits) tables; per-OS **font lists + metrics**;
**audio** sampleRate/latency per platform; **codec** support matrices per Chrome version × OS;
**speechSynthesis** voice lists per OS; libm/Math signatures per OS; and mobile (Android) device
profiles (screen/DPR/GPU/model/RAM). These feed the native-Lobium enforcement layer.

### 2.4 Dataset licensing note

`fingerprint-suite` / `fingerprint-generator` are **Apache-2.0** — freely importable (MASTER_PLAN
§0 open-source posture; §7.5 "import freely, keep attribution"). Any additional real-device dataset
we ingest must be permissively licensed (Apache-2.0 / MIT / CC0 / CC-BY with attribution) or
self-collected; record provenance + license in an attribution file. No scraping of a competitor's
proprietary dataset. Legal/licensing is owner-maintained (MASTER_PLAN header).

---

## 3. The coherence engine (cross-surface constraint set)

Coherence is enforced in three places today: `validateFingerprintCoherence` (post-derive gate),
`isSelectable` (candidate filter in `generate.ts`), and `applyGeoToFingerprint` (geo overlay). The
table below is the **full target constraint set**; the Status column says where each is enforced now.

| ID | Constraint | Rule | Enforced today? |
|---|---|---|---|
| `C-UA-OS` | UA ↔ OS | `userAgent` contains the OS token (`Windows`/`Mac`/`Linux`) for `fp.os` | **yes** (`validateFingerprintCoherence`) |
| `C-PLAT-OS` | platform ↔ OS | `Win32`(win) / `MacIntel`(mac) / `Linux*`(linux) | **yes** |
| `C-LANG-LOCALE` | languages ↔ locale | `navigator.languages[0] === locale.locale` | **yes** |
| `C-ACCEPT-LANG` | Accept-Language ↔ locale | header leads with `locale.locale` | **yes** |
| `C-SCREEN-AVAIL` | avail ≤ physical | `availWidth ≤ width && availHeight ≤ height` | **yes** |
| `C-GPU-NONEMPTY` | WebGL present | vendor/renderer non-empty | **yes** |
| `C-D3D` | Direct3D ↔ Windows | Direct3D renderer only when `os==='windows'` | **yes** |
| `C-UA-CH` | UA ↔ UA-CH | Sec-CH-UA brands non-empty + `uaFullVersion` present; platform from OS map | **yes** (`isSelectable` + `OS_TO_UA_PLATFORM`) |
| `C-SCREEN-REAL` | realistic screen | width ≥ 1024, height ≥ 600 (desktop) | **yes** (`isSelectable`) |
| `C-FONT-NONEMPTY` | fonts present | `fonts.length > 0` | **yes** (`isSelectable`) |
| `C-GEO` | geo cluster ↔ proxy IP | timezone + locale + languages + geolocation all derive from proxy `GeoInfo` | **yes** (`applyGeoToFingerprint` + `setGeolocationOverride`, T-018) |
| `C-UA-VER` | version alignment | engine version == UA-claimed version == Sec-CH-UA full-version-list major | planned/native Lobium |
| `C-ARCH` | arch ↔ UA-CH | `Sec-CH-UA-Arch`/`Bitness` match `fp.arch` | partial (arch mapped; bitness constant) |
| `C-CPU-MEM` | cores ↔ RAM ↔ device | hardwareConcurrency & deviceMemory plausible together and for the device class | partial (drawn from real-device dist) |
| `C-GPU-OS` | GPU ↔ OS | renderer backend matches OS (Metal=mac, Mesa/OpenGL=Linux, D3D11=Win) | partial (modeled; `C-D3D` subset enforced) |
| `C-FONT-OS` | fonts ↔ OS | font list matches the claimed OS | partial (templates are OS-matched) |
| `C-TOUCH` | touch ↔ mobile | `maxTouchPoints>0` ⟺ `uaMobile` ⟺ `Sec-CH-UA-Mobile=?1` | planned (mobile track) |
| `C-SCREEN-DPR` | DPR ↔ platform | Retina mac → DPR 2; mobile 2.6–3.5; Win typ. 1/1.25/1.5 | planned |
| `C-STABLE` | deep-surface stability | canvas/WebGL/audio/rects hashes deterministic per profile, **no per-call noise** (MASTER_PLAN §5 rule 4) | planned (native) |
| `C-WORKER` | window ↔ worker parity | OffscreenCanvas/worker surfaces equal main-thread under same seed | planned |
| `C-CODEC-OS` | codecs ↔ OS/build | canPlayType matrix matches Chrome build + OS | planned |
| `C-VOICE-OS` | voices ↔ OS | speechSynthesis voice set matches OS | planned |
| `C-SENSOR` | sensors ↔ mobile | DeviceMotion/Orientation present iff mobile | planned |
| `C-PERM` | permissions ↔ notification | `permissions.query('notifications')` == `Notification.permission` | planned |
| `C-INTL` | Intl ↔ tz/locale | `Intl.resolvedOptions()` matches overrides | partial (follows CDP overrides) |
| `C-LIBM-OS` | Math ↔ OS libm | transcendental signature matches OS | planned |
| `C-GPU-CONSISTENCY` | WebGPU ↔ WebGL | adapter info agrees with WebGL GPU | planned |
| `C-OSVER` | OS version ↔ UA-CH | `Sec-CH-UA-Platform-Version` matches a real OS build for the claimed OS | partial |
| `C-AUTOMATION` | no automation tell | `navigator.webdriver` false/absent; no CDP artifacts | **yes** (flag + patchright + harness) |

### 3.1 The two master coherence chains

1. **Device story:** `os → platform → userAgent → Sec-CH-UA(all) → arch/bitness → WebGL vendor/
   renderer → WebGPU → fonts → screen/DPR → hardwareConcurrency/deviceMemory → maxTouchPoints/mobile`.
   One implausible link (e.g. Direct3D on macOS, Win32 with an Android UA) fails the chain.
2. **Geo story:** `proxy exit IP → country/city → timezone → locale → navigator.languages →
   Accept-Language → geolocation → Intl.resolvedOptions`. This is the highest-value chain and is the
   one thing most competitors get subtly wrong.

---

## 4. Per-profile seed → config model

```
profile.fingerprintSeed (hex, persisted)                       ← generateSeed() / isValidSeed()
        │
        ▼  hashStringToUint32 → mulberry32  (seeds Math.random)
deriveFingerprint(seed, {os, engine, arch})                    ← derive.ts
        │  generator pool(32) → first isSelectable()  (fallback: pools.ts)
        ▼
Fingerprint  { os, arch, navigator, screen, webgl, locale, fonts }
        │
        ├── applyGeoToFingerprint(fp, GeoInfo)   ← overwrite geo cluster from proxy exit IP
        │
        ├── applyOverrides(fp, FingerprintOverrides)  ← user edits from the editor UI
        ▼
Launch:  buildLaunchOptions(fp) → non-fingerprint launch policy args
         buildLobiumConfig(fp, policy) → <userDataDir>/lobium-fp.json
         createLobiumLauncher(...) → direct-spawn native Lobium
         --lobium-fp-config=<path> → per-profile config channel consumed natively
         CDP endpoint returned → automation/control/measurement only
```

**Invariants:** (1) same `(seed, os, arch)` ⇒ byte-identical `Fingerprint` (deterministic, tested in
`derive.test.ts` / `generate.test.ts`); (2) geo is the *only* thing that changes when the proxy
changes; (3) `FingerprintOverrides` is applied last and is shallow-merged per section
(`overrides.ts`), so an edit never breaks a section it didn't touch — but the editor must re-run
`validateFingerprintCoherence` and warn on any override that breaks a `C-*` rule.

**Seed → config channel (Lobium, production path):** the same derived `Fingerprint` (plus the
deep-surface seed and launch policy) is serialized and handed to Lobium over the per-profile config
channel (MASTER_PLAN §5 Pillar 5) so canvas/WebGL/audio/rects farbling and all UA-CH/screen/font values
are enforced natively with no JS tell. The config model is the *same* `@lobster/shared-types` shape
consumed by the editor UI, the sidecar, and Lobium (MASTER_PLAN §5 rule 5).

---

## 5. Editor-UI grouping

The fingerprint editor (Pillar 1) groups the catalog into these panels; each field shows its
`Method` badge and greys out to read-only where it is native-only/not-yet-editable, and each panel
runs live coherence validation.

| Panel | Parameters (from §1) | Editability | Notes |
|---|---|---|---|
| **Identity / Browser** | userAgent, appVersion, all Sec-CH-UA (brands/mobile/platform/platformVersion/full-version/arch/bitness/model), vendor, productSub | editable (advanced); default seed-driven | changing UA re-validates the whole device chain |
| **Operating System** | os, arch, platform, oscpu, uaPlatformVersion | pick OS → cascades platform/fonts/GPU defaults | drives `C-PLAT-OS`, `C-FONT-OS`, `C-GPU-OS` |
| **Hardware** | hardwareConcurrency, deviceMemory, maxTouchPoints | dropdowns (real-device ranges) | `C-CPU-MEM`, `C-TOUCH` |
| **Screen & Window** | width/height/avail*, colorDepth/pixelDepth, devicePixelRatio, orientation, inner/outer size, matchMedia scheme/gamut | presets + custom | `C-SCREEN-AVAIL`, `C-SCREEN-DPR` |
| **WebGL / GPU** | vendor, renderer, unmasked*, version, extensions, params, WebGPU adapter/limits | host-calibrated bundle; read-only individually | native-Lobium enforced |
| **Canvas / Audio / Rects** | canvas/audio/clientRects noise mode | toggle: off / seeded-native | deep surfaces — no manual values, only on/off + seed |
| **Fonts** | font list (add/remove), metrics | multi-select from OS-appropriate catalog | `C-FONT-OS` |
| **Locale & Geo** | timezone, locale, languages, acceptLanguage, geolocation | **auto from proxy** (default) or manual override | `C-GEO` — warns loudly if manually desynced from proxy |
| **WebRTC** | mode, public-IP policy, local-IP/mDNS, media devices | mode dropdown | `C-WEBRTC` |
| **Advanced / Long-tail** | doNotTrack, plugins/mimeTypes, permissions shape, battery, sensors, speech voices, codecs, connection, storage quota, gamepads | mostly toggles/presets | P2; native-Lobium |
| **Device type** | desktop / mobile (Android) | top-level switch | flips mobile variants across every panel |

### 5.1 Declared create-profile wizard fields

The 2026-07-07 product UI declaration makes these controls first-class in the create/edit profile flow:

| Wizard field | Model status | Engine status | Notes |
|---|---|---|---|
| User Agent | modeled; **product read-only** | native Lobium | Always derived from OS (+ Android type) and `ENGINE_CHROME`. |
| Operating system | `windows` / `macos_intel` / `macos_arm` / `linux` / `android` | desktop launchable except Android | Android fail-closed on desktop until APK track. |
| OS version | `Profile.osVersion` + UA-CH platform version | carried in `lobium-fp.json` policy | Win 10/11; macOS 13/14/15/26; Android 13+. |
| Screen resolution | modeled + Retina DPR | native screen hooks | Hidden for Android; Mac Retina options set DPR=2. |
| Fonts | verified MS Learn / Apple Support catalogs | fontconfig packs conditional | Modes `real\|manual\|based_ip`; Linux deferred. |
| Languages/timezone/geolocation | modeled + persona modes | CDP/native locale path | `based_ip` uses proxy geo overlay. |
| WebRTC | `WebRtcPolicy` + persona mode | launch flags + config `net.webrtcPolicy` | `real` / `manual` / `based_ip` (`proxy_only`). |
| CPU cores/RAM | modeled | native | Coherence-bounded. |
| Renderer/GPU | verified PCI/Apple catalogs (`verified_source`) | native vendor/renderer + caps | See [`fingerprint-catalog-provenance.md`](fingerprint-catalog-provenance.md). |
| Hardware noise: WebGL/canvas/audio | seeds gated by checkboxes | native farbling when seed≠0 | Off → seed 0. |
| Hardware noise: Client Rects | policy field | planned | UI exposed; native hook absent. |
| Media devices | policy field | written to config; native consume partial | Counts + stableDeviceIds. |
| Android device type/model | Play CSV catalog | non-launchable on desktop | Hundreds of verified phones/tablets. |

Android must not be treated as a normal desktop Chromium/Lobium launch target. The TS catalog can now
derive and validate Android personas, but they become launchable only through the Android APK/device
runner described in [`android.md`](android.md). iOS is not a Lobster target.

---

## 6. Native Lobium production mapping — summary

| Surface | Internal harness / legacy mapping | Production Lobium mapping |
|---|---|---|
| navigator / UA / UA-CH | CDP regression harness exists | native, no init script |
| timezone / locale / languages / Accept-Language | CDP/network regression harness exists | native + network headers |
| geolocation | CDP control API can grant/test permission | native/configured policy |
| hardwareConcurrency / deviceMemory / maxTouchPoints | CDP/init regression harness exists | native |
| screen / DPR / matchMedia | launch/window policy harness only | native |
| WebGL vendor/renderer/params/extensions | measured/compared only | **native host-calibrated farbling** |
| Canvas 2D / Offscreen / worker | **not touched** (JS spoof is a tell) | **native farbling (seeded)** |
| AudioContext DSP | **not touched** | **native (seeded)** |
| clientRects / DOMRect | **not touched** | **native (seeded)** |
| fonts enumeration + metrics | modeled list only | native |
| WebRTC IP/leak | policy (planned) | **native** |
| TLS / JA3 / JA4 / HTTP-2 / TCP-IP | measured only | **native (BoringSSL/net)** |
| WebGPU / codecs / speech / battery / sensors / permissions / storage / connection | modeled/planned | native |

Rule (MASTER_PLAN §5 rules 1–2, non-negotiable): **we never ship product fingerprint spoofing through
JS/CDP/Patchright**. CDP may be used to control or measure Lobium, or as an internal regression harness,
but production profile-visible values must be native Lobium or fail/disable honestly.

---

## Status vs target

**Built today:** the deterministic seed→coherent-`Fingerprint` fallback pipeline (`pools.ts`), proxy-geo
overlay, coherence validator, internal CDP regression helpers, and native Lobium config/farbling
coverage for the main deep surfaces: canvas, WebGL vendor/renderer + pixel farbling + scalar caps, audio
float/byte/worklet paths, screen/DPR/colorDepth/availTop, navigator hardware fields, UA/platform in workers,
and UA header/Sec-CH-UA metadata. The launcher can also isolate fonts with private fontconfig when a font
pack is provisioned.

**Still not built/proven:** host-calibrated persona derivation has a typed helper, browser-side probe
scaffold, and `startProfile` path when a host snapshot is supplied, but there is no persisted first-run
host calibration service and no real-GPU baseline yet. Native detector proof is still SwiftShader/dev
proof; clientRects/codecs/voices/WebGPU and TLS/JA4 remain future depth; Android has catalog/coherence
support but remains absent as a launch path; iOS is discarded; final licensed font bundles are packaging
work. The parameter model and constraints here remain useful, but the primary production path is now:
capture the real host -> derive from host -> farble per profile, with `pools.ts` retained as fallback.
The direct native launcher now writes the config and launches Lobium without Patchright; still open are
authenticated proxy handling and cookie pre-injection/export on that direct path. The full create-profile UI requested in
[`product-ui-ux-plan.md`](product-ui-ux-plan.md) must expose support status rather than pretending all
fields are already enforced by the engine.
