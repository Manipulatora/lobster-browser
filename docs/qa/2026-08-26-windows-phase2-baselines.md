# Phase 2 — fingerprint baselines, 20 personas, measured on the Windows host

2026-08-26. Companion to [`2026-08-26-windows-understanding.md`](2026-08-26-windows-understanding.md)
and [`2026-08-26-windows-phase1-3d.md`](2026-08-26-windows-phase1-3d.md).

**Three of the four contradictions the brief predicted are CONFIRMED at full applicability; the
fourth could not be exercised on this host and a control shows the build is not contradicted on it.
A fifth, not in the brief, was found.** The WebGL surface itself came back clean on every persona: no cap
over-claim, no extension advertised-but-null, no software renderer leaked into the persona.

**The one thing this run is not:** a real-GPU baseline. This host has no GPU (see §5), so these 20
captures are SwiftShader captures — the same condition that makes the seven prior detector reports
suspect. What they *do* establish is everything that is backend-independent, which turns out to be
most of the persona surface.

Reports: `ci/validation/reports/win-gpu-baseline-<persona>-20260826T114129Z.json` (20 files + a
summary). Harness: [`scripts/qa-gpu-baseline.mjs`](../../scripts/qa-gpu-baseline.mjs), personas from
[`scripts/qa-generate-personas.mjs`](../../scripts/qa-generate-personas.mjs).

---

## 1. The persona set

Twenty profiles, generated the way the product generates them (`deriveFingerprint` /
`deriveAndroidFingerprint` → `applyGeoToFingerprint` → `buildLobiumConfig`, with a staged and
verified font pack), never read from a real profile.

| group | n | claimed GPUs | notes |
|---|---|---|---|
| Windows | 6 | Intel Arctic Sound, AMD Radeon Pro W5300M, RTX 3060 ×2, RTX 5050 Max-Q, RTX 4060 | one behind a proxy |
| macOS Intel | 3 | AMD Metal renderers | |
| macOS ARM | 3 | Apple M1 Max, M2 Max, M3 Max | `colorDepth 30`; one behind a proxy |
| Linux | 3 | Mesa Intel UHD ×2, RTX 2080 Mobile | |
| Android | 5 | Mali-G57, Adreno 740, … | 393×873, dpr 2.75 |

Locales/timezones span US, DE, JP, BR, GB, FR, ES, IT, NL, KR, PL, SE, TR, ID, IN.

---

## 2. The four known contradictions

| # | contradiction | fires / applicable |
|---|---|---|
| 1 | `screen.colorDepth = 30` while CSS `(color:)` answers the host's 8 | **3 / 3** |
| 2 | persona claims the Google Chrome brand but rejects `com.widevine.alpha` | **20 / 20** |
| 3 | Dolby Vision baked to the build OS, not the persona | **not exercised** — see §2.3 |
| 4 | WebGL names a GPU while `navigator.gpu.requestAdapter()` returns null | **18 / 18** |

### 2.1 colorDepth vs CSS `(color:)` — confirmed, and it is not alone

```
macarm-01   colorDepth 30 | css (color:) 8 | color-gamut srgb | dynamic-range standard
macarm-02   colorDepth 30 | css (color:) 8 | color-gamut srgb | dynamic-range standard
macarm-03   colorDepth 30 | css (color:) 8 | color-gamut srgb | dynamic-range standard
```

`derive.ts:234` ties `colorDepth` to the GPU-derived arch (`arm64 ⇒ 30`), `Screen::colorDepth` is
hooked by `fingerprint/screen-dpr.patch`, and the CSS side is not hooked at all. **All 20 personas
report `colorBits 8`, `color-gamut srgb`, `dynamic-range standard`** — the host's values, unchanged
by any persona.

Worth stating plainly because the brief only names `(color:)`: an Apple-Silicon MacBook persona is
claiming a 30-bit wide-gamut panel, and a page that asks the CSS layer gets "8-bit sRGB, standard
dynamic range" three different ways. The single fix — hooking
`MediaValues::CalculateColorBitsPerComponent` and its gamut/dynamic-range siblings — closes all
three.

### 2.2 Widevine — confirmed on every persona, and EME itself works

```
com.widevine.alpha  ->  REJECTED: NotSupportedError     (20/20)
org.w3.clearkey     ->  RESOLVED                        (20/20)
```

ClearKey resolving is the useful half: EME is present and functioning, so this is specifically
Widevine being absent, exactly as `enable_widevine` defaulting false predicts (neither
`lobium/gn-args.gn.example` nor `gn-args-windows.gn` sets it). Every real Chrome resolves
`com.widevine.alpha`; a one-line page read separates this build from Chrome on every profile.

The brief's own detector for this was wrong in a way worth recording — `claimsChrome` tested
`/Chrome\//` against the UA string, which is true for every persona by construction. It now tests the
Sec-CH-UA brand list, so the signal means something. (Fixed in
`ci/validation/fingerprint-conformance.mjs`.)

