# Lobium engine — anti-detect audit

**Engine:** Chromium `152.0.7977.42` · **Target:** Windows x64 · **Audit date:** 2026-08-14

An end-to-end review of every anti-detect surface in the engine, run as eight parallel
dimension audits, each followed by an independent **skeptic** whose job was to refute the
findings against the actual Chromium source. Only the skeptic's verdict is authoritative:
several plausible-sounding findings did not survive it, and several severities were corrected
in both directions.

This document is generated from the audit run. Do not hand-edit it; fix the engine and
re-run the audit instead. Progress against it belongs in `docs/STATUS.md`.

## Verdict key

| Verdict | Meaning |
| --- | --- |
| `CONFIRMED` | The skeptic reproduced the mechanism in the source. Act on it. |
| `PARTLY_TRUE` | The code observation holds but the severity, the detection or the proposed fix was wrong. **Read the skeptic's note before acting.** |
| `UNVERIFIED` | No skeptic ran for this dimension (the run hit a session limit). Treat as a lead, not a fact. |
| `REFUTED` | Does not hold. Listed at the end so nobody re-raises it. |

## Summary

**79 findings** across 8 dimensions — 30 CONFIRMED, 22 PARTLY_TRUE, 2 REFUTED, 25 UNVERIFIED.

Surviving findings by severity: **10** critical · **19** high · **31** medium · **17** low.

| Dimension | Findings | Critical | High | Skeptic |
| --- | ---: | ---: | ---: | --- |
| Canvas 2D / OffscreenCanvas / ImageBitmap | 7 | 3 | 0 | ran |
| WebGL 1 and WebGL 2 | 10 | 2 | 2 | ran |
| Web Audio | 9 | 0 | 3 | ran |
| Screen, DPR, viewport, media queries, clientRects | 11 | 0 | 3 | ran |
| navigator / User-Agent / UA client hints | 7 | 1 | 3 | ran |
| Config channel, capability contract, launcher | 10 | 1 | 1 | ran |
| Surfaces with no coverage at all | 15 | 3 | 5 | **did not run** |
| Engine architecture, build hygiene, patch series | 10 | 0 | 2 | **did not run** |

## Findings, most severe first

### CRITICAL (10)

#### `canvas-read-rect-dependent-farble` — The farble is a function of the READ RECTANGLE, not of the pixel: getImageData(x,y,1,1) is never farbled, so the pristine host canvas is fully recoverable and farbling is provable in two calls

*Canvas 2D / OffscreenCanvas / ImageBitmap* · **PARTLY_TRUE**

**Where.** `lobium/src/lobium_farble.cc (kernel) + lobium/patches/core/config-channel.patch (getImageData hook -> third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc)` — lobium_farble.cc:33-42 (same_rgb OOB rule) and :79; config-channel.patch:663-671 (applied base_rendering_context_2d.cc:518-526)

**Mechanism.**

IsSolidInterior() treats an out-of-buffer neighbour as MATCHING ("return true; // treat OOB as matching so edge-of-buffer solids still skip", lobium_farble.cc:34-35). The kernel is handed only the pixels of the requested rect, with `origin_x/origin_y` used solely for the hash key -- it can never see pixels outside the rect. Consequence: solidity, and therefore whether a pixel is perturbed at all, depends on the SIZE AND POSITION OF THE READ, while the design claims it depends only on (seed, absolute coordinate). Two exact corollaries: (1) For a 1x1 read all four neighbours are OOB -> all four `same_rgb` return true -> IsSolidInterior is unconditionally true -> `continue`. getImageData(x, y, 1, 1) is NEVER farbled, for any pixel of any canvas. (2) A sub-rect read that lands entirely inside a flat region is entirely unfarbled, while the same pixels in a full-canvas read (and in toDataURL/toBlob/convertToBlob, which always farble the whole canvas at origin 0,0) are heavily perturbed. Simulating the exact kernel on `fillRect(10,10,100,50)` in a 200x100 canvas: getImageData(40,25,20,20) disagrees with getImageData(0,0,200,100) on 312 of 400 pixels (78%). On FingerprintJS-like geometry (240x60, fillRect(100,1,62,20)) it is 243/300 (81%). Honest Chrome guarantees byte-identical results for both reads.

**How a detector sees it.**

```
Two-call farbling oracle, zero false positives, no knowledge of the host needed:
  const c=document.createElement('canvas'); c.width=200; c.height=100;
  const x=c.getContext('2d',{willReadFrequently:true});
  x.fillStyle='#f60'; x.fillRect(10,10,100,50);
  const A=x.getImageData(0,0,200,100).data, B=x.getImageData(40,25,20,20).data;
  let bad=0; for(let j=0;j<20;j++)for(let i=0;i<20;i++){const a=((25+j)*200+(40+i))*4,b=(j*20+i)*4;
    for(let k=0;k<4;k++) if(A[a+k]!==B[b+k]) bad++;}
  // honest Chrome: bad===0.  Lobium: ~936.
Full recovery of the unfarbled fingerprint (slow but exact, W*H calls):
  for(let y=0;y<h;y++)for(let x2=0;x2<w;x2++) truth.set(ctx.getImageData(x2,y,1,1).data, (y*w+x2)*4);
  // `truth` is byte-identical to honest Chrome's getImageData(0,0,w,h).
```

**Fix.**

Stop deriving the skip decision from the read buffer. Either (a) drop IsSolidInterior entirely and make the perturbation a pure function of (seed, absolute x, absolute y, and optionally the pixel's own value) -- which is the only way any of the coherence claims in lobium_farble.h can hold -- or (b) keep an edge-awareness rule but evaluate it against the FULL canvas snapshot (pass the snapshot plus the sub-rect offset into the kernel and index neighbours in snapshot space, treating true canvas-edge OOB as matching). Option (a) is strongly preferred: it also fixes canvas-solid-cascade below and costs nothing.

**Skeptic.**

The named code does not exist in the current tree. E:\project\lobium\src\lobium_farble.cc was rewritten (mtime 8/14 12:34 PM; every sibling file in lobium/src is 02:03 AM), and the canvas hooks were split out of core/config-channel.patch into fingerprint/canvas-farbling.patch. There is no IsSolidInterior, no same_rgb, and no 'treat OOB as matching' comment anywhere in E:\project (grep for IsSolidInterior|same_rgb returns nothing). The predicate is now IsFlatRun (lobium_farble.cc:62-96), which does the OPPOSITE of what the finding says: a missing neighbour sets has_neighbor only when the neighbour exists, so an out-of-buffer neighbour is NOT counted as a match.

Consequence: the quantitative core of the finding is refuted. I ported FarbleRows/IsFlatRun/FarblePixel bit-exactly to C# and ran the finder's own geometry: fillRect(10,10,100,50) #f60 on a 200x100 transparent canvas, getImageData(40,25,20,20) vs getImageData(0,0,200,100) -> 0 of 400 pixels mismatch, not 312/400. On a solid region every interior AND border pixel still matches an in-region neighbour whether or not the read rect clips it, so the claimed 78%/81% cross-read disagreement does not occur. The residual rect dependence is real but confined to the 1-px perimeter of the read rect and needs a contrived scene (8x1 row of doubled pixels AABBAABB: getImageData(1,0,4,1) disagrees with the full read on 2 of 4 pixels, because the pixel at local x=0 loses the left twin that made it flat).

BUT the headline corollary survives verbatim and is the reason I am not refuting outright. lobium_farble.cc:93-95 ends IsFlatRun with `return !has_neighbor;`, and only a 1x1 buffer has no neighbours at all (a 1xN or Nx1 read still has prev/next or left/right). So getImageData(x,y,1,1) is unconditionally treated as flat and is NEVER farbled, for any pixel of any canvas. Simulated on a random opaque 64x64 scene: the full read perturbs 3939/4096 pixels; the 1x1 loop perturbs 0/4096 and recovers 4096/4096 pixels byte-exactly. So both the two-call oracle (compare a farbled pixel from the full read against the same pixel read 1x1 -> honest Chrome is always identical) and the full pristine-host-canvas recovery (W*H 1x1 calls, ~17k calls for a 280x60 scene, well under a second with willReadFrequently:true) hold exactly as described. This is host-linkable recovery of the true canvas fingerprint, so critical is the right severity.

One correction to the 'alreadyDocumented: false': the 1x1 skip is now explicitly documented in-code at lobium_farble.cc:93-95 ('a 1x1 readback is far more likely to be a solid-colour probe than a fingerprint scene'). That rationale does not survive a trivial loop, so it is a known-but-unacceptable limitation rather than an undocumented bug. The proposed fix is also mis-scoped: dropping IsFlatRun entirely would reintroduce the known-input solid-fill probe the rule exists to defeat. The minimal correct fix is to farble a 1x1 read as if the neighbours were unknown (i.e. treat no-neighbour as NOT flat, or better, decide flatness against the full canvas snapshot rather than the read buffer).

#### `canvas-putimagedata-roundtrip-recovery` — getImageData -> putImageData -> getImageData is not idempotent: it flags farbling with certainty and recovers the exact unfarbled pixels as 2a-b

*Canvas 2D / OffscreenCanvas / ImageBitmap* · **CONFIRMED**

**Where.** `lobium/patches/core/config-channel.patch (getImageData hook -> third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc)` — config-channel.patch:663-671 (applied base_rendering_context_2d.cc:518-526)

**Mechanism.**

The hook perturbs every readback but there is no hook on putImageData (BaseRenderingContext2D::putImageData/PutByteArray, base_rendering_context_2d.cc:541-659). In honest Chromium 152 the round trip is exact: PutByteArray writes the unpremultiplied ImageData straight through WritePixels, and for a `{alpha:false}` canvas it explicitly forces kOpaque_SkAlphaType to get a memcpy (base_rendering_context_2d.cc:646-655), so a==b byte for byte. Under Lobium, a = orig + d(coord) and b = a + d(coord), so b-a = d and orig = 2a - b. Simulating the exact kernel on a 48x32 fully textured opaque scene: a!=b on 1473/1536 pixels (96%) and 2a-b recovers the pristine pixel on 1536/1536 (100%). This is not just a tell -- it hands the attacker the true host canvas fingerprint even though the seed is secret, because the noise is additive, deterministic per coordinate, and the attacker can make the canvas replay it.

**How a detector sees it.**

```
const c=document.createElement('canvas'); c.width=280; c.height=60;
  const ctx=c.getContext('2d',{alpha:false,willReadFrequently:true});  // opaque -> honest round trip is a memcpy
  drawFingerprintScene(ctx);
  const a=ctx.getImageData(0,0,280,60);
  ctx.putImageData(a,0,0);
  const b=ctx.getImageData(0,0,280,60);
  let diff=0; for(let i=0;i<a.data.length;i++) if(a.data[i]!==b.data[i]) diff++;
  // honest Chrome: diff===0.  Lobium: ~96% of samples.
  const truth=new Uint8ClampedArray(a.data.length);
  for(let i=0;i<truth.length;i++) truth[i]=2*a.data[i]-b.data[i];   // pristine host pixels
```

**Fix.**

Additive, per-coordinate, replayable noise cannot survive a write-back oracle. Two options: (1) make the perturbation a function of the pixel VALUE as well as the coordinate and non-involutive (e.g. permute within a small value class keyed on the pixel content) so applying it twice does not linearly stack; or (2) accept it and instead move the perturbation to draw time / the backing store once, so a readback is a faithful read of an already-perturbed canvas and the round trip is idempotent. Option (2) also fixes the Snapshot bypass below.

**Skeptic.**

Verified end to end against the applied checkout. There is exactly one Lobium hunk in base_rendering_context_2d.cc (lines 518-527, in getImageDataInternal); putImageData/PutByteArray at lines 541-659 are untouched, and grep for 'lobium' across third_party/blink/renderer returns only base_rendering_context_2d.cc, offscreen_canvas.cc and html_canvas_element.cc among canvas files.

The honest-Chrome baseline claim checks out in source: PutByteArray (base_rendering_context_2d.cc:644-655) forces kOpaque_SkAlphaType when !HasAlpha() with the upstream comment 'we can get the desired behavior (memcpy) by pretending the write is opaque', and otherwise uses kUnpremul_SkAlphaType, which is exact for alpha==255. So getImageData -> putImageData -> getImageData is byte-identical in honest Chrome on an {alpha:false} canvas (and on an alpha:true canvas for opaque pixels).

Simulated on the CURRENT kernel (random opaque 64x64, channel values kept in [40,215] so no clamping): a!=b on 3941/4096 pixels and 2a-b recovers 4096/4096 pixels exactly. The recovery is total because pixels the flat-run rule skips have d=0, for which 2a-b=a=orig is also correct. So both the tamper oracle and the pristine-pixel recovery are real, and the root cause is exactly as stated: the delta is a pure function of (seed, x, y, channel), independent of the pixel value, so it is replayable and linearly stackable.

The fix analysis is sound. I would only add that option (2) (perturb the backing store once at draw-flush) also fixes canvas-snapshot-readback-bypass and canvas-read-rect-dependent-farble, making it the only option that closes all three.

#### `canvas-snapshot-readback-bypass` — Snapshot() is deliberately unfarbled and still reaches raw JS-visible pixels: createImageBitmap(canvas) -> bitmaprenderer -> toDataURL(), new VideoFrame(canvas).copyTo(), and the transferControlToOffscreen placeholder all return the pristine host canvas

*Canvas 2D / OffscreenCanvas / ImageBitmap* · **CONFIRMED**

**Where.** `lobium/patches/core/config-channel.patch (LobiumReadbackSeed + the Snapshot note -> third_party/blink/renderer/core/html/canvas/html_canvas_element.cc)` — config-channel.patch:533-547 (LobiumReadbackSeed, applied html_canvas_element.cc:1281-1295) and 556-559 (applied html_canvas_element.cc:1324-1327)

**Mechanism.**

LobiumReadbackSeed returns 0 for every context type except 2D and WebGL (CanvasRenderingContext::IsRenderingContext2D/IsWebGL, canvas_rendering_context.h:125-137), so a `bitmaprenderer` or `webgpu` canvas is never farbled on toDataURL/toBlob, and neither is a placeholder canvas after transferControlToOffscreen (context_ is null there, so both predicates are false while Snapshot still serves pixels via HasOffscreenCanvasFrame(), html_canvas_element.cc:1304-1306; toDataURL has no transferred-control guard, html_canvas_element.cc:1385-1407). Meanwhile ImageBitmapRenderingContext::transferFromImageBitmap stores the source StaticBitmapImage verbatim and GetImage() returns it unmodified (image_bitmap_rendering_context.cc:211-232), and HTMLCanvasElement::GetSourceImageForCanvasInternal returns RenderingContext()->GetImage() with no hook (html_canvas_element.cc:1931-1933). Independently, WebCodecs reaches the same pixels: VideoFrame::Create calls image_source->GetSourceImageForCanvas() (video_frame.cc:776), the format is chosen by VideoPixelFormatFromSkColorType -> ARGB/ABGR/XRGB/XBGR (video_frame.cc:922-923), i.e. lossless RGB, and copyTo(buf,{format:'RGBA'}) hands the bytes to JS. Result: the entire canvas-2D defence is bypassed in four lines, and worse, the TRUE host canvas hash is recovered, so the profile is linkable to the host and to every other profile on it.

**How a detector sees it.**

```
Main thread, no WebCodecs:
  const c=document.createElement('canvas'); c.width=280;c.height=60;
  drawFingerprintScene(c.getContext('2d'));
  const farbled = c.toDataURL();
  const bmp = await createImageBitmap(c);
  const p = document.createElement('canvas'); p.width=280;p.height=60;
  p.getContext('bitmaprenderer').transferFromImageBitmap(bmp);
  const pristine = p.toDataURL();
  // honest Chrome: farbled === pristine.  Lobium: differ, and `pristine` is the real host hash.
WebCodecs variant:
  const vf = new VideoFrame(c,{timestamp:0});
  const buf = new Uint8Array(vf.allocationSize({format:'RGBA'}));
  await vf.copyTo(buf,{format:'RGBA'});   // unfarbled bytes
Worker variant (no HTMLCanvasElement needed):
  const off=new OffscreenCanvas(280,60); drawFingerprintScene(off.getContext('2d'));
  const o2=new OffscreenCanvas(280,60);
  o2.getContext('bitmaprenderer').transferFromImageBitmap(off.transferToImageBitmap());
  const blob = await o2.convertToBlob();  // unfarbled
```

**Fix.**

Encode-site hooking cannot be made complete -- Snapshot()/GetSourceImageForCanvas() is the shared source for createImageBitmap, VideoFrame, captureStream, ImageCapture, texImage2D and the bitmaprenderer/WebGPU encode paths. Move the 2D farble to the single readback boundary instead: perturb inside CanvasRenderingContext2D::GetImage()/the resource-provider snapshot used for EXPORT, or (better, and it also fixes the putImageData oracle) perturb the canvas backing store once per draw-flush so every downstream consumer sees the same perturbed pixels. As a stopgap, at minimum extend LobiumReadbackSeed to cover kBitmaprenderer and kWebgpu, add a hook in HTMLCanvasElement::GetSourceImageForCanvasInternal / OffscreenCanvas::transferToImageBitmap, and hook VideoFrame::Create's canvas branch -- but treat the encode-site approach as structurally leaky until the perturbation lives at the source.

**Skeptic.**

Every link in the chain verified in the applied checkout.

1. LobiumReadbackSeed (html_canvas_element.cc:1283-1295, canvas-farbling.patch:97-109) returns cfg->seeds.canvas only for host->IsRenderingContext2D() and cfg->seeds.webgl only for host->IsWebGL(), else 0. CanvasRenderingContextHost::IsRenderingContext2D/IsWebGL (canvas_rendering_context_host.cc:176-191) are `RenderingContext() && RenderingContext()->Is...()`, and CanvasRenderingContext::IsRenderingContext2D/IsImageBitmapRenderingContext/IsWebGPU (canvas_rendering_context.h:125-137) switch on canvas_rendering_type_. So kBitmaprenderer and kWebgpu get seed 0, and a placeholder canvas after transferControlToOffscreen (context_ == nullptr) also gets 0 while Snapshot still serves pixels through HasOffscreenCanvasFrame() (html_canvas_element.cc:1304-1306). toDataURL has no transferred-control guard (1385-1407).
2. Snapshot() is explicitly unhooked, with the reasoning in-code at html_canvas_element.cc:1324-1328.
3. ImageBitmapRenderingContext::transferFromImageBitmap -> SetImage -> SetImageInternal stores the StaticBitmapImage verbatim, and GetImage() returns it (image_bitmap_rendering_context.cc:211-232). No conversion.
4. HTMLCanvasElement::GetSourceImageForCanvasInternal (html_canvas_element.cc:1898-1929) has no hook, so createImageBitmap/drawImage/texImage2D all see pristine pixels.
5. WebCodecs: VideoFrame::Create calls image_source->GetSourceImageForCanvas (video_frame.cc:776) and picks the format via media::VideoPixelFormatFromSkColorType (video_frame.cc:864-866 and 922-923), i.e. a lossless RGB layout, so copyTo({format:'RGBA'}) hands JS the unfarbled bytes.
6. The OffscreenCanvas convertToBlob hook (offscreen_canvas.cc:481-514) has the identical 2D/WebGL-only gate, so the worker variant works too.

A grep for 'lobium' across third_party/blink/renderer confirms no hook exists in image_bitmap_rendering_context.cc, image_bitmap.cc, video_frame.cc, or any WebGPU/capture file.

Severity critical is correct, and for the reason the finder gives: this does not merely flag the browser, it hands over the true host canvas hash, which cross-links every profile running on that host. Partially documented: canvas-farbling.patch:22-23 and html_canvas_element.cc:1324-1328 document the decision not to hook Snapshot, but neither acknowledges that Snapshot pixels reach JS through bitmaprenderer/WebCodecs. The structural conclusion in the fix (encode-site hooking cannot be made complete) is right.

#### `phantom-capabilities-timezone-acceptlang` — The capability contract advertises `process-locale-timezone` and `network-accept-language` as native hooks that do not exist; timezone is delivered only by the TZ env var, which ICU ignores on Windows

*Config channel, capability contract, launcher* · **CONFIRMED**

**Where.** `lobium/patches/core/capability-contract.patch (+ packages/engine-runner/src/lobium-capabilities.ts, packages/engine-runner/src/runners/lobium-launcher.ts)` — capability-contract.patch:21-31; lobium-capabilities.ts:11-24 and 101-120; lobium-launcher.ts:172-186 (TZ/LANG/LC_ALL/FC_LANG); lobium/patches/fingerprint/locale-geolocation.patch:5-6

**Mechanism.**

requiredLobiumCapabilities() (lobium-capabilities.ts:105-113) makes 'process-locale-timezone' and 'network-accept-language' MANDATORY for every launch, and the binary always prints them, so assertLobiumBuildCapabilities() always passes. But no patch in lobium/patches/series implements either. locale-geolocation.patch's own preamble (lines 5-6) says so explicitly: "Accept-Language remains sourced from the pre-start profile preference written by the launcher ... Intl locale uses --lang and timezone uses inherited TZ, both process-wide." The only native locale hook is base::i18n::SetICUDefaultLocale (render_thread_impl.cc) - that is the LOCALE, not the timezone. Timezone is delivered solely by lobium-launcher.ts:179 (TZ: ctx.fingerprint.locale.timezone) and there is no CDP fallback either (grep for setTimezoneOverride across packages/engine-runner/src returns zero hits). On the stated Windows build target that mechanism is INERT: E:\lobium-build\src\third_party\icu\source\common\putil.cpp:1107-1145, uprv_tzname() begins with `#if U_PLATFORM_USES_ONLY_WIN32_API { tzid = uprv_detectWindowsTimeZone(); if (tzid != nullptr) return tzid; }` and the `tzid = getenv("TZ")` branch lives in the `#else`, i.e. is not compiled on Windows. ICU therefore takes the zone from GetDynamicTimeZoneInformation / the registry - the operator's real zone. The same launcher env block is POSIX-only throughout: LANG/LC_ALL are ignored by Windows/ICU, and FONTCONFIG_FILE has no consumer because Windows Chromium uses DirectWrite, so the profile's font isolation is inert too. Net effect: the fail-closed gate reports a fully capable native build while two required surfaces silently report host values on the shipping platform.

**How a detector sees it.**

```
One line, no permissions: `Intl.DateTimeFormat().resolvedOptions().timeZone` and `new Date().getTimezoneOffset()`. Compare against the geolocation of the profile's proxy exit IP (which the sidecar itself derived locale/timezone from). On a Windows host in, say, Europe/Warsaw running a US-proxied persona configured for America/New_York, the page reads 'Europe/Warsaw' with offset -60/-120 while the exit IP is in New York and navigator.language is en-US. Timezone-vs-IP is the first check CreepJS, Pixelscan, BrowserScan, IPHey and every commercial anti-fraud vendor runs. ci/validation/native-policy-probe.mjs:272 already asserts value.timezone === fp.locale.timezone but sets TZ in the child env (line 155), so it passes on Linux CI and would fail on the Windows target.
```

**Fix.**

Delete 'process-locale-timezone' and 'network-accept-language' from both the native manifest string and LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES until real hooks exist - a capability the gate cannot falsify is worse than no gate. Then implement timezone natively: read cfg->locale.timezone and call icu::TimeZone::adoptDefault(icu::TimeZone::createTimeZone(...)) in RenderThreadImpl::Init() (right next to the existing SetICUDefaultLocale call) and in the browser process before ICU is first used, gated behind a new 'native-timezone' capability. Change ci/validation/native-policy-contract.test.mjs:22-45 so each capability string must map to an asserted hook site in a named patch, not merely appear in two files.

**Skeptic.**

Verified end to end and this is the strongest finding in the set. No patch in E:\project\lobium\patches implements timezone: I grepped every .patch for /imezone|TimeZone|SetICUDefaultLocale/ and the only hits are the manifest string in capability-contract.patch:24 and `SetICUDefaultLocale(cfg->locale.locale)` in locale-geolocation.patch:40 — which is the LOCALE, not the zone; locale-geolocation.patch:6 states 'timezone uses inherited TZ' in its own preamble. Timezone is delivered solely by lobium-launcher.ts:179 (TZ env), and there is no CDP fallback: `buildCdpEmulation` (launch.ts:151-184) carries timezoneId but is documented at launch.ts:137-140 as 'Legacy/internal CDP emulation... Production Lobium launches do not use this', and the Lobium launcher never applies it (only mobile-emulation.ts issues Emulation.* commands, none of them setTimezoneOverride). On Windows the TZ env is inert twice over: ICU's uprv_tzname (E:\lobium-build\src\third_party\icu\source\common\putil.cpp:1106-1124) returns uprv_detectWindowsTimeZone() inside `#if U_PLATFORM_USES_ONLY_WIN32_API` and the `getenv("TZ")` branch at :1142 is in the `#else`; and V8's WindowsTimezoneCache (v8/src/base/platform/platform-win32.cc:142-166) uses GetTimeZoneInformation. So both `Intl.DateTimeFormat().resolvedOptions().timeZone` and `new Date().getTimezoneOffset()` report the operator's real zone next to a proxy-derived locale/IP. requiredLobiumCapabilities (lobium-capabilities.ts:105-113) makes 'process-locale-timezone' mandatory and the binary hardcodes it, so the gate can never falsify it. native-policy-probe.mjs:155 sets TZ in the child env and :272 asserts value.timezone === fp.locale.timezone, so CI is green on Linux and would be red on the shipping target — confirmed. ONE NUANCE: 'network-accept-language' is a phantom NATIVE hook but is not functionally broken — ensureChromiumPersonaPreferences (lobium-launcher.ts:500-524) writes intl.accept_languages/selected_languages to Default/Preferences pre-start, which is Chromium's canonical, platform-independent Accept-Language source. So that token is a worthless build-differentiator (stock Chromium would satisfy it) rather than a leak. The timezone half alone justifies critical: it is the single cheapest check every vendor listed runs.

#### `timezone-tz-env-noop-on-windows` — Timezone is never spoofed on the Windows build target — TZ env var is a no-op for ICU on Win32 and no native/CDP timezone hook exists

*navigator / User-Agent / UA client hints* · **CONFIRMED**

**Where.** `packages/engine-runner/src/runners/lobium-launcher.ts` — 179 (`TZ: ctx.fingerprint.locale.timezone`) — plus the false claim in lobium/patches/fingerprint/locale-geolocation.patch:6 and docs/ENGINEERING.md:46

**Mechanism.**

The only mechanism the product uses to set the persona timezone is the child-process `TZ` environment variable (buildLobiumLaunchEnv, line 179; the comment even says "desktop Linux"). On Windows that is inert. Verified in the checkout: `uprv_tzname()` (E:\lobium-build\src\third_party\icu\source\common\putil.cpp:1107-1116) begins with `#if U_PLATFORM_USES_ONLY_WIN32_API { tzid = uprv_detectWindowsTimeZone(); if (tzid != nullptr) return tzid; ... }` — the `getenv("TZ")` branch is inside the `#else` arm at :1137-1157 and is unreachable. `uprv_detectWindowsTimeZone()` (third_party/icu/source/common/wintz.cpp:88-98) reads `GetDynamicTimeZoneInformation()`, i.e. the host registry zone. `U_PLATFORM_USES_ONLY_WIN32_API` is 1 for MSVC/ClangCL (unicode/platform.h:249-250). Independently, no patch in lobium/patches/series hooks timezone at all — grepping the whole patch tree for `timezone|TimeZone` returns only three prose lines (config-channel.patch:29, capability-contract.patch:25, locale-geolocation.patch:6), and there is no `Emulation.setTimezoneOverride` anywhere in the production launch path (the only hit in the repo is a UI label in apps/desktop/src/features/fingerprint/coherence.ts:82). Result: `Intl.DateTimeFormat().resolvedOptions().timeZone`, `Date#getTimezoneOffset()` and `Date#toString()` report the HOST machine's zone, while `navigator.languages`, the `Accept-Language` header, the native Geolocation override (locale-geolocation.patch), and the proxy exit IP all claim the persona's region. This is the single cheapest cross-check in the anti-fraud industry and it fires on every proxied profile.

**How a detector sees it.**

```
Page script: `const r=Intl.DateTimeFormat().resolvedOptions(); JSON.stringify({tz:r.timeZone, locale:r.locale, off:new Date().getTimezoneOffset(), langs:navigator.languages})`. Run a profile with a German proxy: expect `{tz:'Europe/Berlin'}` but observe the build host's zone (e.g. `Europe/London`/`America/*`) next to `langs:['de-DE','de']` and an IP that geolocates to DE. CreepJS reports it under `timezone`/`lies`; Pixelscan, BrowserScan and IPHey all surface an explicit "timezone does not match IP" red flag; DataDome/Kasada weight IP-geo-vs-TZ heavily.
```

**Fix.**

Add a native timezone hook alongside the existing ICU-locale hook. In `content/renderer/render_thread_impl.cc` (same place locale-geolocation.patch calls `base::i18n::SetICUDefaultLocale`), also do `icu::TimeZone::adoptDefault(icu::TimeZone::createTimeZone(icu::UnicodeString::fromUTF8(cfg->locale.timezone)))` before `InitializeWebKit()`, and re-apply it in `RenderThreadImpl::OnTimeZoneChange()` so a host OS zone change cannot re-poison the renderer. Do the same in the browser process before `TimeZoneMonitor` starts (so `TimeZoneMonitor` broadcasts the persona zone, not `detectHostTimeZone()`). Until then, correct docs/ENGINEERING.md:46 and the locale-geolocation.patch preamble, which both assert timezone is applied natively/process-wide.

**Skeptic.**

Every load-bearing claim checks out.

(a) TZ is the only mechanism: packages/engine-runner/src/runners/lobium-launcher.ts:179 sets `TZ: ctx.fingerprint.locale.timezone` in buildLobiumLaunchEnv, and buildNativeLobiumEnv (:372) is the only env path for the production launcher.
(b) TZ is inert for ICU on Win32: E:\lobium-build\src\third_party\icu\source\common\putil.cpp:1106-1124 — `uprv_tzname()` opens with `#if U_PLATFORM_USES_ONLY_WIN32_API { tzid = uprv_detectWindowsTimeZone(); if (tzid != nullptr) return tzid; ... return uprv_strdup(""); }`; the `getenv("TZ")` branch is in the `#else` arm at :1142 and is unreachable. wintz.cpp:88-98 reads `GetDynamicTimeZoneInformation()`. timezone.cpp:457-527 `detectHostTimeZone()` uses `uprv_tzname(0)` and :538-579 `initDefault()`/`createDefault()` consume it. base/i18n/icu_util.cc:315-336 `InitializeIcuTimeZone()` is a no-op on Windows (only FUCHSIA/CHROMEOS/LINUX/ANDROID arms), so ICU lazily self-initializes from the host registry.
(c) No native hook exists. Grepping E:\project\lobium for timezone yields only lobium_fp_config.h:122 and lobium_fp_config.cc:152 — the field is PARSED and read by ZERO hooks. `adoptDefault`/`icu::TimeZone` appear nowhere in the patch tree. Blink's TimeZoneController (third_party/blink/renderer/core/timezone/timezone_controller.cc) has no TZ/env path either.
(d) No CDP fallback in production: `buildCdpEmulation` (launch.ts:151-184, with timezoneId at :179) is documented at :136-140 as legacy/internal and is never called by createLobiumLauncher (lobium-launcher.ts:696-813). Repo-wide, `setTimezoneOverride` appears only at apps/desktop/src/features/fingerprint/coherence.ts:82 — and that line is itself a false UI claim ("Applied over CDP").
(e) The false doc claims are real: docs/ENGINEERING.md:46 ("timezone / locale / geolocation: applied natively") and lobium/patches/fingerprint/locale-geolocation.patch:6 ("timezone uses inherited TZ, both process-wide").

TWO CORRECTIONS to the finding's metadata, neither of which reduces severity:
1. `alreadyDocumented: false` is WRONG. lobium/patches/series:99-100 lists an unauthored `fingerprint/native-timezone.patch` with the exact rationale: "TZ/LANG/LC_ALL are POSIX-only; on Windows ICU reads the registry, so the persona timezone must be applied natively." It is a known gap. It is not an acceptable one — see below.
2. The proposed fix cites `RenderThreadImpl::OnTimeZoneChange()`. That method does not exist in M152: grepping content/renderer/render_thread_impl.cc for timezone returns nothing. The real re-application points are blink::TimeZoneController (which owns SetIcuTimeZoneAndNotifyV8) and the device::TimeZoneMonitor client in render_process_host_impl_receiver_bindings.cc:152-153.

TWO THINGS THAT MAKE THIS WORSE THAN THE FINDER STATED, i.e. why 'known' is not 'acceptable':
- The fail-closed capability gate LIES. core/capability-contract.patch:25 makes the binary unconditionally print `process-locale-timezone`, and lobium-capabilities.ts:109 puts it in the ALWAYS-required list, so assertLobiumBuildCapabilities passes on Windows while nothing applies the timezone. The one mechanism designed to stop a silent spoof failure actively certifies this one.
- The CI gates that would catch it are Linux-only by construction: ci/validation/native-policy-probe.mjs:272 and lobium-detect.mjs:489 assert `Intl.DateTimeFormat().resolvedOptions().timeZone === fp.locale.timezone`, and they pass only because they set TZ (native-policy-probe.mjs:155, lobium-detect.mjs:406) on a Linux runner. Those same gates would fail on the shipping Windows target.

#### `timezone-tz-env-inert-on-windows` — Timezone is spoofed ONLY by the TZ env var, which ICU ignores on Windows — every profile reports the real host timezone

*Surfaces with no coverage at all* · **UNVERIFIED**

**Where.** `packages/engine-runner/src/runners/lobium-launcher.ts (env), lobium/patches/fingerprint/locale-geolocation.patch (preamble)` — lobium-launcher.ts:179 (`TZ: ctx.fingerprint.locale.timezone`); locale-geolocation.patch:6 ("timezone uses inherited TZ")

**Mechanism.**

There is NO Blink/ICU hook for timezone anywhere in lobium/patches (the `diff --git` inventory contains no timezone file). The entire strategy is the `TZ` environment variable set on the child process, plus the patch preamble's claim that "Intl locale uses --lang and timezone uses inherited TZ, both process-wide." That is a POSIX-only mechanism. In E:\lobium-build\src\third_party\icu\source\common\putil.cpp, `uprv_tzname()` (line 1107) opens with `#if U_PLATFORM_USES_ONLY_WIN32_API { tzid = uprv_detectWindowsTimeZone(); if (tzid != nullptr) return tzid; }` at line 1112 — it RETURNS before ever reaching `tzid = getenv("TZ")` at line 1142, which lives in the `#else` (POSIX) branch. So on Windows ICU resolves the zone from `GetDynamicTimeZoneInformation()`/the registry. Worse, the browser process actively re-pushes the host zone to every renderer: services/device/time_zone_monitor/time_zone_monitor.cc:16 constructs from `icu::TimeZone::createDefault()`, :57 `DetectHostTimeZoneFromIcu()` calls `icu::TimeZone::detectHostTimeZone()`, and :73 `AddClient` immediately sends `OnTimeZoneChange(GetTimeZoneId(*timezone_))` to each new renderer, which calls `icu::TimeZone::adoptDefault`. Note the sibling `LANG`/`LC_ALL` env vars in the same object are redundant on Windows too, but the Intl LOCALE is separately rescued natively by locale-geolocation.patch's `base::i18n::SetICUDefaultLocale` in render_thread_impl.cc — timezone got no such rescue. Net effect on the shipping Windows target: a profile with a Brazilian proxy and an America/Sao_Paulo persona reports the build host's zone (e.g. Europe/Warsaw) in Intl and in Date.

**How a detector sees it.**

```
One line, no permission, from any page: `Intl.DateTimeFormat().resolvedOptions().timeZone` and `new Date().getTimezoneOffset()`. Every commercial detector (CreepJS, FingerprintJS, DataDome, Cloudflare, Akamai, Kasada, PerimeterX, BrowserScan, Iphey, Pixelscan) cross-checks this against the request's IP geolocation; a mismatch between proxy exit country and reported zone is one of the highest-weight bot signals in production. Also self-detectable: run ci/validation/lobium-detect.mjs on Windows — its `timezoneApplied: nat.timezone === fp.locale.timezone` assertion at line 489 will fail, but the harness at line 406 sets `TZ` in the child env and has only ever been run on Linux, which is why the regression is invisible today.
```

**Fix.**

Add a native hook. The cheapest correct point is browser-side, mirroring the existing config-channel pattern: in `services/device/time_zone_monitor/time_zone_monitor.cc`, have `DetectHostTimeZoneFromIcu()` return `icu::TimeZone::createTimeZone(cfg->locale.timezone)` when `LobiumFpConfig::Current()` supplies one, so both the browser's ICU default and the `OnTimeZoneChange` broadcast to every renderer carry the persona zone. Belt-and-braces: also call `icu::TimeZone::adoptDefault` from the same spot in `RenderThreadImpl::Init()` where `SetICUDefaultLocale` already runs, so workers created before the first monitor message are covered. Keep the `TZ` env var for Linux. Then make ci/validation/lobium-detect.mjs's timezone assertion a Windows gate.

#### `webgpu-adapter-unhooked` — WebGPU is shipped, enabled, and completely unhooked — adapter.info + ~31 adapter limits expose the real GPU and contradict the spoofed WebGL identity

*Surfaces with no coverage at all* · **UNVERIFIED** · previously documented as a known limitation

**Where.** `lobium/patches/series (patch never authored); hooked Chromium file would be third_party/blink/renderer/modules/webgpu/gpu_adapter.cc` — series:70 — `# fingerprint/webgpu-adapter.patch    # coherent WebGPU adapter` (commented out; no such file exists in lobium/patches/fingerprint/)

**Mechanism.**

Grepping lobium/patches/ and lobium/src/ for `webgpu`/`WebGPU` returns ZERO hits, and no patch touches modules/webgpu. Meanwhile WebGPU is unconditionally shipped in this engine: third_party/blink/renderer/modules/webgpu/navigator_gpu.idl has no `[RuntimeEnabled]` guard on `readonly attribute GPU gpu`, and the full module is present in the 152 checkout. The sidecar disables nothing — the complete flag inventory produced from packages/engine-runner/src (launch.ts:78-102, runners/lobium-launcher.ts:318-365, gpu.ts:76-88) contains no `--disable-webgpu` and no `--disable-features=WebGPU`; the only feature disables are `ReduceAcceptLanguage`, `AsyncDns`, `DnsOverHttpsUpgrade`. So `navigator.gpu.requestAdapter()` succeeds and hands the page a live Dawn adapter. In gpu_adapter.cc the constructor at line 55 fills, from `GetHandle().GetInfo(&info)` at line 90: `vendor_` (line 97), `architecture_` (98), `device_` = the raw PCI device ID formatted as hex (99-103), `description_` (104), plus `features_` (116) and `limits_` from `GetHandle().GetLimits()` (118-120). gpu_supported_limits.idl exposes 31 unconditional numeric limits (maxTextureDimension1D/2D/3D, maxBufferSize, maxStorageBufferBindingSize, maxComputeWorkgroupStorageSize, …) read straight from the driver. This is a strictly higher-entropy hardware fingerprint than WebGL's MAX_* set, and Lobium spoofs WebGL (config-channel.patch + host-gpu-profile.patch) while leaving WebGPU truthful — so the two APIs DISAGREE about the GPU, which is a far stronger positive signal than either surface alone. On this Windows build Dawn uses D3D12; note `--use-angle=vulkan` from gpu.ts:81 steers ANGLE/WebGL only and does not touch Dawn, so the backends can also disagree structurally.

**How a detector sees it.**

```
```js
const a = await navigator.gpu.requestAdapter();
const wgpu = {...a.info}; // vendor, architecture, device (PCI id), description
const lim = Object.fromEntries(Object.entries(a.limits).map(([k,v])=>[k,v]));
const gl = document.createElement('canvas').getContext('webgl2');
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const webglRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
// contradiction: webglRenderer says (e.g.) "Apple M2" while wgpu.vendor="nvidia",
// wgpu.architecture="ampere", and lim.maxTextureDimension2D/maxBufferSize match the real card.
```
Hash `a.limits` alone and you get a stable, near-unique hardware ID that survives every Lobium spoof. FingerprintJS and CreepJS already collect WebGPU adapter info and limits; it is one of the fastest-growing signals in commercial anti-bot.
```

**Fix.**

Author fingerprint/webgpu-adapter.patch. Single choke point: `GPUAdapter::GPUAdapter` in third_party/blink/renderer/modules/webgpu/gpu_adapter.cc:55-123 — after `GetHandle().GetInfo(&info)`, override `vendor_`/`architecture_`/`device_`/`description_` from `LobiumFpConfig::Current()->webgpu`, and clamp/replace the `GPUSupportedLimits::ComboLimits` at line 118-120 with a captured coherent profile for the CLAIMED GPU class (the same host-capture pipeline that already feeds webgl.caps/extensions/shaderPrecision). `features_` (line 116) needs the same treatment. Until that patch exists and is proven, the sidecar should pass `--disable-features=WebGPU` (absence of navigator.gpu is itself a small tell, but far cheaper than a truthful high-entropy contradiction) — and either way the choice must be explicit, not accidental.

#### `fonts-fontconfig-inert-on-windows` — Font isolation is a fontconfig mechanism and is 100% inert on the Windows target — the real host font set is fully enumerable

*Surfaces with no coverage at all* · **UNVERIFIED** · previously documented as a known limitation

**Where.** `packages/engine-runner/src/fonts.ts, packages/engine-runner/src/runners/lobium-launcher.ts` — fonts.ts:9-18 (module doc: "On Linux, Chromium resolves every font-facing surface … through the browser process's fontconfig"); lobium-launcher.ts:193 (`env.FONTCONFIG_FILE = await writeFontConfig(...)`)

**Mechanism.**

The entire font strategy is `FONTCONFIG_FILE` pointing at a private per-profile XML plus `FC_LANG` (lobium-launcher.ts:185,193). Chromium on Windows never consults fontconfig: font enumeration for `queryLocalFonts()` goes through content/browser/font_access/font_enumeration_data_source_win.cc (DirectWrite) — the fontconfig implementation is the separate font_enumeration_data_source_linux.cc — and CSS/`document.fonts.check`/`measureText` resolve through third_party/blink/renderer/platform/fonts/win/font_cache_skia_win.cc against the DirectWrite system collection. `FontAccess` is `status: {"Android": "", "default": "stable"}` in runtime_enabled_features.json5, so `queryLocalFonts()` is live on Windows. Net: the ~435-family Windows persona list, the metric-clone table (Liberation/Carlito/Caladea), and the physical-face allowlist all have zero effect; the profile exposes exactly the host machine's installed fonts. The launcher still hard-throws when the pack is absent (lobium-launcher.ts:188-192, "required Lobium open-font pack is not provisioned"), which makes the launch path *look* fail-closed on a platform where it provides no protection at all.

**How a detector sees it.**

```
Two independent probes, both free: (1) the classic width probe — measure a string in each of ~500 candidate families against the three generic fallbacks and diff; the resulting present-set is the host's real font list, including any locally-installed non-stock fonts (Adobe/Office/dev fonts) which are near-unique per machine. (2) `await navigator.permissions.query({name:'local-fonts'})` then `queryLocalFonts()` (user gesture + permission) enumerates postscriptName/fullName/family for every DirectWrite face. Because the set is identical for every profile on the host, it is also a perfect cross-profile linkage key — the exact property the product exists to prevent. CreepJS, FingerprintJS and BrowserScan all run font-width probes by default.
```

**Fix.**

Font control on Windows must be a Blink/Skia hook, not a packaging trick. Filter at the two Windows choke points: (a) `FontCache::CreateFontPlatformData`/the DirectWrite family lookup in platform/fonts/win/font_cache_skia_win.cc, so an un-allowlisted family falls back to the persona's class face; and (b) `FontEnumerationDataSourceWin::GetFonts()` in content/browser/font_access/font_enumeration_data_source_win.cc, so queryLocalFonts returns only the allowlist. Both read `LobiumFpConfig::Current()->fonts`. Until then, Windows profiles are not font-isolated and STATUS.md's framing ("deliberately not bundled") understates it — the surface is not merely unbundled, it is fully exposed and host-linkable.

#### `webgl2-extension-list-served-from-webgl1-persona` — getSupportedExtensions()/getExtension() serve the WebGL1-calibrated persona list to WebGL2 contexts, deleting every WebGL2-only extension

*WebGL 1 and WebGL 2* · **CONFIRMED**

**Where.** `lobium/patches/fingerprint/host-gpu-profile.patch (+ lobium/patches/fingerprint/webgl-runtime-safety.patch); hooks third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc` — host-gpu-profile.patch:18-34 (getExtension) and :110-119 (getSupportedExtensions); webgl-runtime-safety.patch:149-174; applied at webgl_rendering_context_base.cc:3887-3903 and ~4708

**Mechanism.**

getExtension() and getSupportedExtensions() are declared ONCE, non-virtual, in WebGLRenderingContextBase (webgl_rendering_context_base.h:311, :327) — WebGL2RenderingContextBase does not override them (grep for WebGL2RenderingContextBase::getSupportedExtensions/getExtension returns nothing). Both Lobium hooks fire whenever cfg->webgl.extensions is non-empty, which is the PRIMARY product path: validateHostCalibrationProfile() (packages/fingerprint/src/host-calibration.ts:197) hard-refuses to launch if the captured list is empty, and buildHostCalibrationProbeScript captures it from a WebGL1 context only (packages/engine-runner/src/host-calibration-probe.ts:155-159 — `canvas.getContext('webgl')`). There is no `webgl2` key anywhere in the config schema (packages/shared-types/src/fingerprint.ts:94-110) or in lobium_fp_config.h. Chromium registers a DIFFERENT extension set per context version: webgl_rendering_context.cc:104-144 vs webgl2_rendering_context.cc:83-124. Consequence with webgl-runtime-safety applied (intersection with `extensions_`, the WebGL2 tracker list): every WebGL2-only extension is silently deleted from webgl2.getSupportedExtensions() — EXT_color_buffer_float, EXT_texture_norm16, EXT_conservative_depth, EXT_render_snorm, EXT_disjoint_timer_query_webgl2, OES_draw_buffers_indexed, OES_sample_variables, OES_shader_multisample_interpolation, OVR_multiview2, NV_shader_noperspective_interpolation, WEBGL_clip_cull_distance, WEBGL_provoking_vertex, WEBGL_render_shared_exponent, WEBGL_stencil_texturing, WEBGL_draw_instanced_base_vertex_base_instance. Worse, the getExtension() allowlist in host-gpu-profile.patch has NO backend fallback at all, so gl2.getExtension('EXT_color_buffer_float') returns null — no real Chrome build with WebGL2 has ever done that, and it breaks float render targets in three.js/deck.gl/Babylon. Without webgl-runtime-safety (patch order: host-gpu-profile then webgl-runtime-safety, series:56-57) the failure inverts and is equally fatal: the WebGL1-only names ANGLE_instanced_arrays, OES_vertex_array_object, WEBGL_depth_texture, WEBGL_draw_buffers, EXT_frag_depth, EXT_shader_texture_lod, EXT_sRGB are advertised on a WebGL2 context, which Chrome never does.

**How a detector sees it.**

```
const g=document.createElement('canvas').getContext('webgl2'); const e=g.getSupportedExtensions(); // Every real Chrome (any GPU, SwiftShader included) => true; Lobium => false: e.includes('EXT_color_buffer_float') && g.getExtension('EXT_color_buffer_float')!==null. Inverse smell for the pre-runtime-safety build: e.includes('ANGLE_instanced_arrays') is true under Lobium, always false in real Chrome WebGL2. Also compare set(webgl1 exts) vs set(webgl2 exts): in real Chrome the symmetric difference is ~25 names; under Lobium webgl2 is a strict subset of webgl1.
```

**Fix.**

Gate the extension hooks on context version. Add a `webgl2` sub-object to the config schema (extensions/version/shadingLanguageVersion/caps/shaderPrecision), capture it in buildHostCalibrationProbeScript from a real `getContext('webgl2')`, and have the hook select the list via `IsWebGL2() ? cfg->webgl2.extensions : cfg->webgl.extensions`. Until that data exists, make the hook a no-op when `IsWebGL2()` is true (fail-open to the host list) rather than serving the WebGL1 list — a real host extension list is far less detectable than an impossible one.

**Skeptic.**

Every link in the chain verified in source. (1) getExtension/getSupportedExtensions are declared exactly once, non-virtual, in webgl_rendering_context_base.h:311 and :327; grep over the whole webgl module for a WebGL2 override returns nothing, and webgl2_rendering_context.idl:11-13 shows WebGL2RenderingContext simply `includes WebGLRenderingContextBase`, so the WebGL1 hook is the only implementation for both contexts. (2) RegisterContextExtensions is pure-virtual (webgl_rendering_context_base.h:152) and overridden separately by webgl_rendering_context.h:50 / webgl2_rendering_context.h:29 — the two registries genuinely differ: webgl2_rendering_context.cc:83-125 registers EXTColorBufferFloat, EXTConservativeDepth, EXTRenderSnorm, EXTTextureNorm16, EXTDisjointTimerQueryWebGL2, NVShaderNoperspectiveInterpolation, OESDrawBuffersIndexed, OESSampleVariables, OESShaderMultisampleInterpolation, OVRMultiview2, WebGLClipCullDistance, WebGLProvokingVertex, WebGLRenderSharedExponent, WebGLStencilTexturing — none of which appear in webgl_rendering_context.cc:103-145. (3) I read the CURRENTLY-APPLIED source (the other process finished applying the series mid-audit): webgl_rendering_context_base.cc:4726-4741 is the intersection form and :3889-3903 is the exact-match allowlist, both firing on `cfg && !cfg->webgl.extensions.empty()` with no context-version gate. (4) The list really is WebGL1-only and really is always populated on the default path: host-calibration-probe.ts:154 uses `canvas.getContext('webgl')`, host-calibration.ts:197-199 refuses launch on an empty list, lobium-config.ts:100 sets DEFAULT_RENDERER_POLICY = {mode:'host'}, and start-profile.ts:237-245 throws if host calibration is missing in that mode. There is no `webgl2` key in lobium_fp_config.h:104-119. Net effect on the shipped build: webgl2.getSupportedExtensions() is a strict subset of the WebGL1 list and EXT_color_buffer_float is both absent and unobtainable via getExtension — a state no Chrome build has ever produced. One addition the finder should have made: the pre-runtime-safety inversion IS caught by CI — product-e2e.mjs:324-329 builds a `webgl2 || webgl` context and :376 fails the run if any advertised extension returns null from getExtension. That gate passes under the full series precisely because the intersection deletes the impossible names, so it is blind to the far worse post-intersection state.

#### `pack-row-length-disables-webgl-farble` — gl.pixelStorei(PACK_ROW_LENGTH, width) — a byte-for-byte no-op — turns off WebGL pixel farbling and returns the true GPU pixels

*WebGL 1 and WebGL 2* · **CONFIRMED**

**Where.** `lobium/patches/core/config-channel.patch; hooks third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc ReadPixelsHelper` — config-channel.patch:1104-1117 (guard `pack.row_length == 0 && pack.skip_pixels == 0 && pack.skip_rows == 0`); applied at webgl_rendering_context_base.cc:5507-5520

**Mechanism.**

The farble guard bails out whenever PACK_ROW_LENGTH is non-zero, on the stated assumption that a non-default pack layout has 'a different stride'. But WebGLImageConversion::ComputeImageSizeInBytes uses `int row_length = params.row_length > 0 ? params.row_length : width;` (third_party/blink/renderer/platform/graphics/gpu/webgl_image_conversion.cc:3698), so setting PACK_ROW_LENGTH exactly equal to the read width produces an IDENTICAL byte layout. WebGL2RenderingContextBase::pixelStorei stores it verbatim into pack_row_length_ (webgl2_rendering_context_base.cc:802-803) and GetPackPixelStoreParams returns it (:5885-5891). So one extra line of JS before the readback yields the unfarbled, host-true WebGL pixel buffer. This defeats the entire unlinkability goal of seeds.webgl (two profiles on the same machine become instantly linkable) and is simultaneously a self-contained tamper proof requiring no baseline.

**How a detector sees it.**

```
const c=document.createElement('canvas');c.width=c.height=128;const g=c.getContext('webgl2');/* render any gradient */ const a=new Uint8Array(128*128*4),b=new Uint8Array(128*128*4); g.readPixels(0,0,128,128,g.RGBA,g.UNSIGNED_BYTE,a); g.pixelStorei(g.PACK_ROW_LENGTH,128); g.readPixels(0,0,128,128,g.RGBA,g.UNSIGNED_BYTE,b); // honest Chrome: a and b are bit-identical. Lobium: they differ, and b is the true GPU output usable as a cross-profile linking key.
```

**Fix.**

Do not bail on non-default pack state — compute the real destination stride from the pack params (row_length ? row_length : width, plus skip_pixels/skip_rows offsets and alignment) and farble at the correct absolute coordinates. At minimum, treat `row_length == width` as the default case, and for the layouts you genuinely cannot map, fail closed (e.g. synthesize GL_INVALID_OPERATION or fall back to a full-canvas farbled read) rather than returning pristine pixels.

**Skeptic.**

Verified end to end. The guard is real and is in the applied source at webgl_rendering_context_base.cc:5581-5585: `pack.row_length == 0 && pack.skip_pixels == 0 && pack.skip_rows == 0`. WebGL2RenderingContextBase::pixelStorei stores PACK_ROW_LENGTH verbatim (webgl2_rendering_context_base.cc:801-803) and GetPackPixelStoreParams returns it (:5884-5892). The 'different stride' justification in the patch preamble is factually wrong for row_length == width: WebGLImageConversion::ComputeImageSizeInBytes computes `int row_length = params.row_length > 0 ? params.row_length : width;` (webgl_image_conversion.cc:3698) and explicitly special-cases the last row only when `params.row_length > 0 && params.row_length != width` (:3713), so row_length == width produces a byte-identical destination layout and an identical driver stride. One line of JS therefore returns the pristine host GPU pixels. Two accuracy corrections that do not change the verdict: (i) this is WebGL2-only, since WebGL1's pixelStorei rejects PACK_ROW_LENGTH and WebGL1's GetPackPixelStoreParams always reports row_length 0 — a detector just asks for a webgl2 context, so this is not mitigating; (ii) `alreadyDocumented: false` is not quite right — the preamble at :5580 does say 'non-default-pack layouts are left untouched', so the CLASS of bypass is acknowledged; what is undocumented (and unacceptable) is that one member of that class is a byte-for-byte no-op, i.e. the stated rationale is false. The proposed fix is sound; the minimal correct version is to treat `row_length == 0 || row_length == width` as the default case.

### HIGH (19)

#### `blink-deps-include-rules-missing` — 21 Blink translation units include //components/lobium_fp with no DEPS include-rule; blink/common explicitly bans it, and build-gn.patch's preamble falsely claims to add the rules

*Engine architecture, build hygiene, patch series* · **UNVERIFIED**

**Where.** `lobium/patches/core/build-gn.patch` — preamble lines 5-9; diff body lines 17-77 (no DEPS hunk anywhere)

**Mechanism.**

The patch preamble states it adds `core/DEPS += +components/lobium_fp`, `common/DEPS += +components/lobium_fp` and `modules/DEPS += +components/lobium_fp`. The diff touches only five BUILD.gn files (components/embedder_support, content/renderer, third_party/blink/common, blink/renderer/core, blink/renderer/modules) and no DEPS file at all. Meanwhile the series adds `#include "components/lobium_fp/..."` to 23 files, 21 of them under third_party/blink: 1 in blink/common (device_memory/approximated_device_memory.cc), 11 in blink/renderer/core (navigator_base.cc, navigator_events.cc, navigator_concurrent_hardware.cc, navigator_language.cc, media_values.cc, screen.cc, local_dom_window.cc, geolocation.cc, html_canvas_element.cc, offscreen_canvas.cc, element.cc), 9 in blink/renderer/modules (webgl_rendering_context_base.cc, offline_audio_context.cc, realtime_analyser.cc, audio_worklet_processor.cc, script_processor_node.cc, base_rendering_context_2d.cc, media_devices.cc, dom_plugin_array.cc, rtc_peer_connection.cc). Verified against the checkout: E:/lobium-build/src/third_party/blink/common/DEPS line 4 is literally `"-components"` with the comment "In general this directory should not depend on any of components/"; third_party/blink/renderer/DEPS is an allowlist whose only components entry is line 97 `"+components/crash/core/common/crash_key.h"`; core/DEPS allowlists only subresource_filter/performance_manager/viz headers; modules/DEPS has zero components entries. `gn check` passes (GN only validates target deps, which the patch does add), so the violation is invisible to `autoninja` and surfaces only under checkdeps - i.e. it silently ships. The blink/common case is not a bookkeeping nit: blink/common is deliberately embedder-agnostic and is linked into content and the utility/network hosts, so hanging //components off it is a genuine layering inversion, not just a missing allowlist line.

**How a detector sees it.**

```
After `lobium/build.ps1 -Run -Stop patch`, run `python3 buildtools/checkdeps/checkdeps.py --root=E:/lobium-build/src third_party/blink` - it reports one violation per included file (21), with the blink/common one flagged against the explicit `-components` rule. Not web-detectable; this is a fork-hygiene/maintainability defect.
```

**Fix.**

Add the three DEPS hunks the preamble already promises, each with a one-line rationale comment: `+components/lobium_fp` to third_party/blink/renderer/core/DEPS and .../modules/DEPS. For third_party/blink/common/DEPS, do NOT simply punch through `-components`: move the deviceMemory override out of blink/common. ApproximatedDeviceMemory::GetApproximatedDeviceMemory() is reachable from blink/renderer, so hook NavigatorDeviceMemory (blink/renderer/core/frame/navigator_device_memory.cc) plus the client-hint emitter in the renderer instead, and drop the blink/common patch entirely. If that is genuinely impossible, add `+components/lobium_fp` to blink/common/DEPS with an explicit comment recording the deliberate deviation, and fix the build-gn.patch preamble so it no longer describes work it does not do.

#### `widevine-disabled-eme-tell` — enable_widevine is unset, so the shipped Windows engine rejects com.widevine.alpha while every real Chrome for Windows resolves it

*Engine architecture, build hygiene, patch series* · **UNVERIFIED**

**Where.** `lobium/gn-args-windows.gn` — 33-37 (the '---- Media ----' block: only proprietary_codecs and ffmpeg_branding are set)

**Mechanism.**

Verified in E:/lobium-build/src/third_party/widevine/cdm/widevine.gni: `enable_widevine = ((is_chrome_branded || is_chrome_for_testing_branded) && !is_fuchsia) || is_android`. gn-args-windows.gn sets neither branding flag, so enable_widevine is false, enable_library_widevine_cdm is false, and the binary ships with no Widevine key system. The args file's own stated design principle is "match Google's official Chrome-for-Windows build configuration as closely as a non-Google build can" and it correctly reasons about proprietary_codecs on exactly these grounds - but stops one flag short. Widevine is the single most-probed EME key system: every real Chrome/Edge on Windows resolves requestMediaKeySystemAccess('com.widevine.alpha'), and no Chromium-derived browser that lacks it can pass as Chrome. Unlike the codec flags this is not covered by proprietary_codecs. (I confirmed the codec side is fine: with proprietary_codecs=true, media/media_options.gni lines 135/155/108 already give enable_hevc_parser_and_hw_decoder, enable_platform_hevc and enable_platform_dolby_vision on Windows, and enable_platform_ac3_eac3_audio is cast/tvOS-only in real Chrome too - so H.264/AAC/HEVC/DV parity is already correct.)

**How a detector sees it.**

```
Run in the built engine: `navigator.requestMediaKeySystemAccess('com.widevine.alpha',[{initDataTypes:['cenc'],videoCapabilities:[{contentType:'video/mp4;codecs="avc1.42E01E"'}]}]).then(()=>'HAS_WIDEVINE',e=>'NO_WIDEVINE:'+e.name)`. Real Chrome 152/Windows -> HAS_WIDEVINE. Lobium as configured -> NO_WIDEVINE:NotSupportedError. Cross-check: chrome://components lists "Widevine Content Decryption Module" in real Chrome and will not in Lobium. Also breaks Netflix/Spotify/Prime playback outright.
```

**Fix.**

Add `enable_widevine = true` to lobium/gn-args-windows.gn (and to gn-args.gn.example). widevine.gni's own comment sanctions this: "Can be optionally enabled in Chromium on non-Android platforms." bundle_widevine_cdm stays false for a non-Chrome-branded build, so enable_widevine_cdm_component carries the CDM via the component updater - verify the CDM actually lands per-profile before shipping, and add a probe to ci/validation (an EME key-system check belongs in detector-matrix alongside the codec matrix). Also set `ignore_missing_widevine_signing_cert = true` explicitly, since it defaults to `!is_official_build` and this is an official build.

#### `audio-index-keyed-noise-breaks-known-input` — Perturbation is keyed on sample INDEX, not sample VALUE, so a constant/known input renders as a non-constant array - an exact-equality oracle honest Chrome never fails on any platform

*Web Audio* · **CONFIRMED**

**Where.** `lobium/src/lobium_audio_farble.cc` — 40-48 (Mix(seed64, base_index + k) -> eps -> data[k] *= 1+eps); applied hook at E:/lobium-build/src/third_party/blink/renderer/modules/webaudio/offline_audio_context.cc:460

**Mechanism.**

eps is a function of (seed, absolute index) only. Two frames holding the identical input value therefore emit DIFFERENT output values. Honest Chrome has hard exactness guarantees on trivially predictable graphs, which I verified in the 152 tree:
  - modules/webaudio/constant_source_handler.cc:97-105 fills the output bus with std::ranges::fill(..., value) - the exact float offset, no arithmetic.
  - modules/webaudio/audio_buffer_source_handler.cc:451-461 takes ProcessFastPath (a straight memcpy, no interpolation) whenever computedPlaybackRate == 1 and the indices are integral.
  - modules/webaudio/offline_audio_destination_handler.cc:310-318 does Input(0).Pull() and, at worst, an AudioBus::CopyFrom - no gain, no clipping.
  - modules/webaudio/offline_audio_destination_handler.cc:199-209 copies the render bus into the result AudioBuffer as raw BYTES.
So ConstantSourceNode(offset:0.5) -> destination in an OfflineAudioContext produces the bit pattern 0x3F000000 in every single frame, on Windows, macOS, Linux, ARM, x86, SwiftShader, every Chrome build. Lobium produces 8192 distinct values spread over +/-0.15%. Crucially this is NOT fixed by lowering kAmplitude: at 1 ULP the array is still non-constant, so the fix has to change the keying, not just the magnitude. The patch preamble's claim that 'real cross-machine DSP + resampling differences dwarf it' is false for this class of graph - there ARE no cross-machine differences on a fill+memcpy path.

**How a detector sees it.**

```
Five lines, sub-millisecond, zero false positives across every honest browser: `const ctx=new OfflineAudioContext(1,8192,44100); const s=new ConstantSourceNode(ctx,{offset:0.5}); s.connect(ctx.destination); s.start(); const d=(await ctx.startRendering()).getChannelData(0); const lied = d.some(v => v !== 0.5);` -> false on honest Chrome, true on Lobium. Stronger variant with a ground truth of arbitrary content: createBuffer(1,8192,44100), fill with known values, play through AudioBufferSourceNode at playbackRate 1 into a 44100 Hz OfflineAudioContext, and compare the rendered result to the source buffer element-wise (honest maxdiff exactly 0; Lobium ~1.5e-3 relative). Note the repo's own proof that 'a user createBuffer()+copyToChannel()+getChannelData is bit-exact (maxdiff 0)' (audio-context.patch:47) is measuring the WRONG thing - it never renders the buffer through an OfflineAudioContext, which is where the ground truth becomes checkable.
```

**Fix.**

Key eps on the SAMPLE VALUE rather than the index, and make it idempotent: derive the key from the high bits of the float's bit pattern (sign+exponent+top ~12 mantissa bits) and perturb only the low mantissa bits. Then (a) equal inputs map to equal outputs, so a ConstantSourceNode render stays perfectly flat and a mono upmix stays bit-identical for free; (b) f(f(x)) == f(x), which simultaneously kills the double-farble contradiction (audio-worklet-spn-double-farble) and the cross-route keying mismatches (analyser-base-index-zero, spn-base-index-misaligned) because the perturbation stops depending on which route or which index a sample was read through. Accept that f(0.5) != 0.5 remains detectable by a determined adversary at 1-ULP scale, and document that as the residual; it is a vastly smaller surface than a 0.15% noise floor.

**Skeptic.**

Verified end to end in the 152 tree. constant_source_handler.cc:97-105 does `std::ranges::fill(output_bus->Channel(0)->MutableSpan().subspan(...), value)` with the raw float offset — no arithmetic. The destination path is arithmetic-free or exactly-preserving: offline_audio_destination_handler.cc:310-318 does Input(0).Pull() and at worst AudioBus::CopyFrom, and audio_bus.cc:290-306 shows equal-channel-count SumFrom is channel-wise Vadd (0.0f + x == x bit-exactly); lines 199-209 then copy the render bus into shared_render_target_ as raw BYTES, and shared_render_target_ IS the AudioBuffer JS receives. So ConstantSourceNode(offset:0.5) -> destination really does yield 0x3F000000 in every frame on every honest Chrome. Lobium's hook (config-channel.patch:809-823) multiplies each index by a distinct (1+eps), so `d.some(v => v !== 0.5)` is a zero-false-positive oracle. The finder is also right that lowering kAmplitude cannot fix it — the array is non-constant at 1 ULP too.

Two corrections. (a) Not fully undocumented: audio-context.patch:36-37 names 'known-input ratio inversion' in its KNOWN LIMITATIONS list — but it points at hooks.md, which does not exist anywhere in E:\project (see missed items), so the limitation is named and never analysed or accepted in writing. (b) Severity: the oracle is airtight and sub-millisecond, but I know of no production detector (CreepJS/FingerprintJS/Sannysoft/BrowserScan) that currently runs a known-input ConstantSourceNode probe — it is a probe an anti-anti-detect vendor would add in an afternoon, not one already deployed. High rather than critical.

#### `audio-worklet-spn-double-farble` — A pass-through offline AudioWorklet or ScriptProcessorNode gets the farble applied TWICE - (1+eps)^2 at the destination vs (1+eps) on a direct route, a contradiction honest Chrome cannot produce

*Web Audio* · **CONFIRMED**

**Where.** `lobium/patches/core/config-channel.patch` — 743-746 and 758-768 (hunks into third_party/blink/renderer/modules/webaudio/audio_worklet_processor.cc); 972-985 (hunk into script_processor_node.cc)

**Mechanism.**

The worklet tap farbles input_array_buffers_ - the V8 Float32Arrays handed to process() as `inputs`. But the overwhelmingly common processor body copies inputs to outputs (`output[c].set(input[c])`, the canonical pass-through). Those ALREADY-FARBLED values then flow through the graph into the offline destination buffer, where OfflineAudioContext::FireCompletionEvent farbles them a second time. Because the worklet base_index is global_scope_->currentFrame() and I verified (base_audio_context.cc:922-937 called from offline_audio_destination_handler.cc:332, i.e. AFTER AdvanceCurrentSampleFrame) that currentFrame equals the absolute start frame of the quantum being processed, the two applications use the SAME key: the result buffer at index N ends up holding x_N * (1+e_N)^2 while the identical graph without the worklet holds x_N * (1+e_N). The same happens for a pass-through ScriptProcessorNode via external_output_buffer_, with two DIFFERENT keys (see spn-base-index-misaligned), so the SPN case gives x*(1+e_a)*(1+e_b). Honest Chrome renders a pass-through AudioWorkletNode bit-identically to no node at all (the worklet adds no latency and does an exact copy in and out). The header's CALLER CONTRACT explicitly says 'Apply exactly ONCE per logical read to a PRISTINE source (re-running on already-farbled data compounds)' - this hook combination violates its own contract.

**How a detector sees it.**

```
`async function r(useWorklet){ const c=new OfflineAudioContext(1,8192,44100); if(useWorklet) await c.audioWorklet.addModule(URL.createObjectURL(new Blob(["class P extends AudioWorkletProcessor{process(i,o){if(i[0]&&i[0][0])o[0][0].set(i[0][0]);return true}}registerProcessor('p',P)"],{type:'text/javascript'}))); const s=new ConstantSourceNode(c,{offset:0.5}); if(useWorklet){const w=new AudioWorkletNode(c,'p'); s.connect(w); w.connect(c.destination);} else s.connect(c.destination); s.start(); return (await c.startRendering()).getChannelData(0);} const a=await r(false), b=await r(true);` Honest Chrome: a and b are bit-identical (both all-0.5). Lobium: b[i]/a[i] = 1+e_i, deviating up to 1.5e-3 per sample - and the spread of b is ~2x the spread of a, which is measurable even without a known input (use an oscillator instead of the constant source).
```

**Fix.**

Make the kernel idempotent by value-keying (see audio-index-keyed-noise fix), which makes the second application a no-op. Failing that, mark the offline destination buffer as already-perturbed when any farbled tap fed it, or drop the worklet/SPN input taps entirely and accept the upstream read as a documented limitation - it is strictly less damaging than a self-inconsistent double application.

**Skeptic.**

Mechanism verified in full. The key-equality claim, which the whole finding rests on, holds: offline_audio_destination_handler.cc:330-332 calls AdvanceCurrentSampleFrame(number_of_frames) and only THEN Context()->UpdateWorkletGlobalScopeOnRenderingThread(), which at base_audio_context.cc:934 does global_scope->SetCurrentFrame(CurrentSampleFrame()); and audio_worklet_object_proxy.cc:41-42 seeds current_frame_ to context_sample_frame_at_construction_ (0 for an offline context, since addModule precedes startRendering). So at AudioWorkletProcessor::Process time, global_scope_->currentFrame() is exactly the absolute start frame of the quantum being rendered, and config-channel.patch:764 keys the input farble at that frame — the SAME key the offline result hook (base_index=0 over a span that starts at frame 0) will use for the same absolute index. A pass-through processor therefore yields x*(1+e_N)^2 at the destination while the identical graph without the worklet yields x*(1+e_N). This directly violates the kernel's own CALLER CONTRACT (lobium_audio_farble.h:37-38, 'Apply exactly ONCE per logical read to a PRISTINE source').

The honest-baseline claim also holds: AudioWorkletNode adds no latency, mono-in/mono-out with channelCountMode 'max' does an exact copy, so honest Chrome renders the two graphs bit-identically. The detection script is sound.

One caveat on the SPN half: a ScriptProcessorNode adds bufferSize frames of latency, so the SPN comparison is NOT a straight element-wise diff against the direct render — the detector must shift by bufferSize. The finding does not mention this; its actual test uses the worklet, which is fine. Severity: high is right; not critical only because it needs an AudioWorklet module, which a few percent of detectors bother with.

#### `analyser-base-index-zero` — All four AnalyserNode hooks pass base_index=0 (positional keying) while the offline result hook keys on absolute sample index, so an OfflineAudioContext.suspend() analyser read contradicts the corresponding slice of the rendered buffer

*Web Audio* · **CONFIRMED**

**Where.** `lobium/patches/core/config-channel.patch` — 871, 892, 915, 939 (four FarbleAudioSamples calls into realtime_analyser.cc, all /*base_index=*/0) vs 821 (offline_audio_context.cc, index = absolute frame)

**Mechanism.**

GetFloatTimeDomainData farbles destination[i] with eps(seed, i) - keyed on the position within the destination array, not on the absolute frame the sample came from. The offline result buffer at absolute frame n carries eps(seed, n). AnalyserNode is a pass-through (analyser_handler.cc:42-72 calls WriteInput then copies input to output) and its input_buffer_ is a bit-exact record of the samples that also reach the destination (down_mix_bus_->Zero() then SumFrom, so 0.0f + x == x exactly for a mono graph). So in honest Chrome, an analyser read taken at a suspend point at frame n is EXACTLY equal, element-for-element, to renderedBuffer.getChannelData(0).slice(n - fftSize, n). Under Lobium the analyser returns x_{n-fftSize+i}*(1+e_i) and the result returns x_{n-fftSize+i}*(1+e_{n-fftSize+i}) - two different perturbations of the same sample, differing by up to ~0.3% relative. This directly contradicts the audio-context.patch preamble's claim that 'every readback path agrees by construction'. It is also fully deterministic (offline + suspend), so there is no timing jitter to hide behind - the repo's own analyser proof (audio-context.patch:42-43) uses exactly this suspend technique and evidently never cross-checked the two arrays against each other.

**How a detector sees it.**

```
`const c=new OfflineAudioContext(1,8192,44100); const o=new OscillatorNode(c); const a=new AnalyserNode(c,{fftSize:2048,smoothingTimeConstant:0}); o.connect(a); a.connect(c.destination); o.start(); let td=new Float32Array(2048); c.suspend(4096/44100).then(()=>{a.getFloatTimeDomainData(td); c.resume();}); const d=(await c.startRendering()).getChannelData(0); let maxdiff=0; for(let i=0;i<2048;i++) maxdiff=Math.max(maxdiff, Math.abs(td[i]-d[2048+i]));` Honest Chrome: maxdiff === 0 exactly. Lobium: maxdiff ~ 3e-3 * peak. No ground truth needed, no whitelist needed - it is a pure internal-consistency check.
```

**Fix.**

Pass the absolute frame index as base_index in the time-domain hooks: the analyser knows it (fft_size and the write index correspond to context frame CurrentSampleFrame() - fft_size). Frequency-domain bins are not sample-indexed, so they need a separate consistent key domain (e.g. a fixed 'freq' salt folded into the seed once, applied by bin index) - just do not reuse the sample-index domain for them. Or, preferably, adopt value-keying (see audio-index-keyed-noise), which makes every route agree automatically because the key travels with the sample.

**Skeptic.**

Confirmed, with one factual correction to the write-up. The finding contrasts 'four FarbleAudioSamples calls ... all /*base_index=*/0' against 'line 821 (offline_audio_context.cc, index = absolute frame)'. In fact config-channel.patch:821 ALSO passes /*base_index=*/0 — I read it directly. The conclusion survives unchanged only because the offline span covers the entire rendered buffer starting at frame 0, so k does equal the absolute frame there, whereas the analyser's k is the position inside the destination array. The contradiction is real; the stated cause is slightly misdescribed.

Everything else checks out. AnalyserHandler::Process (analyser_handler.cc:42-80) is a pass-through: WriteInput then either in-place or CopyFrom. RealtimeAnalyser::WriteInput (realtime_analyser.cc:236-240) does down_mix_bus_->Zero() then SumFrom, and audio_bus.cc:300-306 makes that a channel-wise Vadd for a mono graph, so input_buffer_ is a bit-exact record of the samples that also reach the destination. GetFloatTimeDomainData (:181-188) reads frames [n-fftSize, n) at a suspend point at frame n. Honest Chrome: td[i] === renderedBuffer[n-fftSize+i] exactly. Lobium: td[i] = x*(1+e_i) vs d[n-fftSize+i] = x*(1+e_{n-fftSize+i}). Pure internal-consistency check, fully deterministic (offline + suspend), no whitelist and no ground truth needed. This is the strongest single finding in the set and it does contradict audio-context.patch:23-24's claim that 'every readback path agrees by construction'.

#### `fail-open-is-silent-in-shipping-build` — Every config-channel failure path fails OPEN into a partial spoof, and the LOG(ERROR) "never silently leaks" safety net is a no-op in the shipping build

*Config channel, capability contract, launcher* · **PARTLY_TRUE**

**Where.** `lobium/src/lobium_fp_config.cc (+ lobium/patches/core/config-channel.patch, packages/engine-runner/src/runners/lobium-launcher.ts)` — lobium_fp_config.cc:236-265 (Current()); config-channel.patch:163-179 == E:\lobium-build\src\content\browser\renderer_host\render_process_host_impl.cc:4045-4079; lobium-launcher.ts:742-747

**Mechanism.**

Three independent failure paths return nullptr and let the renderer report HOST values: (a) browser cannot read lobium-fp.json -> render_process_host_impl.cc:4056-4060 logs and never appends --lobium-fp-data; (b) base64 payload > 28 KiB -> :4069-4077 SKIPS the switch; (c) Base64Decode or JSONReader fails -> lobium_fp_config.cc:238-250 returns nullopt. Each patch justifies this with "every failure path LOG(ERROR)s so it is never silent". That is false in the product configuration, on two counts. First, lobium/gn-args.gn.example sets is_official_build=true / is_debug=false / dcheck_always_on=false; chrome/common/features.gni:36 sets chrome_enable_logging_by_default = is_debug, and features.gni:80 asserts it MUST be false for official builds, so chrome/common/logging_chrome.cc:154-175 returns LOG_NONE unless --enable-logging is passed - which the launcher never passes (grep for enable-logging in engine-runner/src returns nothing). Every Lobium LOG(ERROR) is therefore compiled-in but routed nowhere. Second, lobium-launcher.ts:745 spawns the engine with stdio:'ignore', so even LOG_TO_STDERR would be discarded. Worse, the resulting state is not "unspoofed" but MIXED: the UA hooks are browser-side (user_agent_utils.cc GetUserAgent/GetUserAgentMetadata read the file directly), so the HTTP User-Agent, Sec-CH-UA, and navigator.userAgentData stay persona, while every renderer-side hook falls back to the host - navigator.platform falls back to GetReducedNavigatorPlatform() which is COMPILE-TIME (navigator_base.cc:27; "Win32" on the Windows target), hardwareConcurrency/deviceMemory to real CPU/RAM, Screen::GetRect to the real monitor, devicePixelRatio to the host, and WEBGL_debug_renderer_info UNMASKED_RENDERER to the REAL host GPU string. A partial spoof is strictly more detectable than none. Nothing at any layer - native, browser, or sidecar - notices; the launcher only waits for DevToolsActivePort (lobium-launcher.ts:758) and reports success.

**How a detector sees it.**

```
Serve a page that posts back {hdrUA: <server-side User-Agent header>, jsUA: navigator.userAgent, plat: navigator.platform, hc: navigator.hardwareConcurrency, mem: navigator.deviceMemory, scr: [screen.width, screen.height], dpr: devicePixelRatio, gpu: (()=>{const g=document.createElement('canvas').getContext('webgl');const e=g.getExtension('WEBGL_debug_renderer_info');return g.getParameter(e.UNMASKED_RENDERER_WEBGL)})()}. To force the failure state, chmod/lock lobium-fp.json (or truncate it) between writeLobiumConfig() and spawn, or launch with a config whose base64 exceeds 28 KiB. Observed result: hdrUA/jsUA claim e.g. macOS, plat === 'Win32', gpu === 'ANGLE (NVIDIA GeForce ... Direct3D11 ...)', scr === the operator's real monitor. This is exactly the CreepJS "lies" cluster and the Pixelscan/BrowserScan OS-vs-GPU cross-check; it is a single page load with no permissions.
```

**Fix.**

Make the channel fail CLOSED at three points. (1) Native: when --lobium-fp-config is present in the browser or --lobium-fp-data is present in a renderer but cannot be read/decoded/parsed, CHECK-fail (or send a browser-side kill) rather than return nullptr - a present-but-broken config must never degrade to host values. (2) render_process_host_impl.cc:4069: if the payload is over budget, do not spawn the renderer at all. (3) Sidecar: after waitForEndpointOrExit, run a CDP self-check that evaluates navigator.platform / hardwareConcurrency / deviceMemory / screen.width / devicePixelRatio / UNMASKED_RENDERER in the main frame AND inside a dedicated worker, compare against ctx.fingerprint, and tear the browser down on mismatch. Independently: pass --enable-logging=stderr and stop using stdio:'ignore' so the existing LOG(ERROR)s can actually be surfaced.

**Skeptic.**

The core architecture claim is CONFIRMED and I verified every leg of it. (a) `LobiumFpConfig::Current()` (E:\project\lobium\src\lobium_fp_config.cc:236-265) returns nullptr on decode/parse failure and on an unreadable file; (b) the applied hunk at E:\lobium-build\src\content\browser\renderer_host\render_process_host_impl.cc:4045-4077 logs and SKIPS `--lobium-fp-data` on read failure or >28 KiB; (c) the logging safety net really is dead in the product: the WINDOWS shipping args file the finder never cited, E:\project\lobium\gn-args-windows.gn:15-18, sets is_debug=false / is_official_build=true / dcheck_always_on=false; chrome/common/features.gni:36+80 forces chrome_enable_logging_by_default=false for official builds; logging_chrome.cc:160-172 then returns LOG_NONE; and base/logging.cc:557-563 `ShouldCreateLogMessage` short-circuits when the destination is LOG_NONE, so the LOG(ERROR) never materialises. lobium-launcher.ts:746 spawns with stdio:'ignore', no --enable-logging anywhere in packages/engine-runner/src, and lobium-launcher.ts:758 waits only for DevToolsActivePort — grep for navigator.platform/hardwareConcurrency/UNMASKED in start-profile.ts returns nothing, so there is genuinely no post-launch verification. GetReducedNavigatorPlatform is compile-time 'Win32' (third_party/blink/renderer/core/execution_context/navigator_base.cc:26-42). TWO SUBSTANTIVE ERRORS. First, the flagship 'MIXED persona' description is wrong for the failure path the finder actually proposes triggering. Path (a) is 'browser cannot read lobium-fp.json' — but the browser's OWN `Current()` (lobium_fp_config.cc:253-260) reads the SAME file via the SAME `base::ReadFileToString`, so GetUserAgent/GetUserAgentMetadata also fall back. You do not get 'hdrUA claims macOS, plat===Win32'; you get a stock-Chromium UA plus an unbranded Sec-CH-UA brand list (no 'Google Chrome'), i.e. a different — still bad — failure, not the described one. Only path (b) (oversize payload) produces the persona-UA/host-renderer split the finding is built on, and lobium-config.ts:233-241 rejects the launch at an EXACTLY equal threshold (Math.ceil(bytes/3)*4 is the precise base64 length that base::Base64Encode produces, and the native test is `<= 28*1024`), so path (b) is unreachable through the product. Path (c) requires argv corruption between AppendSwitchASCII and CommandLine::Init in the same OS. Second, 'critical' overstates the reachability: there is no non-adversarial production trigger the finder identified. I found one real one they dropped — Chromium 152 is NOT long-path aware (no `longPathAware` in build/win/*.manifest or chrome/app/chrome.dll.manifest) while libuv silently prefixes \\?\ on write, so a >260-char `<userDataDir>\lobium-fp.json` writes fine and is unreadable by base::ReadFileToString. Verdict: real architectural defect (fail-open + mute logging + zero self-check), wrong failure-state description, severity high not critical.

#### `linux-persona-nonempty-platform-version` — Linux personas emit Sec-CH-UA-Platform-Version "6.8.0"; real Chrome on Linux always emits an empty string

*navigator / User-Agent / UA client hints* · **CONFIRMED**

**Where.** `packages/fingerprint/src/pools.ts` — 284 (`uaPlatformVersion: '6.8.0'` in the LINUX OsTemplate); consumed at components/embedder_support/user_agent_utils.cc:690 via lobium/patches/core/config-channel.patch

**Mechanism.**

The Lobium branch of `GetUserAgentMetadata()` copies the persona field verbatim: `metadata.platform_version = nav.ua_platform_version;`. Upstream Chromium's `GetPlatformVersion()` (E:\lobium-build\src\components\embedder_support\user_agent_utils.cc:616-625) has `#elif BUILDFLAG(IS_LINUX) || BUILDFLAG(IS_FUCHSIA) return std::string();` — genuine Chrome on Linux *never* reports a platform version. So the persona announces a value no real Chrome/Linux can produce, on every request that carries `Sec-CH-UA-Platform-Version` and via `getHighEntropyValues`. Nothing catches it: `validateFingerprintCoherence` (packages/fingerprint/src/coherence.ts:420-739) checks `uaPlatform` but never `uaPlatformVersion`, and `applyProfileOsVersion` (packages/engine-runner/src/start-profile.ts:146-157) only has `windows` and `macos` branches, so the Linux OS-version picker (`Ubuntu 24.04`, … in apps/desktop/src/features/profiles/options.ts:29) leaves 6.8.0 in place. Linux is a first-class, selectable OS (options.ts:19) and is the DEFAULT draft OS (apps/desktop/src/features/profiles/profileDraft.ts:218), and it launches fine on a Windows host because the default renderer choice is a `validated_preset` (profileDraft.ts:252).

**How a detector sees it.**

```
One line in the page: `await navigator.userAgentData.getHighEntropyValues(['platform','platformVersion'])` → `{platform:'Linux', platformVersion:'6.8.0'}`. Real Chrome/Linux returns `{platform:'Linux', platformVersion:''}`. Server-side equivalent: reply `Accept-CH: Sec-CH-UA-Platform-Version` and read the header on the next hop — `"6.8.0"` vs `""`. Deterministic boolean, no permission, works from a first-party script or an edge worker.
```

**Fix.**

Set `uaPlatformVersion: ''` on the LINUX template in pools.ts and make the native hook emit an empty string for it (it already does — `nav.ua_platform_version` is just copied). Add a coherence assertion in `validateFingerprintCoherence`: `fp.os === 'linux' && nav.uaPlatformVersion !== '' → issue`, and mirror the same per-OS expectations for windows/macos so the field can never silently drift again.

**Skeptic.**

Mechanism verified end to end.
- packages/fingerprint/src/pools.ts:284 — LINUX template `uaPlatformVersion: '6.8.0'`; derive.ts:111 copies `tpl.uaPlatformVersion` verbatim into the persona.
- The hook copies it unchanged: `metadata.platform_version = nav.ua_platform_version;` at E:\lobium-build\src\components\embedder_support\user_agent_utils.cc:690 (already applied in the checkout).
- Upstream is hard-empty: user_agent_utils.cc:616-619 `#elif BUILDFLAG(IS_LINUX) || BUILDFLAG(IS_FUCHSIA) return std::string();`. There is no Chrome/Linux build that can emit a non-empty platformVersion.
- Nothing catches it: `uaPlatformVersion` appears nowhere in coherence.ts (grep confirms), and applyProfileOsVersion (start-profile.ts:146-157) has only `windows` and `macos` branches, so the linux OS-version picker (options.ts:29) is inert. start-profile.ts:321 applies it and the linux persona keeps 6.8.0.
- Reachability confirmed: `linux` is in OS_OPTIONS (options.ts:19) and `createProfileDraft(os: ProfileOsTarget = 'linux')` (profileDraft.ts:218) is called with no argument by NewProfileForm.tsx:125, so the create form genuinely opens on Linux.

One attribution error, not a substance error: the finding says the hook is 'consumed at ... via lobium/patches/core/config-channel.patch'. It is not — config-channel.patch is 94 lines of pure transport (render_process_host_impl.cc only). The UA/UA-CH hook lives in lobium/patches/core/navigator-ua-ch.patch (platform_version at patch line 88). The finder's coverage note also claims to have read 'config-channel.patch (all 1121 lines)', which is a 5.5 KB / 94-line file — they clearly read the pre-split version or conflated the two patches. The applied-file line numbers they give are correct, so the finding itself stands.

Severity: I'd keep high. It is a deterministic, permission-free, single-boolean impossible value (`platform:'Linux'` + `platformVersion:'6.8.0'`), reachable from `getHighEntropyValues` or a single `Accept-CH: Sec-CH-UA-Platform-Version` round trip, and it is the DEFAULT OS in the create form.

#### `android-arch-bitness-leak` — Android personas send Sec-CH-UA-Arch "arm" / Sec-CH-UA-Bitness "64"; real Android Chrome sends empty strings for both

*navigator / User-Agent / UA client hints* · **CONFIRMED**

**Where.** `lobium/patches/core/config-channel.patch` — patch lines 104-105 (applied at E:\lobium-build\src\components\embedder_support\user_agent_utils.cc:695-697)

**Mechanism.**

The hook is `metadata.architecture = cfg->arch.empty() ? GetCpuArchitecture() : (cfg->arch == "arm64" ? "arm" : "x86"); metadata.bitness = cfg->arch.empty() ? GetCpuBitness() : "64";`. Its preamble asserts "All catalog personas are 64-bit desktops" — but the Android emulated path is live: `startAndroidEmulatedProfile` projects the Android persona into a Fingerprint with `arch: 'arm64'` (packages/engine-runner/src/start-android-emulated-profile.ts:123-131), `buildLobiumConfig` writes it as top-level `arch` (packages/engine-runner/src/lobium-config.ts:199), and rpc dispatch routes every `os === 'android'` profile there (packages/engine-runner/src/rpc.ts:46-52; `android` is a selectable OS at apps/desktop/src/features/profiles/options.ts:20). Upstream Chromium returns EMPTY strings on Android: `GetCpuArchitecture()` (user_agent_utils.cc:794-802) returns `std::string()` unless `is_desktop()||is_xr()`, and `GetCpuBitness()` (:837-842) does the same — both explicitly documented in user_agent_utils.h:96-102 as "the empty string on Android". So every Lobium Android persona answers arch/bitness where no real Android Chrome ever does, next to `platform:"Android"` and a real Android device model.

**How a detector sees it.**

```
`await navigator.userAgentData.getHighEntropyValues(['platform','platformVersion','architecture','bitness','model','mobile'])`. Lobium Android: `{platform:'Android', architecture:'arm', bitness:'64', model:'Pixel 8', mobile:true}`. Real Android Chrome: `{platform:'Android', architecture:'', bitness:'', model:'Pixel 8', mobile:true}`. Header form: send `Accept-CH: Sec-CH-UA-Arch, Sec-CH-UA-Bitness` and read `Sec-CH-UA-Arch: "arm"` / `Sec-CH-UA-Bitness: "64"` instead of `""`/`""`. Single-boolean check; the Sec-CH-UA-* form works with no JS at all.
```

**Fix.**

In the Lobium branch of `GetUserAgentMetadata()`, blank arch/bitness for mobile Android personas: `if (nav.ua_platform == "Android") { metadata.architecture.clear(); metadata.bitness.clear(); } else { …existing… }`. Cleaner: add explicit `uaArchitecture`/`uaBitness` string fields to the config schema (shared-types + lobium_fp_config.cc `ReadNavigator`) so the TS persona owns them and the C++ never has to infer them from `arch`; set them to `''` in `deriveAndroidFingerprint` and assert it in `validateAndroidFingerprintCoherence`.

**Skeptic.**

Verified in both directions.
- The hook: user_agent_utils.cc:695-697 (applied) `metadata.architecture = cfg->arch.empty() ? GetCpuArchitecture() : (cfg->arch == "arm64" ? "arm" : "x86"); metadata.bitness = cfg->arch.empty() ? GetCpuBitness() : "64";` — with `metadata.model = nav.ua_model` at :699 and `metadata.platform = nav.ua_platform` = "Android" at :675.
- Upstream Android really is empty: GetCpuArchitecture() user_agent_utils.cc:794-802 returns `std::string()` unless `is_desktop() || is_xr()`; GetCpuBitness() :837-842 the same. The header comments at :767-768 and :827-828 say so explicitly.
- The Android path is live and is the DEFAULT for android profiles: rpc.ts:46-52 routes every non-`adb` android profile to startAndroidEmulatedProfile, which sets `arch: 'arm64'` at start-android-emulated-profile.ts:125; lobium-config.ts:199 writes it as top-level `arch`; lobium_fp_config.cc:181 parses it. `android` is selectable at options.ts:20.
- The browser process (which builds the outgoing Sec-CH-UA-* headers) does have the config: LobiumFpConfig::Current() reads the `--lobium-fp-config` file directly on the unsandboxed path (lobium_fp_config.cc:252-261), so this is not renderer-only.
- The preamble's own justification is stale: navigator-ua-ch.patch line 92 asserts "All catalog personas are 64-bit desktops with no device model and no WoW64", which the Android emulated path falsified.

Same patch-file misattribution as the previous finding (the hook is navigator-ua-ch.patch lines 95-97, not config-channel.patch:104-105), but the applied-source line numbers 695-697 are exactly right. Severity high stands: `{platform:'Android', architecture:'arm', bitness:'64', model:'Pixel 8'}` is a combination no real Android Chrome can produce, readable with one getHighEntropyValues call or one Accept-CH round trip.

#### `mobile-pointer-hover-via-cdp` — Mobile pointer/hover media features and the mobile viewport are applied over CDP, not natively — best-effort, page-targets-only, and inconsistent with the native maxTouchPoints

*navigator / User-Agent / UA client hints* · **CONFIRMED**

**Where.** `packages/engine-runner/src/mobile-emulation.ts` — 37-68 (`mobileEmulationCommands`) and 107-123 (`configureSession`, gated on `type === 'page'`)

**Mechanism.**

`navigator.maxTouchPoints` for a mobile persona is native (config-channel.patch → `third_party/blink/renderer/core/events/navigator_events.cc`), but `(pointer: coarse)`, `(any-pointer: coarse)`, `(hover: none)` and the mobile viewport come only from CDP `Emulation.setTouchEmulationEnabled` / `setEmitTouchEventsForMouse` / `setDeviceMetricsOverride{mobile:true}`. Those map to `DevToolsEmulator::SetTouchEventEmulationEnabled` (E:\lobium-build\src\third_party\blink\renderer\core\inspector\dev_tools_emulator.cc:494-511, which sets `SetPrimaryPointerType(kPointerCoarseType)` / `SetPrimaryHoverType(kHoverNone)`) and `EnableMobileEmulation()` (:361-373). This is a DevTools overlay applied after browser start (lobium-launcher.ts:762-771), only to targets whose `type === 'page'`, with every per-session failure swallowed and logged (mobile-emulation.ts:154-160) and the whole controller torn down if the WebSocket closes (:169-175). It also directly contradicts the stated product principle that no fingerprint surface is spoofed via CDP, and it drags in observable side effects real mobile Chrome does not produce in that combination (`ScopedGlobalOverrides`, forced `ViewportStyle::kMobile` + `SetShrinksViewportContentToFit`, `Emulation.setScrollbarsHidden`).

**How a detector sees it.**

```
`JSON.stringify({mtp:navigator.maxTouchPoints, uaMobile:navigator.userAgentData.mobile, coarse:matchMedia('(pointer: coarse)').matches, noHover:matchMedia('(hover: none)').matches})`. Whenever the overlay did not reach a target (socket failure, non-`page` target, a tab opened during a reconnect window) the page sees `{mtp:5, uaMobile:true, coarse:false, noHover:false}` — a UA/UA-CH/touch-count that claim a phone next to a fine, hovering primary pointer, which no real device produces. Separately, `getComputedStyle` on a forced-mobile viewport plus hidden scrollbars is a stable emulation signature.
```

**Fix.**

Move the pointer/hover surface into the native config channel next to `maxTouchPoints`: gate `Settings::SetPrimaryPointerType/SetAvailablePointerTypes/SetPrimaryHoverType/SetAvailableHoverTypes` (and, if the mobile viewport is wanted, `SetViewportStyle`/`SetViewportEnabled`) on `cfg->navigator.ua_mobile` at WebView/Settings initialization, and delete the CDP overlay. Until that lands, make `installMobileEmulationForAllTargets` fail the launch rather than warn when a `page` target cannot be configured.

**Skeptic.**

The code observations are all correct, and the detection is considerably STRONGER than the finder argued.

VERIFIED:
- mobile-emulation.ts:37-68 sends only Emulation.setTouchEmulationEnabled / setEmitTouchEventsForMouse / setDeviceMetricsOverride{mobile:true} / setScrollbarsHidden; :107-118 applies them only when `type === 'page'`; :154-160 swallows per-session failures with a console.warn; installed post-launch at lobium-launcher.ts:762-771.
- dev_tools_emulator.cc:488-515 SetTouchEventEmulationEnabled sets SetAvailablePointerTypes/SetPrimaryPointerType to kPointerCoarseType and SetAvailableHoverTypes/SetPrimaryHoverType to kHoverNone, plus SetForceTouchEventFeatureDetectionForInspector(enabled). :361-392 EnableMobileEmulation installs ScopedGlobalOverrides and forces ViewportStyle::kMobile, SetViewportEnabled, SetShrinksViewportContentToFit, SetDefaultPageScaleLimits(0.25,5).
- It does contradict the stated product principle, and docs/ENGINEERING.md:78 compounds it by claiming "mobile profiles run under native touch/device emulation".

WHAT THE FINDER UNDERSOLD — the leak is STRUCTURAL, not intermittent. They framed it as "whenever the overlay did not reach a target (socket failure ... reconnect window)". Cross-site iframes are a permanent, deterministic miss:
- mobile-emulation.ts:111 gates on `type === 'page'`; an OOPIF target is type 'iframe', so it NEVER receives the emulation commands.
- Browser-side device emulation also stops at main frames: emulation_handler.cc:1119-1126 `ForEachRenderFrameHostImplIncludingSpeculative(... if (host->is_main_frame()) UpdateDeviceEmulationStateForHost(...))`.
- So an OOPIF's own Page keeps the host WebPreferences: slow_web_preference_cache.cc:97-118/179-186 loads available_pointer_types / primary_pointer_type / available_hover_types / primary_hover_type / touch_event_feature_detection_enabled / pointer_events_max_touch_points from the real ui:: host values into EVERY renderer.
- Meanwhile the NATIVE maxTouchPoints hook (navigator-ua-ch.patch -> navigator_events.cc) applies in every frame of every renderer, because --lobium-fp-data rides PropagateBrowserCommandLineToRenderer.

Result, inside any cross-site iframe on an Android persona running on a normal non-touch Windows host: `navigator.maxTouchPoints === 5`, `navigator.userAgentData.mobile === true`, UA says Android — while `matchMedia('(pointer: coarse)').matches === false`, `matchMedia('(hover: hover)').matches === true`, and `'ontouchstart' in window === false` (touch_event_feature_detection_enabled_ is false on a non-touch host, and only the main frame gets SetForceTouchEventFeatureDetectionForInspector). No real device produces that, there is no race, and DataDome / hCaptcha / Arkose / PerimeterX all run inside exactly such an iframe. That is why I'm raising this from medium to high.

ONE FIX-DETAIL CORRECTION: "make installMobileEmulationForAllTargets fail the launch rather than warn" is already half-true — an initial-setup failure throws (mobile-emulation.ts:205-209) and propagates through lobium-launcher.ts:800-804 to abort the launch. Only late Target.attachedToTarget configuration failures warn. The gap that actually matters is the `type === 'page'` filter, which no amount of fail-closed logic fixes; the pointer/hover surface has to move into the native config channel as the finder ultimately proposes.

#### `clientrect-empty-rect-farbled` — getBoundingClientRect() on a display:none / detached / unrendered element returns a NON-ZERO rect (real Chrome always returns all zeros)

*Screen, DPR, viewport, media queries, clientRects* · **CONFIRMED**

**Where.** `lobium/patches/fingerprint/client-rects.patch (hunk @@ -3515,7 +3531,18 @@ → third_party/blink/renderer/core/dom/element.cc, Element::GetBoundingClientRect, upstream line 3411)` — client-rects.patch:44-55; lobium/src/lobium_farble.cc:133-134

**Mechanism.**

Upstream Element::GetBoundingClientRectNoLifecycleUpdate() (element.cc:3398-3409) explicitly early-returns gfx::RectF() when ClientQuads() produced no quads — i.e. for a detached node, display:none, an unrendered <head> child, or a node in a display-locked subtree. Every such call in stock Chrome yields DOMRect{x:0,y:0,width:0,height:0,top:0,right:0,bottom:0,left:0}. The patch farbles `result` unconditionally, with no emptiness guard, so the zero rect is turned into x=±0.015625, y=±0.015625, and — because FarbleClientRect clamps with `std::max(kUnit, *width + delta)` (lobium_farble.cc:133-134) — width=height=0.015625 regardless of the delta sign. Note the sibling hook in the SAME patch does guard correctly: Element::getClientRects() early-returns on `rects.empty()` before the farble loop, so getClientRects() is empty while getBoundingClientRect() is non-zero for the same element — an additional internal contradiction. This is also a functional break, not only a fingerprint tell: enormous amounts of real site code does `if (el.getBoundingClientRect().width === 0) { /* treat as hidden */ }`.

**How a detector sees it.**

```
const r = document.createElement('div').getBoundingClientRect(); const spoofed = (r.x||r.y||r.width||r.height) !== 0;  // real Chrome: 0/0/0/0 always. Variant that also works on an attached node: const d=document.createElement('div'); d.style.display='none'; document.body.append(d); d.getBoundingClientRect().width === 0.015625. Cross-check variant: const rl=d.getClientRects(); rl.length===0 && d.getBoundingClientRect().width!==0 is impossible in Chrome.
```

**Fix.**

Mirror upstream's own guard: skip the farble when the source rect is empty. In the GetBoundingClientRect hunk wrap the call in `if (result != gfx::RectF())` (or `!result.IsEmpty()`), and inside FarbleClientRect return early when the incoming width and height are both 0. Drop the `std::max(kUnit, …)` clamp in favour of `std::max(0.0f, …)` so a legitimately zero-sized rendered box (`width:0;height:0`) also stays exactly 0.

**Skeptic.**

Mechanism verified exactly. E:\lobium-build\src\third_party\blink\renderer\core\dom\element.cc:3384-3396 (GetBoundingClientRectNoLifecycleUpdateNoAdjustment) returns gfx::RectF() when ClientQuads() yields no quads, and :3398-3402 short-circuits on `result == gfx::RectF()`. Every detached / display:none / unrendered element therefore gives 0/0/0/0 in stock Chrome. client-rects.patch:44-55 farbles `result` with no emptiness guard, and lobium_farble.cc:129-134 has `*width = std::max(kUnit, *width + delta(4u))` with kUnit = 1/64, so 0 becomes exactly 0.015625 for BOTH width and height regardless of delta sign, and x/y become +/-0.015625. The internal contradiction is also real: element.cc:3351-3355 shows getClientRects() early-returns an empty DOMRectList before the patch's farble loop (the patch hunk at :23-35 sits after the adjust loop, i.e. after that return), so `el.getClientRects().length===0 && el.getBoundingClientRect().width!==0` is reachable and is impossible in Chrome. SEVERITY CORRECTED critical->high: the finder never checked the gate. `hardwareNoise.clientRects` defaults to FALSE in every product entry point (packages/engine-runner/src/lobium-config.ts:90, start-profile.ts:48, start-android-profile.ts:35, start-android-emulated-profile.ts:28, android-config.ts:66) and lobium-config.ts:209 emits `seeds.clientRects = 0` when off, which makes the whole hook inert (`cfg->seeds.client_rects` guard). Only ci/validation/native-policy-probe.mjs:130, creepjs-battle.mjs:112 and the user-facing 'Client Rects' toggle (apps/desktop/src/features/fingerprint/FingerprintEditor.tsx:125,812 — default false) turn it on. So this is a shipped landmine for anyone who ticks the box, not a default-on tell. The proposed fix is sound; note `!result.IsEmpty()` is NOT equivalent to `result != gfx::RectF()` (IsEmpty() is true for a 0x0-sized rect at nonzero x/y too), so upstream's own `== gfx::RectF()` comparison is the right guard to mirror.

#### `clientrect-delta-never-zero` — The sub-pixel delta is never zero, so every DOMRect coordinate is knocked off the integer grid — integral CSS geometry stops being integral

*Screen, DPR, viewport, media queries, clientRects* · **CONFIRMED**

**Where.** `lobium/src/lobium_farble.cc` — 129-134 (kUnit / delta lambda); doc mismatch at lobium/src/lobium_farble.h:46-48

**Mechanism.**

`const auto delta = [&](uint32_t bit) { return (h & bit) ? kUnit : -kUnit; }` has no zero branch, and all four of x/y/width/height are perturbed on every call. In stock Chrome an element laid out from integral CSS produces exactly integral DOMRect doubles: LayoutUnit is 1/64 CSS px, `left:10px` becomes LayoutUnit(10) (or LayoutUnit(10*dsf) with use-zoom-for-dsf, divided back by the same exactly-representable Windows scale factor 1.25/1.5/1.75/2.0/2.25/2.5/3.0 in AdjustForAbsoluteZoom), so the float round-trips to exactly 10.0. Under Lobium it is always 9.984375 or 10.015625. Nothing in an honest browser produces that. Two secondary breaks fall out of the same defect: (a) `parseFloat(getComputedStyle(el).width)` (unfarbled) no longer equals `bcr.width`; (b) `Math.round(bcr.width) === offsetWidth` — an invariant honest Chrome always satisfies — fails deterministically for any half-pixel width, e.g. width:100.5px gives offsetWidth 101 (LayoutUnit::Round is half-up) but Math.round(100.484375)=100 for the half of seeds whose width bit is 0. Separately, the header contract at lobium_farble.h:46-48 documents a delta of `{-0.0001, 0, +0.0001}` keyed on `(seed, rect_index, channel)`; the implementation uses ±1/64 = 0.015625, never 0, and is not keyed per channel (one hash, four bit tests). On the magnitude question: 1/64 is the RIGHT quantum — it keeps the result on the LayoutUnit grid, whereas the documented 0.0001 would be off-grid and instantly synthetic — so the header should be corrected to the implementation, not the other way round. The defect is applying it unconditionally, not its size.

**How a detector sees it.**

```
const d=document.createElement('div'); d.style.cssText='position:absolute;left:10px;top:20px;width:30px;height:40px'; document.body.append(d); const r=d.getBoundingClientRect(); const spoofed = !(Number.isInteger(r.x)&&Number.isInteger(r.y)&&Number.isInteger(r.width)&&Number.isInteger(r.height));  // real Chrome: all integers. Grid variant that survives odd zoom: Math.abs(r.width - parseFloat(getComputedStyle(d).width)) > 1e-9. Half-pixel variant: set width:100.5px and test Math.round(r.width) === d.offsetWidth.
```

**Fix.**

Key the hash on the QUANTIZED VALUE rather than on an index, and give the delta a zero branch so most rects are returned untouched: e.g. h = mix(seed, lround(v*64)) per component and delta = (h % 3) - 1 in units of 1/64 (same shape as FarblePixel). Better still, only perturb components whose value is already non-integral, so integral layouts stay pristine while text-metric-derived fractional geometry — the part that actually carries fingerprint entropy — still varies per profile.

**Skeptic.**

Code observation exact: lobium_farble.cc:130 `const auto delta = [&](uint32_t bit) { return (h & bit) ? kUnit : -kUnit; }` has no zero branch and all four components are perturbed on every call. The Chromium claim also checks out: AdjustForAbsoluteZoom (core/layout/adjust_for_absolute_zoom.h:69-75, 112-125) divides by EffectiveZoom/LayoutZoomFactor and is a no-op at zoom 1, and AbsoluteQuads for an integral CSS box yields exact integral floats, so `left:10px;width:30px` round-trips to exactly 10.0/30.0 in stock Chrome. `Number.isInteger(r.width)` is therefore a one-line, 100%-reliable discriminator. The offsetWidth cross-check also holds (width:100.5px -> LayoutUnit 6432, Round() = 101 = Math.round(100.5), vs Math.round(100.484375) = 100). Header/impl drift at lobium_farble.h:46-48 ({-0.0001,0,+0.0001} vs +/-1/64 never zero) is real. SEVERITY CORRECTED critical->high for the same reason as the previous finding: the feature is default-off in every launch path (lobium-config.ts:90 / start-profile.ts:48), so the shipping default does not exhibit this. Caveat on the finder's grid argument: 1/64 stays on the LayoutUnit grid only at zoom 1 / DSF 1; once AdjustRectForScrollAndAbsoluteZoom divides by a non-unity LayoutZoomFactor the honest values are already off the 1/64 grid, so 'keeps the result on the LayoutUnit grid' is true only for the unzoomed 1x case.

#### `screen-colordepth-vs-css-color-feature` — screen.colorDepth is spoofed but the CSS colour-depth / HDR / gamut media features still report the host display

*Screen, DPR, viewport, media queries, clientRects* · **CONFIRMED**

**Where.** `lobium/patches/fingerprint/screen-dpr.patch (hooks third_party/blink/renderer/core/frame/screen.cc:113-121); unhooked peers in core/css/media_values.cc` — screen-dpr.patch:117-128; media_values.cc:219-228 (CalculateColorBitsPerComponent), :210-217 (CalculateDeviceSupportsHDR), :396-405 (CalculateColorGamut)

**Mechanism.**

Screen::colorDepth (and pixelDepth, which delegates to it) returns cfg->screen.color_depth, but `(color: N)`, `(dynamic-range: …)` and `(color-gamut: …)` resolve through MediaValues, which reads screen_info.depth_per_component / display_color_spaces straight from the host. Chromium sets those two in lockstep and says so out loud: ui/display/win/screen_win.cc:314-318 — `if (color_spaces.SupportsHDR()) { display.set_color_depth(kHDR10BitsPerPixel /*30*/); display.set_depth_per_component(kHDR10BitsPerComponent /*10*/); }` with the comment "These are (ab)used by pages via media query APIs to detect HDR support"; otherwise 24 / 8. So in honest Chrome colorDepth==30 ⟺ (color:10) and colorDepth==24 ⟺ (color:8), with no exceptions. Lobium breaks the biconditional in both directions. The pool-derived path guarantees the break for a whole persona class: packages/fingerprint/src/derive.ts:126 sets `colorDepth = deviceArch === 'arm64' ? 30 : 24`, so every Apple-Silicon macOS persona reports 30 while a normal SDR Windows host answers `(color: 8)` — 100% of the time, on the shipping target. The reverse fires for any 24-bit persona on an HDR-enabled Windows host. The host-calibrated path (packages/fingerprint/src/host-calibration.ts:50, normalizeColorDepth preserves 30) is coherent, so this is confined to pool-derived personas — but those are exactly the cross-OS personas the product exists to offer. Note also that Screen::colorDepth's guard `color_depth > 0` is always true (the struct default is 24, lobium_fp_config.h:57), so a config with no screen block still pins colorDepth to 24 on a 30-bit host.

**How a detector sees it.**

```
const cd = screen.colorDepth; const bits = [8,10,12].filter(n => matchMedia(`(color: ${n})`).matches)[0]; const spoofed = (cd === 30) !== (bits === 10);  // real Chrome: never true. Add matchMedia('(dynamic-range: high)').matches and matchMedia('(color-gamut: p3)').matches as corroborating host leaks.
```

**Fix.**

Hook MediaValues::CalculateColorBitsPerComponent to return cfg->screen.color_depth / 3 (8 for 24, 10 for 30) whenever color_depth > 0, mirroring screen_win.cc's pairing; hook CalculateDeviceSupportsHDR and CalculateColorGamut off the same persona field (30 ⇒ HDR/p3, 24 ⇒ standard/srgb). Cheapest interim mitigation: forbid the pool path from emitting colorDepth 30 unless the host also reports 30.

**Skeptic.**

Verified end to end. Screen::colorDepth is hooked (screen.cc:113-117 in the checkout, screen-dpr.patch:117-128) and pixelDepth delegates to it (screen.cc:123-125). MediaValues::CalculateColorBitsPerComponent (media_values.cc:219-228), CalculateDeviceSupportsHDR (:210-217) and CalculateColorGamut (:396-405) are all unhooked and read the host ScreenInfo/display_color_spaces. The lockstep pairing is confirmed on both platforms Chromium ships desktop on: ui/display/win/screen_win.cc:314-318 sets 30/10 iff SupportsHDR and :325-328 sets kDefaultBitsPerComponent (8) otherwise, with the literal comment 'These are (ab)used by pages via media query APIs to detect HDR support'; ui/display/mac/screen_mac.mm:176-180 does the identical pairing. Display::kDefaultBitsPerPixel = 24 / kHDR10BitsPerPixel = 30 (display.h:273-279), so colorDepth==30 <=> (color:10) with no exception. `(color: N)` is an exact-equality test — media_query_evaluator.cc:334-345 CompareValue(bits_per_component, N, kEq) — so the finder's detection script works verbatim. derive.ts:126 `deviceArch === 'arm64' ? 30 : 24` is confirmed, and the scoping argument is right: start-profile.ts:266-277 refuses host calibration when hostCalibration.os != params.os, so every cross-OS (macOS-on-Windows) persona necessarily takes the pool path. Two sharpenings the finder missed: derive.ts:123-125 justifies 30 by 'wide-gamut (P3) displays', but in Chromium 30 means HDR support, not P3 — an SDR P3 MacBook Air reports 24/8, so the blanket arm64=>30 is a realism miss even against a real Mac; and `(color-gamut: p3)` / `(dynamic-range: high)` give two further corroborating host leaks on the same persona. Severity high stands. The ReadScreen default note is also right (lobium_fp_config.h:57 `int color_depth = 24`, .cc:81 value_or(24)).

#### `widevine-disabled-chrome-brand-mismatch` — enable_widevine defaults to false in this build, so a persona that claims the "Google Chrome" brand cannot do Widevine EME

*Surfaces with no coverage at all* · **UNVERIFIED**

**Where.** `lobium/gn-args-windows.gn` — 33-37 (the "---- Media ----" block sets proprietary_codecs/ffmpeg_branding but not enable_widevine; no `is_chrome_branded`)

**Mechanism.**

E:\lobium-build\src\third_party\widevine\cdm\widevine.gni declares `enable_widevine = ((is_chrome_branded || is_chrome_for_testing_branded) && !is_fuchsia) || is_android`. gn-args-windows.gn sets neither branding arg (build.ps1:200-208 passes that file verbatim as the only `--args`), so `enable_widevine=false`, hence `enable_library_widevine_cdm=false` and `bundle_widevine_cdm=false`. Meanwhile config-channel.patch builds the Sec-CH-UA brand list from the persona and the preamble explicitly notes "the persona brand list already includes 'Google Chrome', so this also removes the unbranded-Chromium tell natively." The UA and UA-CH say Google Chrome; the binary behaves like unbranded Chromium. This is the single sharpest remaining Chrome-vs-Chromium discriminator, and it is invisible to every existing surface probe in ci/validation (grep for `requestMediaKeySystemAccess` there returns 0).

**How a detector sees it.**

```
```js
navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
  initDataTypes:['cenc'],
  videoCapabilities:[{contentType:'video/mp4;codecs="avc1.42E01E"'}]
}]).then(()=>'chrome', ()=>'NOT chrome');
```
Real Chrome for Windows resolves; this build rejects with NotSupportedError. Same signal via `navigator.mediaCapabilities.decodingInfo({type:'media-source', video:{...}, keySystemConfiguration:{keySystem:'com.widevine.alpha'}})`. DRM-capability probing is used by DataDome, Kasada and several streaming-adjacent bot vendors precisely because it is expensive to fake and trivially cheap to read.
```

**Fix.**

Set `enable_widevine = true` in gn-args-windows.gn and ship the Widevine CDM alongside the binary (or leave `enable_widevine_cdm_component = true` so the component updater fetches it), consistent with the file's own stated design principle that "the build config itself is part of the fingerprint." Note the Widevine LICENSE terms apply. Add a `requestMediaKeySystemAccess` assertion to ci/validation/detector-matrix.mjs so this cannot silently regress.

#### `dolby-vision-is-win-codec-tell` — Dolby Vision codec support is compiled in only on Windows builds — one canPlayType call unmasks any macOS or Linux persona

*Surfaces with no coverage at all* · **UNVERIFIED**

**Where.** `lobium/gn-args-windows.gn (media block); hooked Chromium behaviour in media/base/mime_util_internal.cc` — gn-args-windows.gn:36-37 (`proprietary_codecs = true`); mime_util_internal.cc:361-364 and 640-644

**Mechanism.**

media/media_options.gni declares `enable_platform_dolby_vision = proprietary_codecs && (is_cast_media_device || is_win)`. This build sets `proprietary_codecs = true` on a Windows target, so the flag is TRUE. In media/base/mime_util_internal.cc, lines 361-364 register `DOLBY_VISION` into `mp4_video_codecs`/`mkv_video_codecs` only under `#if BUILDFLAG(ENABLE_PLATFORM_DOLBY_VISION)`, and `IsCodecSupported` at 640-644 returns `true` under the same guard, `false` otherwise. On real Chrome for macOS or Linux both are false (`is_win` is false and `is_cast_media_device` is false). No Lobium patch touches media/ at all. So this Windows engine advertises a codec family that the claimed OS's Chrome does not have. (Cross-check: HEVC is NOT a discriminator here — `enable_platform_hevc` is on for mac/win/linux alike — and AC3/EAC3/DTS are off everywhere, so Dolby Vision is the clean one-bit tell.)

**How a detector sees it.**

```
```js
const v = document.createElement('video');
const dv = v.canPlayType('video/mp4; codecs="dvh1.05.06"');
// this build (Windows): "probably"/"maybe"   real macOS or Linux Chrome: ""
const mse = MediaSource.isTypeSupported('video/mp4; codecs="dvh1.05.06"'); // same split
```
Any persona whose UA/UA-CH platform is macOS or Linux is contradicted immediately, with no permission and no user gesture. Codec-support vectors are a standard part of CreepJS's and FingerprintJS's media section and are cheap for any detector to add.
```

**Fix.**

Two options. (a) Make the codec set persona-driven: hook `MimeUtil::IsCodecSupported` / the codec-registration block in media/base/mime_util_internal.cc on `LobiumFpConfig::Current()->os` so Dolby Vision (and any future is_win-only codec) is reported absent for non-Windows personas. (b) Restrict the persona catalog so Windows hosts only ever generate Windows personas — but packages/fingerprint ships ~200 macOS and ~1.6k Linux presets, so (a) is the real answer. Either way add a codec-matrix assertion to ci/validation/detector-matrix.mjs keyed on persona OS.

#### `speechsynthesis-host-sapi-voices` — speechSynthesis.getVoices() enumerates the host's real SAPI/OneCore voices — a hard Windows tell plus per-machine language-pack entropy

*Surfaces with no coverage at all* · **UNVERIFIED**

**Where.** `no Lobium coverage; hooked Chromium file would be content/browser/speech/tts_win.cc` — tts_win.cc:450 (`TtsPlatformImplBackgroundWorker::GetVoices`) and :622 (`TtsPlatformImplWin::GetVoices`)

**Mechanism.**

Grepping lobium/patches and lobium/src for `speechSynthesis`/`SpeechSynthesis` returns zero hits, and no patch touches modules/speech or content/browser/speech. On Windows, `TtsPlatformImplWin::GetVoices` walks the SAPI and OneCore voice-token categories (`HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech_OneCore\Voices`, declared at the top of tts_win.cc) via `GetVoiceTokens`, reading the `Attributes\Language` value per token. Blink surfaces the result verbatim through SpeechSynthesisVoice.name/voiceURI/lang. The Windows names are self-identifying strings — "Microsoft David Desktop - English (United States)", "Microsoft Zira Desktop", "Microsoft Hazel" — nothing like the macOS set ("Alex", "Samantha", "Daniel") produced by tts_mac.mm or the Linux speech-dispatcher set from tts_linux.cc. Beyond the OS bit, WHICH voices are installed depends on the host's Windows language packs, so the list is also a strong per-machine, cross-profile linkage key.

**How a detector sees it.**

```
```js
speechSynthesis.onvoiceschanged = () => {
  const v = speechSynthesis.getVoices();
  const os = v.some(x=>/^Microsoft /.test(x.name)) ? 'windows'
           : v.some(x=>/^(Alex|Samantha|Daniel|Karen)$/.test(x.name)) ? 'macos' : '?';
  const linkKey = v.map(x=>x.voiceURI+'|'+x.lang).sort().join(',');
};
speechSynthesis.getVoices(); // kick the async load
```
CreepJS reads the voice list explicitly (it is one of its named lie-detection surfaces) and hashes it; BrowserScan and Iphey display it. Note the list also contradicts the persona's `navigator.languages`: a fr-FR persona on an en-US Windows host shows only English voices.
```

**Fix.**

Hook `TtsPlatformImplWin::GetVoices` (tts_win.cc:622) — or, platform-independently, `TtsControllerImpl::GetVoices` in content/browser/speech/tts_controller_impl.cc — to return a persona-derived voice table (name/lang/voiceURI/remote/default) keyed off `LobiumFpConfig::Current()->os` and `locale`, when a config is present. The table has to be in the config schema (packages/shared-types/src/fingerprint.ts has no field for it today) and derived coherently with the persona's OS + languages. Add a getVoices probe to ci/validation/lobium-detect.mjs.

#### `storage-estimate-real-disk` — navigator.storage.estimate().quota is a deterministic function of the host's real disk size — identical across every profile on the machine

*Surfaces with no coverage at all* · **UNVERIFIED**

**Where.** `no Lobium coverage; hooked Chromium files are third_party/blink/renderer/modules/quota/storage_manager.cc and storage/browser/quota/quota_settings.cc` — storage_manager.cc:151 (`StorageManager::estimate`); quota_settings.cc `CalculateNominalDynamicSettings` (pool_size / per_storage_key_quota block)

**Mechanism.**

No patch touches modules/quota; grepping lobium/ for `StorageManager`/`storage_manager` returns zero. `StorageManager::estimate` resolves a StorageEstimate straight from the browser QuotaManager. In storage/browser/quota/quota_settings.cc, `CalculateNominalDynamicSettings` computes `total = device_info_helper->AmountOfTotalDiskSpace(partition_path)`, then `pool_size = min(kPoolSizeBytes, total * kPoolSizeRatio)` and `per_storage_key_quota = pool_size * 0.75` (kDefaultPerStorageKeyRatio). Randomization (`base::RandomizeByPercentage`, kRandomizedPercentage=10) is applied ONLY to `session_only_per_storage_key_quota`, not to the normal quota — so the reported number is fully deterministic given the volume size. Two consequences: (1) it discloses the real physical disk capacity of the host, which no persona field models; (2) because every Lobium profile lives on the same volume, EVERY profile reports the identical quota, making it a free cross-profile join key — the exact linkage the product is supposed to prevent.

**How a detector sees it.**

```
```js
const {quota, usage} = await navigator.storage.estimate();
// quota is stable per-machine and back-solves the disk: total ≈ quota / 0.75 / kPoolSizeRatio
// Same value observed under two different personas ⇒ same physical host.
```
Zero permission, one await. FingerprintJS Pro and several fraud vendors already ship a `storageQuota` signal; it is one of the more reliable device-level (as opposed to browser-level) identifiers available to JS.
```

**Fix.**

Hook `QueryStorageUsageAndQuotaCallback` in third_party/blink/renderer/modules/quota/storage_manager.cc (the point where `estimate->setQuota(quota_in_bytes)` is called) to report a persona-derived quota when `LobiumFpConfig::Current()` supplies one — derive it from a per-profile synthetic disk size seeded off the profile seed, so the value is stable per profile and DIFFERENT across profiles. Add a `storage.quota` field to the config schema (packages/shared-types/src/fingerprint.ts) and a distinct-per-profile assertion to the fleet battle test.

#### `mobile-persona-cdp-overlay-and-outer-geometry` — Mobile personas are driven by a permanently attached CDP device-emulation overlay, and window.outerWidth stays at desktop size while screen.width claims a phone

*Surfaces with no coverage at all* · **UNVERIFIED** · previously documented as a known limitation

**Where.** `packages/engine-runner/src/mobile-emulation.ts; packages/engine-runner/src/runners/lobium-launcher.ts` — mobile-emulation.ts:50-63 (`Emulation.setDeviceMetricsOverride`, mobile:true), :180-184 (`Target.setAutoAttach` browser-wide, waitForDebuggerOnStart), :121 (`Runtime.runIfWaitingForDebugger`); lobium-launcher.ts:338 (`--start-maximized` for device-frame profiles)

**Mechanism.**

This directly contradicts the stated product principle that no surface is spoofed via a CDP overlay. For any `isMobileProfile`, `installMobileEmulationForAllTargets` opens a browser-level WebSocket, sets `Target.setAutoAttach {autoAttach:true, waitForDebuggerOnStart:true, flatten:true}`, and holds it open for the browser's whole lifetime, applying `Emulation.setTouchEmulationEnabled`, `setEmitTouchEventsForMouse`, `setDeviceMetricsOverride{mobile:true}` and `setScrollbarsHidden` to every page target. Two separate problems. (1) Every tab runs with a debugger session attached and each new target is paused then resumed via `Runtime.runIfWaitingForDebugger` — a state real Chrome for Android is never in, and one that changes observable startup timing on every navigation and popup. (2) Device metrics override does NOT alter `window.outerWidth`/`outerHeight`/`screenX`/`screenY`, and those are unhooked in Blink (confirmed: no patch mentions them; screen-dpr.patch:45 defers the clamp). Because mobile profiles also pass `--start-maximized` (lobium-launcher.ts:338) to host the device frame, `outerWidth` is the host desktop width (e.g. 1920) while `screen.width` is the persona's 412 — i.e. the window is reported as ~4.7x wider than the entire screen it is on, which is physically impossible.

**How a detector sees it.**

```
```js
// impossible geometry — one line, no permission
const busted = window.outerWidth > screen.width || window.outerHeight > screen.height;
// classic emulation heuristic Sannysoft/CreepJS already run:
const chromeGap = window.outerWidth - window.innerWidth; // ~1500 here; ~0 on real Android
// plus: screenX/screenY report a desktop window position on a claimed phone
```
Any one of these flags the profile as desktop-Chrome-pretending-to-be-mobile before a single fingerprint hash is computed.
```

**Fix.**

Move mobile emulation native, the same way screen-dpr.patch replaced `setDeviceMetricsOverride` for desktop: drive touch points, primary pointer/hover media features and the mobile viewport from `LobiumFpConfig::Current()->navigator.ua_mobile` inside Blink, and drop the persistent CDP session entirely. Independently, add the deferred native clamp of `LocalDOMWindow::outerWidth/outerHeight/screenX/screenY` to the persona rect — that one is required for desktop personas too whenever the host display is larger than the claimed screen.

#### `supported-extensions-alphabetically-sorted` — The persona extension list is alphabetised by the sidecar, but real Chrome returns registration order in which EXT_sRGB follows the EXT_texture_* block — a sorted list is a fingerprint of the spoof itself

*WebGL 1 and WebGL 2* · **CONFIRMED**

**Where.** `packages/engine-runner/src/host-calibration-probe.ts (sort) + lobium/patches/fingerprint/host-gpu-profile.patch and webgl-runtime-safety.patch (order-preserving replay)` — host-calibration-probe.ts:46-50 (`uniqSorted` -> `.sort((a,b)=>a.localeCompare(b))`) and :87 (`normalized.extensions = uniqSorted(webgl.extensions)`); replayed verbatim by host-gpu-profile.patch:110-119 and webgl-runtime-safety.patch:157 ('Preserve configured ordering')

**Mechanism.**

getSupportedExtensions() in stock Chrome iterates `extensions_` in RegisterExtension() order (webgl_rendering_context_base.cc:~4665), which is fixed per build. In webgl_rendering_context.cc:104-144 the registrations are ordered by C++ CLASS name, not by extension-name string, and that produces exactly one inversion relative to a lexicographic sort: EXTsRGB is registered at :120, after EXTTextureCompressionBPTC (:116), EXTTextureCompressionRGTC (:117), EXTTextureFilterAnisotropic (:118) and EXTTextureMirrorClampToEdge (:119) — verified name string 'EXT_sRGB' at ext_srgb.cc:25-27. So real Chrome WebGL1 always emits ...EXT_texture_mirror_clamp_to_edge, EXT_sRGB, KHR_parallel_shader_compile..., whereas localeCompare puts EXT_sRGB before the EXT_texture_* block. Lobium replays the sorted config order, so the returned array is a strict locale-sorted permutation of itself — something no real Chrome build produces when EXT_sRGB is present. The project's own validation is structurally blind to this: ci/validation/fixtures/fp-probe.html:57 does `(gl.getSupportedExtensions()||[]).slice().sort()` before recording, and packages/shared-types/src/fingerprint.ts:106 even documents the opposite of what the code does ('Order is kept stable').

**How a detector sees it.**

```
const e=document.createElement('canvas').getContext('webgl').getSupportedExtensions(); const tampered = e.indexOf('EXT_sRGB')>=0 && e.indexOf('EXT_sRGB') < e.indexOf('EXT_texture_filter_anisotropic'); // Lobium true, every real Chrome false. Weaker generic form: JSON.stringify(e)===JSON.stringify(e.slice().sort((a,b)=>a.localeCompare(b))).
```

**Fix.**

Stop sorting: in host-calibration-probe.ts use an order-preserving dedupe (`[...new Set(values.map(v=>v.trim()).filter(Boolean))]`) for webgl.extensions specifically — keep uniqSorted for fonts/warnings where order is not observable. Then add a CI assertion that the emitted list is NOT its own locale-sorted permutation, and stop pre-sorting in fp-probe.html:57 so the gate can see order regressions.

**Skeptic.**

Verified in both directions. Sidecar side: host-calibration-probe.ts:46-50 defines uniqSorted with `.sort((a,b)=>a.localeCompare(b))` and :87 applies it to webgl.extensions; host-calibration.ts:75 (cloneHostWebgl) and lobium-config.ts:202 (`webgl: fp.webgl`) pass it through verbatim; the applied hook at webgl_rendering_context_base.cc:4726-4741 iterates the config in order and pushes tracker->ExtensionName(), so the emitted array is exactly the sorted config order. Chromium side: getSupportedExtensions iterates `extensions_` in RegisterExtension order (unpatched form still visible at :4743-4751), and webgl_rendering_context.cc:103-145 registers by C++ class name. I walked the entire WebGL1 registration list against a locale sort and found exactly ONE inversion, the one the finder names: EXTsRGB is registered at :120, after EXTTextureCompressionBPTC (:116), EXTTextureCompressionRGTC (:117), EXTTextureFilterAnisotropic (:118) and EXTTextureMirrorClampToEdge (:119), and its name string is 'EXT_sRGB' (ext_srgb.cc:25-27) which sorts before 'EXT_texture_*' under both localeCompare and code-unit order. Every other adjacent pair in the list is already in sorted order, so `e.indexOf('EXT_sRGB') < e.indexOf('EXT_texture_filter_anisotropic')` is a clean, zero-false-positive discriminator. One caveat the finder did not state: the probe depends on EXT_sRGB being present in the capture — it is gated on GL_EXT_sRGB (ext_srgb.cc:20-23; ANGLE sets Extensions::sRGBEXT from DetermineSRGBTextureSupport, Caps.cpp:803, true on D3D11/Metal), so present in practice, but on a host lacking it the real Chrome list IS its own locale sort and the weaker generic form of the probe false-positives. The CI blindness is also real: fp-probe.html:57 does `.slice().sort()` before recording, and shared-types/fingerprint.ts documents 'Order is kept stable', which the sidecar violates.

#### `unfarbled-webgl-readback-routes` — User-FBO readPixels, WebGL2 PIXEL_PACK_BUFFER + getBufferSubData, and drawImage-into-2D all bypass or mis-key the WebGL pixel farble

*WebGL 1 and WebGL 2* · **PARTLY_TRUE** · previously documented as a known limitation

**Where.** `lobium/patches/core/config-channel.patch (readPixels + canvas hooks); third_party/blink/renderer/modules/webgl/webgl2_rendering_context_base.cc` — config-channel.patch:1104-1106 (`framebuffer == nullptr` guard) and :549-561 (Snapshot deliberately left unfarbled); webgl2_rendering_context_base.cc:874-925 (PIXEL_PACK_BUFFER readPixels writes straight to ContextGL()->ReadPixels at :922 with no Lobium code path)

**Mechanism.**

The farble is applied only to the DEFAULT framebuffer, RGBA/UNSIGNED_BYTE, default pack state. Three routes read the same pixels unfarbled: (a) render the fingerprint scene into a user framebuffer (renderbuffer or texture attachment) and readPixels from it — `framebuffer != nullptr` skips the hook entirely; (b) WebGL2 `bindBuffer(PIXEL_PACK_BUFFER,b); readPixels(...,offset); getBufferSubData(...)` — that overload never calls ReadPixelsHelper, so no Lobium code runs at all; (c) `ctx2d.drawImage(glCanvas,0,0)` or `createImageBitmap(glCanvas)` -> getImageData, which sources HTMLCanvasElement::Snapshot() (deliberately unfarbled per config-channel.patch:556-559) and then applies seeds.CANVAS instead of seeds.WEBGL. Routes (a) and (b) recover the true GPU pixel hash, destroying unlinkability; route (c) is a cross-surface incoherence — for opaque sRGB content real Chrome returns identical RGB from readPixels and from drawImage+getImageData, whereas Lobium returns webgl-seed noise on one and canvas-seed noise on the other. captureStream()/new VideoFrame(glCanvas) are further unfarbled exits from the same Snapshot(). The patch preamble acknowledges only 'User-FBO reads and non-RGBA8 / non-default-pack layouts are left untouched'; the PIXEL_PACK_BUFFER path and the drawImage seed mismatch are not mentioned.

**How a detector sees it.**

```
(a)/(b) self-comparison, no baseline needed: draw the same scene twice, once to the default FB and once to a user FBO of the same size, readPixels both — honest Chrome gives identical bytes, Lobium differs. WebGL2 variant: const b=g.createBuffer(); g.bindBuffer(g.PIXEL_PACK_BUFFER,b); g.bufferData(g.PIXEL_PACK_BUFFER,w*h*4,g.STREAM_READ); g.readPixels(0,0,w,h,g.RGBA,g.UNSIGNED_BYTE,0); g.getBufferSubData(g.PIXEL_PACK_BUFFER,0,out); // out is unfarbled, compare against the ArrayBufferView overload. (c) c2d.drawImage(glCanvas,0,0); c2d.getImageData(px,py,4,4) vs g.readPixels(px, H-1-py-3, 4,4,...) — honest Chrome agrees on opaque content, Lobium disagrees.
```

**Fix.**

Extend the hook to every readback that can reach JS: farble user-FBO reads whose attachment is the drawing buffer or a same-size colour target; intercept the PIXEL_PACK_BUFFER path (farble at getBufferSubData time, keyed on the recorded read rect); and make the WebGL-canvas snapshot consumed by drawImage/createImageBitmap/captureStream carry seeds.webgl rather than letting the destination 2D canvas re-key it with seeds.canvas. Where a route genuinely cannot be keyed coherently, prefer refusing/degrading it over returning pristine pixels.

**Skeptic.**

Routes (a) and (b) confirmed; route (c) is overstated. (a) The applied guard at webgl_rendering_context_base.cc:5581-5583 requires `framebuffer == nullptr`, where `framebuffer` is GetReadFramebufferBinding() (:5528), so any user-FBO read is pristine — acknowledged in the preamble at :5579-5580, so alreadyDocumented:true is right for this half. (b) Genuinely undocumented and genuinely fatal: WebGL2RenderingContextBase::readPixels(x,y,w,h,format,type,offset) at webgl2_rendering_context_base.cc:874-925 goes straight to ContextGL()->ReadPixels at :922 and never touches ReadPixelsHelper, so `bindBuffer(PIXEL_PACK_BUFFER,b); readPixels(...,0); getBufferSubData(...)` returns the true GPU bytes with no Lobium code executing at all. Combined with finding 3 that is three independent pristine exits, any one of which restores cross-profile linkability. (c) is the weak part and should not carry the same weight: HTMLCanvasElement::Snapshot is indeed left unfarbled by design (config-channel.patch:556-559) and the destination 2D canvas re-keys with seeds.canvas via getImageData, so the incoherence exists — but the claim 'honest Chrome agrees' on readPixels vs drawImage+getImageData is only approximately true. The default drawing buffer is premultiplied while getImageData is unpremultiplied, LobiumFarbleReadback/getImageData round-trip through kUnpremul_SkAlphaType with an sRGB color space, and drawImage may resample; the equality only holds for fully opaque, 1:1, same-color-space content. A detector building on (c) has to control all of that, whereas (a) and (b) are self-comparisons that need no baseline. Severity high is right, but it is carried by (a)+(b), not (c).

### MEDIUM (31)

#### `device-frame-dead-patch-in-series` — branding/device-frame.patch is in the series, cannot compile on any platform, and is inert on Windows - 16 hunks of rebase surface in four of Chromium's churniest UI files for zero shipped behaviour

*Engine architecture, build hygiene, patch series* · **UNVERIFIED**

**Where.** `lobium/patches/branding/device-frame.patch` — patch line 427 (`+  if (content::SetLobiumDeviceEmulationScale(web_contents.get(), scale)) {`); `new file mode 100644` sections for chrome/browser/ui/views/frame/lobium_device_frame_view.cc (406 lines) and .h (87 lines)

**Mechanism.**

Three independent defects stack. (1) The patch creates lobium_device_frame_view.cc/.h but touches no GN file; Chromium lists sources explicitly (verified: chrome/browser/ui/BUILD.gn:3916 lists "views/frame/browser_view.cc"), and no patch in the series touches chrome/browser/ui/BUILD.gn, so the file is never compiled. (2) The .cc calls `content::SetLobiumDeviceEmulationScale()`, which I grepped for across both the entire patch series and the whole 152.0.7977.42 checkout - it exists nowhere, so even if the file were compiled it would not link. (3) Every call site in browser_view.cc / browser_view.h / browser_view_layout.h / browser_view_tabbed_layout_impl.cc is wrapped in `#if BUILDFLAG(IS_LINUX)`, so on the WINDOWS ship target the whole feature is compiled out and the patch changes nothing at all. Net effect: 32 KB / 16 hunks permanently applied to browser_view.cc (6 hunks), browser_view.h, browser_view_layout.h and browser_view_tabbed_layout_impl.cc - among the highest-churn files in the Chromium UI layer - purchasing nothing on the shipping platform and an unbuildable feature on Linux. This is exactly the rebase cost the series header says the added-file strategy exists to avoid. It is now documented in lobium/patches/series lines 28-32, which is honest, but a patch documented as broken and inert should not be in `series`.

**How a detector sees it.**

```
`gn refs out/Lobium chrome/browser/ui/views/frame/lobium_device_frame_view.cc` returns nothing after the series applies. On Linux, `autoninja -C out/Lobium chrome` fails at link with undefined references to LobiumDeviceFrameView::IsEnabled/ctor/GetDeviceScreenBounds/ZoomIn/ZoomOut/ResetZoom and to content::SetLobiumDeviceEmulationScale. On Windows the build succeeds and the feature is absent.
```

**Fix.**

Move device-frame.patch out of `series` into the same 'present on disk but deliberately not in the series' bucket that already holds suppress-sandbox-infobar.patch (series:121-122), and add it to the NOT_IN_SERIES map in ci/validation/patch-series.test.mjs:28 with the reason. When it is revived: add the two sources to chrome/browser/ui/BUILD.gn in the same patch, land content::SetLobiumDeviceEmulationScale (a content/public/browser header plus its impl) as part of it, and drop the IS_LINUX guards or replace them with a proper buildflag - a feature gated to a platform the product does not ship is dead code by definition.

#### `google-api-keys-startup-infobar` — Every launch shows Chromium's "Google API keys are missing" infobar; the one infobar patch that exists suppresses a different one and is not in the series

*Engine architecture, build hygiene, patch series* · **UNVERIFIED**

**Where.** `lobium/gn-args-windows.gn` — whole file - no google_api_key / use_official_google_api_keys / infobar suppression anywhere; the trigger is E:/lobium-build/src/chrome/browser/ui/startup/infobar_utils.cc:188

**Mechanism.**

infobar_utils.cc:188 is `if (!google_apis::HasAPIKeyConfigured()) { GoogleApiKeysInfoBarDelegate::Create(infobar_manager); }`, run on the first tab of every browser startup. Neither gn-args file defines google_api_key/google_default_client_id/google_default_client_secret, and google_apis/BUILD.gn:34-48 resolves use_official_google_api_keys from the absent internal checkout, so HasAPIKeyConfigured() is false and the yellow bar appears on every launch of every profile. The series does contain branding/suppress-sandbox-infobar.patch, but that hooks a completely different entry point (chrome/browser/ui/startup/bad_flags_prompt.cc ShowBadFlagsPrompt) and, per series:121-122, is deliberately excluded from the series anyway. So an anti-detect browser whose whole premise is being indistinguishable from Chrome greets the operator - and any screenshot-based or human review of a session - with a banner that says "Some functionality of Chromium will be disabled", naming Chromium.

**How a detector sees it.**

```
Launch the built chrome.exe with a fresh --user-data-dir and observe the infobar on the first tab; chrome://version also renders the missing-keys warning. Not script-observable from the page, but trivially visible in any headful screenshot and in the ci/validation/realsite-shot.mjs / visual-battle.mjs output.
```

**Fix.**

Two parts. (a) Provide real API keys via gn args (google_api_key / google_default_client_id / google_default_client_secret) if the product wants Safe Browsing, translate and network geolocation to behave like Chrome; those subsystems are silently degraded today and their absence is itself a behavioural difference. (b) Regardless of (a), suppress the infobar in a patch: guard the infobar_utils.cc:188 call the same way suppress-sandbox-infobar.patch guards ShowBadFlagsPrompt, and put BOTH suppressions in one `branding/suppress-startup-infobars.patch` that IS in the series - the current split (one patch, wrong infobar, out of series) means neither is actually suppressed in a shipped build.

#### `buildps1-chromium-ref-ungated` — lobium/build.ps1 hardcodes a second copy of the Chromium pin that neither the bump script nor the coherence gate touches, and its comment claims the opposite

*Engine architecture, build hygiene, patch series* · **UNVERIFIED**

**Where.** `lobium/build.ps1` — 43-48 (`$ChromiumRef = '152.0.7977.42'` and the comment above it)

**Mechanism.**

The comment reads "Kept in lockstep with build.sh CHROMIUM_REF and with ENGINE_CHROME in packages/fingerprint/src/pools.ts; ci/validation/version-coherence.test.mjs fails the build if the three ever disagree." That is false in both directions. I grepped both files: scripts/bump-engine-version.mjs rewrites only `lobium/build.sh` (const BUILD_SH = 'lobium/build.sh' at line 45; the regex at 246 targets CHROMIUM_REF) and ENGINE_CHROME in pools.ts; ci/validation/version-coherence.test.mjs reads exactly three sources - lobium/build.sh (line 28), packages/fingerprint/src/pools.ts (line 30) and engine-manifest.json (line 37) - and never mentions build.ps1. So the moment `rebase.sh <newref> --run` or `bump-engine-version.mjs` runs, build.sh and the personas advance and build.ps1 does not; the coherence gate stays green; and the Windows build then dies at build.ps1:125 with "Checkout is at tag 'X' but this script pins '152.0.7977.42'". Since Windows is the ship target, the one build path that matters is the one outside the guard rail.

**How a detector sees it.**

```
`node scripts/bump-engine-version.mjs 153.0.8000.20` then `node --test ci/validation/version-coherence.test.mjs` -> passes, while `Select-String -Path lobium/build.ps1 -Pattern ChromiumRef` still shows 152.0.7977.42, and `powershell -File lobium/build.ps1` dies in preflight.
```

**Fix.**

Delete the second copy. Have build.ps1 parse the pin out of lobium/build.sh (a one-line regex, the same one bump-engine-version.mjs uses) so there is exactly one source of truth, or - cleaner - move the pin into a shared `lobium/CHROMIUM_REF` text file that build.sh, build.ps1, bump-engine-version.mjs and version-coherence.test.mjs all read. Either way, add build.ps1 (or the new file) to the assertion set in version-coherence.test.mjs so the gate actually covers what the comment claims.

#### `lobium-src-not-clang-formatted` — The shipped //components/lobium_fp module is not clang-formatted: 20 non-ASCII lines and 220 lines over Chromium's 80-column limit, and the new patch-series test checks patches but not lobium/src/

*Engine architecture, build hygiene, patch series* · **UNVERIFIED**

**Where.** `lobium/src/lobium_fp_config.h` — lobium_fp_config.h 5 non-ASCII / 32 >80col of 184 lines; lobium_fp_config.cc 4 / 52 of 268; lobium_audio_farble.h 6 / 23 of 44; lobium_audio_farble.cc 3 / 13 of 52; lobium_farble.h 0 / 45 of 118; lobium_farble.cc 0 / 49 of 254; BUILD.gn 1 / 6; OWNERS 1

**Mechanism.**

Chromium's .clang-format is `BasedOnStyle: Chromium` (ColumnLimit 80) with `InsertBraces: true`, and PRESUBMIT.py:7051/7076 run canned_checks.CheckPatchFormatted. 220 of roughly 815 lines in lobium/src exceed 80 columns and 20 lines carry non-ASCII (U+2014 em-dash, U+2192 arrow) - including BUILD.gn line 3 and OWNERS. The config reader also uses brace-less single-line `if (const std::string* s = ...) nav.x = *s;` throughout, which InsertBraces would rewrite. A commendable new gate, ci/validation/patch-series.test.mjs, now enforces pure-ASCII added source (lines 194-211) and LF/no-BOM - and it worked: patch-added source went from 74 non-ASCII lines to 0 and the byte-identical-hunk duplication is gone. But the gate reads only lobium/patches/, so lobium/src/ - the code that is actually staged into the Chromium tree and compiled - is unchecked and still dirty. The result is that the ADDED module, the part of the fork with the fewest excuses, is the part most visibly off-house-style.

**How a detector sees it.**

```
`third_party/depot_tools/clang-format --style=file -n lobium/src/*.cc lobium/src/*.h` reports diffs on every file; `Get-Content lobium/src/*.h | Where-Object { $_.Length -gt 80 }` returns 220 lines across the module; a byte scan for [^\x00-\x7F] returns 20 lines. Not web-detectable - this is fork hygiene.
```

**Fix.**

Run `git cl format` (or clang-format --style=file -i) over lobium/src/ once, strip the em-dashes and arrows to ASCII, and then extend ci/validation/patch-series.test.mjs with a third test that applies the SAME two rules (pure ASCII, and no added/source line over 80 columns) to every file in lobium/src/ as well as to patch-added lines. Also add the 80-column rule for patch-added .cc/.h lines - it currently catches non-ASCII but not length, and there are 380 patch-added C++ lines over 80 columns (worst offenders: device-frame 66, canvas-farbling 43, navigator-ua-ch 42, webgl-surfaces 37, audio-context 32, omnibox-profile-chip 29).

#### `no-native-tests-for-kernel` — //components/lobium_fp has no test target, no unit tests, and no DEPS/visibility declaration - the anti-detect kernel is the only untested code in the product

*Engine architecture, build hygiene, patch series* · **UNVERIFIED**

**Where.** `lobium/src/BUILD.gn` — 9-22 (the entire source_set; there is no test source_set, no `visibility`, and no accompanying DEPS or README.chromium)

**Mechanism.**

The BUILD.gn declares one source_set with six sources and `public_deps = ["//base"]` and nothing else. There is no `source_set("unit_tests")`, nothing registers into //components:components_unittests, and I found no .cc test anywhere in the repo for the C++ kernel (the only lobium*test* hits are TypeScript sidecar tests). Yet the kernel contains precisely the logic whose correctness is detection-critical and is pure, dependency-free, and trivially testable: FarbleCanvasRgba's flat-run predicate (the property "a solid fill reads back byte-exact" is a one-line unit test and is the single cheapest canvas-tamper check a detector runs), FarbleCanvasRgbaFlippedRows' Y-flip coherence with the top-down path, FarbleAudioSamples' documented invariant that identical channels stay identical, and ParseConfig's version gating and optional/sentinel semantics (max_touch_points is std::optional precisely because 0 is legal - exactly the kind of thing that regresses silently). Everything is instead validated end-to-end through ci/validation probes that need a built binary and a real GPU, so a kernel regression is caught hours later, if at all. On the smaller points: the module correctly needs no DEPS file (root DEPS allows +base and components/DEPS's `-components` is not violated since it includes nothing from //components), and the `#pragma allow_unsafe_buffers` guarded by UNSAFE_BUFFERS_BUILD is the correct sanctioned opt-out given //components/lobium_fp is not exempted in build/config/unsafe_buffers_paths.txt - both of those check out. The missing piece is tests and a `visibility` list.

**How a detector sees it.**

```
`gn refs out/Lobium //components/lobium_fp` lists only the five consumer targets, no test target; `git grep lobium_fp components/BUILD.gn` in the patched tree is empty; `autoninja -C out/Lobium components_unittests` builds nothing Lobium-related.
```

**Fix.**

Add `source_set("unit_tests") { testonly = true; sources = ["lobium_farble_unittest.cc", "lobium_audio_farble_unittest.cc", "lobium_fp_config_unittest.cc"]; deps = [":lobium_fp", "//base/test:test_support", "//testing/gtest"] }` and a one-line hunk in core/build-gn.patch registering it in //components:components_unittests. Seed it with the invariants the headers already assert in prose: solid-fill readback is bit-exact, sub-rect getImageData and full-canvas toDataURL perturb the same absolute pixel identically, flipped-row and top-down paths agree, identical audio channels remain identical after farbling, seed 0 is a no-op, and ParseConfig rejects version<1 while accepting version>1 with unknown fields. Also add `visibility` to the source_set naming the five permitted consumers, so a future hook cannot quietly take a dependency from an unintended layer.

#### `audio-amplitude-4-orders-too-large` — kAmplitude = 1.5e-3 is ~12,600x float32 epsilon and ~190x wider than the entire honest cross-platform spread of the canonical audio fingerprint

*Web Audio* · **PARTLY_TRUE**

**Where.** `lobium/src/lobium_audio_farble.cc` — 38 (constexpr double kAmplitude = 1.5e-3;)

**Mechanism.**

The kernel applies data[k] *= (1 + eps), eps uniform in [-1.5e-3, +1.5e-3]. Quantified against the real numbers:

(a) float32 has relative epsilon 1.1921e-7. 1.5e-3 / 1.1921e-7 = 12,583 ULP. log2(12583) = 13.6, i.e. the perturbation randomises the bottom ~13.6 of the 24 significand bits of every sample. It is not a rounding-level nudge; it is a wholesale rewrite of the low half of the mantissa.

(b) Genuine honest-Chrome variation for the canonical FingerprintJS graph (OfflineAudioContext(1,5000,44100), triangle osc @10 kHz -> DynamicsCompressor, sum |x[i]| over [4500,5000) - literally the graph this repo's own probe uses at ci/validation/lobium-detect.mjs:100-112) is tiny. The known desktop-Blink population values are 124.04344968475198 and 124.04347527516074: delta 2.559e-5 absolute = 2.06e-7 RELATIVE over a 500-term sum, i.e. roughly one float32 ULP of accumulated per-sample difference. The largest known honest Blink family gap (x86 desktop vs the ~124.0807 ARM/Android cluster) is 3.0e-4 relative - still 5x SMALLER than Lobium's PER-SAMPLE amplitude, and it is a structured libm difference, not white noise. I verified the mechanism that produces that spread: platform/audio/audio_utilities.cc:37-45 uses the host libm powf/log10f (NOT fdlibm) for DecibelsToLinear/LinearToDecibels, and dynamics_compressor.cc calls them per sample - that is the only honest source of cross-OS divergence in this graph. Everything else in Blink audio that I checked is bit-portable (biquad.cc:585 uses fdlibm::cos/sin/atan2).

(c) Lobium's effect on that same sum: for N=500 samples with iid uniform(-A,A) relative perturbation, the relative shift of the sum is ~A/(sqrt(3)*sqrt(N)) = 1.5e-3/(1.732*22.36) = 3.87e-5, i.e. ~4.8e-3 ABSOLUTE on 124.0434. So Lobium reports something like 124.0386..124.0483 - roughly 190x further from the honest cluster than the entire honest x86 spread, and well outside the ARM cluster too. It is not 'a build we have not seen'; it is off the manifold.

The patch preamble's own proof line ('slicesum shifts ~0.003%') is exactly this: 3e-5 relative, when the honest population spread is 2e-7.

**How a detector sees it.**

```
Whitelist/manifold check, which is what CreepJS and commercial stacks already do with audio: render the canonical graph, take the sum, and test distance to the known Chrome value set. `const ctx=new OfflineAudioContext(1,5000,44100); const o=ctx.createOscillator(); o.type='triangle'; o.frequency.value=10000; const c=ctx.createDynamicsCompressor(); o.connect(c); c.connect(ctx.destination); o.start(0); const b=await ctx.startRendering(); let s=0; for(let i=4500;i<5000;i++) s+=Math.abs(b.getChannelData(0)[i]); const off = Math.min(Math.abs(s-124.04344968475198), Math.abs(s-124.04347527516074), Math.abs(s-124.0807))/s;` Honest Chrome: off < 3e-4 (usually < 3e-7). Lobium: off ~ 4e-5 with random sign per profile, and never converging on any cluster member across profiles on the same host.
```

**Fix.**

Drop kAmplitude to 1-4 float32 ULP: A in [1.2e-7, 5e-7]. At A=4e-7 the 500-term sum shifts by ~1.0e-8 relative = ~1.3e-6 absolute, which still yields ~1.8e8 distinguishable double values for the reported sum (>27 bits of per-profile audio entropy - far more than the fingerprint needs) while placing the per-sample deviation squarely inside the honest population's own 2e-7 spread. Better still, quantise the perturbation to whole float32 ULPs (add k ULP, k in {-2..+2}) rather than a continuous relative multiply, so every emitted value is one honest float arithmetic could plausibly have produced. Combine with the value-keying change in canvas-of-this-report finding audio-index-keyed-noise.

**Skeptic.**

The code fact is exactly right: lobium_audio_farble.cc:38 kAmplitude=1.5e-3, and 1.5e-3/FLT_EPSILON(1.1920929e-7) = 12,583 ULP = 13.6 randomised mantissa bits. The claimed mechanism for the honest cross-platform spread is also verified: audio_utilities.cc:37-45 really does use host libm powf/log10f (only DiscreteTimeConstantForSampleRate at :69 uses fdlibm), and dynamics_compressor.cc calls powf twice plus LinearToDecibels/DecibelsToLinear 14 times, so the honest population of the canonical sum genuinely is a small discrete per-OS set. The sum-shift arithmetic (A/(sqrt(3)*sqrt(500)) = 3.87e-5 relative = 4.8e-3 absolute) is correct.

BUT two central claims are wrong.

(1) APPLES-TO-ORANGES. The finding says the honest x86-vs-ARM family gap of 3.0e-4 relative is '5x SMALLER than Lobium's PER-SAMPLE amplitude'. That compares a population statistic against a per-sample amplitude. The like-for-like comparison is Lobium's shift of the same statistic: 3.87e-5 relative, which is ~8x SMALLER than the 3e-4 honest cross-family gap, not larger. Lobium's reported sum lands strictly inside the honest cross-family envelope; it is only outside the intra-cluster spread. 'Off the manifold' is therefore an overstatement — it is off the known POINTS, not outside the known RANGE.

(2) THE PROPOSED DETECTION DOES NOT FIRE. The script computes off = min-distance/s and states 'Honest Chrome: off < 3e-4; Lobium: off ~ 4e-5'. 4e-5 < 3e-4, so Lobium PASSES the finder's own test. A working test needs exact-set membership or a tolerance around 1e-4 absolute — and note that exact-set membership is defeated by ANY non-zero farbling, including the proposed 1-4 ULP fix (at A=4e-7 the sum still shifts by ~1.2e-6 absolute, changing the double). So the fix helps only against a distance-threshold test, not against the whitelist test the finding leads with; the finding does not say this.

Net: a real over-perturbation worth reducing (1.5e-3 is ~190x the honest intra-cluster spread and, per the write-up below, ~1.7% linear distortion in the dB frequency domain), but it is a soft 'unknown build' signal, not a hard tell, and the fix cannot close the exact-value oracle. Medium, not critical.

#### `audio-device-props-unspoofed` — AudioContext.sampleRate / destination.maxChannelCount / baseLatency / outputLatency are pure host-device values with no config field at all - a stable cross-profile host identifier and a persona-coherence hole

*Web Audio* · **CONFIRMED**

**Where.** `lobium/src/lobium_fp_config.h` — 133-141 (FarblingSeeds is the only audio-related config; there is no AudioDeviceConfig anywhere)

**Mechanism.**

I grepped the entire patch series for sampleRate / maxChannelCount / baseLatency / outputLatency / HardwareSampleRate: the only hits are the SPN farble's own use of external_input_buffer_->sampleRate() and the pre-existing AudioWorkletGlobalScope::sampleRate() accessor. Nothing spoofs the realtime AudioContext's device-derived properties, and there is no field for them in lobium_fp_config.h or shared-types. So every Lobium profile on a given host reports the identical tuple (sampleRate, destination.maxChannelCount, baseLatency, outputLatency, getOutputTimestamp() cadence), which is derived from the host's actual default output device / the audio-service fallback sink. This is a plain cross-profile linkage vector that all the per-profile seeding elsewhere is specifically designed to prevent, and it is read by CreepJS, BrowserScan, Pixelscan and Iphey as a matter of course. It is also a coherence problem: baseLatency and maxChannelCount cluster strongly by OS and by device class, so a persona claiming macOS or Android on a Windows Server VM with no real audio hardware presents a combination that does not occur in the wild.

**How a detector sees it.**

```
`const c=new AudioContext(); const sig=[c.sampleRate, c.destination.maxChannelCount, c.baseLatency, c.outputLatency].join('|');` Launch two Lobium profiles with different personas (different claimed OS) on the same host: sig is byte-identical across both, and does not vary with the persona. On honest hardware the tuple correlates with the claimed platform; here it correlates only with the physical host.
```

**Fix.**

Add an audioDevice block to lobium-fp.json (sampleRate, maxChannelCount, baseLatency) derived coherently from the persona's OS/device class in packages/fingerprint, and hook AudioContext's hardware sample rate (RealtimeAudioDestinationHandler / AudioDestination::HardwareSampleRate), AudioDestinationHandler::MaxChannelCount, and AudioContext::baseLatency/outputLatency to read it. Constrain sampleRate to values the persona class actually produces (44100/48000) and derive baseLatency from a plausible callback buffer size for that OS.

**Skeptic.**

The code fact is confirmed: I grepped all of E:\project for sampleRate/maxChannelCount/baseLatency/outputLatency/HardwareSampleRate/audioDevice and the only hits are AudioWorkletGlobalScope::sampleRate() (an untouched upstream accessor quoted as patch context) and the SPN farble's own external_input_buffer_->sampleRate(). lobium_fp_config.h has FarblingSeeds (:133-141) and nothing audio-device-shaped. AudioContext::baseLatency is cached at audio_context.cc:676-681 from GetFramesPerBuffer()/sampleRate() — pure host device. So the tuple is host-derived and persona-invariant, and the coherence complaint is legitimate.

Severity is overstated at high, for two reasons.

(1) outputLatency carries almost no entropy: audio_context.cc:83-89 quantizes it to 8 ms (kOutputLatencyQuatizingFactor = 0.008) unless the page holds microphone permission. Listing it as a distinguishing component of the signature is wrong.

(2) The remaining entropy is a few bits: sampleRate is essentially {44100, 48000}, maxChannelCount is usually 2, baseLatency is a small set of buffer/rate quotients. That is a weak linkage vector compared with everything else Lobium does spoof, and it is not a 'lie' a detector can catch — it is honest host data.

Refinement the finding missed and which raises the practical stakes for the likely deployment target: on a Windows host with no usable output endpoint (VPS/Server VM), AudioManagerWin falls back to 48000 Hz with kFallbackBufferSize = 2048 (audio_manager_win.cc:74, 216-218, 340-341), which surfaces as baseLatency = 0.042666666666666665 — a value that reads as 'no real audio hardware' far more loudly than a persona/OS mismatch does. That specific value, not the generic tuple, is the actual tell.

#### `duplicate-audio-patches-in-series` — Every audio hook exists twice in the quilt series - core/config-channel.patch already contains all of them, so fingerprint/audio-context.patch and fingerprint/audio-worklet-tap.patch are dead and break `quilt push -a`

*Web Audio* · **CONFIRMED**

**Where.** `lobium/patches/series` — 38 (fingerprint/audio-context.patch) and 44 (fingerprint/audio-worklet-tap.patch), applied after core/config-channel.patch at line 27

**Mechanism.**

core/config-channel.patch lines 675-987 already carry byte-identical hunks for audio_worklet_global_scope.h, audio_worklet_processor.cc, offline_audio_context.cc, offline_audio_worklet_thread.cc and script_processor_node.cc, plus a SUPERSET of the realtime_analyser.cc hunks (it adds the byte-path hooks that audio-context.patch lacks). Both later patches are therefore fully redundant. I confirmed this with a read-only dry run against the live checkout: `patch --dry-run -p1 --forward -i fingerprint/audio-context.patch` -> 'Reversed (or previously applied) patch detected! Skipping patch' on both files, 6/6 hunks ignored, exit 1; audio-worklet-tap.patch -> 9/9 hunks ignored across 4 files, exit 1. The Windows helper E:/lobium-build/apply-series.ps1:35 passes --forward so it merely reports two FAILs, but lobium/build.sh:51 - the documented real pipeline - runs `quilt push -a`, which does not pass --forward and aborts the whole series at fingerprint/audio-context.patch. Consequence for a rebase: whoever refreshes fingerprint/audio-context.patch against a new Chromium will be refreshing a patch that has no effect, and the hooks that ARE live sit in a 64 KB catch-all patch, defeating the stated 'one patch per deep surface so one can rebase without disturbing the others' strategy (series:33). Secondary documentation drift: audio-context.patch:36-37 lists 'byte analyser paths' as a KNOWN LIMITATION, but config-channel.patch:876-947 actually farbles them - so the stated limitations no longer describe the shipped binary.

**How a detector sees it.**

```
Not a web-detectable finding - a build/maintenance defect. Reproduce: `patch --dry-run -p1 --forward -i lobium/patches/fingerprint/audio-context.patch` in a tree with config-channel.patch applied.
```

**Fix.**

Pick one home for the audio hooks. Given series:33's stated strategy, strip the five webaudio file diffs out of core/config-channel.patch and fold the byte-analyser hunks into fingerprint/audio-context.patch, then refresh both. Update the audio-context.patch preamble to drop 'byte analyser paths' from the KNOWN LIMITATIONS list. Add a CI step that runs `quilt push -a` (or apply-series.ps1 -Reset) on a clean tree and fails on any non-zero exit, so a redundant patch cannot sit unnoticed in the series.

**Skeptic.**

Confirmed with harder evidence than the finding gives. I compared the patches structurally rather than by dry-run: splitting both files on `diff --git` and comparing section-by-section, all FOUR webaudio sections of fingerprint/audio-worklet-tap.patch (audio_worklet_global_scope.h, audio_worklet_processor.cc, offline_audio_worklet_thread.cc, script_processor_node.cc) are BYTE-IDENTICAL to the corresponding sections of core/config-channel.patch, including the git blob index lines (db95810f7c..73038f832c, 4b35cc4adc..c3b9063a12, bd2958443a..56e11a98af, f797aa6484..f61f726b41). fingerprint/audio-context.patch's offline_audio_context.cc section is likewise byte-identical (aed92e0ec4..7e4f98c9dd), and its realtime_analyser.cc section is a strict subset (d0b1bd6401..b808229cf8 vs config-channel's d0b1bd6401..190bc3a77e, which adds the byte paths).

Independent confirmation from the live tree: E:\lobium-build\src\third_party\blink\renderer\modules\webaudio\ currently contains .rej files for exactly these six files (audio_worklet_global_scope.h.rej, audio_worklet_processor.cc.rej, offline_audio_context.cc.rej, offline_audio_worklet_thread.cc.rej, realtime_analyser.cc.rej, script_processor_node.cc.rej), and offline_audio_context.cc.rej opens with the already-applied lobium include hunk. The series does not apply cleanly today.

build.sh:51 does run `quilt push -a`, and quilt invokes patch with -f (which suppresses the reversed-patch prompt rather than skipping), so the hunks fail and the series stops at fingerprint/audio-context.patch. apply-series.ps1:35 passes --forward --batch, which downgrades this to two FAILs.

The documentation-drift sub-claim also holds: audio-context.patch:36-37 still lists 'byte analyser paths' as a KNOWN LIMITATION while config-channel.patch:876-947 farbles them. Medium is right — build/maintenance, not web-detectable.

#### `canvas-float-imagedata-corruption` — The getImageData hook assumes RGBA8888 and silently corrupts float16/float32 ImageData: it mangles only the left half (F16) or left quarter (F32) of each row, nudges float EXPONENT bytes, and modifies alpha

*Canvas 2D / OffscreenCanvas / ImageBitmap* · **PARTLY_TRUE**

**Where.** `lobium/patches/core/config-channel.patch (getImageData hook -> third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc)` — config-channel.patch:668-671 (applied base_rendering_context_2d.cc:523-526)

**Mechanism.**

The hook passes image_data_pixmap.width()/height()/rowBytes() to FarbleCanvasRgba, which hard-codes 4 bytes per pixel (lobium_farble.cc:32, 82). ImageData is not always 8-bit: ImageData::GetSkPixmap() uses color_type_, which is kRGBA_F16_SkColorType or kRGBA_F32_SkColorType when getImageData is called with {pixelFormat:'rgba-float16'|'rgba-float32'} (image_data.cc:122-134, image_data.cc:364-370). Both the ImageDataPixelFormat and CanvasFloatingPoint runtime flags are status:"stable" in Chromium 152 (runtime_enabled_features.json5:3644-3646 and 1055-1057), so this is reachable in shipping configuration with no flags. For F16 the row is width*8 bytes but the kernel walks x in [0,width) at 4-byte stride, so it writes only bytes [0,4*width) = the LEFT HALF of each row and leaves the right half pristine; within that half, byte index 3 of each 4-byte group is a float16 HIGH byte (sign+exponent) which the kernel misreads as "alpha" for the alpha==0 skip, and bytes 0-2 span a full half's high byte -- a +/-1 there is a 12.5%-25% value change, not a 1-LSB nudge, and can reach Inf/NaN at the top of the range. Alpha is also mutated: for odd 4-byte groups px[2] is the A low byte, so alpha can become 1.00098 (>1.0), which no honest readback can produce. Simulated on an 8-pixel float16 row of pure white (1,1,1,1) the kernel yields px0 (1, 1.00098, 0.875488, 1), px1 (0.875, 1, 0.875488, 1), px2 (1.25098, 1, 0.875488, 1), px3 (0.875, 1.00098, 1.25, 1) and px4..7 exactly (1,1,1,1). For F32 the row is width*16 bytes so only the first width/4 pixels are touched, and only their R mantissa.

**How a detector sees it.**

```
const c=document.createElement('canvas'); c.width=16;c.height=1;
  const x=c.getContext('2d',{willReadFrequently:true});
  x.fillStyle='#fff'; x.fillRect(0,0,16,1); x.fillStyle='#000'; x.fillRect(3,0,1,1); // break solidity
  const u8=x.getImageData(0,0,16,1).data;
  const f16=x.getImageData(0,0,16,1,{pixelFormat:'rgba-float16'}).data;
  // honest Chrome: f16[i] === u8[i]/255 to within float16 precision for ALL 16 pixels, and every alpha <= 1.0.
  // Lobium: pixels 0-7 diverge by up to 25% (values like 0.875 / 1.251), alphas > 1.0 appear,
  //         pixels 8-15 are exact -> a left/right split no honest engine produces.
```

**Fix.**

Gate the hook on the pixmap's colour type: only call FarbleCanvasRgba when image_data_pixmap.colorType() == kRGBA_8888_SkColorType, and either skip float readbacks or add an explicit float path that perturbs each channel by ~1 unorm8 LSB (1/255) in float space while leaving alpha untouched. The same guard belongs in FarbleCanvasRgba itself (take bytes-per-pixel or an explicit format, and CHECK it) so no future caller can repeat the mistake.

**Skeptic.**

The mechanism is real; the worked example and the severity are wrong.

Confirmed: the hook at base_rendering_context_2d.cc:518-527 passes image_data_pixmap.width()/height()/rowBytes() with no colorType guard, and FarbleCanvasRgba hard-codes 4 bytes per pixel (row_pixels = width*4 at lobium_farble.cc:128, x*4 indexing at 142/150). ImageData::GetSkPixmap() builds the pixmap from color_type_ (image_data.cc:364-370), which is kRGBA_F16/kRGBA_F32 when getImageData is passed {pixelFormat:'rgba-float16'|'rgba-float32'} (image_data.cc:122-134), and ImageDataPixelFormat is status:"stable" (runtime_enabled_features.json5:3644-3646), reachable with no flags. For F16 the kernel walks the first width*4 of the row's width*8 bytes, so it mangles the left half of each row and leaves the right half pristine, misreads a half-float high byte as alpha, nudges exponent bytes, and mutates the alpha low byte. Note this is corruption, not memory unsafety: width*4 <= rowBytes for both float formats, so there is no OOB write.

Wrong: the concrete simulation. The finder's worked F16 example (an 8-pixel row of pure white producing px0 (1, 1.00098, 0.875488, 1), px1 (0.875, ...) etc.) cannot occur under the current kernel. half(1.0)=0x3C00, so a white F16 pixel is bytes 00 3C 00 3C 00 3C 00 3C and every 4-byte group the kernel sees is byte-identical to its neighbours -> IsFlatRun returns true -> zero bytes changed. I reran their exact detection scene (16x1, white with a black pixel at x=3) on a bit-exact port: only ONE 4-byte group is perturbed, the (B,A) half of pixel 3, giving alpha 1.0009765625 (>1.0, impossible in an honest readback) and blue ~1.5e-5 instead of 0. So the tell exists but is a single pixel, not 'pixels 0-7 diverge by up to 25%'. On a genuinely textured F16 row the structural bug shows properly: 8/8 pixels changed in the left half, 0/8 in the right half, alphas outside [0,1], max relative RGB error 19.4%.

Severity: high overstates it. No shipping fingerprinter (CreepJS, FingerprintJS, BrowserScan, Iphey, Pixelscan, DataDome, Kasada) passes an ImageDataSettings pixelFormat today; this is reachable but requires a detector that specifically goes looking. It is a genuine correctness defect and the proposed fix (gate on colorType == kRGBA_8888_SkColorType, and take an explicit bytes-per-pixel/format argument in the kernel so the CHECK lives at the boundary) is exactly right, but it should rank below the 1x1 and putImageData oracles, which are two-call, zero-knowledge, and hit the default code path.

#### `canvas-readback-forced-srgb-8888` — LobiumFarbleReadback re-reads every 2D/WebGL snapshot into a hard-coded RGBA8888 / sRGB bitmap, silently stripping display-p3 colour profiles and 16-bit depth from toDataURL / toBlob / convertToBlob

*Canvas 2D / OffscreenCanvas / ImageBitmap* · **PARTLY_TRUE**

**Where.** `lobium/patches/core/config-channel.patch (LobiumFarbleReadback -> html_canvas_element.cc; the same code in offscreen_canvas.cc)` — config-channel.patch:519-520 (applied html_canvas_element.cc:1267-1268) and config-channel.patch:630-631 (applied offscreen_canvas.cc:502-503)

**Mechanism.**

Both readback hooks build SkImageInfo::Make(w, h, kRGBA_8888_SkColorType, kUnpremul_SkAlphaType, SkColorSpace::MakeSRGB()) and readPixels the snapshot into it, then hand that bitmap to the encoder. Chromium 152 canvases are not always sRGB/8-bit: getContext('2d', {colorSpace:'display-p3'}) and {colorType:'float16'} are unflagged (canvas_context_creation_attributes_module.idl:53-55; CanvasPixelFormat::kF16 -> viz::SinglePlaneFormat::kRGBA_F16, canvas_2d_color_params.cc:23-28). In honest Chrome the encode keeps the snapshot's colour type and colour space (ImageDataBuffer::ImageDataBuffer, image_data_buffer.cc:66-92, uses paint_image_info.colorType()/refColorSpace()), so a display-p3 canvas produces a PNG carrying an ICC profile chunk (SkPngRustEncoderImpl.cpp:283-284 writes an iCCP whenever colorSpace && !colorSpace->isSRGB()) and a float16 canvas produces a 16-bit-per-channel PNG (SkPngEncoderBase::getTargetInfo -> makeRgba16Info, SkPngEncoderBase.cpp:145-155). Under Lobium both are downgraded to an 8-bit untagged sRGB PNG, with P3 primaries gamut-clipped. This also breaks the hooks' own cross-surface coherence claim: getImageData on a P3 canvas returns P3-encoded samples (GetDefaultImageDataColorSpace() == color_params_.ColorSpace(), base_rendering_context_2d.h:285-287) while toDataURL now returns sRGB-converted ones, so the two disagree by far more than the +/-1 the design allows. Note the conversion happens even when the farble itself is a no-op (the early return is only on seed==0), so it fires on every 2D and WebGL canvas export in the product.

**How a detector sees it.**

```
Colour-profile tell (works even on a solid fill, where the noise is a no-op):
  const c=document.createElement('canvas'); c.width=8;c.height=8;
  const x=c.getContext('2d',{colorSpace:'display-p3'});
  x.fillStyle='color(display-p3 1 0.2 0.1)'; x.fillRect(0,0,8,8);
  const png=atob(c.toDataURL().split(',')[1]);
  // honest Chrome: png contains an 'iCCP' chunk.  Lobium: it does not.
Bit-depth tell:
  const c2=document.createElement('canvas'); c2.width=8;c2.height=8;
  c2.getContext('2d',{colorType:'float16'});
  const b=atob(c2.toDataURL().split(',')[1]);
  // IHDR bit depth is byte 24: honest Chrome 16, Lobium 8.
Coherence tell: compare getImageData samples on a display-p3 canvas against the decoded toDataURL.
```

**Fix.**

Preserve the snapshot's own SkImageInfo: build the scratch bitmap with paint_image.GetSkImageInfo().makeAlphaType(kUnpremul_SkAlphaType) (keeping colorType and refColorSpace) rather than forcing kRGBA_8888 + MakeSRGB. Then either add an F16 branch to the farble kernel or leave non-8-bit canvases unfarbled rather than silently re-encoding them -- an unfarbled but structurally correct PNG is far less detectable than a downgraded one.

**Skeptic.**

Mechanism fully confirmed; one of the three proposed detections does not work, and the severity is overstated.

Confirmed in source: LobiumFarbleReadback (html_canvas_element.cc:1260-1276, canvas-farbling.patch:81-82) and the duplicate block in offscreen_canvas.cc:492-493 both build SkImageInfo::Make(w, h, kRGBA_8888_SkColorType, kUnpremul_SkAlphaType, SkColorSpace::MakeSRGB()) and readPixels the snapshot into it, then hand it to the encoder as an UnacceleratedStaticBitmapImage. Both canvas attributes that break this are unflagged: colorSpace defaults to "srgb" but accepts "display-p3" (canvas_context_creation_attributes_module.idl:53; predefined_color_space.idl:8 has display-p3 with no RuntimeEnabled, unlike srgb-linear/display-p3-linear), and colorType accepts "float16" (idl:55) which maps to viz::SinglePlaneFormat::kRGBA_F16 (canvas_2d_color_params.cc:23-28). Honest Chrome preserves both through the encode: ImageDataBuffer::ImageDataBuffer builds its pixmap with paint_image_info.colorType() and paint_image_info.refColorSpace() (image_data_buffer.cc:75-78); the PNG encoder writes an iCCP chunk exactly when `colorSpace && !colorSpace->isSRGB()` (SkPngRustEncoderImpl.cpp:283-287; png_set_iCCP at SkPngEncoderImpl.cpp:292) and selects makeRgba16Info for >8 bits per channel (SkPngEncoderBase.cpp:121, 147, 152). So the iCCP tell and the IHDR-bit-depth tell are both real, and they fire on every 2D/WebGL export because the early return is only on seed==0.

Wrong: the 'coherence tell' (compare getImageData samples on a display-p3 canvas against the decoded toDataURL). It will mostly not fire. Decoding Lobium's untagged-sRGB PNG onto an sRGB canvas yields the already-converted values; decoding honest Chrome's p3-tagged PNG onto an sRGB canvas performs the same p3->sRGB conversion and yields the same values. The reliable probes are the raw PNG chunk scan and the IHDR byte, not a pixel comparison. Reading getImageData against a p3-tagged decode would work, but that is not what is written.

Severity: this is a genuine engine defect (colour management is silently destroyed for every display-p3 or float16 canvas export, which is also a product-quality bug for legitimate pages), but no real-world detector in the named set currently constructs a p3/F16 canvas and parses PNG chunks. Medium, below the putImageData and bitmaprenderer bypasses. The proposed fix (preserve paint_image.GetSkImageInfo() and only override alphaType) is correct and cheap.

#### `canvas-impossible-unpremultiplied-values` — A +/-1 nudge in unpremultiplied space produces (colour, alpha) pairs that an 8-bit premultiplied canvas store can never emit -- a self-contained "impossible value" check with no reference needed

*Canvas 2D / OffscreenCanvas / ImageBitmap* · **PARTLY_TRUE**

**Where.** `lobium/src/lobium_farble.cc` — 44-61 (FarblePixel), reached from both readback hooks

**Mechanism.**

Both hook sites deliberately read into kUnpremul_SkAlphaType buffers (ImageData::GetSkPixmap uses kUnpremul, image_data.cc:364-370; LobiumFarbleReadback requests kUnpremul explicitly). That correctly avoids the RGB>A premultiplied-impossible case the header worries about, but it creates the mirror-image problem. The canvas backing store is 8-bit premultiplied N32, so an honestly-read unpremultiplied sample c for alpha a must satisfy c == round(255*k/a) for some integer premultiplied k in [0,a]; only a+1 of the 256 possible values are reachable. FarblePixel adds +/-1 to c without touching a, which lands outside that set. Computed over the exact reachable sets: for alpha <= 96 a nudged value is unreachable 100% of the time; at alpha 128 it is 99%; at 192 it is 33%; at 254 it is 0%. Anti-aliased text and emoji on a transparent canvas -- the standard fingerprint scene, and precisely the pixels the design intends to perturb -- are full of low-alpha samples, so the check fires broadly. Using {willReadFrequently:true} forces CPU raster and makes the invariant exact, removing any GPU-rounding false positives.

**How a detector sees it.**

```
const c=document.createElement('canvas'); c.width=64;c.height=64;
  const x=c.getContext('2d',{willReadFrequently:true});
  for(let i=0;i<64;i++){ x.fillStyle=`rgba(${i*4},128,64,0.25)`; x.fillRect(i,0,1,64); } // alpha=64, no flat region
  const d=x.getImageData(0,0,64,64).data; let bad=0;
  for(let i=0;i<d.length;i+=4){ const a=d[i+3]; if(!a||a===255) continue;
    for(let k=0;k<3;k++){ const v=d[i+k], p=Math.round(v*a/255);
      if(Math.round(p*255/a)!==v) bad++; } }
  // honest Chrome: bad===0.  Lobium: ~100% of the perturbed low-alpha samples.
The identical check applies to the samples decoded out of toDataURL()/toBlob().
```

**Fix.**

Perturb in premultiplied-consistent space: after nudging c, snap the result back onto the reachable lattice for that alpha (c' = round(255*round(c'*a/255)/a)), which for low alpha means either moving by a full lattice step or not at all. Equivalently, apply the nudge to the premultiplied value before the unpremultiply, or restrict farbling to pixels with alpha == 255 (which also matches what the fingerprint hash mostly consumes on an opaque canvas). Note that snapping by a full lattice step at low alpha is a visible change, so alpha==255-only is the safer trade.

**Skeptic.**

The analysis is correct; the detection script as written returns bad===0 on Lobium.

Confirmed: both hook sites read into kUnpremul_SkAlphaType (ImageData::GetSkPixmap at image_data.cc:364-370; LobiumFarbleReadback requests it explicitly), and FarblePixel (lobium_farble.cc:98-112) adds a delta in {-1,0,+1} to R/G/B while leaving A alone. The reachability argument holds: Skia's premul->unpremul readback is a divide in normalised float followed by a round-to-nearest 8-bit store, so an honest sample is c = round(255*k/a) for integer k in [0,a]. I recomputed the exact reachable sets and the escape rates match the finding closely: alpha 32/64/96 -> a +/-1 nudge lands off the lattice 100.0% of the time, alpha 128 -> 99.2%, alpha 160 -> 59.4%, alpha 192 -> 32.8%, alpha 224 -> 13.8%, alpha 254 -> 0.4%, alpha 255 -> 0.0%. So a zero-reference 'impossible unpremultiplied value' check is genuinely available on any farbled partial-alpha pixel.

Wrong: the supplied probe. `for(let i=0;i<64;i++){ x.fillStyle=rgba(i*4,128,64,0.25); x.fillRect(i,0,1,64); }` paints 64 one-pixel-wide bars that are each uniform down the full 64-pixel column. Every pixel is byte-identical to its up and/or down neighbour, so IsFlatRun (lobium_farble.cc:62-96) returns true and NOTHING is farbled. The inline comment 'alpha=64, no flat region' is wrong: it accounts for horizontal variation only. A working probe needs isolated partial-alpha values, e.g. anti-aliased fillText on a transparent {willReadFrequently:true} canvas, then the same lattice test over samples with 0 < a < 255.

Severity medium is fair. If anything I would rank it slightly above canvas-float-imagedata-corruption, because it needs no exotic API and fires on exactly the anti-aliased text scene that every mainstream fingerprinter already draws. The fix analysis (snap to the reachable lattice, or restrict farbling to alpha==255) is sound; note that restricting to alpha==255 would substantially shrink the perturbed set on a transparent text canvas, which is where most of the entropy lives, so lattice-snapping or premultiplied-space perturbation is the better trade.

#### `contract-is-a-hardcoded-literal` — The capability manifest is a hardcoded string literal, not derived from the compiled hooks, and several shipped surfaces have no capability at all

*Config channel, capability contract, launcher* · **PARTLY_TRUE**

**Where.** `lobium/patches/core/capability-contract.patch (+ lobium/patches/series, packages/engine-runner/src/lobium-capabilities.ts)` — capability-contract.patch:18-31; series:19 (contract applied BEFORE the surface patches), series:45-51, 57, 61; lobium-capabilities.ts:11-24

**Mechanism.**

The patch preamble calls the manifest "machine-readable proof of the native fingerprint hooks in THIS executable", but chrome_main.cc just std::cout's a fixed 12-element string. Nothing links a capability token to the code that implements it. The series applies core/capability-contract.patch at position 19, before every surface patch, so a build in which fingerprint/host-gpu-profile.patch, fingerprint/media-devices.patch, fingerprint/client-rects.patch or fingerprint/webrtc-policy.patch was rejected during a rebase still prints the full list and still passes assertLobiumBuildCapabilities(). Conversely, hooks that ARE shipped have no capability token whatsoever and therefore no gate: fingerprint/screen-dpr.patch (Screen::GetRect width/height/avail*, Screen::colorDepth, LocalDOMWindow::devicePixelRatio, MediaValues DPR), fingerprint/media-values-device-size.patch (matchMedia device-width/height), fingerprint/mobile-persona.patch (dom_plugin_array), fingerprint/webgl-runtime-safety.patch, and the whole navigator/UA-CH/hardwareConcurrency/deviceMemory/maxTouchPoints/canvas-2D block folded into core/config-channel.patch (only transitively implied by 'config-channel-v1'). A Lobium binary built with config-channel but without screen-dpr passes the gate cleanly and ships the host monitor geometry and DPR - or, headless, the 800x600 default the patch exists to remove.

**How a detector sees it.**

```
Not a page-side probe; it is a build-integrity gap. Reproduce by removing fingerprint/screen-dpr.patch (or fingerprint/host-gpu-profile.patch) from lobium/patches/series, rebuilding, and running any product launch: probeLobiumBuildCapabilities() returns the full 12-capability manifest, assertLobiumBuildCapabilities() passes, the browser starts, and a page reading screen.width/screen.height/devicePixelRatio (or gl.getParameter(gl.VERSION) / getSupportedExtensions()) gets host values against a persona UA.
```

**Fix.**

Generate the manifest instead of hardcoding it: have each hook TU register its token (e.g. a LOBIUM_DECLARE_CAPABILITY("screen-geometry") static registrar in //components/lobium_fp, or a generated header the build emits from the applied series) so a dropped patch removes the token from the printed JSON. Add the missing tokens - screen-geometry, device-pixel-ratio, media-query-device-size, navigator-core, plugins, canvas-farbling coverage for the config-channel-folded surfaces - and require them in requiredLobiumCapabilities().

**Skeptic.**

The architectural criticism is right: chrome_main.cc just std::cout's a fixed 12-token literal (capability-contract.patch:21-31) and nothing links a token to compiled code. Several shipped hooks genuinely have no token — I confirmed by mapping every patch to its touched files: fingerprint/media-values-device-size.patch (MediaValues::CalculateDeviceWidth/Height), fingerprint/mobile-persona.patch (dom_plugin_array.cc), fingerprint/webgl-runtime-safety.patch, fingerprint/audio-worklet-tap.patch. BUT BOTH CONCRETE FAILURE SCENARIOS ARE REFUTED. (1) 'a patch REJECTED during a rebase still ships': build.ps1:174-189 collects every non-zero `patch -p1 --forward` exit into `$failed` and calls `Die`, and build.sh runs `quilt push -a` under `set -euo pipefail`. A rejected patch produces no binary at all. (2) The flagship example — 'remove fingerprint/screen-dpr.patch and screen.width/devicePixelRatio go host' — is factually wrong. screen-dpr.patch's three hunks are VERBATIM duplicates of hunks already inside core/config-channel.patch: identical blob ids (screen.cc `69ffc2b05f..cda8982346`, media_values.cc `0d60244742..5b0f34d0a7`, local_dom_window.cc `6aa773e59b..910a3b3612`) and identical bodies including the comment text. config-channel.patch:436-468 already contains Screen::colorDepth and Screen::GetRect; :251-278 already contains CalculateDevicePixelRatio; :345-370 already contains LocalDOMWindow::devicePixelRatio. Dropping screen-dpr.patch changes nothing, and `patch --forward` skips it as already-applied. (3) The 'series:19 applied BEFORE the surface patches' mechanism is a red herring — the manifest is a compile-time string literal, so apply order is irrelevant to what it prints. Also, ci/validation/native-policy-contract.test.mjs:8-20 does pin six named patches into `series`, which the finder did not credit. Residual real gap: four untokenised patches plus the general 'manifest cannot go stale-detect' point. Medium, not high.

#### `config-absent-in-gpu-and-utility-processes` — The config reaches only the browser and renderer processes; the GPU process switch allowlist has no Lobium entry, so WebGPU adapter identity still describes the real GPU

*Config channel, capability contract, launcher* · **PARTLY_TRUE**

**Where.** `lobium/patches/core/config-channel.patch (+ lobium/patches/series)` — config-channel.patch:127-134 (renderer allowlist) and :139-179 (renderer-only forwarding); series:70 (fingerprint/webgpu-adapter.patch commented out); upstream E:\lobium-build\src\content\browser\gpu\gpu_process_host.cc:252

**Mechanism.**

--lobium-fp-data is appended only in RenderProcessHostImpl::PropagateBrowserCommandLineToRenderer, and --lobium-fp-config is never added to any child allowlist. Renderer, worker-hosting renderer, and extension/service-worker renderers are all RenderProcessHostImpl, so those are covered (the preamble's claim is correct). GpuProcessHost's kSwitchNames array (gpu_process_host.cc:252ff) contains no Lobium switch, so LobiumFpConfig::Current() returns nullptr in the GPU process; likewise for utility processes (network service, audio service). For the network service this is currently harmless - user_agent and accept_language are pushed in via NetworkContextParams from the browser, which already reads the persona. For the GPU process it is not: navigator.gpu.requestAdapter() -> adapter.info (vendor/architecture/device/description) originates from gpu::GPUInfo in the GPU process and is not hooked anywhere (series:70 lists fingerprint/webgpu-adapter.patch as unauthored), so WebGPU reports the real adapter beside a spoofed WEBGL_debug_renderer_info string.

**How a detector sees it.**

```
const a = await navigator.gpu.requestAdapter(); console.log(a.info); then compare with gl.getExtension('WEBGL_debug_renderer_info') UNMASKED_RENDERER_WEBGL. On a spoofed profile the two disagree - e.g. WebGL claims 'ANGLE (Apple, Apple M2, OpenGL 4.1)' while adapter.info.description names the host's actual Intel/NVIDIA/AMD device or SwiftShader. WebGPU is enabled by default in Chrome 152 on Windows, so this is a no-permission, single-call check.
```

**Fix.**

For the WebGPU surface specifically, hook it renderer-side in Blink's GPUAdapterInfo construction (where Current() is already available) rather than plumbing the config into the GPU process. If any GPU-process-resident value ever needs spoofing, add --lobium-fp-data to gpu_process_host.cc's kSwitchNames the same way the renderer path does, and gate it behind a new capability token.

**Skeptic.**

Both code observations check out: --lobium-fp-data is appended only in PropagateBrowserCommandLineToRenderer, GpuProcessHost's kSwitchNames (E:\lobium-build\src\content\browser\gpu\gpu_process_host.cc:252-343) carries no Lobium switch, and series:70 lists fingerprint/webgpu-adapter.patch as unauthored — no patch in the tree touches any webgpu file (I mapped every patch's `diff --git` targets). WebGPU is reachable in the product: resolveGpuMode() defaults to 'auto' (gpu.ts:38-44), which emits no GL flags, so a Windows host runs the real driver. The WebGL-vs-WebGPU disagreement is therefore a genuine, single-call, no-permission cross-check. BUT THE CAUSAL FRAMING IS WRONG, and it matters because it points the fix at the wrong layer. GPU-process reachability is NOT why WebGPU leaks. `GPUAdapter::CreateAdapterInfoForAdapter()` (third_party/blink/renderer/modules/webgpu/gpu_adapter.cc:125-146) constructs GPUAdapterInfo in the RENDERER from the wire-transferred wgpu::AdapterInfo — exactly where LobiumFpConfig::Current() is already populated. The leak exists purely because nobody wrote the hook, which the series already records as a TODO; plumbing the switch into gpu_process_host.cc would fix nothing. The finder's own fix paragraph says this, contradicting the title. Net: the config-channel reachability claim is correct-but-inert (low); the embedded WebGPU leak is real and higher-value than 'low' but is a known unauthored surface belonging to the WebGL/GPU dimension. Medium overall.

#### `host-calibration-maxtouchpoints-hardfail` — Host-calibrated derivation copies the host's real navigator.maxTouchPoints into desktop personas, which the coherence gate then rejects — every desktop launch fails on a touch-capable Windows host

*navigator / User-Agent / UA client hints* · **PARTLY_TRUE**

**Where.** `packages/fingerprint/src/host-calibration.ts` — 155 (`maxTouchPoints: Math.max(0, Math.round(host.navigator.maxTouchPoints))`)

**Mechanism.**

Host calibration is the DEFAULT derivation path when the profile OS matches the runtime host (packages/engine-runner/src/start-profile.ts:219-233 auto-probes and persists one). The probe launches Lobium with no `--lobium-fp-config` and captures the raw host value (`maxTouchPoints: navigator.maxTouchPoints || 0`, packages/engine-runner/src/host-calibration-probe.ts:192, normalized at :118). `deriveFingerprintFromHost` then hands that value straight into a desktop persona whose `uaMobile` is false. `validateFingerprintCoherence` immediately flags it: `if (!nav.uaMobile && nav.maxTouchPoints !== 0) issues.push(...)` (packages/fingerprint/src/coherence.ts:692-694); `validateHostCalibrationProfile` re-emits it as `derived fingerprint: …` (host-calibration.ts:234-240) and `startProfile` throws `refusing to launch profile …: invalid host calibration` (start-profile.ts:279-287). `ensureHostCalibration` does NOT validate the profile it just probed before persisting it (packages/engine-runner/src/ensure-host-calibration.ts:84-90) — it validates only a previously loaded one — so the bad snapshot is written to disk and the failure repeats on every subsequent launch. On the shipping target (Windows) any machine with a touch digitizer (Surface, most 2-in-1s, many consumer laptops) reports `navigator.maxTouchPoints === 10`, so the product cannot launch a single desktop profile there. Secondarily, if the gate were relaxed instead of the value fixed, a non-zero host touch count on every profile is a cross-profile linkage signal and directly contradicts the persona's `(pointer: fine)`/`(hover: hover)` and `uaMobile:false`.

**How a detector sees it.**

```
Reproduce: on a Windows host with a touchscreen, delete `host-calibration.json` and call `startProfile({os:'windows', …})` — it throws with `derived fingerprint: maxTouchPoints (10) must be 0 for a non-mobile profile`. Page-side equivalent (if the gate is loosened rather than the value): `navigator.maxTouchPoints > 0 && !navigator.userAgentData.mobile && matchMedia('(pointer: fine)').matches && matchMedia('(hover: hover)').matches` — a desktop UA advertising touch points while reporting a fine, hovering primary pointer, identical across every profile on the box.
```

**Fix.**

Do not carry the host touch count into a desktop persona: in `deriveFingerprintFromHost`, use `maxTouchPoints: 0` for non-mobile personas (the native `NavigatorEvents::maxTouchPoints` hook already guards on `has_value()` precisely so a configured 0 overrides the host). If touch personas are wanted later, make the value persona-chosen and drive the pointer/hover media features from the same config field. Independently, validate the freshly probed profile inside `ensureHostCalibration` before `persistHostCalibration`, so an unusable snapshot is never written to disk.

**Skeptic.**

Every individual code observation is correct, but the central premise about reachability is wrong, so the stated impact is a large overstatement.

VERIFIED CORRECT:
- host-calibration.ts:155 `maxTouchPoints: Math.max(0, Math.round(host.navigator.maxTouchPoints))` into a persona whose uaMobile is false.
- coherence.ts:692-694 rejects any non-mobile persona with maxTouchPoints !== 0.
- host-calibration.ts:234-240 runs deriveFingerprintFromHost + validateFingerprintCoherence inside validateHostCalibrationProfile and re-emits as `derived fingerprint: ...`; start-profile.ts:279-287 throws `invalid host calibration`.
- ensure-host-calibration.ts:84-90 really does `persistHostCalibration` WITHOUT validating the freshly probed profile (it validates only the loaded one at :70-78), so an unusable snapshot is written to disk.
- The probe is genuinely unspoofed: capture-host-calibration.ts:36-46 launches with no `--lobium-fp-config`; host-calibration-probe.ts:192 captures `navigator.maxTouchPoints || 0`, :118 carries it through normalization.
- Windows really reports non-zero: ui/base/pointer/pointer_device_win.cc:75-77 `int MaxTouchPoints() { return IsTouchDevicePresent() ? GetSystemMetrics(SM_MAXIMUMTOUCHES) : 0; }`, plumbed via slow_web_preference_cache.cc:186 -> web_view_impl.cc:1716 `settings->SetMaxTouchPoints(prefs.pointer_events_max_touch_points)`.

WRONG — the premise:
"Host calibration is the DEFAULT derivation path when the profile OS matches the runtime host (start-profile.ts:219-233 auto-probes)" is false. Both the persisted-load block (start-profile.ts:202-218) and the auto-probe block (:219-233) are gated on `rendererWantsHostCalibration = launchPolicy.renderer.mode === 'host' || 'normalized_host'` (:199-201, and the guard is literally on line 221 inside the block the finder cites). The comment at :203-209 documents that this gate was added precisely because the block used to run unconditionally. The desktop UI ALWAYS writes an explicit renderer policy — profileDraft.ts:593 `overrides.renderer = rendererPolicy(draft)` with rendererPolicy() at :490-494 — and the draft default is a validated_preset (:252). So the default product path never touches host calibration. The sidecar-level `DEFAULT_RENDERER_POLICY = { mode: 'host' }` (start-profile.ts:58) only bites when a caller supplies no `fingerprintOverrides.renderer` at all (API/SDK path).

Therefore "every desktop launch fails on a touch-capable Windows host" and "the product cannot launch a single desktop profile there" are both false. Scope is: profiles that explicitly select the real-host-GPU renderer, plus API callers that omit a renderer policy.

ALSO WRONG in emphasis: this is a loud fail-closed error, not a detection surface. It belongs in the robustness bucket. The finder's page-side detection is explicitly conditioned on "if the gate is loosened", i.e. hypothetical. Downgrading to medium: real bug (bad snapshot persisted, unusable renderer mode on touch hardware, repeats every launch), but not a fingerprint leak and not a universal launch blocker.

#### `android-tablet-phone-hardware` — Android tablet personas pair a real tablet Sec-CH-UA-Model with phone hardware, a rotated phone screen, and an arbitrary Android version

*navigator / User-Agent / UA client hints* · **CONFIRMED**

**Where.** `packages/fingerprint/src/android.ts` — 72-99 (catalog/template selection and the `mobile ? min : max` screen swap)

**Mechanism.**

`deriveAndroidFingerprint` takes the model name (and therefore `navigator.userAgent`'s device token and `Sec-CH-UA-Model`) from `ANDROID_TABLET_MODEL_CATALOG`, but takes screen/GPU/RAM/cores from `ANDROID_TEMPLATE.devices` (packages/fingerprint/src/pools.ts:387-683), which contains only phones. `exactTemplate` (match on `d.model === selected.model`) can therefore never hit for a tablet, so selection falls to `brandTemplate` (brand-only) or a seeded random phone. Lines 94-99 then just swap the phone's portrait dimensions to landscape, producing e.g. 915x412 CSS px at dpr 2.625 for an 11-inch tablet. `androidVersion` also comes from the phone template when `opts.osVersion` is absent (line 90-91), so a 2019 Android-9 tablet model such as `Lenovo TB-X505F` can be emitted as `Android 14` with Chrome 152. `validateAndroidFingerprintCoherence` passes because its screen bounds (minSide 320-600, maxSide 600-1100, android.ts:288-294) were written for phones and its tablet check only requires landscape.

**How a detector sees it.**

```
`JSON.stringify({model:(await navigator.userAgentData.getHighEntropyValues(['model'])).model, w:screen.width, h:screen.height, dpr:devicePixelRatio, gpu:(()=>{const g=document.createElement('canvas').getContext('webgl');const e=g.getExtension('WEBGL_debug_renderer_info');return g.getParameter(e.UNMASKED_RENDERER_WEBGL)})()})` → e.g. `{model:'SM-X210', w:915, h:412, dpr:2.625, gpu:'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)'}`. The Galaxy Tab A9+ is a 1920x1200 Helio-G99/Mali-G57 tablet reporting ~1340x800 CSS at dpr ~1.5, and it never shipped an Adreno. Any vendor with a device-model→(panel, SoC, OS-version) table — DataDome and Kasada both maintain them — resolves this in one lookup.
```

**Fix.**

Add genuine tablet entries to `ANDROID_TEMPLATE.devices` (landscape CSS geometry ~1280x800 / 1340x800 at dpr 2, real tablet SoC/GPU strings, tablet RAM/core counts) and mark them with a form factor; require a tablet persona to select a tablet template (exact model, then same-brand tablet, then a seeded tablet) instead of falling through to phones. Constrain `androidVersion` to versions the selected model actually shipped/received. Extend `validateAndroidFingerprintCoherence` with per-form-factor screen bounds so a phone-sized tablet is rejected.

**Skeptic.**

Structurally verified.
- ANDROID_TEMPLATE.devices (pools.ts:387+) contains only phones — Pixel 8/7/9/6, SM-S911B/S921B/S901B/G991B/A546B/A346B/A145F, CPH2449/CPH2359, 22111317G/2211133G, motorola edge 40, V2205, RMX3710. No tablet model appears.
- ANDROID_TABLET_MODEL_CATALOG (catalog.generated.ts) contains only real tablets — SM-X210 / SM-X216B / 23043RP34C / A301LV etc. Intersection is empty, so `exactTemplate` (android.ts:83-85, `d.model === selected.model`) can never hit for a tablet; selection falls to brandTemplate (:86-88) or `rng.pick` (:89), i.e. always a phone.
- The landscape swap at android.ts:94-99 confirmed. Worked example: Galaxy Tab A9+ (SM-X210, Samsung) -> brandTemplate = SM-S911B (Galaxy S23, 360x780 @ dpr 3, Adreno 740) -> emitted screen 780x360 @ dpr 3. A real Tab A9+ is a 1920x1200 Helio-G99/Mali-G57 panel reporting roughly 1340x800 CSS at dpr ~1.5, and never shipped an Adreno. A ~780 CSS-px-wide 11-inch tablet is not a thing.
- The gate genuinely misses it: validateAndroidFingerprintCoherence's tablet check is only `width > height` (:283-287) and its bounds are phone bounds — minSide 320-600, maxSide 600-1100 (:288-294) — which 360/780 satisfies.

TWO CORRECTIONS, neither fatal:
1. The illustrative payload is a mashup. `{model:'SM-X210', w:915, h:412, dpr:2.625, gpu:'Adreno (TM) 740'}` cannot occur: 915x412@2.625 is the Pixel 8 template (Mali-G715), while a Samsung model resolves to a Samsung phone template. Both outcomes are absurd for a tablet, so the finding survives, but the exact numbers quoted are wrong.
2. The androidVersion claim is inverted in practice. android.ts:90-91 falls back to the template version only when `opts.osVersion` is absent, and the desktop draft always seeds one (profileDraft.ts:225, OS_VERSION_OPTIONS.android[0] = 'Android 17'). So the real hazard is not "a 2019 tablet silently gets the template's Android 14" but "a 2019 tablet gets whatever the user picked, up to Android 17", with zero model<->version validation either way. Same conclusion, different route.

Severity medium is right: it needs a device-model database to exploit, which DataDome/Kasada have but a generic script does not.

#### `clientrect-index-keying` — Keying on rect_index gives getBoundingClientRect a single global 4-bit offset (removable, ~zero unlinkability) and breaks bcr == union(getClientRects())

*Screen, DPR, viewport, media queries, clientRects* · **CONFIRMED**

**Where.** `lobium/src/lobium_farble.cc + lobium/patches/fingerprint/client-rects.patch` — lobium_farble.cc:123-134; client-rects.patch:31-32 (index i) and :52 (index 0u)

**Mechanism.**

FarbleClientRect derives h from `seed ^ (rect_index * 0x9E3779B1u)` only. Every Element::GetBoundingClientRect call passes rect_index = 0, so h is identical for EVERY element on the page and the four deltas collapse to ONE constant (dx,dy,dw,dh) shared page-wide — 16 possible states, i.e. ≤4 bits. Two consequences. (1) Unlinkability is essentially nil and the noise is trivially strippable: for any two elements A,B the differences A.x-B.x, A.width-B.width are exact, so a detector that hashes pairwise deltas (or subtracts documentElement's rect) recovers the honest layout fingerprint verbatim. The project's own gate depends on this entropy: ci/validation/native-policy-probe.mjs:316-319 requires document.body's rect to be DISTINCT across 4 profiles, which with 16 states collides ~33% of the time — a flaky gate that is itself evidence of the entropy shortfall. (2) getClientRects() uses per-fragment index i while getBoundingClientRect() uses 0, so for a multi-fragment element the hard upstream invariant bcr == union(all client rects) — both are literally computed from the same Vector<gfx::QuadF> from Element::ClientQuads (element.cc:3315-3349) — is violated whenever the extreme edge comes from a fragment with i != 0, which is ~62% of seeds per edge. Note for the record: the concern that two COINCIDING elements would stop coinciding does NOT materialise here, precisely because bcr always uses index 0 — a child exactly filling its parent still reports equal doubles. Value-keying would preserve that property while fixing both (1) and (2).

**How a detector sees it.**

```
const s=document.createElement('span'); s.textContent='x '.repeat(400); document.body.append(s); const rs=[...s.getClientRects()], b=s.getBoundingClientRect(); const ok = b.top===Math.min(...rs.map(r=>r.top)) && b.bottom===Math.max(...rs.map(r=>r.bottom)) && b.left===Math.min(...rs.map(r=>r.left)) && b.right===Math.max(...rs.map(r=>r.right)); // real Chrome: always true. Entropy-strip demo: (a.getBoundingClientRect().x - b.getBoundingClientRect().x) is the exact honest value.
```

**Fix.**

Drop the rect_index parameter entirely and hash the value: `h = mix(seed, static_cast<int32_t>(lroundf(v * 64.0f)))` computed independently per component. Identical inputs then map to identical outputs (union invariant restored, coincidences preserved), and the noise becomes a function of the whole layout rather than one 4-bit page-wide constant.

**Skeptic.**

Verified. lobium_farble.cc:123 derives h solely from `seed ^ (rect_index * 0x9E3779B1u)`, and client-rects.patch:52 passes rect_index = 0u for every Element::GetBoundingClientRect call, so one 4-bit constant (dx,dy,dw,dh) applies page-wide; pairwise differences between any two elements are byte-exact honest values, and 1/64 is exactly representable in float32 for all realistic coordinates so no rounding hides it. The CI-gate evidence checks out precisely: ci/validation/native-policy-probe.mjs:243 measures `document.body.getBoundingClientRect()` (index 0) and :316-319 requires the 8-field toJSON to be distinct across the 4 policy profiles; with 16 reachable states that is 1 - (16*15*14*13)/16^4 = 33.4% flaky. The union-invariant break is real too: element.cc:3365-3382 and :3384-3396 build getClientRects() and gBCR from the SAME Vector<gfx::QuadF> from ClientQuads (:3315-3349) and AdjustRectForScrollAndAbsoluteZoom is affine, so bcr == union(clientRects) exactly in stock Chrome, while the patch gives the fragments index-keyed deltas and the bounding box an index-0 delta. SEVERITY CORRECTED high->medium: same default-off gate as above, and the union check is a bespoke probe no shipping detector runs today — the practical damage is that the feature buys ~4 bits of trivially strippable entropy in exchange for the hard tells in the two findings above.

#### `clientrect-unfarbled-geometry-siblings` — Range.getBoundingClientRect and IntersectionObserver entry rects expose the UNFARBLED geometry of the same element

*Screen, DPR, viewport, media queries, clientRects* · **PARTLY_TRUE**

**Where.** `third_party/blink/renderer/core/dom/range.cc and core/intersection_observer/intersection_observer_entry.cc (neither hooked by lobium/patches/fingerprint/client-rects.patch)` — range.cc:1681 (Range::getClientRects), range.cc:1695 (Range::getBoundingClientRect), range.cc:1745-1753 (element branch of GetBorderAndTextQuads); intersection_observer_entry.cc:18-30

**Mechanism.**

client-rects.patch touches only Element::getClientRects and Element::GetBoundingClientRect. Range::getBoundingClientRect reaches the identical numbers by an independent route: for a range produced by `selectNode(el)` the element lands in `selected_elements` and GetBorderAndTextQuads calls `layout_object->AbsoluteQuads()` + `AdjustQuadsForScrollAndAbsoluteZoom()` — byte-for-byte the same computation as Element::ClientQuads (element.cc:3347) + AdjustRectForScrollAndAbsoluteZoom. So in stock Chrome the two are EXACTLY equal, and under Lobium they differ by the constant ±1/64. IntersectionObserverEntry.boundingClientRect is built from geometry_.TargetRect() and is likewise spec-required to equal target.getBoundingClientRect() for an untransformed box. offsetLeft/Top/Width/Height, scrollWidth/Height, getComputedStyle, visualViewport, and hit-testing (elementFromPoint / caretRangeFromPoint, which run on the REAL geometry because layout is untouched) are all unfarbled too, giving several more independent cross-checks. Checked and NOT a vector: Element.getBoxQuads sits behind the `GeometryUtils` runtime flag, whose status is "experimental" (runtime_enabled_features.json5:3385-3386), so it is absent in a stable build exactly as in Chrome; and DOMRectReadOnly::right/bottom/top/left are derived from x/y/width/height (dom_rect_read_only.h:40-43), so `rect.right === rect.x + rect.width` still holds.

**How a detector sees it.**

```
const el=document.querySelector('div'); const rg=document.createRange(); rg.selectNode(el); const a=el.getBoundingClientRect(), b=rg.getBoundingClientRect(); const spoofed = a.x!==b.x||a.y!==b.y||a.width!==b.width||a.height!==b.height;  // real Chrome: identical. IO variant: new IntersectionObserver(([e])=>{const g=e.target.getBoundingClientRect(); report(e.boundingClientRect.width!==g.width);}).observe(el);
```

**Fix.**

Either narrow the farble to a single choke point that every DOMRect-producing surface funnels through, or widen it to cover the peer surfaces: Range::getClientRects/getBoundingClientRect and IntersectionObserverEntry::boundingClientRect/intersectionRect/rootBounds. Value-keying (see clientrect-index-keying) is what makes widening safe — index-keyed noise cannot be made consistent across sources that enumerate rects differently.

**Skeptic.**

The Range half is CONFIRMED and exact. range.cc:1718-1755 GetBorderAndTextQuads takes the element branch for a selectNode()'d element (it lands in selected_elements at :1734) and calls `layout_object->AbsoluteQuads(element_quads)` + `AdjustQuadsForScrollAndAbsoluteZoom` — byte-identical to Element::ClientQuads (element.cc:3347) + AdjustRectForScrollAndAbsoluteZoom — and BoundingRect (range.cc:1810-1830) unions the quad bounding boxes. So for an empty div the two are exactly equal in stock Chrome and differ by the constant +/-1/64 under Lobium. Neither range.cc nor intersection_observer_entry.cc is touched by any patch (grepped lobium/patches: no reference). The getBoxQuads / DOMRectReadOnly-derivation exclusions the finder listed are correct. WHAT IS WRONG: (1) the IntersectionObserver half is asserted, not verified. IO's boundingClientRect comes from geometry_.TargetRect() built in intersection_geometry.cc:576 (InitializeTargetRect) then mapped by ObjectToViewTransform at :598 and zoom-adjusted at :700-704 — a different pipeline from AbsoluteQuads, LayoutUnit-quantised at the source, and Chromium makes no byte-exactness guarantee against gBCR; using it as a discriminator risks false positives on honest Chrome, so only the Range probe should be relied on. (2) Severity: everything here is gated behind the same default-off `hardwareNoise.clientRects` (lobium-config.ts:90), so high overstates it. (3) The 'narrow to a single choke point' fix is not available — Range and Element genuinely compute geometry independently; only value-keying makes widening consistent, as the finder eventually says.

#### `screen-isextended-no-prompt` — screen.isExtended leaks the host's real multi-monitor bit with NO permission prompt — the patch preamble's justification for deferring it is factually wrong

*Screen, DPR, viewport, media queries, clientRects* · **CONFIRMED** · previously documented as a known limitation

**Where.** `third_party/blink/renderer/core/frame/screen.cc (unhooked) — claim made in lobium/patches/fingerprint/screen-dpr.patch` — screen.cc:165-176; screen-dpr.patch:41-43

**Mechanism.**

screen-dpr.patch lines 41-43 defer Screen.isExtended / getScreenDetails on the grounds that "These require the `window-management` permission prompt, so they are not silently scriptable". That is true of getScreenDetails() but NOT of Screen::isExtended(), which gates only on `context->IsFeatureEnabled(PermissionsPolicyFeature::kWindowManagement)` — a permissions-POLICY check, not a permission grant. The WindowManagement entry in services/network/public/cpp/permissions_policy/permissions_policy_features.json5:645-648 specifies no feature_default, so it inherits the file default `EnableForSelf` (same file, parameters block, line 33). A top-level document therefore reads `GetScreenInfo().is_extended` — the host's true multi-monitor state — from `screen.isExtended` with zero user interaction. Every profile on a given machine returns the same bit, so it is a cross-profile linkage signal as well as a persona contradiction (a persona claiming a single 1920x1080 laptop panel on an operator's 3-monitor workstation). Related and correctly deferred: ScreenDetailed::devicePixelRatio (modules/screen_details/screen_detailed.cc:128-132) returns the host device_scale_factor and so contradicts the spoofed window.devicePixelRatio — that one genuinely is behind the prompt.

**How a detector sees it.**

```
screen.isExtended  // true on any multi-monitor host regardless of persona; no prompt, no gesture. Cross-check: a persona advertising one 1920x1080 display with isExtended===true.
```

**Fix.**

Hook Screen::isExtended() to return false whenever a config with a positive screen width is present (the persona describes exactly one display), and correct the preamble text at screen-dpr.patch:41-43, which currently records a limitation with an incorrect risk rating. If multi-display personas are ever wanted, drive isExtended from a config field instead of the host.

**Skeptic.**

Verified in full. screen.cc:165-176 gates isExtended() only on `context->IsFeatureEnabled(PermissionsPolicyFeature::kWindowManagement)` and then returns GetScreenInfo().is_extended — no permission grant, no gesture. permissions_policy_features.json5:645-648 defines WindowManagement with no feature_default, so it inherits `default: "EnableForSelf"` from the parameters block at :32-33, which is enabled for a top-level document. The value is the host's true multi-monitor bit: ui/display/display_util.cc:55 `screen_info->is_extended = screen && screen->GetNumDisplays() > 1`. So the screen-dpr.patch:41-43 justification ('These require the window-management permission prompt, so they are not silently scriptable') is factually wrong for isExtended — it is correct only for getScreenDetails()/ScreenDetailed, which the finder correctly separates. Medium is defensible as written, though the exploitation value is a single bit and I know of no shipping detector that currently cross-checks it against the persona; the strongest argument is cross-profile linkage on one operator machine plus the wrong risk rating recorded in the patch preamble.

#### `outer-geometry-unhooked` — window.outerWidth/outerHeight/screenX/screenY are unreconciled host values in host DIPs; the only coupling is a --window-size guess

*Screen, DPR, viewport, media queries, clientRects* · **PARTLY_TRUE** · previously documented as a known limitation

**Where.** `third_party/blink/renderer/core/frame/local_dom_window.cc (unhooked) + packages/engine-runner/src/launch.ts` — local_dom_window.cc:1670-1700 (outerHeight), :1702-1732 (outerWidth), :1785-1808 (screenX), :1810-1833 (screenY); launch.ts:83-87

**Mechanism.**

All four read chrome_client.RootWindowRect(*frame) — the real OS window rect on the real desktop — while Screen::GetRect serves the persona rect. The only coupling is launch.ts:87 passing `--window-size=${availWidth},${availHeight}`, which is applied in host DIPs and is clamped by the WindowSizer to the host work area. Two concrete incoherences follow when the persona screen and the host display disagree: (a) if the host work area in DIPs is smaller than the persona avail rect (very common — a 1920x1080 panel at Windows 125% scaling gives a 1536x824 DIP work area, versus a 1920x1040 persona avail rect), outerWidth/outerHeight are capped well below screen.availWidth/availHeight and innerWidth sits hundreds of CSS px below availWidth even though nothing about the persona suggests a small window; (b) screenX/screenY are true desktop coordinates, so a window opened on a secondary monitor or restored at a cascaded offset yields screenX + outerWidth > screen.width, or a negative screenX below screen.availLeft — geometry a single-display machine cannot produce, and screen.isExtended (see screen-isextended-no-prompt) is the host bit rather than a matching persona bit. Mitigating context the preamble does not mention: the primary derivation path deriveFingerprintFromHost (packages/fingerprint/src/host-calibration.ts:36-64, :157) copies the host screen verbatim, so on host-calibrated profiles this is a non-issue; it bites the pool-derived path, which is exactly where the persona is allowed to differ from the machine.

**How a detector sees it.**

```
const offscreen = (screenX < screen.availLeft) || (screenX + outerWidth > screen.width) || (screenY + outerHeight > screen.height); const gap = screen.availWidth - innerWidth;  // maximized real Chrome: gap is 0-20 (scrollbar); mismatched host: hundreds.
```

**Fix.**

Implement the follow-up the preamble already names: clamp outerWidth/outerHeight to the persona avail rect and translate screenX/screenY into persona-screen coordinates (clamped so screenX+outerWidth <= screen.width) inside the four LocalDOMWindow getters, guarded on the config being present. Independently, reject or clamp pool-derived personas whose avail rect exceeds the host DIP work area at profile-creation time.

**Skeptic.**

The core mechanism is CONFIRMED: local_dom_window.cc:1669-1699 (outerHeight), :1701-1731 (outerWidth), :1784-1807 (screenX), :1809-1832 (screenY) all read chrome_client.RootWindowRect(*frame) (chrome_client_impl.cc:305-309 -> the widget's real window rect, in DIPs) with no Lobium hook, while Screen::GetRect serves the persona. The scoping is right too — start-profile.ts:266-277 refuses host calibration on an OS mismatch, so cross-OS personas necessarily diverge from the machine. TWO THINGS ARE WRONG. (1) The clamping mechanism in scenario (a) is refuted: chrome/browser/ui/browser_window_state.cc:154-162 runs WindowSizer FIRST and then applies UpdateWindowBoundsAndShowStateFromCommandLine, whose kWindowSize branch (:174-181) calls `bounds->set_size(...)` unconditionally with no work-area clamp; the WindowSizer's `bounds->AdjustToFit(work_area)` (window_sizer.cc:276-282) has already run and cannot see the override. So on a 1920x1080@125% host with a 1920x1040 persona avail rect the window becomes 1920x1040 DIP = 2400x1300 physical and hangs off the desktop — outerWidth still reports 1920 and matches availWidth. The described 'capped hundreds of px below availWidth' outcome does not happen at launch; it happens only if the user maximizes on a host LARGER than the persona (then outerWidth = host work area > screen.width, which is the genuinely impossible case). (2) The sharpest zero-interaction instance is missing: WindowSizer's default origin is work_area.origin + kWindowTilePixels (window_sizer.cc:356-358) and --window-position is not passed, so a fresh profile opens at screenY = 10 on a bottom-taskbar Windows host, while a macOS pool persona reports screen.availTop = 25 (derive.ts:121,133; lobium_fp_config.cc:80; screen.cc:191-193). `screenY < screen.availTop` is impossible on macOS, where the OS refuses to place a window under the menu bar — a deterministic, first-launch, no-gesture contradiction for every Mac persona. Severity medium stands, but the evidence should be rewritten around (2).

#### `screen-isextended-no-permission` — screen.isExtended leaks the host's real multi-monitor state with no permission — the patch preamble's deferral rationale is factually wrong

*Surfaces with no coverage at all* · **UNVERIFIED** · previously documented as a known limitation

**Where.** `lobium/patches/fingerprint/screen-dpr.patch; hooked Chromium file third_party/blink/renderer/core/frame/screen.cc` — screen-dpr.patch:42-43 ("These require the `window-management` permission prompt, so they are not silently scriptable — deferred"); screen.cc:165 (`bool Screen::isExtended()`)

**Mechanism.**

screen-dpr.patch hooks `Screen::GetRect` and `Screen::colorDepth` but explicitly defers the Window Management surfaces on the stated grounds that they need a permission prompt. That is true for `getScreenDetails()` but NOT for `Screen.isExtended`. In screen.cc:165 the implementation is: `if (!context->IsFeatureEnabled(PermissionsPolicyFeature::kWindowManagement)) return false; return GetScreenInfo().is_extended;` — that is a PERMISSIONS-POLICY check (allowed by default for a top-level same-origin document), not a user permission. screen.idl declares it `[SecureContext, MeasureAs=WindowScreenIsExtended] readonly attribute boolean isExtended` with no RuntimeEnabled gate. So any https page reads the host's true monitor count as a boolean, silently. Combined with the also-unhooked `window.screenX/screenY/outerWidth/outerHeight` (same patch, line 45, deferred), a multi-monitor operator box is distinguishable from the single 1920x1080 display every persona claims.

**How a detector sees it.**

```
`screen.isExtended` — one property read on any https page, no prompt. On a two-monitor build/ops host it returns `true` while `screen.width/height` report the persona's single display. Cross-check with `window.screenX > screen.width` (the browser window sitting on a secondary monitor) for a second, independent contradiction. Low weight individually, but it is a free host-class signal and a cross-profile linkage bit.
```

**Fix.**

Add `Screen::isExtended` to the existing screen-dpr.patch hook set: return `false` (or a persona-configured boolean) whenever `LobiumFpConfig::Current()` supplies a screen rect, alongside the `GetRect`/`colorDepth` overrides already in that file. Correct the preamble text — `isExtended` is silently scriptable and should not be grouped with the permission-gated `getScreenDetails()` APIs. While in there, close the deferred `outerWidth/outerHeight/screenX/screenY` clamp noted at screen-dpr.patch:45.

#### `netinfo-uncovered-and-android-shape-mismatch` — navigator.connection is unhooked: rtt/downlink expose the real network path, and the Android-only members are missing for mobile personas

*Surfaces with no coverage at all* · **UNVERIFIED**

**Where.** `no Lobium coverage; hooked Chromium file third_party/blink/renderer/modules/netinfo/network_information.cc` — network_information.cc:113 (effectiveType), :134 (rtt), :150 (downlink); network_information.idl:32-39

**Mechanism.**

Zero hits for `NetworkInformation`/`effectiveType` in lobium/. Two distinct problems. (a) On desktop, `rtt` and `downlink` are computed by the network quality estimator from real observed transport timings — through the proxy, so they describe the operator's actual link quality and are stable enough to correlate profiles launched from the same box on the same upstream. (b) Shape mismatch for mobile personas: network_information.idl guards `type`, `downlinkMax` and `ontypechange` with `[RuntimeEnabled=NetInfoDownlinkMax]`, and runtime_enabled_features.json5 declares that feature `status: {"Android": "stable", "ChromeOS": "stable", "default": "experimental"}`. This is a desktop Windows build, so those three members are ABSENT — but real Chrome for Android always has them. Lobium ships Android personas (fingerprint/mobile-persona.patch, packages/fingerprint android generator, AndroidFingerprint in shared-types), so any of them is contradicted by a single `in` check.

**How a detector sees it.**

```
```js
// Android persona unmasked in one expression, no permission:
const isReallyDesktop = !('type' in navigator.connection);
// real Chrome for Android: navigator.connection.type === 'wifi'|'cellular'|…
//                          and typeof navigator.connection.downlinkMax === 'number'
// this build: both undefined / absent from the prototype

// desktop linkage:
const netKey = [navigator.connection.effectiveType, navigator.connection.rtt,
                Math.round(navigator.connection.downlink)].join('|');
```
Property-presence checks on NetworkInformation are a standard part of mobile-emulation detection (Sannysoft-class scripts and CreepJS both enumerate the connection object).
```

**Fix.**

Hook the NetworkInformation getters in modules/netinfo/network_information.cc on `LobiumFpConfig::Current()`: serve persona-derived `effectiveType`/`rtt`/`downlink`/`saveData` (seeded per profile so they differ across profiles), and for `ua_mobile` personas additionally force the `NetInfoDownlinkMax` runtime feature on and serve a coherent `type`/`downlinkMax` so the Android object shape matches. Add the fields to packages/shared-types/src/fingerprint.ts.

#### `webhid-present-for-android-persona` — navigator.hid exists on this desktop build but never on real Chrome for Android — a one-token check unmasks every Android persona

*Surfaces with no coverage at all* · **UNVERIFIED**

**Where.** `no Lobium coverage; gated in third_party/blink/renderer/modules/hid/navigator_hid.idl via runtime_enabled_features.json5` — navigator_hid.idl:8-14 (`RuntimeEnabled=WebHID`); runtime_enabled_features.json5 entry `name: "WebHID", status: {"Android": "", "default": "stable"}`

**Mechanism.**

The WebHID runtime feature is explicitly disabled on Android (`"Android": ""`) and stable everywhere else, so `navigator.hid` is a clean desktop-vs-Android bit. Nothing in lobium/patches touches modules/hid or the runtime feature set, and fingerprint/mobile-persona.patch handles only `DOMPluginArray` — it hides the PDF plugin list for `ua_mobile` personas and nothing else. So an Android persona on this Windows build presents `navigator.hid` (and its `HID`/`HIDDevice` constructors on `window`), which no real Android Chrome has. This is the same class of gap as the NetInfo one above: the mobile persona changes the strings but not the API surface shape.

**How a detector sees it.**

```
`'hid' in navigator` / `typeof window.HIDDevice` — one token, no permission, no gesture. `true` proves the client is not Chrome for Android regardless of what the UA, UA-CH, screen, touch points and plugin list say. Detectors routinely enumerate `Object.getOwnPropertyNames(Navigator.prototype)` and diff against per-platform reference sets, so this is found automatically rather than needing a bespoke rule.
```

**Fix.**

For `ua_mobile` personas, disable the Android-absent runtime features at renderer startup — the natural place is next to the existing `SetICUDefaultLocale` call in `RenderThreadImpl::Init()` (locale-geolocation.patch), calling `RuntimeEnabledFeatures::SetWebHIDEnabled(false)` and friends before Blink initialisation. Then audit the whole Navigator prototype: build the reference property list for real Chrome for Android at the pinned milestone and diff it against a Lobium Android profile in ci/validation, rather than fixing members one at a time.

#### `system-font-caption-windows-tell` — getComputedStyle on `font: caption` resolves to the real Windows UI font — a hard OS tell for macOS and Linux personas

*Surfaces with no coverage at all* · **UNVERIFIED**

**Where.** `no Lobium coverage; hooked Chromium files third_party/blink/renderer/core/layout/layout_theme_font_provider_win.cc and third_party/blink/renderer/core/exported/web_view_impl.cc` — layout_theme_font_provider_win.cc `SystemFontFamily`/`SystemFontSize`; web_view_impl.cc:3650-3661 (`#if BUILDFLAG(IS_WIN)` … `WebFontRendering::SetMenuFontMetrics(renderer_preferences_.menu_font_family_name, …)`)

**Mechanism.**

No patch touches core/layout/layout_theme* or the font-metrics plumbing. On Windows, `WebViewImpl::UpdateFontRenderingFromRendererPrefs` (web_view_impl.cc:3644) pushes `renderer_preferences_.menu_font_family_name` / `small_caption_font_family_name` / `status_font_family_name` — populated browser-side from `SystemParametersInfo(SPI_GETNONCLIENTMETRICS)` — into `FontCache::SetMenuFontMetrics` etc. `LayoutThemeFontProvider::SystemFontFamily` (layout_theme_font_provider_win.cc) then maps CSS `caption`/`menu`/`small-caption`/`status-bar` onto those cached values, and `SystemFontSize` returns the real point heights (converted at 96 dpi). So `font: caption` computes to the host's actual Windows shell font — "Segoe UI" at the host's UI scale — where real macOS Chrome resolves the system-font keywords through layout_theme_mac.mm to the Apple system font and Linux resolves to the GTK/desktop font. This is an OS discriminator that survives every string spoof in the config channel, and the resolved SIZE additionally leaks the host's Windows text-scaling setting.

**How a detector sees it.**

```
```js
const d = document.createElement('div');
d.style.font = 'caption';           // also: menu, small-caption, status-bar, -webkit-control
document.body.appendChild(d);
const cs = getComputedStyle(d);
// this Windows build: fontFamily "Segoe UI", a concrete px size from NONCLIENTMETRICS
// real macOS Chrome: the Apple system font; real Linux: the GTK font
```
No permission, no gesture, one layout. It is a well-known probe and directly contradicts a macOS or Linux persona's UA, UA-CH platform, WebGL renderer and screen DPR all at once.
```

**Fix.**

Hook `LayoutThemeFontProvider::SystemFontFamily` and `SystemFontSize` (layout_theme_font_provider_win.cc) to return persona-appropriate system-font names and sizes from `LobiumFpConfig::Current()->os` — the values are a small fixed table per OS, so this is a genuinely small patch and does not need the font pack. Do it together with the Windows font-cache hook from the fonts finding so the named face also measures plausibly.

#### `keyboard-layout-map-host-layout` — navigator.keyboard.getLayoutMap() returns the host's real physical keyboard layout, contradicting the persona locale

*Surfaces with no coverage at all* · **UNVERIFIED**

**Where.** `no Lobium coverage; hooked Chromium files third_party/blink/renderer/modules/keyboard/keyboard_layout.cc and the browser-side ui::KeyboardLayoutMap` — modules/keyboard/keyboard.idl (getLayoutMap, no platform gate); modules/keyboard/keyboard_layout.cc (no BUILDFLAG guards — verified: the only constants are the frame-detached error string)

**Mechanism.**

Nothing in lobium/ mentions Keyboard, KeyboardLayout or getLayoutMap. `navigator.keyboard` is declared in navigator_keyboard.idl with no RuntimeEnabled gate, and keyboard_layout.cc contains no platform guards, so `getLayoutMap()` resolves on this build and delegates to the browser's `ui::KeyboardLayoutMap`, which reads the active Windows keyboard layout. The returned map is a code→character table: on a German QWERTZ host `map.get('KeyY')` is `'z'`, on French AZERTY `map.get('KeyQ')` is `'a'`, on Cyrillic layouts the values are Cyrillic. Lobium derives `navigator.languages`, Accept-Language, timezone and geolocation from the proxy exit IP, but the keyboard layout is untouched — so a profile presenting as en-US/America/New_York on a Polish or German operator machine hands the detector a direct, silent contradiction of its own claimed locale, and a cross-profile linkage key (all profiles on the host share the layout).

**How a detector sees it.**

```
```js
const m = await navigator.keyboard.getLayoutMap();
const layoutKey = ['KeyQ','KeyW','KeyY','KeyZ','Semicolon','BracketLeft']
  .map(c => m.get(c)).join('');
// 'qwyz;[' = US/UK; 'qwzy;[' = DE; 'azyw m^' = FR …
// compare against navigator.languages[0] / the request IP country
```
Secure context, no permission, no user gesture. Anti-detect vendors treat keyboard-layout-vs-locale as a standard coherence check.
```

**Fix.**

Hook `KeyboardLayout::GetKeyboardLayoutMap` (modules/keyboard/keyboard_layout.cc) to synthesise the map from a per-locale layout table selected by `LobiumFpConfig::Current()->locale.locale`, so it agrees with `navigator.languages` and the proxy geo. The table is small (a handful of layouts covers the catalog's locales). Add a layout-vs-locale assertion to ci/validation/detector-matrix.mjs alongside the existing `environment.timezone` check.

#### `perf-memory-and-battery-host-hardware` — performance.memory.jsHeapSizeLimit and navigator.getBattery() report real host hardware, contradicting the spoofed deviceMemory and the persona's device class

*Surfaces with no coverage at all* · **UNVERIFIED**

**Where.** `no Lobium coverage; hooked Chromium files third_party/blink/renderer/core/timing/memory_info.cc and third_party/blink/renderer/modules/battery/battery_manager.cc` — memory_info.cc `GetHeapSize` (`info.js_heap_size_limit = heap_statistics.heap_size_limit()`); battery_manager.cc:82 (charging), :86 (chargingTime), :94 (level)

**Mechanism.**

Neither surface appears anywhere in lobium/. (a) `performance.memory` is Chrome-specific and always present; `jsHeapSizeLimit` comes from V8's `heap_size_limit()`, which V8 derives from the machine's physical memory via ResourceConstraints, then Blink buckets it (`QuantizeMemorySize`). Lobium spoofs `navigator.deviceMemory` natively (config-channel.patch hooks approximated_device_memory.cc), so a 4 GB build host claiming `deviceMemory: 8` keeps a heap ceiling in the bucket that belongs to 4 GB — the two numbers are derived from the same physical RAM in real Chrome and are trivially cross-checked. (b) `navigator.getBattery()` has no RuntimeEnabled gate (navigator_battery.idl) and returns the host's real battery state. A desktop tower reports `charging:true, level:1, chargingTime:0, dischargingTime:Infinity`; a laptop reports a fractional level and finite times. Lobium personas include MacBook-class devices (the catalog carries ~200 macOS presets) whose WebGL renderer, DPR 2 screen and UA all say "laptop" while the battery says "desktop, permanently on AC" — or, on a laptop build host, every profile shares one continuously-changing battery level, which is a strong real-time cross-profile join key.

**How a detector sees it.**

```
```js
// (a) RAM coherence, no permission:
const ratio = performance.memory.jsHeapSizeLimit / (navigator.deviceMemory * 1024**3);
// (b) device-class coherence:
const b = await navigator.getBattery();
const looksDesktop = b.charging && b.level === 1 && b.dischargingTime === Infinity;
// looksDesktop === true for a MacBook Air persona is a contradiction;
// b.level sampled from two profiles at the same instant links them to one host.
```
Both are permission-free reads. FingerprintJS and CreepJS both collect performance.memory; battery is read by several fraud vendors specifically as a device-class and session-linkage signal.
```

**Fix.**

For memory: hook `GetHeapSize` in core/timing/memory_info.cc to derive `js_heap_size_limit` from `LobiumFpConfig::Current()->navigator.device_memory` using V8's own physical-memory→limit mapping, before quantization (leave used/total alone — they are genuinely workload-dependent). For battery: hook the `BatteryManager` getters (battery_manager.cc:82-100) to serve a persona-derived, seed-stable, slowly-drifting state coherent with the persona's form factor (desktop personas: charging/1.0/Infinity; laptop personas: a plausible fractional level). Add both fields to packages/shared-types/src/fingerprint.ts.

#### `webgl2-getparameter-never-hooked` — WebGL2RenderingContextBase::getParameter intercepts VERSION, SHADING_LANGUAGE_VERSION and ~35 WebGL2-only MAX_* before the Lobium hook, leaking the real backend and breaking an ANGLE arithmetic invariant

*WebGL 1 and WebGL 2* · **PARTLY_TRUE**

**Where.** `third_party/blink/renderer/modules/webgl/webgl2_rendering_context_base.cc (no Lobium hook); Lobium caps hook is in lobium/patches/core/config-channel.patch` — webgl2_rendering_context_base.cc:4839-5055 (delegation to the base class only at :5052 `default:`); Lobium hook at config-channel.patch:1010-1058, applied at webgl_rendering_context_base.cc:4016-4060

**Mechanism.**

`grep -ri lobium third_party/blink/renderer/modules/webgl/` in the checkout matches exactly one file: webgl_rendering_context_base.cc. WebGL2RenderingContextBase::getParameter has its own switch that handles GL_VERSION (:4851), GL_SHADING_LANGUAGE_VERSION (:4844), GL_MAX_3D_TEXTURE_SIZE, GL_MAX_ARRAY_TEXTURE_LAYERS, GL_MAX_COLOR_ATTACHMENTS, GL_MAX_DRAW_BUFFERS, GL_MAX_SAMPLES, GL_MAX_UNIFORM_BUFFER_BINDINGS, GL_MAX_ELEMENT_INDEX, GL_MAX_TEXTURE_LOD_BIAS, GL_MAX_VARYING_COMPONENTS, GL_MAX_{VERTEX,FRAGMENT}_UNIFORM_COMPONENTS, GL_MAX_TRANSFORM_FEEDBACK_*, GL_UNIFORM_BUFFER_OFFSET_ALIGNMENT and ~20 more, and only falls through to WebGLRenderingContextBase::getParameter (where the Lobium clamp lives) in the `default:` arm. So all of those return raw ContextGL()->GetIntegerv values: a detector reading only WebGL2 parameters classifies the true backend (SwiftShader vs ANGLE/D3D11 vs Metal vs Vulkan) and its true tier while UNMASKED_RENDERER claims something else. There is also a zero-baseline arithmetic proof: ANGLE hard-codes GL_MAX_VARYING_COMPONENTS = maxVaryingVectors * 4 (third_party/angle/src/libANGLE/Context.cpp:2039) and the D3D11 backend hard-codes maxShaderUniformComponents[Fragment] = maxFragmentUniformVectors * 4 (third_party/angle/src/libANGLE/renderer/d3d/d3d11/renderer11_utils.cpp:1213). Lobium overrides/clamps the *_VECTORS side (config-channel.patch:1034-1036, webgl-runtime-safety.patch:66-69) and leaves the *_COMPONENTS side at the backend value, so whenever the configured cap is BELOW the backend cap the identity breaks. That is the normal case for pool/preset personas: D3D11_CAPS maxVaryingVectors=30 (packages/fingerprint/src/pools.ts:67) on an Intel/Metal/GL backend reporting 31 yields MAX_VARYING_VECTORS=30 next to MAX_VARYING_COMPONENTS=124. Note VERSION/SHADING_LANGUAGE_VERSION are low-impact in practice because Chromium synthesizes constants (gpu/command_buffer/service/gl_utils.cc:391-406 -> 'OpenGL ES 3.0 Chromium'), but they are still un-spoofed on WebGL2 while spoofed on WebGL1, so any persona whose configured string is not exactly the Chromium constant produces a WebGL1/WebGL2 contradiction.

**How a detector sees it.**

```
const g=document.createElement('canvas').getContext('webgl2'); const tampered = g.getParameter(g.MAX_VARYING_COMPONENTS)!==4*g.getParameter(g.MAX_VARYING_VECTORS) || g.getParameter(g.MAX_FRAGMENT_UNIFORM_COMPONENTS)!==4*g.getParameter(g.MAX_FRAGMENT_UNIFORM_VECTORS) || g.getParameter(g.MAX_VERTEX_UNIFORM_COMPONENTS)!==4*g.getParameter(g.MAX_VERTEX_UNIFORM_VECTORS); // needs no knowledge of the real GPU. Backend recovery: [MAX_3D_TEXTURE_SIZE, MAX_ARRAY_TEXTURE_LAYERS, MAX_SAMPLES, MAX_UNIFORM_BUFFER_BINDINGS, MAX_ELEMENT_INDEX, MAX_TEXTURE_LOD_BIAS, MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS] read the real driver and contradict UNMASKED_RENDERER.
```

**Fix.**

Add a Lobium interception block at the top of WebGL2RenderingContextBase::getParameter (mirroring the WebGL1 one) driven by a new cfg->webgl2 caps set captured from a real WebGL2 context, and derive the *_COMPONENTS values from the reported *_VECTORS values (x4) rather than from the backend, so the ANGLE identity holds by construction. Hooking VERSION/SHADING_LANGUAGE_VERSION there too is trivial and should be done for symmetry.

**Skeptic.**

The code observation is exactly right, the severity and the flagship detection are not. Verified: webgl2_rendering_context_base.cc:4839-5055 handles GL_SHADING_LANGUAGE_VERSION (:4844), GL_VERSION (:4851) and ~35 WebGL2-only MAX_* itself, delegating to the Lobium-hooked WebGLRenderingContextBase::getParameter only at `default:` (:5052-5053), and there is no Lobium code in that file. GL_MAX_VARYING_COMPONENTS (:4911) is one of them, and ANGLE really does hard-code it as 4x maxVaryingVectors (Context.cpp:2035-2040), with the D3D11 backend deriving maxShaderUniformComponents[Vertex/Fragment] the same way (renderer11_utils.cpp:1195, :1212-1213, :1251-1252). BUT the finder never checked whether the clamp can actually fire, and on the shipped configuration it usually cannot. (a) Primary path: renderer mode defaults to 'host' (lobium-config.ts:100) and caps are the host's own; I confirmed ANGLE does NOT vary maxVaryingVectors / maxVertexUniformVectors / maxFragmentUniformVectors by client version — Context::initCaps (Context.cpp:4190-4420) only client-gates maxViews, maxVertexAttribBindings, maxCombinedTextureImageUnits and a forceMinimumMaxVertexAttributes workaround — so the WebGL1 capture equals the WebGL2 backend value, min(x,x)=x, and every identity holds exactly. No leak, no arithmetic break. (b) validated_preset on Windows: D3D11_CAPS (pools.ts:59-73) is maxVaryingVectors=30, maxVertexUniformVectors=4096, maxFragmentUniformVectors=1024, maxTextureSize=16384 — and I computed the real ANGLE D3D11 FL11 values to be exactly 30 (D3D11_VS_OUTPUT_REGISTER_COUNT 32 minus GetReservedVertexOutputVectors=2, renderer11_utils.cpp:555-596), 4096 (D3D11_REQ_CONSTANT_BUFFER_ELEMENT_COUNT, :513-521) and 1024 (:629-638). configured == backend, so the identity holds there too. The invariant only breaks for a cross-OS persona (a macOS METAL_CAPS preset with maxVertexUniformVectors=1024 on a D3D11 host reporting 4096 -> MAX_VERTEX_UNIFORM_COMPONENTS 16384 next to VECTORS 1024) or on a software/CI backend. (c) The 'classify the true backend' claim is also weaker than stated: on D3D11 the WebGL2-only caps are feature-level constants, identical across all FL11 GPUs, so they recover backend CLASS (D3D11 vs Metal vs SwiftShader), not GPU model — which only contradicts the persona in the same preset/cross-OS cases. (d) The finder is right that VERSION/SHADING_LANGUAGE_VERSION are near-harmless: gl_utils.cc:391-405 returns the fixed 'OpenGL ES 3.0 Chromium'/'OpenGL ES GLSL ES 3.0 Chromium' constants. Real finding, but it is a preset-mode/cross-OS coherence hole (largely the same population as findings 8 and 10), not a critical leak on the default host-calibrated product.

#### `solid-interior-oob-skips-small-reads` — IsSolidInterior treats out-of-buffer neighbours as matching, so a 1x1 readPixels/getImageData is NEVER farbled — the unfarbled image is recoverable pixel by pixel

*WebGL 1 and WebGL 2* · **PARTLY_TRUE**

**Where.** `lobium/src/lobium_farble.cc` — 26-42 (IsSolidInterior, `return true; // treat OOB as matching`), used at :79 (FarbleCanvasRgba) and :102 (FarbleCanvasRgbaFlippedRows)

**Mechanism.**

IsSolidInterior() returns true — meaning 'skip this pixel' — when the pixel's RGBA equals all four orthogonal neighbours, and out-of-bounds neighbours are counted as equal. For a 1x1 read (width=1, height=1) all four neighbours are out of bounds, so the predicate is unconditionally true and FarblePixel is never called. gl.readPixels(px,py,1,1,RGBA,UNSIGNED_BYTE,buf) therefore returns the pristine host pixel, and so does ctx.getImageData(px,py,1,1) on a 2D canvas (same kernel, config-channel.patch:663-671). More generally the noise applied to a pixel depends on the READ RECTANGLE (the 1-pixel border ring of any sub-rect is evaluated against phantom matching neighbours), which contradicts the kernel's own documented invariant in lobium_farble.h:18-24 ('identical between getImageData and toDataURL/toBlob for the same pixel'). That gives a two-call tamper proof with no baseline, and an O(W*H)-call full recovery of the unfarbled WebGL/canvas image.

**How a detector sees it.**

```
const full=new Uint8Array(w*h*4); g.readPixels(0,0,w,h,g.RGBA,g.UNSIGNED_BYTE,full); const one=new Uint8Array(4); g.readPixels(px,py,1,1,g.RGBA,g.UNSIGNED_BYTE,one); // honest Chrome: full[(py*w+px)*4 + k] === one[k] for k=0..3. Lobium: differs for any non-solid pixel. Identical test on 2D canvas: getImageData(0,0,w,h) vs getImageData(px,py,1,1).
```

**Fix.**

Make the edge test independent of the read rectangle. Either drop the solid-interior heuristic in favour of a value-based test (e.g. skip only fully-transparent pixels and pixels whose RGB is one of the exact fill colours the page requested), or compute the neighbour comparison against the full backing surface rather than the caller's sub-rect buffer. Treating OOB as 'not matching' would at least make small reads farbled, but the rect-dependence of the border ring would remain — the invariant must be 'noise(pixel) depends only on (seed, absolute x, absolute y, channel)'.

**Skeptic.**

The conclusion survives; the cited code does not exist. There is no `IsSolidInterior` anywhere in E:\project or in the staged //components/lobium_fp copy (grepped both) — the real predicate is `IsFlatRun` at lobium_farble.cc:62-96, and its OOB semantics are the OPPOSITE of what the finder claims: out-of-bounds neighbours are simply not consulted (`if (x > 0)`, `if (x + 1 < width)`, `if (prev)`, `if (next)`), never counted as matching. The only path that returns true from missing neighbours is the explicit degenerate case `return !has_neighbor;` at :95, which fires only when width==1 && height==1. So: (a) the 1x1-is-never-farbled conclusion is CORRECT — verified for both getImageData (config-channel.patch:663-671, origin (sx,sy)) and readPixels (webgl_rendering_context_base.cc:5581-5590, width>0 && height>0 admits 1x1) — and it is a deliberate, explicitly documented trade-off, spelled out in the comment at lobium_farble.cc:93-95 ('a 1x1 readback is far more likely to be a solid-colour probe than a fingerprint scene'), which the finder marked alreadyDocumented:false; (b) the claim that 'the 1-pixel border ring of any sub-rect is evaluated against phantom MATCHING neighbours' is backwards — border pixels have FEWER neighbours to match, so they are more likely to be farbled, not less. The rect-dependence the finder infers is nonetheless real, just in the inverted direction (a pixel that matched only its left neighbour in a full read gets farbled when it is the left edge of a sub-rect), which does contradict the header's overclaim at lobium_farble.h:18-19 while the .cc comment at :37 correctly scopes it to 'a full-canvas read'; (c) the proposed fix 'treating OOB as not-matching would at least make small reads farbled' is confused — that is already the behaviour except for the 1x1 case. Severity down to medium: the 2-call tamper proof and the sampled-1x1 pristine-hash recovery are real and defeat unlinkability, but this is a knowingly-taken trade-off against the cheaper and more widely-run known-input solid-fill probe, and no shipped detector currently runs the 1x1-vs-full comparison.

#### `getextension-case-sensitive-allowlist` — The persona extension allowlist compares names case-SENSITIVELY while Chrome's matcher is case-insensitive: getExtension('webgl_debug_renderer_info') returns null under Lobium and an object in real Chrome

*WebGL 1 and WebGL 2* · **CONFIRMED**

**Where.** `lobium/patches/fingerprint/host-gpu-profile.patch; hooks third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc getExtension` — host-gpu-profile.patch:23-27 (`if (name == String::FromUtf8(ext))`); applied at webgl_rendering_context_base.cc:3892-3897

**Mechanism.**

The WebGL spec requires extension-name matching to be case-insensitive, and Chromium implements that in WebGLRenderingContextBase::ExtensionTracker::MatchesName, which uses DeprecatedEqualIgnoringCase (webgl_rendering_context_base.cc:3825-3831) and is reached from EnableExtensionIfSupported (:3856). Lobium's allowlist, inserted BEFORE that call, uses WTF String operator== (exact, case-sensitive) against the config strings. Because the config list is captured verbatim from getSupportedExtensions() it always holds the canonical casing, so every non-canonical spelling is refused. In stock Chrome `gl.getExtension('webgl_debug_renderer_info')`, `gl.getExtension('OES_TEXTURE_FLOAT')`, `gl.getExtension('Ext_Srgb')` all succeed. Under Lobium they return null while getSupportedExtensions() still lists the canonical name — a direct, unambiguous tamper proof in one line, and it also breaks any real site that spells an extension in lower case.

**How a detector sees it.**

```
const g=document.createElement('canvas').getContext('webgl'); const tampered = g.getSupportedExtensions().includes('WEBGL_debug_renderer_info') && g.getExtension('webgl_debug_renderer_info')===null; // honest Chrome: getExtension returns a WEBGL_debug_renderer_info object. Corroborate with g.getExtension('oes_texture_float') vs g.getExtension('OES_texture_float').
```

**Fix.**

Replace the exact comparison with a case-insensitive one (EqualIgnoringASCIICase / DeprecatedEqualIgnoringCase) so the filter mirrors ExtensionTracker::MatchesName exactly. Better still, express the filter as a deny-list applied inside EnableExtensionIfSupported (skip trackers whose canonical name is absent from the config) so there is exactly one matching implementation and the two entry points cannot drift.

**Skeptic.**

Mechanism verified exactly. ExtensionTracker::MatchesName uses DeprecatedEqualIgnoringCase (webgl_rendering_context_base.cc:3822-3828) and is the only matcher reached from EnableExtensionIfSupported (:3852-3853). The Lobium allowlist sits ahead of it in the applied source at :3889-3903 and compares with WTF `String operator==` (`if (name == String::FromUtf8(ext))`, :3893), which is exact and case-sensitive. Since the config list is captured verbatim from getSupportedExtensions() (host-calibration-probe.ts:159) it always carries canonical casing, so `gl.getExtension('webgl_debug_renderer_info')` returns null under Lobium and a live object in stock Chrome, while getSupportedExtensions() still lists the canonical spelling — an unambiguous one-line tamper proof, and a real functional regression for any page that spells an extension non-canonically. Severity corrected to medium rather than high only because no currently-deployed detector (CreepJS, FingerprintJS, Sannysoft, BrowserScan, Pixelscan, DataDome, Kasada) probes extension-name case; it is a latent, zero-false-positive probe that costs one line to add, not one already in the field. Note also that hc4-probe.mjs:148-152 bakes the allowlist's refusal behaviour into a gate but never exercises the case-insensitive path, so nothing in CI would notice the fix or the regression. The proposed fix (EqualIgnoringASCIICase, or better, filtering inside EnableExtensionIfSupported so there is a single matcher) is correct.

#### `silent-cap-clamp-no-fail-closed` — webgl-runtime-safety clamps configured MAX_* and shader precision down to the backend SILENTLY, producing an RTX-class renderer string next to SwiftShader-class limits

*WebGL 1 and WebGL 2* · **PARTLY_TRUE**

**Where.** `lobium/patches/fingerprint/webgl-runtime-safety.patch` — 12-127 (clamped_integer_cap / viewport / aliased ranges) and 128-147 (clamped_precision)

**Mechanism.**

clamped_integer_cap() returns std::min(configured, backend) with no signal of any kind — no log, no metric, no launch-time check. The renderer/vendor strings (config-channel.patch:1062-1092) are NOT clamped, so on any host weaker than the persona the pair is contradictory: UNMASKED_RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)' next to MAX_TEXTURE_SIZE=8192 / MAX_VARYING_VECTORS=15 / highp precision=SwiftShader's. This is the classic Pixelscan/CreepJS cross-check. Note the clamp is a no-op on the primary host-calibration path (caps come from the host, so min(host,host)=host) — it bites in `validated_preset` mode (packages/engine-runner/src/start-profile.ts:303-319, caps from D3D11_CAPS/METAL_CAPS/GL_CAPS in pools.ts:59-119) and on any software/CI backend. Argument: silent clamping is the wrong default for an anti-detect product. Clamping trades a hard crash (heavy 3D content allocating a 16K texture on an 8K backend) for a *permanently detectable* profile that the user will keep using; a launch-time refusal ('this persona's GPU class cannot be honoured on this host — pick a lower tier or enable host calibration') is fail-closed and preserves the product's core promise. The correct shape is: refuse at launch when configured > backend on any cap, clamp only under an explicit dev/provisional flag (the codebase already has that pattern: allowProvisionalSoftwareGpu() at start-profile.ts:280).

**Fix.**

Add a launch-time capability probe in the sidecar (or a browser-process check that refuses to emit --lobium-fp-data) comparing every configured cap against the live backend; refuse the launch with an actionable message when the persona over-promises. Keep the runtime clamp only as a crash guard behind the existing provisional-software-GPU escape hatch, and emit a LOG(WARNING) whenever it actually fires so the condition is observable in the field.

**Skeptic.**

The code observation and the design argument are both correct, but the population where the clamp actually bites is smaller than described. Verified: clamped_integer_cap (webgl-runtime-safety.patch:28-36) is a bare std::min with no LOG, metric or launch-time check, and clamped_precision (:136-140) likewise; the vendor/renderer strings at config-channel.patch:1071-1088 are not clamped, so an over-promising persona does leave a contradictory pair. The finder correctly notes it is a no-op on the host-calibration path. What they missed is that it is ALSO a near no-op in the main preset case: I computed the real ANGLE D3D11 FL11 caps from renderer11_utils.cpp — maxVaryingVectors 30 (:585-596 with GetReservedVertexOutputVectors=2 at :555-577), maxVertexUniformVectors 4096 (:513-521), maxFragmentUniformVectors 1024 (:629-638), max2DTextureSize 16384 — and D3D11_CAPS in pools.ts:59-73 is exactly 30/4096/1024/16384. So a Windows preset on a Windows D3D11 host clamps nothing. The clamp only bites on a software/SwiftShader backend (the CI/dev case) or for a cross-OS persona (METAL_CAPS or GL_CAPS on a D3D11 host), which is where the 'RTX-class renderer next to SwiftShader limits' contradiction actually appears. The proposed fix — refuse at launch when configured > backend on any cap, keep the clamp only behind the existing allowProvisionalSoftwareGpu() escape hatch (start-profile.ts:280) and LOG(WARNING) when it fires — is the right shape. Medium is the correct severity: this is a fail-open design defect that manufactures a permanently detectable profile, not an independently exploitable leak.

#### `hc4-probe-contradicted-by-runtime-safety` — The HC-4 CI gate can no longer pass once webgl-runtime-safety is applied — the two patches in the same series contradict each other, so the deep-WebGL hooks are effectively unverified

*WebGL 1 and WebGL 2* · **CONFIRMED**

**Where.** `ci/validation/hc4-probe.mjs vs lobium/patches/fingerprint/webgl-runtime-safety.patch` — hc4-probe.mjs:36 and :38 (sentinels), :143-147 and :153-160 (assertions); webgl-runtime-safety.patch:157-171 (intersection) and :131-145 (precision clamp)

**Mechanism.**

hc4-probe feeds synthetic sentinels ['LOBIUM_EXT_ALPHA','LOBIUM_EXT_BRAVO','WEBGL_debug_renderer_info'] and an impossible precision bucket {rangeMin:77,rangeMax:66,precision:55}, then asserts JSON.stringify(getSupportedExtensions())===JSON.stringify(sentinelList) and exact equality of the precision triple. webgl-runtime-safety.patch (series:57, applied AFTER host-gpu-profile.patch) intersects the configured list with `extensions_` and pushes `tracker->ExtensionName()`, so LOBIUM_EXT_ALPHA/BRAVO are dropped and the list collapses to ['WEBGL_debug_renderer_info']; and clamped_precision() takes std::min against the backend, so precision 55 becomes the backend's 23. Two of the five gate checks therefore fail deterministically on any build that has the full series applied. Either the gate has not been run against a runtime-safety build (so HC-4 is unproven in the shipped binary) or it is being skipped — both leave the deep-WebGL hooks unvalidated, which matters because findings 1, 5 and 6 above all live in exactly those hooks.

**How a detector sees it.**

```
Run `LOBSTER_LOBIUM_BIN=<binary> node ci/validation/hc4-probe.mjs` against a build with the full series applied: 'getSupportedExtensions() == sentinel list' and 'getShaderPrecisionFormat(FRAGMENT, HIGH_FLOAT) == sentinel bucket' fail.
```

**Fix.**

Rewrite the probe to assert behaviour that survives the intersection/clamp: use real extension names the backend supports and assert the configured SUBSET and ORDER are reproduced exactly; use precision values that are <= the backend's and assert equality. Add two new assertions that would have caught the findings above — a webgl2 context must still expose EXT_color_buffer_float, and getExtension() must be case-insensitive.

**Skeptic.**

Both failing assertions verified against the applied source. hc4-probe.mjs:36 feeds ['LOBIUM_EXT_ALPHA','LOBIUM_EXT_BRAVO','WEBGL_debug_renderer_info'] and :143-147 asserts JSON.stringify equality with getSupportedExtensions(); the applied intersection at webgl_rendering_context_base.cc:4730-4739 only pushes names for which some tracker in `extensions_` matches AND ExtensionSupportedAndAllowed, so the two synthetic sentinels are silently dropped and the array collapses to ['WEBGL_debug_renderer_info']. hc4-probe.mjs:38 feeds {rangeMin:77,rangeMax:66,precision:55} and :153-160 asserts exact equality; webgl-runtime-safety.patch:131-145 replaces the returned triple with std::min against the live backend, and the probe deliberately runs on SwiftShader (buildGpuArgs({mode:'software'}) at :98) whose HIGH_FLOAT precision is 23, so precision comes back 23. Two of five checks fail deterministically on any build with the full series. The probe is wired into .github/workflows/real-gpu-gate.yml:78, so either that job is not green or it is not running; either way the deep-WebGL hooks that host findings 1, 5 and 6 are unvalidated in the shipped binary. The suggested rewrite (real backend-supported names, assert configured subset AND order; precision values <= backend; add a webgl2 EXT_color_buffer_float assertion and a case-insensitivity assertion) is the right remedy.

#### `preset-mode-deep-surfaces-fall-back-to-host` — In validated_preset renderer mode the catalog supplies only numeric caps, so extensions, VERSION, GLSL version and shader precision still report the real host GPU

*WebGL 1 and WebGL 2* · **CONFIRMED** · previously documented as a known limitation

**Where.** `packages/fingerprint/src/catalog.generated.ts and packages/engine-runner/src/start-profile.ts` — catalog.generated.ts:157-163, :183-189, :212-216, :240-246 (each preset webgl object carries only vendor/renderer/unmasked*/caps); start-profile.ts:303-319 (preset spread replaces fp.webgl wholesale)

**Mechanism.**

The preset entries never set extensions/version/shadingLanguageVersion/shaderPrecision, so cfg->webgl.extensions is empty and cfg->webgl.shader_precision.present is false. All four Lobium hooks in host-gpu-profile.patch are gated on those fields being populated (host-gpu-profile.patch:21, :45, :57, :70, :112) and fail open to the host. The result is exactly the leak the patch preamble says battle-testing found ('extension set + precision leaked the host while UNMASKED_RENDERER was spoofed') — closed on the host-calibration path, still open on the preset path, which is a user-facing product feature (pick a GPU model). The entropy is modest on desktop ANGLE/D3D11 (extension sets are fairly uniform across GPUs; the discriminators are EXT_texture_compression_bptc / WEBGL_compressed_texture_astc / EXT_disjoint_timer_query availability), which is why this ranks below the WebGL2 findings, but it is a real coherence hole and it compounds with finding 8 on a software backend.

**How a detector sees it.**

```
Launch a profile in validated_preset mode on a host whose GPU differs in extension support from the claimed model, then compare getSupportedExtensions() and getShaderPrecisionFormat(VERTEX, HIGH_INT) against a stock-Chrome capture of the claimed GPU. A detector with a renderer->extension-set table (CreepJS keeps one) sees the mismatch.
```

**Fix.**

Ship the capture pipeline described in docs/ENGINEERING.md W1 (scripts/capture-gpu-catalog.mjs) so preset entries carry {extensions, version, glsl, precision, caps}; until then, refuse to launch validated_preset mode unless the selected entry has all deep fields populated, rather than silently emitting a caps-only persona whose other WebGL surfaces are the host's.

**Skeptic.**

Verified. The catalog factory functions at catalog.generated.ts:149-163 (winRenderer), :175-190 (macArmRenderer), :204-219 (macIntelRenderer) and :234-249 (linuxRenderer) each emit a webgl object carrying only vendor/renderer/unmasked*/caps — no extensions, version, shadingLanguageVersion or shaderPrecision — and start-profile.ts:310-318 replaces fp.webgl wholesale with that object. Consequently cfg->webgl.extensions is empty and cfg->webgl.shader_precision.present is false, and every host-gpu-profile hook is gated on exactly those fields being populated (applied source: :3890, :4246, :4314, :4658, :4727), so all four fail open to the host. That is precisely the leak the patch preamble says battle-testing found (host-gpu-profile.patch:5-6), closed on the calibration path and still open on the preset path. Two minor corrections: the Linux table is named MESA_CAPS, not GL_CAPS (pools.ts:89 defines GL_CAPS but catalog.generated.ts:247 uses MESA_CAPS), and the entropy argument understates the exposure slightly — on the preset path the host also leaks through the WebGL2-only getParameter surface (finding 2) and through WebGPU, so these compound. alreadyDocumented:true is correct; the recommendation to refuse validated_preset until the capture pipeline lands is the right fail-closed call.

### LOW (17)

#### `gn-args-linux-truncated-and-divergent` — gn-args.gn.example is truncated mid-comment and has silently drifted from gn-args-windows.gn; two hand-maintained copies with no shared source

*Engine architecture, build hygiene, patch series* · **UNVERIFIED**

**Where.** `lobium/gn-args.gn.example` — 23 (file ends on the dangling comment `# Branding (rebrand for distribution):` with nothing after it)

**Mechanism.**

The Linux args file ends on a section header that introduces content that is not there, and it is missing three settings its Windows twin has and justifies at length: v8_symbol_level, target_cpu, and an explicit use_remoteexec. The two files share ~10 identical assignments maintained by hand in parallel, with build.sh consuming one (via `grep -v '^#' | tr '\n' ' '`) and build.ps1 the other (copied verbatim to args.gn - a genuinely better mechanism than --args=, and correctly reasoned about in build.ps1:286-292). Any future arg (enable_widevine, google_api_key) will have to be added twice and will drift. Two obsolete items from the review checklist are worth recording as non-issues so nobody adds them: `enable_nacl` no longer exists as a GN arg in 152 (NaCl is removed - `git grep -l enable_nacl -- '*.gni' '*.gn'` returns nothing), and `is_cfi` is gated to `target_os == "linux" && target_cpu == "x64"` in build/config/sanitizers/sanitizers.gni, so it is inert on Windows and must not be forced on. enable_resource_allowlist_generation is likewise Android-only. The rest of the Windows args are correct for a fast release build: is_official_build + is_component_build=false + dcheck_always_on=false + chrome_pgo_phase=2 + use_thin_lto is exactly the stock-Chrome configuration, and symbol_level/blink_symbol_level/v8_symbol_level = 0 costs no runtime.

**How a detector sees it.**

```
`Get-Content lobium/gn-args.gn.example | Select-Object -Last 1` shows the dangling header; `Compare-Object (gc lobium/gn-args.gn.example) (gc lobium/gn-args-windows.gn)` shows the drift.
```

**Fix.**

Either finish the truncated line or delete it, then factor the shared assignments into `lobium/gn-args-common.gni` (or a plain shared fragment both scripts concatenate) with only the genuinely platform-specific lines - target_cpu, use_remoteexec, cc_wrapper - left per-platform. Add a tiny CI assertion that the two files agree on the shared keys, in the same spirit as patch-series.test.mjs. While editing, add `enable_widevine = true` to both (see the widevine finding).

#### `hooks-md-referenced-but-absent` — series and several patch preambles point at ../hooks.md as the authoritative hook index; the file does not exist anywhere in the repo

*Engine architecture, build hygiene, patch series* · **UNVERIFIED**

**Where.** `lobium/patches/series` — 21-22 ("Status of every hook, with its exact file and line, is in ../hooks.md"), and again at 31 and 95

**Mechanism.**

A recursive search of E:/project for hooks.md returns nothing. The series header, the device-frame entry ("See ../hooks.md 'device frame' before enabling it"), the WebGPU note ("See ../hooks.md 'WebGPU'"), and previously several patch preambles all defer the per-hook rationale to a document that was never written. docs/ contains only ENGINEERING.md, LOBEE_AGENT_ROADMAP.md, OPERATIONS.md and STATUS.md. The series file is otherwise an unusually good piece of documentation - it now explains the one-patch-per-concern rule, the ordering chains and the deliberate exclusions - so the dangling pointer stands out, and every 'see hooks.md for the limitations' deferral in a patch preamble is currently a deferral to nothing.

**How a detector sees it.**

```
`Get-ChildItem -Recurse -Filter hooks.md E:/project` returns no results while `Select-String -Path lobium/patches/series -Pattern 'hooks.md'` returns three hits.
```

**Fix.**

Either write lobium/hooks.md - one section per hook: upstream file, function, what it overrides, the fallback when the config is absent, and the known limitation - or remove the three references and fold the per-hook detail into each patch's preamble, which is where the series header already says the source of truth lives. Add an assertion to patch-series.test.mjs that any path referenced from series or a preamble as `../<name>` actually exists.

#### `config-channel-renderer-only` — --lobium-fp-data is appended only to renderer command lines, so the network/utility/GPU processes have no config channel and the planned net/ patches would silently no-op

*Engine architecture, build hygiene, patch series* · **UNVERIFIED**

**Where.** `lobium/patches/core/config-channel.patch` — the sole hooked file is content/browser/renderer_host/render_process_host_impl.cc, in PropagateBrowserCommandLineToRenderer

**Mechanism.**

The browser reads --lobium-fp-config and base64s it into --lobium-fp-data inside RenderProcessHostImpl::PropagateBrowserCommandLineToRenderer, which by construction runs only for renderer children. Chromium builds each child command line explicitly, so the out-of-process network service (--type=utility --utility-sub-type=network.mojom.NetworkService), the GPU process and other utility hosts never receive either switch, and LobiumFpConfig::Current() returns nullptr there. That is correct and sufficient for every surface hooked today - I checked: all 23 include sites are renderer-side except components/embedder_support/user_agent_utils.cc, which runs in the browser and does get --lobium-fp-config. But series lines 101-102 plan net/tls-ja3-ja4.patch (BoringSSL ClientHello ordering) and net/http2-settings-order.patch, both of which execute inside the network service. Wired the way the channel is today, those hooks would compile, link, apply cleanly, and do nothing - the exact silent-spoof-failure mode this codebase otherwise fails closed on. //components/lobium_fp itself links fine anywhere (it is a genuine //base-only leaf), so this is a transport gap, not a build-graph gap.

**How a detector sees it.**

```
After launching with a config, inspect child command lines (Process Explorer, or `Get-CimInstance Win32_Process | ? CommandLine -match 'utility-sub-type=network'`): --lobium-fp-data is present on every --type=renderer line and absent from the network service line.
```

**Fix.**

Before authoring any net/ patch, extend the transport: add the same cached base64 forward to content/browser/utility_process_host.cc (and the GPU host if a WebGPU adapter hook ever lands), or - better for a payload that is already bumping against the 28 KB command-line guard the patch itself documents - replace the command-line transport with a read-only shared memory region or a small mojo interface handed to each child at startup. Whichever is chosen, add a capability string to core/capability-contract.patch (e.g. "config-channel-net-v1") so the sidecar can refuse a binary whose net hooks would be inert rather than launching one that silently leaks the host TLS fingerprint.

#### `spn-base-index-misaligned` — ScriptProcessorNode farble key is offset from the true frame index by 2*bufferSize - renderQuantum, and is computed through a lossy double round-trip that can truncate to N-1

*Web Audio* · **CONFIRMED** · previously documented as a known limitation

**Where.** `lobium/patches/core/config-channel.patch` — 975-976 (const size_t base = static_cast<size_t>(playback_time * external_input_buffer_->sampleRate());)

**Mechanism.**

Two defects. (1) Alignment: script_processor_handler.cc:265-266 computes playback_time = (Context()->CurrentSampleFrame() + buffer_size_) / sampleRate, and the dispatch happens synchronously from inside Process() (line 205-215, waitable event), so CurrentSampleFrame() is M = the start frame of the CURRENT quantum. The buffer that just filled holds absolute frames [M + 128 - bufferSize, M + 128). The hook's base is therefore M + bufferSize, which is off by 2*bufferSize - 128 frames (8064 frames for bufferSize 4096). The patch preamble concedes 'it is NOT claimed to index-align', but combined with the pass-through double-farble above it becomes observable, and it defeats the stated design goal of 'one key per (seed, absolute frame) across all routes'. (2) Precision: (N/sr)*sr is not exactly N in IEEE double for arbitrary N and sr=44100; static_cast<size_t> TRUNCATES, so the key silently becomes N-1 for whichever dispatches land on the low side of the rounding. The key sequence is deterministic but arbitrary, and adjacent dispatch key ranges can overlap by one sample.

**How a detector sees it.**

```
Concretely visible via the pass-through-SPN vs direct-render comparison in audio-worklet-spn-double-farble (the misalignment is why the SPN case shows two independent perturbations rather than a clean square). Directly: instrument the hook and compare `base` against the true frame of external_input_buffer_ frame 0 for bufferSize in {256, 4096} - the gap is 2*bufferSize - 128. Not independently detectable from JS without the double-farble route.
```

**Fix.**

Compute the key from the integer frame count, not from a float seconds value: pass the dispatch frame down as an integer (Context()->CurrentSampleFrame() + renderQuantum - buffer_size_) rather than re-deriving it as playback_time * sampleRate. Or drop index keying entirely in favour of value keying, which removes the whole class of problem.

**Skeptic.**

Both sub-claims verified, but the severity is too high.

Alignment: script_processor_handler.cc:169-171 points internal_input_bus_ at shared_input_buffer[buffer_read_write_index_ .. +128); :189-190 wraps the index; :197-216 dispatches synchronously (waitable_event->Wait()) for the offline path; :265-266 computes playback_time = (CurrentSampleFrame() + buffer_size_)/sampleRate. CurrentSampleFrame() is M (the advance at offline_audio_destination_handler.cc:330 has not happened yet), the filled buffer holds absolute frames [M+128-bufferSize, M+128), and the hook's base is M+bufferSize. Offset = 2*bufferSize - 128 exactly, as claimed (8064 for bufferSize 4096).

Precision: I measured it rather than asserting it. For N = 128k, k=1..20000, static_cast<size_t>((N/sr)*sr) < N in 1373/20000 cases (6.9%) at sr=44100 (first at N=1920) and 1363/20000 at sr=48000 (first at N=3456). Real defect, confirmed.

Why low, not medium: the finding itself concedes it is 'not independently detectable from JS'. The alignment half is explicitly documented in the hook comment (config-channel.patch:969-971, 'it is NOT claimed to index-align'), and the precision half has literally zero detection consequence — the key sequence is still a deterministic pure function of the render, so the SPN tap remains stable-per-profile and distinct-per-seed, which is all it needs to be. Its only real cost is that it makes the pass-through-SPN double-farble two independent perturbations instead of a clean square, which is already counted under audio-worklet-spn-double-farble. Counting it again at medium double-counts.

#### `realtime-gating-asymmetry` — AnalyserNode float+byte hooks are NOT offline-gated while the AudioWorklet and SPN taps ARE, so in one realtime context two APIs reading the same node disagree about the same sample

*Web Audio* · **PARTLY_TRUE**

**Where.** `lobium/patches/core/config-channel.patch` — 869-872 / 890-893 / 913-916 / 937-940 (analyser hooks, no HasRealtimeConstraint check) vs 760 (worklet: gated on IsOfflineContext()) and 972 (SPN: gated on !HasRealtimeConstraint())

**Mechanism.**

The four analyser hooks fire unconditionally, including in a realtime AudioContext; the worklet and SPN taps deliberately do not. So in a single realtime graph, ConstantSourceNode(0.5) fanned out to both an AnalyserNode and an AudioWorkletNode yields exactly 0.5 through the worklet and 0.5 +/- 0.15% through the analyser. Honest Chrome returns exactly 0.5 through both. The asymmetry also means the realtime analyser is the only farbled surface that a page can read without any OfflineAudioContext, so the cheapest form of the known-input oracle needs no offline render at all. (I verified the offline gate itself is sound: audio_worklet_messaging_proxy.cc:106-138 selects OfflineAudioWorkletThread if and only if realtime_buffer_duration is nullopt, which is set unconditionally for a realtime context because AudioContext::PlatformBufferDuration() returns a non-optional base::TimeDelta; and OfflineAudioContext is Exposed=Window only, so there is no worker path. is_offline_context_ can never be true for a realtime worklet nor false for an offline one.)

**How a detector sees it.**

```
`const c=new AudioContext(); await c.audioWorklet.addModule(<processor that postMessages inputs[0][0][0]>); const s=new ConstantSourceNode(c,{offset:0.5}); const a=new AnalyserNode(c,{fftSize:2048}); const w=new AudioWorkletNode(c,'p'); s.connect(a); s.connect(w); s.start(); ... const td=new Float32Array(2048); a.getFloatTimeDomainData(td);` Honest: worklet sample === 0.5 and td.every(v=>v===0.5). Lobium: worklet says 0.5, analyser says 0.5*(1+e_i) - the two APIs contradict each other inside one context, in realtime, with no offline render.
```

**Fix.**

Value-key the kernel so every route agrees regardless of gating (see audio-index-keyed-noise). Do not fix this by gating the analyser to offline - that would hand the pristine host analyser output back to every realtime probe.

**Skeptic.**

The code observation is exactly right and I confirmed it: the four analyser hooks (config-channel.patch:869-872, 890-893, 913-916, 937-940) have no context gate, while the worklet tap is gated on IsOfflineContext() (:760) and the SPN tap on !HasRealtimeConstraint() (:972). So yes, in one realtime AudioContext an AnalyserNode and an AudioWorkletNode fed by the same ConstantSourceNode disagree.

But the finding is mis-framed and over-rated.

(a) It identifies the wrong defect. The finding's own fix section concedes that gating the analyser to offline would be WORSE (it would hand the pristine host analyser to every realtime probe), i.e. the asymmetry is a deliberate and defensible design choice. The actual defect is index-keying rather than value-keying, which is audio-index-keyed-noise. Everything detectable here is a restatement of that finding on the realtime path.

(b) The detection is weaker than presented. It needs a RUNNING realtime AudioContext. Under Chrome's autoplay policy a fresh AudioContext starts suspended without a user gesture; while suspended the graph does not render, input_buffer_ stays zero, and 0.0f*(1+eps) == 0.0f — so the oracle silently returns 'clean'. The claim that this is 'the cheapest form of the known-input oracle' is only true on a page that has already had user interaction; the offline version in audio-index-keyed-noise needs nothing.

The unique marginal content over finding 2 is thin, so low, not medium.

#### `worklet-currentframe-trylock-stale` — The worklet farble key can go stale for a quantum because currentFrame is updated under a try-lock that is allowed to fail

*Web Audio* · **CONFIRMED**

**Where.** `lobium/patches/core/config-channel.patch` — 764 (farble_base_index = global_scope_->currentFrame();) via base_audio_context.cc:922-937

**Mechanism.**

BaseAudioContext::UpdateWorkletGlobalScopeOnRenderingThread uses DeferredTaskHandler::GraphAutoTryLocker and simply skips the SetCurrentFrame(CurrentSampleFrame()) call when the graph lock is contended (e.g. the main thread is mutating the graph via connect()/disconnect() during the render). When that happens, the next quantum's process() sees the previous quantum's currentFrame, so two different 128-frame blocks are farbled with the identical eps sequence and, worse, the worklet's key stops matching the offline result's absolute index for the rest of the render. It is a race, so it is nondeterministic across runs of the same page - which is itself the opposite of the 'stable per profile' property the whole design rests on.

**How a detector sees it.**

```
Hard to trigger deliberately from JS but observable as flakiness: run the pass-through-worklet vs direct-render comparison from audio-worklet-spn-double-farble repeatedly while calling connect()/disconnect() on an unrelated node during the render, and look for runs where the b[i]/a[i] ratio sequence shifts by exactly one render quantum. Mostly a determinism/robustness concern rather than a detector oracle.
```

**Fix.**

Do not derive the farble key from the worklet global scope's mirrored currentFrame. Either maintain a private monotonic frame counter incremented by render_quantum_size on each AudioWorkletProcessor::Process call, or - better - remove index keying in favour of value keying so the key cannot go stale at all.

**Skeptic.**

Verified: base_audio_context.cc:925-936 wraps SetCurrentFrame(CurrentSampleFrame()) in a DeferredTaskHandler::GraphAutoTryLocker and silently skips the update when the lock is not acquired, so config-channel.patch:764's farble_base_index = global_scope_->currentFrame() can indeed be one quantum stale.

Two qualifications the finding does not make. First, the window is narrow: in an offline render the render loop runs on the worklet thread and the graph lock is only contended when the main thread is concurrently mutating the graph, and HandlePreRenderTasks at offline_audio_destination_handler.cc:299 is itself competing for that lock in the same loop. Second, and more important, a stale key is HARMLESS on its own — the worklet tap is designed as an independent surface, so a duplicated eps sequence across two quanta is not observable from JS. It only becomes observable in combination with the pass-through double-farble, where it turns a deterministic (1+e)^2 into a run-to-run-varying product. So it is genuinely a determinism/robustness nit that inherits its (small) detectability from audio-worklet-spn-double-farble. Low is correct; the finding's own severity is already low, so this is a confirm with the scope narrowed.

#### `config-version-forward-open` — Version negotiation accepts arbitrarily NEWER schemas, so a newer sidecar silently leaves every new field unspoofed on an older binary

*Config channel, capability contract, launcher* · **PARTLY_TRUE**

**Where.** `lobium/src/lobium_fp_config.cc` — 174-180 (and kSupportedVersion at :32; lobium-config.ts:31, 128)

**Mechanism.**

ParseConfig rejects only cfg.version < kSupportedVersion. The comment argues that an exact `== 1` would make a newer sidecar "silently disable ALL spoofing", but the chosen alternative is not safer, only quieter: a v1 binary handed a v2 document parses the v1 subset and IGNORES every v2 key, so each newly-added surface falls back to the host individually while the launch reports full success. That is the same partial-spoof state as finding #1, reached through a routine version skew (sidecar auto-updates, engine binary pinned). Nothing else catches it: the capability manifest carries only contractVersion (a separate number, checked for exact equality at lobium-capabilities.ts:52) and no supported-config-schema version, and validateLobiumConfig (lobium-config.ts:128) compares the document against the SIDECAR's own LOBIUM_CONFIG_VERSION constant, so it can never observe the binary's.

**How a detector sees it.**

```
Bump LOBIUM_CONFIG_VERSION to 2 in packages/engine-runner/src/lobium-config.ts, add any new field, and launch against the current binary. probeLobiumBuildCapabilities passes, buildLobiumConfig passes, the browser starts, and the v2 surface reports host values. Same page-side probe as #1, but only the new surface diverges - which makes it much harder to notice in a smoke test.
```

**Fix.**

Reject version > kSupportedVersion as well (a config from the future is not parseable by definition), AND publish the supported schema version in the capability manifest (e.g. "configVersion":1) so the sidecar can refuse before spawn with a clear "engine too old" message. Forward-compat should be expressed by bumping the capability token (config-channel-v2) rather than by loosening the version check.

**Skeptic.**

The code reading is correct: lobium_fp_config.cc:174-180 rejects only `cfg.version < kSupportedVersion`, and validateLobiumConfig (lobium-config.ts:128) compares against the SIDECAR's own LOBIUM_CONFIG_VERSION, never the binary's. But the severity and the fix are both wrong. THE FIX IS SELF-DEFEATING: adding `reject version > kSupportedVersion` on top of the existing `<` check is arithmetically identical to the exact `== 1` match the code comment at :175-177 deliberately rejected, and it makes the outcome STRICTLY WORSE by the finder's own finding-#1 logic — ParseConfig returning nullopt kills the BROWSER-side config too, so GetUserAgent falls back to stock and GetUserAgentMetadata emits an unbranded 'Chromium' Sec-CH-UA brand list (no 'Google Chrome'), a hard tell, instead of a v1-subset spoof. Only the second half of the fix (publish configVersion in the manifest and refuse before spawn) is sound. THE SCENARIO IS ALSO LARGELY BLOCKED ALREADY: parseCapabilities (lobium-capabilities.ts:51-57) requires `contractVersion === 1` exactly AND rejects any capability token not in KNOWN_CAPABILITIES, so the described 'sidecar auto-updates, engine pinned' skew hard-fails the launch the moment the new sidecar adds either a contract bump or a new token. The silent path requires a developer to add a v2 config field with no token and no contract bump — a process slip, not a mechanism. No present defect; latent. Low.

#### `native-reader-has-no-required-field-or-integrity-check` — The native parser accepts any subset of the schema and has no integrity hash; only the writer validates, and one launcher path bypasses the writer entirely

*Config channel, capability contract, launcher* · **PARTLY_TRUE**

**Where.** `lobium/src/lobium_fp_config.cc (+ packages/engine-runner/src/lobium-config.ts, packages/engine-runner/src/runners/lobium-launcher.ts)` — lobium_fp_config.cc:165-216 (ParseConfig), 221-227 (Load); lobium-config.ts:120-157 (validateLobiumConfig); lobium-launcher.ts:283-285 (opts.extraArgsFor bypass)

**Mechanism.**

ParseConfig uses value_or() / FindString() everywhere and never asserts that any field is present. A document missing `screen`, or with `unmaskedRenderer` misspelled, parses successfully and produces a config whose corresponding hooks all fall through to the host - the same partial spoof, with no error at all this time (not even a LOG). The only guard is validateLobiumConfig on the writer side, which is reachable only via buildLobiumConfig(); buildNativeLobiumProcessArgs (lobium-launcher.ts:283-285) uses opts.extraArgsFor when supplied, bypassing both validateLobiumConfig and the size guard in writeLobiumConfig. On truncation specifically the channel does fail: base::Base64Decode defaults to Base64DecodePolicy::kStrict (base/base64.h:53-56 - length divisible by 4, no stray chars) and JSONReader is called with JSON_PARSE_RFC, so a mangled blob is rejected - but it is rejected into the same silent fail-open, and there is no hash, so a STALE or WRONG-PROFILE lobium-fp.json (well-formed, complete, but for a different persona) is indistinguishable from the right one.

**How a detector sees it.**

```
Hand-edit <userDataDir>/lobium-fp.json to delete the whole "screen" object (or rename "unmaskedRenderer" to "unmasked_renderer") and launch. No error anywhere; screen.width/height/availWidth and UNMASKED_RENDERER_WEBGL report the operator's real display and GPU while everything else stays persona.
```

**Fix.**

Mirror validateLobiumConfig's required-field set inside ParseConfig and return nullopt (which, with finding #1's fix, becomes fatal) when any of navigator.userAgent/platform/hardwareConcurrency/deviceMemory/languages/uaBrands, screen.width/height/devicePixelRatio/colorDepth, webgl.unmaskedVendor/unmaskedRenderer, locale.timezone/locale is absent. Add a `"digest":"<sha256 of the canonicalised document minus this field>"` and a `"profileId"` so a truncated, mangled, or stale/mismatched config is positively identified rather than partially applied.

**Skeptic.**

ParseConfig's use of value_or()/FindString() with no required-field assertion is correctly described (lobium_fp_config.cc:165-216), and base::Base64Decode's kStrict default is confirmed at E:\lobium-build\src\base\base64.h:40-56. But the two things that give the finding its bite are both wrong. (1) THE 'BYPASS' IS TEST-ONLY AND UNREACHABLE IN PRODUCTION: `extraArgsFor` is not exposed to the product. default-launchers.ts:33 declares `BuildLaunchersOptions = Pick<NativeLobiumLauncherOptions, 'headless' | 'extraArgs'>` and line 45 constructs the only production launcher from that Pick — `extraArgsFor` cannot be supplied. A repo-wide grep finds it referenced only in lobium-launcher.ts:66/283-284 and lobium-launcher.test.ts:385/433. So validateLobiumConfig and the size guard are on the only reachable path. (2) THE 'STALE OR WRONG-PROFILE lobium-fp.json' SCENARIO IS NOT REACHABLE: buildLobiumLaunchArgs (lobium-launcher.ts:253-275) calls writeLobiumConfig on EVERY launch, overwriting <userDataDir>/lobium-fp.json from ctx.fingerprint before spawn, so a hand-edited or stale file cannot survive a launch — it requires an attacker with local write access racing the write/spawn window, at which point argv injection is easier. The residual valid point is narrow: ParseConfig mirrors none of the writer's checks, so any future writer path or schema drift fails open silently. Low, and note the finder's own required-field list omits the fields that actually leak (see missedByFinder).

#### `windows-cmdline-budget-too-thin` — The 28 KiB --lobium-fp-data cap leaves only ~4 KiB for the rest of the Windows renderer command line against the 32767-WCHAR CreateProcess limit

*Config channel, capability contract, launcher* · **PARTLY_TRUE**

**Where.** `lobium/patches/core/config-channel.patch (+ packages/engine-runner/src/lobium-config.ts)` — config-channel.patch:168-178 == render_process_host_impl.cc:4066-4077 (kMaxLobiumFpDataBytes = 28u*1024u); lobium-config.ts:33-34 and 233-241

**Mechanism.**

Windows caps the ENTIRE lpCommandLine passed to CreateProcess at 32767 characters, and base/process/launch_win.cc:265 hands CommandLine::GetCommandLineString() straight to it with no length check of its own. A Chromium 152 renderer line on Windows already carries --type=renderer, --user-data-dir, --app-user-model-id, --string-annotations, --lang, --device-scale-factor, --renderer-client-id, --time-ticks-at-unix-epoch, --launch-time-ticks, --field-trial-handle, --enable-features / --disable-features (variations-driven; routinely 1-3 KiB on a seeded profile), --variations-seed-version and /prefetch:N - typically 2-4 KiB. 28672 + 17 ("--lobium-fp-data=") + ~4 KiB sits within a few hundred characters of the ceiling. For comparison, Chromium's own file-to-switch precedent that this patch copies documents its payload as "usually <2 KB" (render_process_host_impl.cc:4029). Overflow is an availability failure, not a leak: CreateProcess fails and every renderer dies, so the browser is an endless sad-tab. Measured worst case for a realistic persona today is ~5-8 KiB of JSON (navigator ~0.5K, webgl.caps ~0.45K, webgl.extensions ~1.5-3K for a full desktop capture, shaderPrecision ~0.7K, the rest <1K) -> ~7-11 KiB base64, so the cap is not currently binding. It becomes binding the moment LobiumConfig.fonts is populated: lobium-config.ts:190-196 documents that a macOS catalog (~2500 names) blows past it, which is precisely why fonts is hardcoded to []. Minor: the sidecar guard at lobium-config.ts:233 measures only the payload, not the 17-character switch prefix.

**How a detector sees it.**

```
Deterministic, not probabilistic: temporarily populate config.fonts with a full macOS family list (or pad any string field) so the base64 lands between ~28 KiB and the true ceiling, launch on Windows with a seeded variations profile, and watch every renderer fail to spawn. Below 28 KiB you instead hit the SKIP branch and get the finding-#1 partial spoof.
```

**Fix.**

Lower kMaxLobiumFpDataBytes to ~16 KiB, include the switch-name length in both guards, and keep the two constants in sync via a generated header rather than the comment at lobium-config.ts:33. Better: stop shipping the payload on argv. Pass it the way Chromium passes field trials - a read-only shared-memory region whose handle is inherited and named on the command line - which removes the size cliff, the truncation surface, and the argv exposure in one change.

**Skeptic.**

The constants and the absence of a length check are right (render_process_host_impl.cc:4068 kMaxLobiumFpDataBytes = 28u*1024u; base/process/launch_win.cc:265 hands GetCommandLineString() straight through; the GaiaConfig 'usually <2 KB' precedent is at :4030), and the fonts cliff is real and documented. BUT THE HEADROOM MATH IS REFUTED. The finder's largest single term — '--enable-features / --disable-features (variations-driven; routinely 1-3 KiB on a seeded profile)' — does not exist on a child command line. base/metrics/field_trial.cc:687-719 `PopulateLaunchOptionsWithFieldTrialState` passes the entire field-trial/variations state through a READ-ONLY SHARED MEMORY region (`shared_memory_switch->AddToLaunchParameters`, surfaced as `--field-trial-handle`), and only appends --enable-features/--disable-features for overrides the USER put on the command line (:703-706). For Lobium that is `--disable-features=ReduceAcceptLanguage[,<proxy hardening>]`, a few dozen bytes. A real Chromium 152 Windows renderer line is on the order of ~1 KiB, not 2-4 KiB, so 28 KiB is nowhere near 'a few hundred characters of the ceiling'. Combined with the finder's own admission that a realistic persona is ~7-11 KiB base64 and that fonts is hardcoded to [] (lobium-config.ts:190-204), the cap is not binding and has ~4 KiB of slack even at the cap. It is a documented latent limit (patch comment :4062-4067 and lobium-config.ts:33-34/190-196 both say so), not a medium defect. The shared-memory transport recommendation is the right long-term fix. Low.

#### `capability-probe-brittle-on-windows` — The capability probe parses raw stdout and allows 5 s for a cold chrome.dll load, so unrelated engine chatter or a slow first launch turns into a total launch failure

*Config channel, capability contract, launcher* · **PARTLY_TRUE**

**Where.** `packages/engine-runner/src/lobium-capabilities.ts` — 38-46 (JSON.parse(stdout.trim())), 75-99 (execFileAsync with timeout: 5_000)

**Mechanism.**

parseCapabilities requires stdout to be EXACTLY the manifest JSON. Any additional byte on stdout - an ANGLE/Dawn/SwiftShader warning, a third-party DLL injecting a banner (common on Windows: AV, RDP, GPU vendor overlays), a CRT message - makes JSON.parse throw and every profile launch fail with "did not return a valid native capability manifest". Separately, the probe execs the real chrome.exe, which on Windows loads chrome_elf.dll, then the ~200 MB chrome.dll, and initialises crash reporting before ChromeMain reaches the early return at capability-contract.patch:21; a cold first launch with Defender scanning the DLL can exceed the 5 s timeout, producing "cannot prove native fingerprint capabilities". Both directions are fail-closed (correct) but they convert a benign environment quirk into a hard product outage, and there is no retry - the cache entry is deleted (line 90) so every subsequent launch pays the same cost and fails the same way. Note also that the probe never passes --user-data-dir, so it relies entirely on the early return firing before Chromium touches the default profile.

**How a detector sees it.**

```
On Windows, run the probe with any stdout-writing DLL injected, or on a machine where the first chrome.dll load is slow (fresh install, on-access AV): `execFile(chrome.exe, ['--lobium-fingerprint-capabilities'])` either returns manifest JSON prefixed by noise or times out. Both make createLobiumLauncher throw before spawn.
```

**Fix.**

Extract the manifest with a tolerant scan (take the last line that parses as an object with product === 'Lobium') rather than JSON.parse of the whole stream; raise the timeout to ~20 s for the first probe of a given path; retry once on timeout before failing the launch. Have the engine write the manifest to a file named by the switch value instead of stdout if robustness matters more than convenience.

**Skeptic.**

The three code facts are right: parseCapabilities does `JSON.parse(stdout.trim())` on the whole stream (lobium-capabilities.ts:38-46), the timeout is 5_000 (line 84), and no --user-data-dir is passed. The early return at capability-contract.patch:21-31 does land before any profile access (it is inserted right after `CommandLine::ForCurrentProcess()` in ChromeMain, ahead of ContentMain), so that concern is fine. BUT two claims do not hold. (1) 'unrelated engine chatter' on STDOUT is speculative: execFileAsync separates stdout and stderr, so ANGLE/Dawn/SwiftShader warnings (stderr, and only after GPU init the early return skips) are harmless, and Windows AV/RDP/GPU-overlay DLLs log to files or OutputDebugString, not to an inherited stdout pipe. No concrete stdout-writing injector was identified. (2) 'there is no retry — the cache entry is deleted (line 90) so every subsequent launch pays the same cost and fails the same way' is backwards: deleting the cache key is precisely what makes the NEXT launch re-probe, and by then the ~200 MB chrome.dll is in the OS file cache, so the second attempt is warm and will almost certainly beat 5 s. A cold-start timeout costs one failed launch, not a persistent outage. Both directions remain fail-closed, which the finder correctly notes. Low.

#### `browser-side-blocking-read-on-ui-thread` — LobiumFpConfig::Current() does synchronous disk I/O with no ScopedAllowBlocking; in the browser process the first caller is GetUserAgent() on the UI thread

*Config channel, capability contract, launcher* · **CONFIRMED**

**Where.** `lobium/src/lobium_fp_config.cc` — 221-227 (Load -> base::ReadFileToString) reached from 252-261

**Mechanism.**

base::ReadFileToString -> ReadFileToStringWithMaxSize opens with ScopedBlockingCall(MAY_BLOCK) (base/files/file_util.cc:81), whose constructor calls AssertBlockingAllowed() (base/threading/scoped_blocking_call.cc:43), which is DUMP_OR_DCHECK(!tls_blocking_disallowed) (base/threading/thread_restrictions.cc:63). content/browser/browser_main_loop.cc:1089 calls base::DisallowUnresponsiveTasks() on the UI thread. The browser's first Current() call comes from embedder_support::GetUserAgent() via ChromeContentBrowserClient (chrome/browser/chrome_content_browser_client.cc:6947, 7701-7707), which runs on the UI thread. The config-channel patch's own comment at render_process_host_impl.cc:4041-4044 shows the author was aware that a ScopedAllowBlocking is needed on this thread - it is present for the browser's forwarding read but absent from the module's own Load() path. Whether the assert actually trips depends on whether the first GetUserAgent() precedes DisallowUnresponsiveTasks() during PreMainMessageLoopRun; on a dcheck_always_on build it is a hard failure, and on any build it is a synchronous open+read of a profile file on the UI thread during startup. Not web-detectable - a correctness/robustness defect.

**Fix.**

In Current()'s browser branch, either wrap the Load() call in a base::ScopedAllowBlocking with a comment (one-time read of a small local file written before launch), or have the browser hand the already-read contents to the module explicitly at startup (an Initialize(std::string_view) called from the same place render_process_host_impl.cc already does the ScopedAllowBlocking read) so the module never touches the filesystem itself.

**Skeptic.**

Verified. `Load()` (lobium_fp_config.cc:221-227) calls base::ReadFileToString with no ScopedAllowBlocking; ReadFileToStringWithMaxSize takes ScopedBlockingCall(MAY_BLOCK) whose ctor calls AssertBlockingAllowed, which is DUMP_OR_DCHECK — and base/threading/thread_restrictions.cc:48 currently defines `#define DUMP_OR_DCHECK DCHECK`, over `tls_blocking_disallowed` set by content/browser/browser_main_loop.cc:1089 `base::DisallowUnresponsiveTasks()` (end of PreMainMessageLoopRun, line 1092 returns). The inconsistency the finder points at is real and self-evidencing: the very same patch does wrap its browser-side read in `base::ScopedAllowBlocking allow_blocking;` at render_process_host_impl.cc:4050 with a justifying comment, but the module's own Load() path has none. Worth stating the practical bound the finder hedged on correctly: with dcheck_always_on=false and is_official_build=true (gn-args-windows.gn:15-18) DCHECK compiles out, so the shipping binary cannot crash here — the residual is a one-time synchronous open+read of a small local file on the UI thread during startup, plus a hard DCHECK failure for anyone building with dcheck_always_on. Correctness/robustness only, not web-detectable. Low is right, and the 'hand the already-read contents to the module' fix is the cleaner of the two.

#### `windows-config-file-and-argv-exposure` — The "owner-only, 0600" claim for lobium-fp.json does not hold on Windows, and the same persona rides every renderer's argv where any same-user process (and every minidump) can read it

*Config channel, capability contract, launcher* · **CONFIRMED**

**Where.** `packages/engine-runner/src/lobium-config.ts (+ lobium/patches/core/config-channel.patch)` — lobium-config.ts:222-243 (writeFile ... { mode: 0o600 }); config-channel.patch:170-172 (AppendSwitchASCII of the base64 blob)

**Mechanism.**

Node's fs mode on Windows only maps the FILE_ATTRIBUTE_READONLY bit; POSIX permission bits are ignored and the file inherits the parent directory's ACL, so the header comment "owner-only, 0600" and the SECURITY note at lobium-config.ts:26-28 overstate the protection on the shipping platform. Contents include locale.geolocation latitude/longitude, net.proxy {type,host,port}, the per-profile farbling seeds (which are the profile's unlinkability secret - knowing them lets an observer de-farble or link canvas/audio hashes), and the full persona. The same document is then base64'd onto EVERY renderer command line, and on Windows any process running as the same user can read another process's command line via NtQueryInformationProcess/PEB or Win32_Process.CommandLine; Windows minidumps capture the PEB, so a crash upload carries the whole persona. The browser process's own line additionally exposes --lobium-fp-config=<path> and is displayed verbatim on chrome://version.

**How a detector sees it.**

```
Local only, not web-reachable: `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select CommandLine` recovers the base64 blob from any same-user shell; `icacls <userDataDir>\lobium-fp.json` shows inherited, non-restricted ACLs. Relevant as a threat-model gap (a co-resident agent can link profiles or recover the proxy endpoint), not as a page-side detector signal.
```

**Fix.**

On Windows set an explicit restrictive DACL on the profile directory and on lobium-fp.json rather than relying on the mode argument, and update the comments to state the actual guarantee per platform. Moving the payload off argv (see the shared-memory recommendation in the command-line-budget finding) removes the argv and minidump exposure at the same time. Consider omitting net.proxy from the file entirely - the native reader never consumes it.

**Skeptic.**

Accurate. Node's fs mode on Windows maps only FILE_ATTRIBUTE_READONLY (and 0o600 has the write bit set, so it does not even do that); the file inherits the parent directory ACL, so the 'owner-only, 0600' claim in the writeLobiumConfig docstring (lobium-config.ts:222) does not describe the shipping platform. The contents genuinely include locale.geolocation lat/long, net.proxy {type,host,port}, and the per-profile farbling seeds — and I confirmed the seeds are the profile's unlinkability secret, derived in buildLobiumConfig:205-213 and consumed by the canvas/WebGL/audio/clientRects/mediaDevices kernels. The same document rides every renderer's argv via AppendSwitchASCII (render_process_host_impl.cc:4070), readable by any same-user process on Windows. The observation that ParseConfig never consumes net.proxy is correct — it reads only `net.webrtcPolicy` (lobium_fp_config.cc:212-214) — so dropping that field is a free win. TWO SMALL OVERREACHES: the SECURITY note at lobium-config.ts:26-28 is about proxy CREDENTIALS and is accurate as written (no credentials are in the file); it is the writeLobiumConfig docstring that overstates. And the minidump/crash-upload vector is speculative for an unbranded build with no configured crash server. Also worth saying: on Windows the practical boundary for both the file and argv is 'same user', which is roughly what 0600 buys on POSIX too, so the delta is smaller than the write-up implies. Local threat-model gap, not a detector signal. Low is right.

#### `fleet-constant-ua-platform-version` — Sec-CH-UA-Platform-Version is a single hard-coded constant per OS (Windows 15.0.0, macOS 14.5.0), so the whole fleet reports one implausibly uniform OS build

*navigator / User-Agent / UA client hints* · **PARTLY_TRUE**

**Where.** `packages/fingerprint/src/pools.ts` — 131 (`WINDOWS uaPlatformVersion: '15.0.0'`) and 212 (`MACOS uaPlatformVersion: '14.5.0'`); the only override is packages/engine-runner/src/start-profile.ts:146-157

**Mechanism.**

`applyProfileOsVersion` can only ever produce `10.0.0` (Windows 10) or `15.0.0` (Windows 11), and macOS only `<major>.0.0` when the user explicitly picks a version — otherwise every macOS persona is `14.5.0` and every Windows persona `15.0.0`. On Windows the value is the UniversalApiContract version (user_agent_utils.cc:114-155); Chromium 152 itself records `kHighestKnownUniversalApiContractVersion = 19` (:81), i.e. current Windows 11 24H2/25H2 hosts report `19.0.0`. A Lobium fleet therefore has zero mass at the version most real Chrome-152-on-Windows-11 users report, and a hard spike at 15.0.0 / 14.5.0. Each individual value is legal, so this is a population-level rather than a per-session tell.

**How a detector sees it.**

```
Not a single-session boolean. A detector that buckets `Sec-CH-UA-Platform-Version` per account (trivial, it is a header once `Accept-CH` is set) sees an account cluster whose Windows profiles are 100% `15.0.0` and whose Mac profiles are 100% `14.5.0`, against a real-world distribution spread over 10.0.0 / 14.0.0 / 15.0.0 / 19.0.0 and macOS 13/14/15/26. Combined with the other fleet constants (colorDepth, availTop, deviceMemory ∈ {4,8}) this is usable for cross-account linking.
```

**Fix.**

Draw `uaPlatformVersion` from a market-share-weighted table seeded by the profile seed (as pools.ts already does for GPU/screen), including Windows `19.0.0` for 24H2/25H2 and macOS 15.x/26.x; extend `applyProfileOsVersion` with the missing mappings (and a linux branch that forces `''`, see the linux finding) so the user-facing OS-version picker stays authoritative.

**Skeptic.**

The constants and the mechanism are real; the fleet-uniformity story is wrong for the actual product path.

VERIFIED: pools.ts:131 WINDOWS '15.0.0', :212 MACOS '14.5.0', :284 LINUX '6.8.0'. applyProfileOsVersion (start-profile.ts:146-157) maps only Windows 10 -> 10.0.0, Windows 11 -> 15.0.0, macOS <major> -> <major>.0.0. Windows platformVersion really is the UniversalApiContract version (user_agent_utils.cc:112-155) and `kHighestKnownUniversalApiContractVersion = 19` at :81.

WRONG: "macOS only <major>.0.0 when the user explicitly picks a version — otherwise every macOS persona is 14.5.0 and every Windows persona 15.0.0". In the desktop product, osVersion is ALWAYS set: createProfileDraft seeds `osVersion: OS_VERSION_OPTIONS[os][0]` (profileDraft.ts:225), and start-profile.ts:321 applies it unconditionally. So macOS personas default to 'macOS 26 Tahoe' -> '26.0.0', not '14.5.0'; the 14.5.0 constant is only reachable via an API caller that omits osVersion. The real, narrower population complaint is: Windows collapses to exactly two values {10.0.0, 15.0.0}, and macOS to `<major>.0.0` with a hard-zero minor and bugfix — whereas real macOS Chrome reports base::SysInfo::OperatingSystemVersionNumbers verbatim, i.e. values like 15.6.1, so `x.0.0` is only plausible in the weeks after a major release.

ALSO OVERSTATED: "zero mass at the version most real Chrome-152-on-Windows-11 users report". 15.0.0 is itself a legitimate, currently-reported Windows 11 contract version. And `kHighestKnownUniversalApiContractVersion = 19` is only Chromium's FALLBACK for when the HKLM WellKnownContracts key is unreadable (user_agent_utils.cc:139-143) — it is not evidence of what real hosts report. That part of the argument is an assertion about the world, not something the source supports.

Severity low is correct: population-level linkage only, every individual value is legal, and it needs cross-session bucketing to exploit.

#### `device-frame-linux-only-mobile-viewport` — The Android device-frame viewport is #if BUILDFLAG(IS_LINUX) — on the Windows product a mobile profile gets a desktop-sized viewport with a 412px screen.width

*Screen, DPR, viewport, media queries, clientRects* · **PARTLY_TRUE**

**Where.** `lobium/patches/branding/device-frame.patch + packages/engine-runner/src/runners/lobium-launcher.ts` — device-frame.patch:9-11, 47-52, 86-110, 111-140 (all LobiumDeviceFrameView call sites guarded by IS_LINUX; the switches kDeviceFrameSwitch/kDeviceScreenSwitch are declared only in the added lobium_device_frame_view.cc at patch line 243-244); lobium-launcher.ts:310-317, 336-352

**Mechanism.**

The build target is Windows, and every consumer of `--lobium-device-frame` / `--lobium-device-screen` lives inside LobiumDeviceFrameView, which BrowserView only instantiates under `#if BUILDFLAG(IS_LINUX)`. On Windows both switches are parsed by nobody, and the renderer device-emulation image scale the preamble describes ("Native BrowserView computes the exact content-area fit scale … keeps the renderer's device-emulation image scale locked to the aperture") is never applied. Meanwhile the launcher, seeing a mobile profile, actively STRIPS `--window-size=` and `--window-position=` from the arg list (lobium-launcher.ts:348-352) and adds `--start-maximized`. Net effect on Windows: the window opens maximized at the host desktop size and the page's layout viewport is the full desktop, while Screen::GetRect serves the persona's phone rect from packages/fingerprint/src/android.ts:133-142 (e.g. 412x915) and MediaValues::CalculateDeviceWidth/Height serve 412/915 as well. window.innerWidth > screen.width is physically impossible in any real browser.

**How a detector sees it.**

```
innerWidth > screen.width || innerHeight > screen.height  // ~2544 vs 412 on a 2560-wide host. Corroborate with matchMedia('(device-width:412px)').matches === true while document.documentElement.clientWidth is ~2544, and with CSS 100vw >> screen.width.
```

**Fix.**

Either port the device-frame view to Windows (drop the IS_LINUX guards and add the win BUILD.gn sources), or — until it is ported — make the launcher stop stripping --window-size for mobile profiles on non-Linux and instead pass `--window-size=<persona width>,<persona height>` plus a native viewport/DSF override, so the layout viewport actually matches the phone screen the config advertises. Failing both, block launching an Android-emulated profile on Windows rather than shipping a guaranteed contradiction.

**Skeptic.**

The code observation is right: every LobiumDeviceFrameView call site in device-frame.patch (:9-11, 19-24, 32-34, 42-46, 55-57, 65-81, 102-106, 135-137, 149-151, 162-172, 186-204) is inside #if BUILDFLAG(IS_LINUX), and --lobium-device-frame / --lobium-device-screen are read only inside the added lobium_device_frame_view.cc (:243-244, 269-282, 304-309). On Windows both switches are inert, there is no phone bezel, and no native aperture->emulation-scale sync. BUT THE DETECTION IS REFUTED. The mobile viewport does not come from the device-frame view at all — it comes from CDP. packages/engine-runner/src/runners/lobium-launcher.ts:762-771 calls installMobileEmulationForAllTargets for every `ctx.isMobileProfile` on every platform, and mobile-emulation.ts:50-63 issues Emulation.setDeviceMetricsOverride with width/height = the persona screen, mobile:true, screenWidth/screenHeight = persona. That drives ScreenMetricsEmulator (core/frame/screen_metrics_emulator.cc:109-117, 142-143, 157-167), which sets widget_size, screen_rect, available_rect AND the window rect to the emulated values. So innerWidth is 412, not the desktop width; `innerWidth > screen.width` is false, `(device-width:412px)` matches with clientWidth ~412, and outerWidth/screenX are 412/0 rather than host values. What survives is a real but cosmetic/product defect: on Windows the phone renders as a small letterboxed image (scale from device-frame.ts:88-92 with resolveDesktopWorkArea falling back to the 1920x1080 env default because it shells out to `xrandr`, device-frame.ts:59) inside a maximized window, and never re-fits on resize. Fingerprint severity high -> low. The 'block launching an Android profile on Windows' fix rests on a false premise.

#### `dpr-frozen-under-page-zoom` — devicePixelRatio is pinned to the persona and no longer tracks page zoom, unlike every real Chrome

*Screen, DPR, viewport, media queries, clientRects* · **CONFIRMED**

**Where.** `lobium/patches/fingerprint/screen-dpr.patch (hooks core/frame/local_dom_window.cc:1918 and core/css/media_values.cc:196)` — screen-dpr.patch:91-104 and :62-77; upstream reference third_party/blink/renderer/core/frame/local_frame.cc:1848-1855

**Mechanism.**

Real Chrome computes window.devicePixelRatio as `LocalFrame::DevicePixelRatio() = InspectorDeviceScaleFactorOverride() * LayoutZoomFactor()`, and LayoutZoomFactor includes browser page zoom. Ctrl+/- therefore changes devicePixelRatio and innerWidth together, in exact inverse proportion — a relation anti-fraud SDKs that sample geometry on `resize` see constantly. Both Lobium hooks return cfg->screen.device_pixel_ratio unconditionally, so after a zoom change innerWidth/innerHeight move while devicePixelRatio and matchMedia('(resolution: Xdppx)') do not move at all. The two hooks are at least consistent with each other (the patch's stated goal), so this needs a zoom event to observe rather than a single synchronous read — hence low.

**How a detector sees it.**

```
let w0=innerWidth, d0=devicePixelRatio; addEventListener('resize',()=>{ const rw=innerWidth/w0, rd=devicePixelRatio/d0; if (Math.abs(rw-1)>0.02 && Math.abs(rd-1)<1e-9) report('dpr frozen under zoom'); });  // then wait for the user's Ctrl+/-. Real Chrome: rd ≈ 1/rw.
```

**Fix.**

Multiply the persona DPR by the live zoom rather than replacing the whole product: return `cfg->screen.device_pixel_ratio * (frame->LayoutZoomFactor() / frame->GetPage()->InspectorDeviceScaleFactorOverride())`, or more simply scale the persona value by the browser zoom level, in BOTH LocalDOMWindow::devicePixelRatio and MediaValues::CalculateDevicePixelRatio so they stay in step.

**Skeptic.**

Mechanism verified. local_frame.cc:1848-1855 `DevicePixelRatio() = InspectorDeviceScaleFactorOverride() * LayoutZoomFactor()`, and LayoutZoomFactor (local_frame.h:441) is the live layout zoom, so real Chrome's window.devicePixelRatio moves inversely with innerWidth on Ctrl+/-. Both Lobium hooks return the persona value with no zoom term: local_dom_window.cc devicePixelRatio (screen-dpr.patch:98-101, applied in the checkout) and MediaValues::CalculateDevicePixelRatio (media_values.cc:196-208). They are mutually consistent, so the tell needs a zoom event to observe; low is the right severity. ONE DEFECT IN THE FIX: `cfg->screen.device_pixel_ratio * (frame->LayoutZoomFactor() / frame->GetPage()->InspectorDeviceScaleFactorOverride())` is wrong. InspectorDeviceScaleFactorOverride is 1 in normal browsing, so it reduces to persona_dpr * LayoutZoomFactor, and LayoutZoomFactor already includes the HOST device scale factor under use-zoom-for-dsf — on a 150%-scaled Windows host at 100% page zoom that returns 1.5x the persona DPR and destroys the spoof entirely. Only the second variant the finder offers ('scale the persona value by the browser zoom level', i.e. persona_dpr * LayoutZoomFactor / host_DSF) is correct, and it must be applied identically in both hooks.

#### `screen-patch-preamble-stale-availtop` — screen-dpr.patch documents availLeft/availTop as unimplemented and as forced to 0, but the hook it ships consumes both

*Screen, DPR, viewport, media queries, clientRects* · **CONFIRMED** · previously documented as a known limitation

**Where.** `lobium/patches/fingerprint/screen-dpr.patch` — preamble :37-40 vs hook comment :136 vs hook body :143-145

**Mechanism.**

Three statements in one patch contradict each other and the code. The KNOWN LIMITATIONS block (lines 38-40) says macOS availTop is 0 and that fixing it "needs avail_left/avail_top threaded through shared-types + the catalog (derive.ts)"; the in-hook comment at line 136 says "availLeft/Top become 0 (a full-screen available rect)"; the actual hook at lines 143-145 returns `gfx::Rect(cfg->screen.avail_left, cfg->screen.avail_top, …)`. The threading the preamble calls deferred is in fact complete end to end: packages/shared-types/src/fingerprint.ts:36-42 defines the fields, derive.ts:121/132-133 sets availTop=25 for macOS, coherence.ts:507-531 enforces it, lobium-config.ts:201 serialises the whole screen object, and lobium_fp_config.cc:79-80 parses availLeft/availTop. So avail_left/avail_top are NOT dead config — but a reviewer trusting the preamble would conclude they are, and the contradictory line 136 comment invites someone to "fix" the hook back to hard-coded zeros. On the Windows target the values are 0 either way, so there is no runtime tell here; this is a maintainability/documentation defect only.

**Fix.**

Delete the first KNOWN LIMITATIONS bullet (lines 38-40) and rewrite the line 136 comment to state that availLeft/availTop come from the persona (0 on Windows/Linux, ~25 top inset on macOS). While there, add a defensive clamp in ReadScreen (lobium/src/lobium_fp_config.cc:74-83) so avail_left+avail_width <= width and avail_top+avail_height <= height, which the native side currently trusts the sidecar to guarantee.

**Skeptic.**

All three contradictory statements verified. screen-dpr.patch:38-40 says fixing macOS availTop 'needs avail_left/avail_top threaded through shared-types + the catalog (derive.ts)'; the in-hook comment shipped into screen.cc:184-185 says 'availLeft/Top become 0 (a full-screen available rect)'; the hook body two lines later (screen.cc:191-193) returns gfx::Rect(cfg->screen.avail_left, cfg->screen.avail_top, ...) with its own comment (:188-190) explaining the opposite. The threading is indeed complete: shared-types/src/fingerprint.ts:35-42 declares availLeft/availTop, derive.ts:121/132-133 sets availTop=25 for macOS, lobium_fp_config.cc:79-80 parses both. Documentation-only on Windows, low is correct. The ReadScreen clamp suggestion is worth taking (lobium_fp_config.cc:74-83 currently trusts the sidecar; host-calibration.ts:54-61 clamps but derive.ts does not). SECOND INSTANCE THE FINDER MISSED, same patch, same class: the comment injected into local_dom_window.cc (screen-dpr.patch:96-97) reads 'NOTE: CSS resolution media queries still reflect the real DPR — full DPR coherence (matchMedia) is a documented follow-up', which the SAME patch contradicts at :65-77 by hooking MediaValues::CalculateDevicePixelRatio, and which the preamble at :19-26 explicitly says was required. That stale note is now live in the checkout at media_values.cc's sibling file and invites exactly the same wrong 'cleanup' as the availTop one.

#### `host-desktop-environment-media-queries` — System-preference media queries and CSS system colours report the host desktop's real settings, shared identically by every profile

*Surfaces with no coverage at all* · **UNVERIFIED**

**Where.** `no Lobium coverage; hooked Chromium files third_party/blink/renderer/core/css/media_values.cc and third_party/blink/renderer/core/layout/layout_theme.cc` — media_values.cc (patched by screen-dpr.patch and media-values-device-size.patch for DPR + device-width/height ONLY); layout_theme.cc `SystemColor`/`DefaultSystemColor` (kAccentcolor branch → `GetAccentColorOrDefault`)

**Mechanism.**

screen-dpr.patch and media-values-device-size.patch hook exactly two things in media_values.cc — `CalculateDevicePixelRatio` and the device-width/height pair. Everything else in that file still resolves from the real host: `prefers-color-scheme`, `prefers-reduced-motion`, `prefers-contrast`, `forced-colors`, `dynamic-range`/`video-dynamic-range` (real monitor HDR capability), `(pointer)`/`(hover)`/`(any-pointer)`, `inverted-colors`, and `prefers-reduced-transparency`. Separately, `LayoutTheme::SystemColor` routes through `SystemColorFromColorProvider`, whose `kAccentcolor`/`kAccentcolortext` branch returns the host's Windows accent colour when exposure is allowed. Individually these are low-entropy, but they are (a) an OS-behaviour cluster — `forced-colors` and the accent colour are Windows concepts — and (b) byte-identical across every profile on the machine, so together with `dynamic-range` (which describes the physical monitor, not the persona's claimed screen) they form a stable host signature that no amount of canvas/audio/WebGL per-profile farbling breaks.

**How a detector sees it.**

```
```js
const q = ['(prefers-color-scheme: dark)','(prefers-reduced-motion: reduce)',
  '(forced-colors: active)','(dynamic-range: high)','(prefers-contrast: more)',
  '(pointer: fine)','(hover: hover)','(inverted-colors: inverted)']
  .map(s => +matchMedia(s).matches).join('');
const el = document.createElement('div');
el.style.color = 'AccentColor'; document.body.appendChild(el);
const accent = getComputedStyle(el).color;  // the host's Windows accent colour
// (q + accent) is identical for every Lobium profile on one machine.
```
CreepJS explicitly collects the CSS system-colour table and the preference media queries and hashes them.
```

**Fix.**

Extend the existing media_values.cc hook set: serve persona/seed-derived values for `prefers-color-scheme`, `prefers-reduced-motion`, `prefers-contrast`, `forced-colors`, `inverted-colors` and `dynamic-range` from the config (a handful of booleans in the schema), so they are stable per profile and vary across profiles. Force `can_expose_accent_color=false` at the `LayoutTheme::SystemColor` call site so `AccentColor`/`AccentColorText` fall back to the fixed defaults rather than the host accent. Lowest priority of this set, but it is cheap and it closes the last no-cost cross-profile join key.

## Raised by the skeptics, missed by the finders

### Canvas 2D / OffscreenCanvas / ImageBitmap

- CHEAPEST AND MOST COMPLETE ORACLE, MISSED: known-input putImageData -> getImageData, two calls, no drawing, no host knowledge. The finder reported the three-call round trip (getImageData -> putImageData -> getImageData) but missed that putImageData alone makes every pixel's exact value page-chosen, which directly falsifies the design premise stated at lobium_farble.cc:22-26 ('the noise must be confined to pixels whose exact value a page cannot predict'). Script: build a 64x64 ImageData filled pseudorandomly with channel values in [1,254] and alpha 255, putImageData it, then getImageData. Honest Chrome returns the byte-identical array (PutByteArray at base_rendering_context_2d.cc:644-658: kUnpremul write, exact for alpha==255; kOpaque memcpy for {alpha:false}). Bit-exact simulation of the current kernel: 8190 of 12288 colour channels differ, delta set exactly {-1,0,+1}. Worse than a tell: out-minus-src IS the complete delta map d(x,y,c) for the whole canvas (pseudorandom input guarantees no pixel is flat, values in [1,254] guarantee no clamping). The attacker then clears, draws the real fingerprint scene, takes ONE getImageData and subtracts the map, recovering the pristine host canvas in about four API calls instead of the finder's W*H 1x1 reads. This should be the top-ranked canvas finding.
- MISSED: median-of-copies recovery with a single readback, which defeats any purely coordinate-keyed additive scheme and needs neither putImageData nor a 1x1 loop. Because d depends only on the absolute coordinate and not on the pixel value, drawImage of the same scene at K different (x,y) offsets onto one large canvas gives K independent samples orig + d(x+k, y+k) per pixel; a per-channel median across the copies recovers orig. Simulated K=9 on a random 64x64 scene: 1475/4096 pixels recovered exactly with a single getImageData; the rate rises with K, and since the delta alphabet is only {-1,0,+1} a coordinate is pinned exactly as soon as both -1 and +1 appear among the samples. The finder explicitly examined the drawImage path and concluded it 'stays coherent', which is true but is precisely what makes this attack work.
- MISSED: the read-modify-write drift as a product-quality defect, not just a detection. Because the perturbation is applied on every readback and there is no putImageData hook, any page that loops getImageData -> mutate -> putImageData (image editors, pixel-art tools, canvas-based filters, feedback/blur effects) accumulates a fresh +/-1 per channel per iteration. Over tens of frames this becomes visible banding, and it drifts deterministically in the same direction each time because d is fixed per coordinate. The kernel's own no-compounding claim (canvas-farbling.patch:16-18, 'the live canvas is never touched, so repeated reads cannot compound') is true only for pure reads.
- MISSED: lobium_farble.h was not updated alongside the kernel rewrite and now misdescribes it. The header contract (lines 15-20) says the kernel nudges 'each visible pixel' keyed on (seed, absolute coordinate, channel) and promises the getImageData/toDataURL results are 'identical ... for the same pixel'. Neither is true: the content-dependent flat-run gate (lobium_farble.cc:62-96) decides whether a pixel is touched at all, is not mentioned in the header, and is what makes a 1x1 read and a full read disagree. Any future caller reading only the header will make the same wrong assumption the base_rendering_context_2d.cc hook already makes about pixel format.
- MISSED: the perturbed-pixel SET is seed-independent by design (lobium_farble.cc:35-37 states this explicitly as a feature). Since the predicate is a public function of image content alone, a detector that has reverse-engineered it once knows, for any scene it chooses, exactly which pixels carry noise and which are returned pristine. Combined with the +/-1 alphabet this reduces the whole defence to a 32-bit secret that one known-input round trip recovers in full.
- MISSED (validation gap, minor): ci/validation/lobium-detect.mjs:84-94 records only fnv(c.toDataURL()) for a fillRect+fillText scene. The fillRect(0,0,110,20) contributes nothing (solid -> flat -> unfarbled, confirmed by simulation) and the glyph/emoji anti-aliasing is the only thing that moves the hash, so the gate confirms 'the hash changed' but cannot detect any of the tamper oracles above. There is no probe anywhere in ci/validation for the 1x1-vs-full-read mismatch, the putImageData round trip, or the createImageBitmap -> bitmaprenderer -> toDataURL bypass, which is why this class of defect is invisible to the project's own CI.

### WebGL 1 and WebGL 2

- WebGPU adapter identity is completely unspoofed and is the cheapest contradiction of UNMASKED_RENDERER in this dimension — the finder explicitly declined it as 'outside this dimension', which I think is wrong since it is the same GPU-identity surface. Verified in the checkout: third_party/blink/renderer/modules/webgpu/gpu_adapter_info.idl:11-17 exposes vendor, architecture, device, description, subgroupMinSize/MaxSize and isFallbackAdapter with NO RuntimeEnabled guard (only driver/backend/type/memoryHeaps/d3dShaderModel sit behind WebGPUDeveloperFeatures). Nothing in packages/engine-runner/src disables WebGPU (grep for --disable-webgpu / dawn flags returns nothing; gpu.ts:77-88 only sets --use-gl/--use-angle). So `(await navigator.gpu.requestAdapter()).info.vendor` returns the real 'intel'/'nvidia'/'amd' next to a persona UNMASKED_RENDERER claiming another vendor in validated_preset mode, and adapter.limits classifies the true backend class in every mode. lobium/patches/series:70 lists fingerprint/webgpu-adapter.patch as NOT AUTHORED and ci/validation/detector-matrix.json:367-375 already tracks webbrowsertools' WebGPU fingerprint page, so this is known-but-open, not unknown.
- The finder treated both halves of finding 1 as equally unverified by CI, but ci/validation/product-e2e.mjs:324-329 and :371-378 already gate 'every name from getSupportedExtensions() must be enableable via getExtension()' on a webgl2-first context. That gate would have caught the pre-runtime-safety inversion (WebGL1-only names advertised on WebGL2) and it passes under the full series precisely because the intersection deletes them — so CI actively certifies the worse state. The cheap CI fix is to add the converse assertion (a webgl2 context must expose EXT_color_buffer_float) rather than to rely on the existing check.
- On the primary host-calibrated path the WebGL1 extension hook is semantically a NO-OP: cfg->webgl.extensions IS the host's own WebGL1 list, so the intersection at webgl_rendering_context_base.cc:4730-4739 reproduces exactly what stock Chrome would have returned. The only observable changes it makes on WebGL1 are the sort-order permutation (finding 6) and the case-sensitivity regression (finding 5). Framed that way, host-gpu-profile.patch's extension hook is pure downside on WebGL1 and catastrophic on WebGL2 for the default renderer mode — it only earns its keep in validated_preset mode, which is exactly the mode that never populates the field (finding 10). That inversion is worth calling out as the structural conclusion the ten findings add up to.
- A plausible-looking WebGL1/WebGL2 divergence that I checked and can rule out, so the team does not chase it: getShaderPrecisionFormat has no WebGL2 override either, so the WebGL1-captured precision buckets are served on WebGL2 too — but ANGLE reads those from mState.getCaps() (Context.cpp:7442-7502) and Context::initCaps (Context.cpp:4190-4420) does not client-version-gate any of the vertex/fragment Lowp/Mediump/Highp Float/Int caps, so an ES2 and an ES3 context on the same display report identical values. Same for maxVaryingVectors / maxVertexUniformVectors / maxFragmentUniformVectors, which is why the ANGLE 4x identity in finding 2 does not break on the host-calibrated path.
- Minor, preset-mode only: two more backend-truth reads sit outside the caps set and are never intercepted — getParameter(COMPRESSED_TEXTURE_FORMATS) (real backend format list) and getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) once EXT_texture_filter_anisotropic is enabled. ANGLE normalises both heavily within a backend so the entropy is small, but they belong on the same list as the WebGL2-only MAX_* in finding 2 when the webgl2/caps capture work is scoped.

### Web Audio

- KERNEL IS DIMENSIONALLY WRONG IN THE dB DOMAIN, AND DEGENERATES AT ZERO. lobium_audio_farble.cc:47 applies a RELATIVE multiply, and config-channel.patch:869-872/890-893 applies it to DECIBEL values from LinearToDecibels. dB is already logarithmic, so a relative nudge there is a power-law distortion in linear magnitude whose size grows with quietness: a bin at -100 dB moves by +/-0.15 dB = +/-1.74% in LINEAR magnitude, ~11x the '+/-0.15%, -56 dBFS, inaudible' budget the header (lobium_audio_farble.h:21) and the patch preamble (audio-context.patch:7-8) both claim. Conversely a bin near 0 dB is perturbed by essentially nothing, so the LOUDEST bins of getFloatFrequencyData are returned near-pristine host values. Same degeneracy in the time domain: any sample that is exactly 0.0f (pre-start silence, post-stop silence, an exact zero crossing) is returned bit-identical to the host. The perturbation magnitude is therefore inversely correlated with signal level — the opposite of any plausible noise model, and a structure a detector can fit.
- STRONGER, WHITELIST-FREE FORM OF THE KNOWN-INPUT ORACLE: SHIFT-INVARIANCE. Honest Chrome's offline render of a source delayed by an integral number of frames is a bit-exact shift of the undelayed render — ConstantSourceNode uses std::ranges::fill (constant_source_handler.cc:101-103) and AudioBufferSourceNode takes ProcessFastPath, a straight copy, whenever computedPlaybackRate == 1 and the virtual indices are integral (audio_buffer_source_handler.cc:454-461). Because eps is keyed on the absolute index, Lobium breaks this: render the SAME graph twice, once with start(0) and once with start(128/44100), then compare r2[128+i] against r1[i]. Honest Chrome: exactly equal for every i. Lobium: they differ by (1+e_{128+i})/(1+e_i), up to ~0.3% per sample. This needs no known constant, no ground-truth buffer, no whitelist, no worklet and no analyser — it is a pure invariance test on two renders of the detector's own choosing, and it is strictly cheaper and more robust than the ConstantSourceNode version in audio-index-keyed-noise. Any fix that keys on index rather than value leaves it open.
- PER-CALL HEAP ALLOCATION IN THE HOT BYTE-ANALYSER PATHS, UNCONDITIONAL ON THE SEED. config-channel.patch:885 (`std::vector<float> db(len);`) and :927 (`std::vector<float> pcm(len);`) allocate and value-initialise on EVERY getByteFrequencyData / getByteTimeDomainData call, before the `cfg && cfg->seeds.audio` check, so the cost is paid even with farbling disabled. Upstream (realtime_analyser.cc:143-163, 199-219) allocates nothing on these paths — they are single fused loops. fftSize can be 32768, so len can be 16384 floats = 64 KB per call, and a typical visualizer calls these at 60 Hz per AnalyserNode. This is a straight performance regression relative to stock Chrome and a (weak) timing side channel on the most commonly-called audio API. Trivially fixable: hoist the buffer behind the seed check, or use a member scratch vector.
- O(N) KERNEL RUN SYNCHRONOUSLY ON THE MAIN THREAD IN FireCompletionEvent. config-channel.patch:809-823 farbles the entire rendered buffer, all channels, inside OfflineAudioContext::FireCompletionEvent, which runs on the main thread. offline_audio_context.cc takes number_of_frames as an unsigned with no length cap beyond allocation success, so a page can legally do new OfflineAudioContext(2, 44100*600, 44100) = ~53 M kernel iterations (splitmix64 + two double multiplies each) blocking the main thread before the promise resolves. Honest Chrome dispatches the completion event immediately. That is real jank a page can weaponise, and in aggregate it gives a startRendering()-latency-versus-length slope that stock Chrome does not have.
- hooks.md DOES NOT EXIST. series:9 ('See hooks.md for the hook point + code of each'), series:37, audio-context.patch:36 ('See hooks.md for the documented KNOWN LIMITATIONS ...') and audio-context.patch:51 all point at hooks.md as the authoritative record of the audio hooks and their accepted limitations. A recursive glob over all of E:\project finds no hooks.md anywhere. So every limitation the preambles claim is 'documented' — including 'known-input ratio inversion', which is finding audio-index-keyed-noise, and 'AudioWorklet / ScriptProcessorNode upstream taps' — is documented nowhere. This matters for the audit's own framing: several of these findings are named-but-never-analysed rather than genuinely undocumented, and there is no written acceptance of any of them.
- CLOSING THE FINDER'S OWN OPEN QUESTION ON THE SEED RANGE (not a finding). seeds.audio cannot silently be 0 by accident: DEFAULT_HARDWARE_NOISE.audio = true in all four launch paths (start-profile.ts:44-49, start-android-profile.ts:31-36, start-android-emulated-profile.ts:24-29, android-config.ts:62-67), and the seed is hashStringToUint32(`${base}:audio`) — an FNV-1a over a per-profile string (prng.ts:4-11) with no zero guard, so seed 0 arises only on a 2^-32 collision or when an operator explicitly disables audio noise. The whole audio surface silently reverting to pristine host values is therefore a configuration choice, not a latent bug.

### Screen, DPR, viewport, media queries, clientRects

- THE GATE: hardwareNoise.clientRects defaults to FALSE in every product entry point (packages/engine-runner/src/lobium-config.ts:90, start-profile.ts:48, start-android-profile.ts:35, start-android-emulated-profile.ts:28, android-config.ts:66), and lobium-config.ts:209 emits seeds.clientRects = 0 when off, which makes the entire client-rects hook inert via the `cfg->seeds.client_rects` guard. Only ci/validation/native-policy-probe.mjs:130, ci/validation/creepjs-battle.mjs:112, and the user-facing 'Client Rects' switch in apps/desktop/src/features/fingerprint/FingerprintEditor.tsx:125,812 (default false) enable it. The finder rated four clientRects findings critical/high as if they were shipping-on and never checked the default — every one of them is opt-in.
- THE MOBILE VIEWPORT IS A CDP OVERLAY, NOT NATIVE: packages/engine-runner/src/mobile-emulation.ts:50-63 sends Emulation.setDeviceMetricsOverride (width/height/screenWidth/screenHeight = persona, mobile:true, explicit screenOrientation) for every mobile profile on every platform, installed at runners/lobium-launcher.ts:762-771. This is what actually supplies the mobile viewport, screen orientation and window rect (screen_metrics_emulator.cc:109-167) — it refutes finding 6's detection and finding 8 outright. It is also a finding in its own right: it directly contradicts the project's stated principle that no surface is spoofed via a CDP overlay, and because installMobileEmulationForAllTargets runs only AFTER waitForEndpointOrExit + cookie import, the already-restored first tab can render and run script at desktop metrics while Screen::GetRect (native, live from process start) already reports 412x915 — a transient, platform-independent `innerWidth > screen.width` window on startup.
- macOS PERSONA availTop vs screenY — the sharpest instance of the outer-geometry problem, only alluded to: WindowSizer places a fresh window at work_area.origin + kWindowTilePixels (chrome/browser/ui/window_sizer/window_sizer.cc:356-358) and --window-position is never passed (launch.ts only passes --window-size), so screenY = 10 on a bottom-taskbar Windows host, while a macOS pool persona reports screen.availTop = 25 (derive.ts:121,133 -> lobium_fp_config.cc:80 -> screen.cc:191-193). macOS forbids a window above the menu bar, so screenY (10) < availTop (25) is impossible on a real Mac. Zero interaction, first launch, 100% of Mac personas on Windows hosts.
- --window-size IS NOT CLAMPED: chrome/browser/ui/browser_window_state.cc:154-162 applies the command-line override AFTER WindowSizer::GetBrowserWindowBoundsAndShowState, and :174-181 calls bounds->set_size() with no work-area intersection — the WindowSizer's bounds->AdjustToFit(work_area) (window_sizer.cc:276-282) has already run. The real failure mode on a high-DPI Windows host is an oversized window hanging off the desktop with JS-coherent outerWidth, not the capped outerWidth finding 9 describes.
- SECOND STALE COMMENT IN screen-dpr.patch: the hook comment injected into local_dom_window.cc (screen-dpr.patch:96-97) still claims 'CSS resolution media queries still reflect the real DPR — full DPR coherence (matchMedia) is a documented follow-up', which the same patch contradicts at :65-77 (the MediaValues::CalculateDevicePixelRatio hook) and at :19-26. Same maintainability defect as finding 11, in the same file, and it invites re-breaking the media-query half of the DPR spoof.
- QUIRK ASYMMETRY between the two screen hooks: Screen::GetRect's Lobium branch returns before the ReportScreenSizeInPhysicalPixelsQuirk / TextScaleMetaTagPresent scaling (screen.cc:186-194 vs :198-202), while media-values-device-size.patch:21-24 and :38-41 DO apply the quirk by multiplying by the persona DPR. If the quirk were ever enabled, screen.width and (device-width) would disagree — the exact CreepJS 'failed matchMedia' lie that patch exists to fix. Currently harmless on the shipping target: report_screen_size_in_physical_pixels_quirk is set only from WebPreferences (web_view_impl.cc:1831) and is never set anywhere in content/ or chrome/ for desktop, so it is false on Windows. Worth a comment rather than code.
- DESKTOP-PERSONA ORIENTATION, the direction finding 8 got backwards: because desktop profiles get no CDP emulation and no orientation hook exists, a normal 1920x1080 persona on a host with a rotated/portrait monitor reports screen.orientation.type 'portrait-primary' with angle 90 against a landscape persona rect — the same spec contradiction, in the only configuration where it can actually occur.

### navigator / User-Agent / UA client hints

- ANDROID TABLET PERSONAS LEAK THE DESKTOP PDF PLUGIN SURFACE — the finder listed this as VERIFIED-CLEAN (#8), and it is only clean for phones. mobile-persona.patch gates BOTH hooks on `cfg->navigator.ua_mobile` (dom_plugin_array.cc:57-60 in the constructor and :143-146 in IsPdfViewerAvailable, already applied in the checkout). deriveAndroidFingerprint sets `mobile = opts.deviceType !== 'tablet'` and `uaMobile: mobile` (android.ts:93, 129), so an Android TABLET persona has ua_mobile === false and both hooks fall through. On the Windows build `enable_pdf = !is_android && !is_ios && !is_castos && !is_fuchsia` (pdf/features.gni) is TRUE, so the constructor builds the five fixed plugins ('PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF', dom_plugin_array.cc:61-71) and NavigatorPlugins::pdfViewerEnabled -> IsPdfViewerAvailable() returns true (navigator_plugins.cc:75-77). Detection is one line: `JSON.stringify({p:navigator.plugins.length, m:navigator.mimeTypes.length, pdf:navigator.pdfViewerEnabled, plat:navigator.platform, ua:navigator.userAgent})` returns `{p:5, m:2, pdf:true, plat:'Linux armv81', ua:'...Android 14; SM-X210...'}`. Real Android Chrome reports `{p:0, m:0, pdf:false}` on EVERY form factor because enable_pdf is off for the whole platform. Deterministic, no permission, no Accept-CH. I'd rate this high for android-tablet profiles and it is a one-line fix (gate on `ua_platform == "Android"` rather than on `ua_mobile`).
- THE FAIL-CLOSED CAPABILITY CONTRACT CERTIFIES A HOOK THAT DOES NOT EXIST — core/capability-contract.patch:25 makes the binary print `process-locale-timezone` unconditionally, and lobium-capabilities.ts:109 puts it in the ALWAYS-required list, so assertLobiumBuildCapabilities (lobium-launcher.ts:707-716) passes on Windows while zero code applies the persona timezone. Worse, `cfg->locale.timezone` is parsed at lobium_fp_config.cc:152 into LocaleConfig::timezone (lobium_fp_config.h:122) and read by NO hook anywhere in the patch tree — it is dead config that makes lobium-fp.json look complete. validateLobiumConfig even hard-requires it (lobium-config.ts:146 `need(str(l?.timezone), 'locale.timezone')`). This is the mechanism specifically designed to prevent a silent spoof failure, and it is the mechanism that hides this one. It deserves to be called out separately from the timezone finding because the same pattern will hide the next unimplemented capability too.
- THE CI GATES THAT WOULD CATCH THE TIMEZONE GAP ARE STRUCTURALLY LINUX-ONLY — ci/validation/native-policy-probe.mjs:272 asserts `value.timezone === fp.locale.timezone` and lobium-detect.mjs:489 asserts `timezoneApplied: nat.timezone === fp.locale.timezone`, but both harnesses set the child env themselves (native-policy-probe.mjs:155, lobium-detect.mjs:406, creepjs-battle.mjs:351, deep-probe-50.mjs:99, tls-fingerprint.mjs:51) and therefore only ever exercise the POSIX path. Green CI on these gates is not evidence about the shipping Windows binary. The same is true of the FONTCONFIG_FILE/LANG/LC_ALL env the finder correctly flagged as inert.
- MOBILE EMULATION NEVER REACHES CROSS-SITE IFRAMES (see my finding-6 verdict) — I list it here too because the finder's own detection framed it as an intermittent race rather than a permanent structural hole, and the iframe case is the one an anti-bot vendor actually lands in.
- MINOR, WORTH A GLANCE: the Android emulated path passes `--lobium-device-frame=<formFactor>` and `--lobium-device-screen=WxH` (lobium-launcher.ts:339-340) plus '--start-maximized', but branding/device-frame.patch is documented at lobium/patches/series:28-31 as entirely `#if BUILDFLAG(IS_LINUX)` with its view file in no GN target. On the Windows target those switches are inert unknowns, so an Android persona gets a full-size maximized desktop window whose outer geometry has no relation to the 412x915 CSS screen the config claims. That is a screen/window-geometry concern rather than navigator-UA, so I am not scoring it here, but it interacts directly with the setDeviceMetricsOverride scale computed at lobium-launcher.ts:766-770.

### Config channel, capability contract, launcher

- DEEP-WEBGL CONFIG FIELDS ARE OPTIONAL AND VALIDATED BY NEITHER SIDE — the strongest miss, and it is the same partial-spoof class as finding #1 but reachable through the NORMAL path with no failure at all. packages/shared-types/src/fingerprint.ts:101-109 declares webgl.caps, version, shadingLanguageVersion, extensions and shaderPrecision as optional (`?`); validateLobiumConfig (lobium-config.ts:142-144) requires ONLY unmaskedVendor/unmaskedRenderer; and ParseConfig (lobium_fp_config.cc:113-148) leaves each unset field empty, which lobium_fp_config.h:110-118 documents as 'Empty/absent = leave the host value'. Those five fields are populated only by host calibration (packages/fingerprint/src/host-calibration.ts:75-83); the seed-derived pools (pools.ts:125/198/206/278/380) supply `caps` only. So a profile created before calibration ships a persona UNMASKED_RENDERER_WEBGL beside the host's real gl.VERSION, gl.SHADING_LANGUAGE_VERSION, getSupportedExtensions() and getShaderPrecisionFormat() — a one-call cross-check, and the 'webgl-deep' capability is REQUIRED at lobium-capabilities.ts:111 so the gate reports success. Note the finder's own proposed required-field list in finding #5 omits exactly these fields.
- THE CAPABILITY GATE IS FORWARD-INCOMPATIBLE IN THE OPPOSITE DIRECTION, which partly answers finding #4. parseCapabilities (lobium-capabilities.ts:51-57) rejects the manifest if contractVersion !== 1 OR if ANY advertised token is absent from KNOWN_CAPABILITIES. A NEWER engine that adds a token therefore hard-fails an older sidecar with 'incompatible native capability contract'. Engine and sidecar must move in lockstep, which is fail-closed and safe, but it means the 'sidecar auto-updates, engine pinned' skew in finding #4 is silent only if a developer adds a config field with neither a token nor a contract bump.
- screen-dpr.patch IS A VERBATIM DUPLICATE OF HUNKS ALREADY IN config-channel.patch — identical git blob ids (69ffc2b05f..cda8982346, 0d60244742..5b0f34d0a7, 6aa773e59b..910a3b3612) and identical bodies. The series applies both and `patch -p1 --forward` (build.ps1:178) skips the second as already-applied. Beyond refuting finding #3's example, this is a live maintenance hazard: two copies of the same hook can drift on a rebase, and the series comment at lines 45-49 attributes the screen hooks to the wrong patch. Same duplication exists between config-channel.patch and fingerprint/audio-context.patch (offline_audio_context.cc, realtime_analyser.cc) and fingerprint/audio-worklet-tap.patch (all four webaudio files).
- THE BUILD FAILS CLOSED ON PATCH REJECTION, which the finder should have checked before building finding #3's scenario on it: build.ps1:174-189 accumulates every non-zero `patch` exit into $failed and calls Die; build.sh:47 runs `quilt push -a` under `set -euo pipefail`. A rejected surface patch produces no binary.
- CHROMIUM 152 IS NOT LONG-PATH AWARE ON WINDOWS — no `longPathAware` in any of build/win/{as_invoker,common_controls,compatibility,require_administrator,segment_heap}.manifest nor chrome/app/chrome.dll.manifest — while Node/libuv transparently prefixes \\?\ on write. A `<userDataDir>\lobium-fp.json` path over 260 characters therefore writes successfully from the sidecar and is unreadable by base::ReadFileToString in the browser. This is the one concrete, non-adversarial trigger for finding #1's fail-open path (a); the finder identified it and then dropped it for lack of manifest evidence that is in fact available.
- THE `policy` BLOCK IS WRITTEN BUT MOSTLY UNREAD — ParseConfig (lobium_fp_config.cc:197-211) consumes only `policy.mediaDevices`. `policy.renderer` (RendererPolicy, including 'normalized_host'), `policy.hardwareNoise` and `policy.osVersion` are serialised by buildLobiumConfig:181-187 and ignored natively (noise is gated indirectly by zero seeds instead). A user selecting renderer normalisation in the UI gets a silent no-op in the engine, with no capability token covering it. series:64-65 records this as a known follow-up, so it is documented — but it is a config-channel field with a writer and no reader, which is exactly the shape of defect this dimension should surface.
- FONT ISOLATION IS INERT ON THE WINDOWS TARGET AND THE LAUNCHER STILL HARD-FAILS WITHOUT IT — buildLobiumLaunchEnv (lobium-launcher.ts:187-198) THROWS if no font pack is provisioned and then sets FONTCONFIG_FILE/FC_LANG, which have no consumer on Windows (Chromium uses DirectWrite; fontconfig is Linux/ChromeOS-only). The finder mentions this in passing inside finding #2 but does not draw the operational conclusion: on the shipping platform the launcher mandates a provisioning step that changes nothing, so the per-profile font surface silently reports the host catalog.

## Refuted — do not re-raise

- **`screen-orientation-host-values`** (Screen, DPR, viewport, media queries, clientRects) — screen.orientation.type/angle are pure host values — spec-impossible for any portrait persona
  - The unhooked-code observation is correct (grep for 'orientation' across lobium/patches returns nothing; ScreenOrientationController reads GetScreenInfo().orientation_type/angle), but the detection does not work for the case it claims. Portrait personas are Android personas, and every Android profile gets Emulation.setDeviceMetricsOverride with an explicit screenOrientation — mobile-emulation.ts:59-61 sends {type:'portraitPrimary', angle:0} for phones and {type:'landscapePrimary', angle:90} for tablets, unconditionally on all platforms (lobium-launcher.ts:762-771). That reaches the renderer: content/browser/devtools/protocol/emulation_handler.cc:66-77, 705-717 converts it into DeviceEmulationParams::screen_orientation_type, and screen_metrics_emulator.cc:124-131, 163-164 writes it into emulated_screen_info.orientation_type/angle, which is exactly the ScreenInfo ScreenOrientationController reads. So `screen.orientation.type === 'portrait-primary'` for a 412x915 persona — the claimed spec-impossible pairing never occurs. For desktop personas the finder concedes the host's landscape-primary/0 coincides with the persona's landscape geometry, which I confirm (display_util.cc:48 GetOrientationTypeForDesktop). Residual, much narrower case the finding does not describe: a DESKTOP persona on a host with a rotated (portrait) monitor would report portrait-primary/90 against a 1920x1080 persona screen, and desktop profiles get no CDP emulation to correct it. That is a genuine but niche host-dependent tell, worth a cheap derive-from-persona hook, not a medium-severity finding.
- **`canvas-solid-cascade`** (Canvas 2D / OffscreenCanvas / ImageBitmap) — FarbleCanvasRgba reads neighbours from the buffer it is mutating: the raster-order cascade destroys the documented "solid interiors stay exact" invariant -- 82% of a solid fillRect's pixels are modified, while a canvas-filling fillRect is modified 0%
  - Fixed in the current tree, and fixed with exactly the mechanism the finding asks for. lobium_farble.cc:56-61 carries a comment describing this precise bug ('this function walks in raster order, so by the time it reaches (x, y) the left neighbour (x-1, y) and the whole row above have already been rewritten. Reading those back made every pixel next to an already-nudged one look like an edge, so the farble cascaded outward from the first edge pixel and flooded solid interiors'). FarbleRows (lines 117-157) now keeps two std::vector<uint8_t> row buffers: `cur` is a memcpy of row y taken BEFORE any pixel of row y is written (line 135), `prev` holds row y-1's pristine bytes via cur.swap(prev) at line 154, and `next` points at row y+1 in the live buffer, which has not been visited yet (lines 136-138). IsFlatRun reads only cur/prev/next, never the mutated row. FarblePixel writes to `row + x*4` (line 150), i.e. the live buffer, but nothing reads it back.

## What each dimension examined

### Canvas 2D / OffscreenCanvas / ImageBitmap

Read in full: lobium/src/lobium_farble.{h,cc}; the complete lobium/patches/core/config-channel.patch (all 1121 lines) with focus on the html_canvas_element.cc, offscreen_canvas.cc and base_rendering_context_2d.cc hunks. Verified every Chromium-behaviour claim against the actual checkout at E:\lobium-build\src, which already has the patch series applied (base_rendering_context_2d.cc:518-527, html_canvas_element.cc:1253-1295/1343-1346/1451-1453, offscreen_canvas.cc:481-514 all match the patch). Upstream files read to verify claims: image_data.cc/.h/.idl, image_data_settings.idl, canvas_rendering_context.h, canvas_rendering_context_host.cc, image_bitmap_rendering_context.cc, image_data_buffer.cc, image_encoder.cc, SkPngRustEncoderImpl.cpp, SkPngEncoderBase.cpp, video_frame.cc/.idl, video_frame_copy_to_options.idl, canvas_context_creation_attributes_module.idl, canvas_2d_color_params.cc, runtime_enabled_features.json5.

Quantitative claims come from a bit-exact reimplementation of FarbleCanvasRgba/IsSolidInterior/FarblePixel in Python (scratchpad sim2/sim3/sim4.py), run on the geometries cited in each finding; the numbers quoted (82% of a solid fillRect modified, 312/400 sub-rect mismatch, 100% recovery via 2a-b, the float16 row, the unpremultiplied escape rates) are outputs of that simulation, not estimates.

Questions answered that did NOT produce a finding:
- Copy vs backing store / compounding: the farble is applied to a private buffer in every hook (the freshly allocated ImageData array for getImageData; a scratch SkBitmap for toDataURL/toBlob/convertToBlob). The live canvas is never mutated, so repeated getImageData calls do NOT compound. Correct as designed. (Compounding only appears via the putImageData write-back, reported separately.)
- Premultiplication: the header's claim is accurate. ImageData::GetSkPixmap() is kUnpremul_SkAlphaType and LobiumFarbleReadback requests kUnpremul explicitly, so nudging RGB independently of A can never create RGB>A. The downstream ImageDataBuffer takes its non-converting branch (image_data_buffer.cc:93-98) because the image is already unpremul, so there is no double conversion. The inverse hazard is reported as canvas-impossible-unpremultiplied-values.
- willReadFrequently: no effect on hook coverage; getImageDataInternal always reaches the hook through the same snapshot->readPixels path whether accelerated or not.
- Text/emoji scene: yes, it IS perturbed. Anti-aliased glyph pixels differ from their neighbours, so the solid-interior rule never protects them; only large flat fills are affected by the cascade bug.
- Cross-surface coherence for a FULL-canvas read: getImageData(0,0,W,H), toDataURL, toBlob and OffscreenCanvas.convertToBlob all farble the whole buffer at origin (0,0) with seeds.canvas, so on a plain sRGB 8-bit canvas they agree pixel-for-pixel. drawImage(otherCanvas) / createPattern / captureStream-then-draw also stay coherent because the source image is unfarbled and the noise is applied once at the destination read, keyed on destination coordinates. The coherence breaks reported above are the sub-rect case, the non-sRGB case, and the paths that skip the hook entirely.
- Could NOT check: nothing was executed in a real browser -- there is no built Lobium binary in the tree, so all behavioural claims are static-analysis plus bit-exact kernel simulation. In particular the exact perturbed-pixel counts assume the canvas raster values I modelled (an accelerated GPU canvas could differ by a rounding step in the premul->unpremul readback), and I did not confirm empirically that createImageBitmap(canvas) performs no colour conversion under the default options (the code path suggests a straight reference to the same StaticBitmapImage, and the bypass holds regardless since any conversion would apply equally to honest Chrome). ci/validation/lobium-detect.mjs draws fillRect(0,0,110,20) flush with the canvas origin, which is the one geometry where the cascade barely fires (114/2200 pixels) -- that is likely why this class of bug has not shown up in the project's own probe.

### WebGL 1 and WebGL 2

Read in full: lobium/patches/fingerprint/host-gpu-profile.patch, lobium/patches/fingerprint/webgl-runtime-safety.patch, the WebGL hunk of lobium/patches/core/config-channel.patch (lines 989-1121) plus its canvas hunks (469-673), lobium/src/lobium_farble.{h,cc}, lobium/src/lobium_fp_config.cc (ReadWebGl + ParseConfig), lobium/patches/series, packages/engine-runner/src/host-calibration-probe.ts, packages/engine-runner/src/lobium-config.ts, packages/engine-runner/src/start-profile.ts (webgl/preset path), packages/fingerprint/src/host-calibration.ts, packages/fingerprint/src/pools.ts (caps tables), packages/fingerprint/src/catalog{,.generated}.ts, packages/shared-types/src/fingerprint.ts, ci/validation/hc4-probe.mjs, ci/validation/fixtures/fp-probe.html, ci/validation/gpu-baseline.mjs, docs/ENGINEERING.md.

Verified against the real Chromium 152 checkout at E:\lobium-build\src (read-only): webgl_rendering_context_base.{h,cc} (getExtension/MatchesName/EnableExtensionIfSupported/getParameter/ReadPixelsHelper/GetPackPixelStoreParams/getSupportedExtensions), webgl2_rendering_context_base.cc (getParameter switch and its single `default:` delegation, all three readPixels overloads, pixelStorei, GetPackPixelStoreParams), webgl_rendering_context.cc and webgl2_rendering_context.cc (extension registration order), ext_srgb.cc (name string), platform/graphics/gpu/webgl_image_conversion.cc (row_length semantics), gpu/command_buffer/service/gl_utils.cc and gles2_cmd_decoder_passthrough_doers.cc (synthesized GL_VERSION/GL_SHADING_LANGUAGE_VERSION), third_party/angle libANGLE/Context.cpp and renderer/d3d/d3d11/renderer11_utils.cpp (the *_COMPONENTS = 4 * *_VECTORS invariants), base/values.cc (GetIfDouble int handling).

Checked and found NOT to be problems: the flip arithmetic in the readPixels farble is correct (buffer row r maps to top-down y = (fb_height-1-y_gl) - r, which is what FarbleCanvasRgbaFlippedRows computes, so readPixels and the top-down toDataURL/convertToBlob snapshots key on the same absolute pixel); the PACK_ALIGNMENT handling in the same hook computes the right stride and cannot read past the validated buffer; the masked GL_RENDERER/GL_VENDOR pair is Chrome's constant pair ('WebKit WebGL'/'WebKit', webgl_rendering_context_base.cc:4173,4257) so there is no second unmasked route; contrary to the brief's premise, Chromium 152 still gates UNMASKED_VENDOR_WEBGL/UNMASKED_RENDERER_WEBGL behind ExtensionEnabled(kWebGLDebugRendererInfoName) (:4280, :4299), and the vendor/renderer override is correctly atomic; config parsing fails closed on oversize configs (lobium-config.ts:234-240) and on an older schema version; the aliased-range clamp correctly falls back when the intersection inverts; getShaderPrecisionFormat and getSupportedExtensions have no WebGL2 override, so those hooks do at least execute on WebGL2 (which is precisely what makes finding 1 fire).

Could NOT check: no built Lobium binary and no GPU host were available, so nothing here was confirmed empirically — all findings are derived from the patch text plus the upstream sources. I could not run hc4-probe or fp-probe. The checkout at E:\lobium-build\src currently has core/config-channel.patch and fingerprint/host-gpu-profile.patch applied but NOT fingerprint/webgl-runtime-safety.patch (getParameter at :4016 is the un-clamped form), so the runtime-safety behaviour is read from the patch file rather than from applied source. I did not examine WebGPU (no patch authored; series:70 lists it as future work) — a detector can still read the true adapter there, but that is outside this dimension.

### Web Audio

WHAT I READ. lobium/src/lobium_audio_farble.{h,cc} in full; lobium/patches/fingerprint/audio-context.patch and audio-worklet-tap.patch in full; the webaudio hunks of lobium/patches/core/config-channel.patch (lines 675-988) in full; lobium/patches/series; lobium/build.sh; E:/lobium-build/apply-series.ps1; lobium/src/lobium_fp_config.cc in full and the seeds section of lobium_fp_config.h; ci/validation/lobium-detect.mjs (the project's own audio probe). Against the real 152.0.7977.42 checkout I read the APPLIED state of realtime_analyser.cc, offline_audio_context.cc, script_processor_node.cc, plus upstream script_processor_handler.cc, audio_worklet_processor.cc, audio_worklet_messaging_proxy.cc, audio_worklet_global_scope.{h,cc}, audio_worklet_object_proxy.cc, base_audio_context.cc, offline_audio_destination_handler.cc, analyser_handler.cc, constant_source_handler.cc, audio_buffer_source_handler.cc, offline_audio_context.idl, platform/audio/{audio_utilities.cc,audio_utilities.h,biquad.cc,dynamics_compressor.cc}.

QUESTIONS FROM THE BRIEF THAT CAME BACK CLEAN (no finding filed):

1. is_offline_context_ gating is SOUND. audio_worklet_messaging_proxy.cc:106-138 picks OfflineAudioWorkletThread iff realtime_buffer_duration is nullopt, and that optional is engaged unconditionally for any realtime context because AudioContext::PlatformBufferDuration() (audio_context.cc:1794) returns a plain base::TimeDelta, not an optional - so there is no no-audio-device path that misclassifies a realtime context as offline. OfflineAudioContext is Exposed=Window only (offline_audio_context.idl:27-29), so the worker case does not exist. The flag can never be true for a realtime worklet nor false for an offline one.

2. LobiumFpConfig::Current() is THREAD-SAFE from the audio render thread. It is a function-local static base::NoDestructor initialised by a lambda, so C++ magic-static guards serialise first use. In a renderer the --lobium-fp-data branch runs (base64 + base::JSONReader, no I/O, no thread restrictions), and I confirmed the file-reading branch cannot be reached in a renderer: config-channel.patch:130-131 adds only "lobium-hwc" to RenderProcessHostImpl's kSwitchNames, so --lobium-fp-config is never forwarded and base::ReadFileToString never runs off the browser UI thread.

3. Byte analyser paths ARE covered, contrary to the audio-context.patch preamble. config-channel.patch:876-947 recomputes the float dB / PCM values, farbles them with the identical (seed, index) key, and only then quantises, so getByteFrequencyData is the exact byte quantisation of getFloatFrequencyData and getByteTimeDomainData of getFloatTimeDomainData. I checked the seed-0 case too: because audio_utilities::LinearToDecibels already returns float, the added static_cast<float> round-trip changes nothing, so with farbling off the byte paths are bit-identical to stock. The float-vs-byte cross-check oracle is genuinely closed.

4. Stereo/channel coherence holds in EVERY hook. Offline result, worklet (one base_index across all buses and channels), SPN (one base per dispatch across channels), and the analyser (mono downmix) all use a single key per index with no channel fold, so an honest mono upmix stays bit-identical between channels.

5. BiquadFilterNode/IIRFilterNode.getFrequencyResponse is correctly left alone: biquad.cc:585 uses fdlibm::cos/sin/atan2, so it is bit-portable across all platforms and carries zero host entropy - farbling it would make Lobium differ from every honest Chrome. Not a gap.

6. decodeAudioData / user AudioBuffer getChannelData / copyFromChannel / copyToChannel are untouched by design and that is right for playback safety - but note that this is precisely what makes the known-input oracle in finding audio-index-keyed-noise possible, since it hands a page an exact ground truth to render against.

WHAT I COULD NOT CHECK. No binary was available, so nothing here is measured on a running Lobium - all quantities are derived from the source plus the published FingerprintJS audio-sum population values. I did not verify the persona generator's seed range (whether seeds.audio can legitimately be 0, which would silently disable the whole surface), and I did not audit MediaStreamAudioDestinationNode / MediaRecorder / WebCodecs AudioData.copyTo, which are realtime-only and timing-jittery; they are unfarbled but I judged them not to be a stable fingerprint. Per the read-only rule I ran only `patch --dry-run` against E:/lobium-build/src and edited nothing in either tree.

### Screen, DPR, viewport, media queries, clientRects

WHAT I READ. Patches: lobium/patches/fingerprint/screen-dpr.patch (full), media-values-device-size.patch (full), client-rects.patch (full), mobile-persona.patch (head), branding/device-frame.patch (full switch/BUILDFLAG survey), the screen hunks of core/config-channel.patch, and lobium/patches/series. Engine source: lobium/src/lobium_farble.cc + .h (FarbleClientRect and its header contract), lobium/src/lobium_fp_config.h/.cc (ScreenConfig, ReadScreen, seeds). Sidecar/persona: packages/engine-runner/src/launch.ts, runners/lobium-launcher.ts, lobium-config.ts; packages/fingerprint/src/derive.ts, host-calibration.ts, coherence.ts, android.ts; ci/validation/native-policy-probe.mjs. Upstream verified against E:\lobium-build\src (read-only): core/frame/screen.cc (patch already applied there), core/frame/local_dom_window.cc (outer/inner/screenX/screenY), core/frame/local_frame.cc DevicePixelRatio, core/css/media_values.cc (full — DPR hook applied, device-width/height hook NOT yet applied in the checkout), core/dom/element.cc (ClientQuads / getClientRects / GetBoundingClientRect* / internal callers), core/dom/range.cc GetBorderAndTextQuads, core/intersection_observer/intersection_observer_entry.cc, core/geometry/dom_rect_read_only.h, core/dom/geometry_utils.idl, modules/screen_details/screen_detailed.cc, modules/screen_orientation/screen_orientation{,_controller}.cc, ui/display/win/screen_win.cc, platform/runtime_enabled_features.json5, services/network/public/cpp/permissions_policy/permissions_policy_features.json5.

CHECKED AND CLEAN (no finding). rect.right === rect.x + rect.width and the top/bottom/left duals hold — DOMRectReadOnly derives them (dom_rect_read_only.h:40-43). getClientRects() correctly early-returns on the empty list before farbling, so only the bounding-rect path has the empty-rect bug. For a single-fragment element getClientRects()[0] still equals getBoundingClientRect(), because both use rect_index 0 — the multi-fragment case is where the union invariant breaks. Element.getBoxQuads is not a detection vector: the GeometryUtils mixin is RuntimeEnabled and its status is "experimental", so it is absent from a stable build exactly as it is from stock Chrome. window.innerWidth/innerHeight and visualViewport are honestly unhooked and match the real (untouched) layout, which is the right call. Screen::GetRect is genuinely the single source for width/height/avail*, so those six stay mutually coherent. The DPR hook does cover both window.devicePixelRatio and the CSS resolution path, and media-values-device-size.patch does close the (device-width)/(device-height) gap including the physical-pixels quirk — the preamble's claims there check out. ReadScreen defaults availWidth/availHeight to width/height, so an omitted avail block cannot produce a 0-width available rect.

WHAT I COULD NOT CHECK. No build and no running binary, so nothing here was confirmed dynamically — every detection script is derived from reading the two sources side by side rather than executed. client-rects.patch had not yet been applied to E:\lobium-build\src at audit time (element.cc contained no lobium reference), so I analysed the patch text against the current upstream element.cc rather than the merged result; the hunk contexts do match upstream, so it should apply cleanly. media-values-device-size.patch was likewise not yet applied. I did not measure the actual host display's HDR state, so the direction of the colorDepth break on this particular machine is inferred from screen_win.cc rather than observed. I did not attempt to enumerate every DOMRect-producing Web API exhaustively — I covered the ones named in the brief plus Range and IntersectionObserver; other DOMRect sources (e.g. DocumentTimeline-adjacent APIs, ResizeObserver's contentRect, which is a size-only box in the element's own coordinate space) may add further unfarbled cross-checks. ResizeObserver in particular is worth a follow-up pass: contentRect.width is unfarbled and directly comparable to bcr.width minus padding/border.

### navigator / User-Agent / UA client hints

WHAT I READ: lobium/patches/core/config-channel.patch (all 1121 lines), lobium/patches/fingerprint/{mobile-persona,locale-geolocation}.patch, lobium/src/lobium_fp_config.cc; packages/fingerprint/src/{pools,derive,android,coherence,device-tiers,host-calibration,overrides}.ts; packages/engine-runner/src/{launch,lobium-config,start-profile,start-android-emulated-profile,mobile-emulation,host-calibration-probe,capture-host-calibration,ensure-host-calibration,rpc}.ts and runners/{lobium-launcher,composite}.ts; apps/desktop/src/features/profiles/{options,profileDraft}.ts. Every Chromium claim was verified against E:\\lobium-build\\src (read-only): user_agent_utils.{h,cc}, navigator_base.cc, navigator_language.cc, navigator_id.cc, approximated_device_memory.cc, dom_plugin_array.cc, dom_mime_type_array.cc, navigator_plugins.cc, dev_tools_emulator.cc, content/child/runtime_features.cc, chrome_content_browser_client.cc, services/network/public/cpp/features.cc, pdf/features.gni, third_party/icu putil.cpp/wintz.cpp/platform.h.

VERIFIED-CLEAN (checked, not findings): (1) navigator.webdriver is FALSE — although `--remote-debugging-port=0` triggers `EnableAutomationControlled(true)` (runtime_features.cc:446-453) and `--headless=new` does too (:396), `buildLaunchOptions` passes `--disable-blink-features=AutomationControlled` (launch.ts:81) and `--disable-blink-features` is applied last, after `SetRuntimeFeaturesFromCommandLine` (runtime_features.cc:663-676), so it wins. (2) `buildChromeBrands` (pools.ts:768-797) is an exact reimplementation of Chromium's GREASE algorithm — chars, `{8,99,24}` versions, and the `shuffled[order[i]] = list[i]` permutation all match GetGreasedUserAgentBrandVersion/GetRandomOrder/ShuffleBrandList (user_agent_utils.cc:238-280, 561-577); the native `bv.second + \".0.0.0\"` padding matches GetProcessedGreasedBrandVersion (:529-558), and GREASE-version-equals-UA-major (which would mis-pad) is unreachable for any real major. (3) Worker coverage is genuinely complete: `--lobium-fp-data` rides `PropagateBrowserCommandLineToRenderer`, which covers dedicated/shared/service-worker renderers; UA-CH for shared workers (shared_worker_host.cc:480), service workers (service_worker_version.cc:2689) and every renderer (render_process_host_impl.cc:2018) all route through `ChromeContentBrowserClient::GetUserAgentMetadata()` → the hooked `embedder_support::GetUserAgentMetadata()` (chrome_content_browser_client.cc:7705-7708); UA/platform are hooked on NavigatorBase, shared by Navigator and WorkerNavigator. (4) `navigator.appVersion` derives from the overridden virtual `userAgent()` (navigator_id.cc appVersion) so it cannot disagree. (5) `navigator.platform: 'Linux armv81'` (pools.ts:384) is NOT a typo — it is Chromium's literal Android value (navigator_base.cc:29). (6) navigator.languages vs Accept-Language agree: `languagesToAcceptLanguage` reproduces `net::HttpUtil::GenerateAcceptLanguageHeader` for 1-10 entries, `intl.accept_languages` is written into Preferences even on first run (readPrefsForUpdate returns `{}` for a missing file), and `network::features::kReduceAcceptLanguage` is DISABLED_BY_DEFAULT in M152 and additionally force-disabled by launch.ts:77. (7) `--lang=<locale>` IS passed (launch.ts:82) despite the launcher's own arg list not containing it — it arrives via `...ctx.options.args`. (8) Mobile plugins/mimeTypes/pdfViewerEnabled are correct: `enable_pdf = !is_android` (pdf/features.gni), and `GetFixedMimeTypeArray()` returns empty when `dom_plugins_` is empty, so suppressing the constructor also empties mimeTypes coherently. (9) deviceMemory is always 4 or 8 (never off-ladder, never >8) across pools.ts, device-tiers.ts TIERS and host normalization, and `LobiumRoundDeviceMemoryGb` reproduces `CalculateAndSetApproximatedDeviceMemory` exactly including the [2,32]/[1,8] clamps. (10) hardwareConcurrency×deviceMemory pairings in device-tiers.ts are tier-coherent (no 2 GB / 32 core combinations).

EXPLICITLY DISCONFIRMED PROMPT ASSUMPTION: the brief states an Android tablet must report `Sec-CH-UA-Form-Factors: \"Tablet\"`. Chromium 152 never emits it — `GetFormFactorsClientHint()` (user_agent_utils.cc:742-755) only ever produces \"Mobile\"/\"Desktop\" (+\"XR\"), and `kTabletFormFactor` appears nowhere in the tree except the valid-values list (blink/common/user_agent/user_agent_metadata.cc:23). Real Chrome on an Android tablet has `mobile=false` and therefore reports \"Desktop\", which is exactly what Lobium emits. Not a finding.

COULD NOT CHECK: (a) I could not run the engine — the checkout is mid-patch (config-channel and mobile-persona hunks are applied in E:\\lobium-build\\src, locale-geolocation is not yet), so all runtime claims are source-derived rather than observed. (b) I did not evaluate whether a real Android device DB would reject specific model↔Android-version pairs beyond the structural argument in the tablet finding. (c) TLS/HTTP2 fingerprint, header ORDER of Sec-CH-UA-* on the wire, and Client Hints permission-policy delegation to third-party iframes were out of dimension and unexamined. (d) `FONTCONFIG_FILE`/`FC_LANG`/`LANG`/`LC_ALL` set at lobium-launcher.ts:180-193 are POSIX-only and inert on the Windows target exactly like `TZ` — I flagged only TZ because only TZ has no native replacement; the font-isolation consequence belongs to the fonts dimension.

### Config channel, capability contract, launcher

WHAT I READ IN FULL: lobium/src/lobium_fp_config.h and .cc; lobium/patches/core/config-channel.patch (all 1121 lines); lobium/patches/core/capability-contract.patch; lobium/patches/fingerprint/locale-geolocation.patch; lobium/patches/series; packages/engine-runner/src/lobium-config.ts; packages/engine-runner/src/lobium-capabilities.ts; packages/shared-types/src/fingerprint.ts; the config/capability/env/spawn regions of packages/engine-runner/src/runners/lobium-launcher.ts (lines 160-210, 240-375, 495-543, 660-813); ci/validation/native-policy-contract.test.mjs; lobium/gn-args.gn.example. I enumerated the files touched by every patch in the series programmatically to map hooks to capabilities.

WHAT I VERIFIED AGAINST THE REAL CHROMIUM 152 CHECKOUT (E:\lobium-build\src, read-only): base::DictValue/ListValue and JSONReader::ReadDict exist (base/values.h:242, base/json/json_reader.h:113) so the reader compiles as written; base::Base64Decode defaults to kStrict (base/base64.h:53-56); ReadFileToStringWithMaxSize takes ScopedBlockingCall(MAY_BLOCK) (base/files/file_util.cc:81) and AssertBlockingAllowed is DUMP_OR_DCHECK'd (base/threading/thread_restrictions.cc:63) with the UI thread under DisallowUnresponsiveTasks (content/browser/browser_main_loop.cc:1089); content::RenderProcessHostImpl IS on the ScopedAllowBlocking friend list (base/threading/thread_restrictions.h:630) so that hunk compiles; embedder_support::GetUserAgent is reached only browser-side via ChromeContentBrowserClient (chrome_content_browser_client.cc:6947, 7701-7707); GpuProcessHost's switch allowlist (gpu_process_host.cc:252) carries no Lobium switch; chrome/app/chrome_main.cc already includes <iostream> so the capability patch's std::cout compiles, and I confirmed the patch applies cleanly with `patch --dry-run` (offset 36 lines); official-build logging resolves to LOG_NONE (chrome/common/logging_chrome.cc:154-175 + chrome/common/features.gni:36,80); ICU on Windows never consults TZ (third_party/icu/source/common/putil.cpp:1107-1145). The config-channel patch is already applied in the checkout, so I read the applied render_process_host_impl.cc hunk at lines 4034-4079 directly.

WHAT I COULD NOT CHECK: (1) I did not run the Lobium binary - no built Windows engine was available in this environment - so the capability probe's stdout capture from a /SUBSYSTEM:WINDOWS chrome.exe is reasoned from CreateProcess/STARTF_USESTDHANDLES semantics rather than observed; the brittleness finding stands regardless of whether the happy path works. (2) I did not measure a real lobium-fp.json - no generated fixture existed - so the 5-8 KiB / 7-11 KiB figures in the command-line-budget finding are computed from the shared-types schema field-by-field, and the 2-4 KiB Windows renderer-command-line figure is from Chromium's known switch set rather than a captured line on this machine. (3) I did not audit the correctness of the individual surface hooks (canvas/audio/WebGL farbling kernels, WebRTC policy semantics, media-device IDs) beyond checking that each is or is not represented in the capability contract - those belong to other dimensions. (4) MAX_PATH behaviour for an over-260-character userDataDir is a plausible additional fail-open (libuv prefixes \\\\?\\ on write, base::FilePath does not) but chrome.dll.manifest showed no longPathAware entry and I could not confirm the exe manifest, so I left it out rather than assert it. (5) Two of my findings (phantom timezone capability, GPU-process reachability) overlap the locale and WebGL dimensions; I scoped each to the contract/reachability aspect that belongs here.

### Surfaces with no coverage at all

SCOPE AND METHOD. I enumerated Lobium's total hook surface by extracting every `diff --git` header from all 24 files in lobium/patches/ — that is the authoritative list of Chromium files this fork touches, and it is short (25 distinct files). Any surface whose implementation file is not on that list is, by construction, unhooked. I then verified each candidate surface's actual behaviour against the real Chromium 152 source in E:\lobium-build\src (read-only; no git/patch/edit commands were run there), and verified the sidecar's full command-line by extracting every `--flag` token from packages/engine-runner/src.

CONFIRMED HOOKED (not reported): hardwareConcurrency, deviceMemory (+ Device-Memory hint), maxTouchPoints, userAgent/platform in all contexts, UA-CH/Sec-CH-UA incl. high-entropy hints, WebGL unmasked vendor/renderer + scalar caps + version/GLSL/extensions/shaderPrecision, WebGL pixel farbling, canvas 2D farbling, Web Audio (offline + analyser + worklet/SPN taps), clientRects, screen geometry/colorDepth/DPR + matchMedia DPR + device-width/height, navigator.languages, geolocation, mediaDevices enumeration, WebRTC policy, plugins/pdfViewerEnabled (mobile only), and Intl LOCALE (via SetICUDefaultLocale in render_thread_impl.cc — this one DOES work on Windows; timezone, in the same sentence of the same preamble, does not).

WEBGPU FLAG QUESTION, ANSWERED DIRECTLY: the sidecar passes NO flag that disables WebGPU. The complete flag set is --user-data-dir, --remote-debugging-port, --no-first-run, --no-default-browser-check, --password-store, --restore-last-session, --lobium-* (profile-name/device-frame/device-screen/open-side-panel/fp-config/fp-data/fingerprint-capabilities), --lang, --window-size/position, --disable-blink-features=AutomationControlled, --force-webrtc-ip-handling-policy, --proxy-server/--proxy-bypass-list, --disable-features=ReduceAcceptLanguage[,AsyncDns,DnsOverHttpsUpgrade], --disable-quic, --load-extension/--disable-extensions-except, --headless (opt-in only; production is headed), and the GPU set from gpu.ts (--use-gl=angle, --use-angle=<backend>, --enable-gpu, --ignore-gpu-blocklist, --enable-features=Vulkan). WebGPU is therefore live and truthful while WebGL is spoofed — reported as finding 2.

CHECKED AND CLEARED — NO JS INJECTION IN THE CDP PATH: grepping all of packages/engine-runner/src for `addScriptToEvaluateOnNewDocument`, `Emulation.setUserAgentOverride`, `setTimezoneOverride`, `setLocaleOverride`, `setGeolocationOverride` returns ZERO hits. The only `Runtime.evaluate` uses are one-shot agent-automation calls in agent/cdp-driver.ts, and agent/persistent-cdp.ts deliberately avoids `Runtime.enable`/`Page.enable`. So `Function.prototype.toString` of natives and error-stack shapes are clean — there is nothing to leak. The ONE exception is mobile-emulation.ts, which is a genuine permanent CDP overlay; reported as finding 9.

CHECKED AND CLEARED — NOT WORTH REPORTING: navigator.getGamepads() (empty array everywhere, no entropy); navigator.userActivation and navigator.scheduling (uniform across all Chrome); performance.now() resolution (Chromium's clamp is a fixed constant, identical on every Chrome — not a discriminator, and performance.timeOrigin is just wall-clock); SharedArrayBuffer (gated by cross-origin isolation identically on all desktop Chrome); Intl.supportedValuesOf / collation / calendar / numbering (these come from the bundled ICU data, which is the same for every Chrome build at this milestone — the Intl *locale* is natively hooked and the Intl *timezone* problem is finding 1, which is where the real Intl risk lives); Notification.permission / Permissions.query (the classic denied-vs-prompt mismatch is a HEADLESS artifact, and launch.ts:105 defaults headless to false, so production launches are headed and the matrix is normal); the Lobee extension (manifest.json declares no web_accessible_resources, no externally_connectable and no content_scripts, so a page cannot probe for the fixed extension id opbicdcjjlpehmibpmkmkconpnnkijel); window.chrome / chrome.loadTimes / chrome.csi (present in unbranded Chromium builds too — the branding gap that DOES bite is Widevine, finding 4); scrollbar width (follows the real OS but is already handled for mobile by setScrollbarsHidden and is low-entropy on desktop); navigator.mediaCapabilities.decodingInfo powerEfficient/smooth (does leak the real GPU's hardware-decode profile and so compounds finding 2, but I could not isolate a clean scripted contradiction without a real-GPU host to measure on — flagged here rather than as a finding).

NOT VERIFIABLE FROM THIS MACHINE: nothing was executed — there is no built Windows Lobium binary on this host (STATUS.md §2 confirms `lobium-win-x64` does not yet exist), so every claim above is source-derived rather than observed. The three findings I would most want confirmed on real hardware once a Windows binary exists are #1 (run ci/validation/lobium-detect.mjs on Windows and watch the `timezoneApplied` assertion at line 489 fail), #2 (dump adapter.info + all 31 limits next to the spoofed WebGL renderer), and #5 (the exact canPlayType return value for dvh1.05.06). I also could not inspect E:\lobium-build\src while patches were mid-application for any file outside those I read; screen.cc was already patched when I read it, which is why my Screen::colorDepth excerpt shows Lobium code — that is expected, not a discrepancy.

ONE ADJACENT OBSERVATION, OUTSIDE THIS DIMENSION: gpu.ts:81 forces `--use-angle=vulkan` as the default GPU backend. Real Chrome for Windows defaults to ANGLE/D3D11. The unmasked vendor/renderer strings are spoofed so that specific tell is covered, but the WebGL extension list, GLSL version string and shader-precision buckets differ structurally between the D3D11 and Vulkan ANGLE backends — so whichever backend the host-calibration capture ran on must be the backend the profile launches with, or host-gpu-profile.patch will serve a self-inconsistent WebGL profile. That belongs to the WebGL dimension, but it is worth someone checking that the capture and the launch agree on Windows.

### Engine architecture, build hygiene, patch series

SNAPSHOT WARNING: E:/project was being actively rewritten during this audit. Between 12:49 and 13:14 local another process landed a major patch-series decomposition. All findings below are against the state at 2026-08-14 13:14; lobium/src/lobium_farble.cc/.h and fingerprint/client-rects.patch were still changing when I finished, so the farbling-kernel internals may have moved (my findings do not depend on them). Two of the three headline defects I found at 12:20 were fixed by that refactor while I was writing them up, and I have NOT reported them as open - recording them here because they are the strongest evidence of what the series-level gates are for. (a) core/config-channel.patch was 64 KB / 19 files / 55 hunks and contained byte-identical copies of every hunk in screen-dpr.patch, audio-context.patch and audio-worklet-tap.patch. I proved this was a hard build break by reconstructing a sparse tree of all 57 touched files from `git show HEAD:<path>` in the pristine 152.0.7977.42 checkout and running the series with the same `patch -p1 --forward --batch` invocation build.ps1 uses: those three patches exited 1 with "Reversed (or previously applied) patch detected! Skipping patch" (13 hunks ignored, .rej files written) and build.ps1 then Died with "3 patch(es) did not apply". I separately confirmed with a minimal two-file experiment that GNU patch --forward exits 1 on an already-applied hunk. (b) 74 patch-added source lines carried non-ASCII (71 em-dashes) across 28 files. Both are now zero: I re-ran the same sparse-tree apply at 13:05 and all 24 series patches applied cleanly (exit 0), and the only remaining cross-patch duplication is bare `#include` lines, which is unavoidable. ci/validation/patch-series.test.mjs (created 12:57) now enforces no-duplicate-hunks, complete diff/---/+++ trios, hunk-header/body count agreement, non-overlapping ordered hunks, LF-only UTF-8 without BOM, pure-ASCII added source, the three ordering chains, and that config-channel.patch stays transport-only. That is a genuinely good gate and closes those two holes; the gaps I report are the ones it does not cover (lobium/src/ style, line length, DEPS, GN registration of patch-created files). WHAT I EXAMINED: lobium/{build.sh, build.ps1, rebase.sh, gn-args.gn.example, gn-args-windows.gn}, lobium/src/{BUILD.gn, OWNERS, all six sources}, lobium/patches/series and all 25 patches (144 hunks, 57 upstream files, 24 in series + suppress-sandbox-infobar.patch deliberately out), scripts/{build-windows-product.ps1, bump-engine-version.mjs, apply-lobium-branding.mjs, package-lobium-runtime.sh}, ci/validation/{patch-series.test.mjs, version-coherence.test.mjs}, and docs/{STATUS,OPERATIONS,ENGINEERING}.md. Every Chromium claim was verified read-only against E:/lobium-build/src at tag 152.0.7977.42 (working tree clean apart from untracked components/lobium_fp/): blink/common/DEPS, blink/renderer/{,core/,modules/}DEPS, base/values.h (base::DictValue and base::ListValue are real M152 classes, so the config reader compiles), base/json/json_reader.h ReadDict, chrome/app/chrome_main.cc (already includes <iostream>, so capability-contract.patch's std::cout is fine - not a finding), chrome/browser/ui/BUILD.gn:3916, chrome/browser/ui/startup/infobar_utils.cc:188, third_party/widevine/cdm/widevine.gni, media/media_options.gni, build/config/sanitizers/sanitizers.gni, build/config/unsafe_buffers_paths.txt, .gn, .clang-format and PRESUBMIT.py. WHAT I COULD NOT CHECK: I could not run `gn gen`, `ninja`, `gn check` or checkdeps - that needs depot_tools, a configured MSVC toolchain and hours of build time on the locked checkout, which I was instructed not to mutate. So the DEPS violation, the missing-GN-target link failure and the Widevine gap are established by source inspection and by exact reproduction of the tooling's own logic, not by an actual compile. I also could not verify the Windows ENGINE PACKAGING path end to end: scripts/package-lobium-runtime.sh is bash/Linux-only, scripts/build-windows-product.ps1 explicitly states the Windows engine "does not exist yet" and pins engine-manifest.json to linux-x64, and nothing stages the branding pass (scripts/apply-lobium-branding.mjs, which still defaults CHROMIUM_SRC to the hardcoded '/home/ivyhfx/lobium-build/src' and imports playwright at module scope) into the Windows build. lobium/build.ps1 now produces out/Lobium/chrome.exe and correctly stages the NTP brand PNGs, but there is still no Windows counterpart to package-lobium-runtime.sh and no Windows engine-manifest entry - I left that out of the findings list because it is squarely the STATUS.md section 2 known gap rather than a new defect, but it remains the single largest structural hole between "the engine builds" and "the product ships on Windows". Finally, one checklist item I want to correct rather than report: Chromium's presubmit non-ASCII check (PRESUBMIT.py:4377) applies only to IDL files, not to .cc/.h - the real style gate for C++ is canned_checks.CheckPatchFormatted at PRESUBMIT.py:7051/7076 plus .clang-format's 80-column Chromium style, which is what I based the style finding on.