### 2.3 Dolby Vision — NOT confirmed. It could not be exercised here at all.

**This section originally reported the contradiction as confirmed, 6/20. That was wrong twice over,
and a control settled it.**

The first run probed `dvh1.05.07` and got `""` on all 20 personas. `engine-audit.md:715` uses
`dvh1.05.06` — a different profile/level — and predicts the opposite result: *"this build (Windows):
'probably'/'maybe'"*, because
`enable_platform_dolby_vision = proprietary_codecs && (is_cast_media_device || is_win)` and this is a
Windows target with `proprietary_codecs = true`.

So I re-probed every Dolby Vision string, and — the part that decides it — **ran the same probe
against stock Chrome 152.0.7977.42 on this same machine**:

```
                        our build          stock Chrome 152 (same host)
dvh1.05.06              ""    MSE=false    ""    MSE=false
dvh1.05.07              ""    MSE=false    ""    MSE=false
dvhe.05.06 / .07        ""    MSE=false    ""    MSE=false
dva1.05.06              ""    MSE=false    ""    MSE=false
hvc1.1.6.L93.B0         ""    MSE=false    ""    MSE=false
avc1.42E01E             "probably" MSE=true "probably" MSE=true
```

**Our build is not contradicted on this surface — it matches real Chrome on the same OS exactly.**
Platform Dolby Vision needs a host decoder as well as the build flag, and this VM has none, so the
`is_win`-only tell cannot be produced here in either browser. A run that reports it "clean" is
reporting that it never looked, which is why the harness now emits an explicit
`dolby-vision-not-exercised` rather than a pass.

Two consequences worth carrying forward:

* **`engine-audit.md`'s `dolby-vision-baked-to-build-os` finding is unverified on this class of
  host.** Its mechanism may well be right — nothing in the fork touches `canPlayType`, so a Windows
  build *with* a DV decoder would advertise it to a macOS persona. But its stated expectation for
  "this build" does not hold on a machine without the decoder, and no measurement in this repo has
  yet been taken on one that has it.
* **My earlier `hevc` claim was wrong for the same reason.** I recorded "hevc empty on all 20, real
  Chrome on Windows reports HEVC" as a second discrepancy. Stock Chrome on this host also reports
  `""`. It is a host-capability effect, not a build difference.

The direction of the check was also inverted while I was correcting it, in both
`ci/validation/fingerprint-conformance.mjs` and `scripts/qa-gpu-baseline.mjs`: it fired on the
personas that were *correct* and stayed silent on the only case that is genuinely contradicted. The
rule is one-directional — a **non-Windows** persona advertising Dolby Vision is unmasked — and both
files now say so.

### 2.4 WebGL GPU vs `navigator.gpu` — confirmed, and the repo's two descriptions were both wrong

```
navigator.gpu           present: true      (20/20)
requestAdapter()        returns null       (20/20)
```

This settles a contradiction I flagged in Phase 0: `docs/STATUS.md:16` said `requestAdapter()`
returns null and `docs/qa/2026-08-23-fingerprint-defect-register.md:62` said `navigator.gpu` is
undefined. **Neither is quite right** — `navigator.gpu` exists, and `requestAdapter()` resolves to
`null`. A page therefore sees a browser that has WebGPU, names an Apple M3 Max in WebGL, and cannot
produce an adapter.

Two of the 18 applicable personas are worth naming for honesty: `linux-01` and `linux-02` did **not**
fire, because my detector's "claims a discrete GPU" test does not match `Mesa Intel(R) UHD Graphics`.
That is a gap in the detector, not a difference in the product — those two behave identically. The
brief's own claim that "every profile advertises a discrete GPU" is likewise too strong: the catalog
includes integrated parts, and `linux-01`/`linux-02` drew them.

---

## 3. A fifth contradiction, not in the brief: Android pointer/hover

**An Android persona reports desktop pointer and hover.**

```
android-01   UA "…Android 10; K… Mobile Safari"   uaData.mobile true
             maxTouchPoints 5      screen 393x873 dpr 2.75
             css (device-width/height) agree
             (pointer: coarse) FALSE       (hover: none) FALSE
```

All five Android personas, and in fact all 20 profiles, report `pointer: fine` / `hover: hover`.

**The capability contract claimed otherwise.** `lobium_capabilities.cc` described `mobile-persona` as
covering "Touch points, pointer/hover media features and the rest of the mobile-shaped surfaces".
`fingerprint/mobile-persona.patch` hooks **exactly one upstream file** —
`third_party/blink/renderer/modules/plugins/dom_plugin_array.cc` — and nothing else. `maxTouchPoints`
comes from `navigator-ua-ch`; pointer and hover come from **CDP**
(`Emulation.setDeviceMetricsOverride{mobile:true}`, `packages/engine-runner/src/mobile-emulation.ts`),
which the Android launch path installs and my desktop-path harness did not.

So the product's Android path does cover these surfaces — but not natively, and not the way the
contract said. That matters because over-reporting is the one direction this contract must never
fail in: the sidecar *requires* `mobile-persona` for a mobile launch, and anyone who trusted the old
wording and removed the CDP layer would silently return pointer and hover to desktop values next to
an Android UA. It also sits awkwardly against the product's stated principle that identity is applied
in C++ "never by a JavaScript or CDP overlay, because an overlay is itself detectable".

**Fixed** to describe what the hook actually does, and to name where the other surfaces come from.
Whether to hook pointer/hover natively is a design decision, not a doc fix, and is left open.

---

## 4. What came back clean

Every one of these held across all 20 personas:

| surface | result |
|---|---|
| `getSupportedExtensions()` naming an extension `getExtension()` will not return | **0 / 20** — none |
| texture allocated at the advertised `MAX_TEXTURE_SIZE` | succeeds, 20 / 20 |
| renderbuffer at advertised `MAX_RENDERBUFFER_SIZE` | succeeds, 20 / 20 |
| program linked at advertised `MAX_VARYING_VECTORS` | succeeds, 20 / 20 |
| WebGL2 context available | 20 / 20 |
| `navigator.webdriver` | `false`, 20 / 20 |
| software renderer leaked into the persona's WebGL strings | **never** |
| persona timezone applied | 20 / 20 |
| persona language applied | 20 / 20 |
| `mediaDevices.enumerateDevices()` | 3 devices, per-origin hashed ids, 20 / 20 |

The cap results are the strongest of these. A persona claiming an RTX 5090 or an Apple M3 Max on a
host whose only backend is SwiftShader does **not** advertise caps the backend cannot execute —
`fingerprint/webgl-runtime-safety.patch` clamps them, and the allocation at the advertised limit
succeeds rather than erroring. That is the single most likely way for a spoofed GPU to break a real
page, and it does not happen.

Extension counts split 32 / 35, and the two halves have different explanations — one intended, one
not:

* The **Apple-Silicon** 35s are `webgl-extensions.ts` emitting the three mobile block-compression
  formats, gated on `opts.appleSilicon` (`webgl-extensions.ts:164`, matched via `/Apple Md/`). That
  is the intended rule, visible in the measurement.
* The **Android** 35s are not that rule at all — an Android renderer never matches `/Apple Md/`.
  `deriveAndroidFingerprint` never calls `webgl1/2ExtensionsFor`: `android.ts:197` spreads
  `coherentGpuIdentity({ ...device.webgl })` from `androidGpu()` (`pools.ts:436-440`), which sets
  vendor/renderer/caps and **no `extensions`**. `WebGlFingerprint.extensions` is optional and
  `lobium-config.ts` never populates it, so by the series' own fail-open rule the page reads the
  **host's** list — which is exactly the 35 stock Chrome reports on this machine.

  So an Android persona very likely ships the host's WebGL extension list. I have not confirmed this
  against a captured Android config field-by-field, so it is stated as the reading of the code plus a
  matching count, not as a measurement.

**Timezone note.** `android-05` asked for `Asia/Kolkata` and reports `Asia/Calcutta`. That is ICU's
own canonicalisation, not the engine's — Node on this host resolves `Asia/Kolkata` to `Asia/Calcutta`
too — so stock Chrome does the same and it is not a tell.

---

## 5. What this run cannot tell you

**Everything above was measured on SwiftShader.** This host has no GPU:
`webgl: unavailable_software`, `glRenderer: ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device
(Subzero)), SwiftShader 5.0.0)`, on a QEMU/Bochs adapter. The brief was written believing this
machine had one; it does not, and neither does the Linux box.

What that does and does not cost:

* **Not affected** — contradictions 1, 2, 3 and the Android pointer/hover finding are all
  backend-independent: they are build configuration and unhooked CSS/codec surfaces, and they will
  read the same on any host.
* **Affected** — contradiction 4 is *guaranteed* to fire here, because a GPU-less host cannot produce
  a WebGPU adapter at all. Whether a real-GPU host produces a **coherent** adapter (one that names
  the persona's claimed GPU rather than the host's) is the actual question, and it is untested.
* **Affected** — the clean cap results prove the clamp works *downward*, to a weak backend. Whether a
  persona claiming a **weaker** GPU than the host correctly clamps *its* caps, and whether the deep
  WebGL surfaces (`host-gpu-profile.patch`'s extension list and shader precision, the ones the fork's
  own comment says "leaked the host while UNMASKED_RENDERER was already spoofed") hold up against a
  real driver, is untested.
* **CreepJS** was captured but returned nothing usable — the page was still computing when the probe
  read it. The stored `headline` field shows `FP ID: Computing…`. Treat CreepJS as not measured; a
  longer settle or an explicit completion signal is needed.

A real-GPU run remains outstanding, and no work on either of this project's two hosts can substitute
for it.
