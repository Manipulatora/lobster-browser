# Farbling vs. detection — what CreepJS actually catches, and what can be done about it

**Measured:** 2026-08-16, Lobium 152.0.7977.42, Windows x64, software renderer.

A benchmark run against live third-party detectors found the engine clean everywhere except two
places, both of them our own farbling. This document records the exact detection mechanisms — read
out of CreepJS's source, not inferred — and what is and is not fixable.

## The measurements

`ci/validation/creepjs-battle.mjs`, 12 personas. The result tracks the noise switch exactly; the
persona, the seed and the geo make no difference.

| noise mode | runs | CreepJS lies |
| --- | ---: | --- |
| `canvas-off`, `minimal` | 6 | **0** |
| `default` | 3 | 1 — `CanvasRenderingContext2D.getImageData` |
| `all` | 3 | 2–3 — plus `Element.getClientRects` |

Everything else measured clean, and is worth stating because it bounds the problem:
`headlessRating 0`, `stealthRating 0`, `platformEstimate Windows 1.0`, worker UA/platform coherent
with no prototype lies, `screen.lied false`, timezone correct. Sannysoft: 57 tests, **0 failed**.
deviceandbrowserinfo: `isBot: false` with `isAutomatedWithCDP: false`.

## 1. Canvas — `"pixel data modified"`

### The mechanism

`creep.js` L2913-2992 (`getPixelMods`) and L3216-3220. It is a **known-input fidelity** test:

```js
// for each of 64 pixels on an 8x8 canvas
context1.fillStyle = `rgba(${red}, ${green}, ${blue}, 255)`;   // random per pixel
context1.fillRect(x, y, 1, 1);
pattern1.push(colors);                                          // what we WROTE
// ...then, for each pixel
const { data: [r, g, b, a] } = context1.getImageData(x, y, 1, 1);
pattern2.push(`${r}, ${g}, ${b}, ${a}`);                        // what we READ
// any pattern1[i] !== pattern2[i] -> mods.pixels -> lie
```

Reproduced in isolation by `ci/validation/creepjs-pixelmods-probe.mjs`:

```
canvas noise ON  seed A   knownInputDiffs=43/64   creepJsFlags=YES   textHash=ec5adf4a
canvas noise ON  seed B   knownInputDiffs=40/64   creepJsFlags=YES   textHash=1ddc2fde
canvas noise OFF seed A   knownInputDiffs= 0/64   creepJsFlags=no    textHash=608b15bc
```

`FarbleChannel` perturbs when `(value + key) % 3 == 0`, so ~1/3 of channels move and ~70% of pixels
change. The flat-run exemption does not help: 64 random colours contain no runs.

The other half of the same `if()` — a cleared canvas must read all-zero — **already passes**
(`clearedMax=0`). Only the known-input half fails.

### A wrong turn, recorded because the reasoning was seductive

The first analysis concluded this was **unfixable at the readback hook**: the detector hands us an
arbitrary byte buffer and demands it back; an 8×8 of random colours is byte-identical to an 8×8 crop
of rendered text; therefore no filter can perturb one and not the other.

Every step of that is true and the conclusion is still wrong. It assumed the filter must be a **pure
function of the pixel buffer**. It does not have to be. Blink knows how those bytes got there, and
Chromium already classifies every 2D draw for its performance monitor. The discriminator was one
layer up the whole time.

Generalisable: when a detector compares output against a known input, look for **provenance** before
concluding the information is not available.

Three pixel-local ideas were tried and rejected first, and they are worth keeping as a record of why
appearance-based rules cannot work here:

| idea | why it fails |
| --- | --- |
| exempt uniform runs | 64 random pixels contain no runs |
| exempt `alpha == 255` (assume antialiasing carries the entropy) | the common fingerprinting canvas draws opaque text on an opaque background — every pixel is `alpha 255`, so the real entropy would be exempted too |
| exempt small canvases | 8×8 passes, but a fingerprinter then reads honest host pixels from a 16×16 text render; entropy is not proportional to area, and the exemption is bypassable in a tiling loop |

### The fix: provenance, not appearance

The probe's 64 pixels carry **zero cross-host entropy** — 64 `fillRect`s of exact sRGB colours
produce identical bytes on every machine. Real canvas entropy is in rasterisation: glyphs, path
anti-aliasing, decoded images, gradient interpolation, shadow blur, filters.

Chromium funnels every 2D draw through one pure virtual with a classification —
`Canvas2DRecorderContext::WillDraw(const gfx::Rect&, CanvasPerformanceMonitor::DrawType)` — and the
enum already separates exactly what is needed (`canvas_performance_monitor.h:23-34`):

```
kOther = 0, kPath = 1<<0, kImage = 1<<1, kText = 1<<2,
kRectangle = 1<<3, kImageData = 1<<4, kElement = 1<<5
```

`fillRect` reports `kRectangle` (`canvas_2d_recorder_context.cc:1754`); `fillText` reports `kText`.

So: `Canvas2DRecorderContext::LobiumNoteDraw()` sets a per-canvas flag when a draw could differ
between hosts — `kText`/`kPath`/`kImage`/`kElement`, or any draw carrying a gradient, pattern, shadow
or filter. `ResetInternal()` clears it. Both readback paths gate on it: `getImageData`
(`base_rendering_context_2d.cc`) and `toDataURL`/`toBlob` via `LobiumReadbackSeed`
(`html_canvas_element.cc`). Gating both matters — farbling one and not the other is its own tell.

Two details that are easy to get wrong:

- **`kOther` must not mark.** `ResetInternal()` fires `WillDraw(..., kOther)` for every
  `canvas.width = N`, and `getPixelMods` does exactly that before drawing. Marking on `kOther` would
  silently defeat the gate.
- **The default is `true`.** `CanvasRenderingContext::LobiumHostEntropyDrawn()` returns `true` so any
  context that does not track provenance — WebGL, anything new — keeps farbling. Only the 2D context
  may answer "nothing was rasterised here".

The gate can only ever make **fewer** pixels move, so it cannot regress known-input fidelity,
idempotence, or read-rectangle independence — the three properties documented at the top of
`lobium_farble.h`.

## 2. clientRects — `"unknown rotate dimensions"`, `"unknown ghost dimensions"` — FIXED

### The mechanism

`creep.js` L3971-3992 defines two probe elements, and L4189-4216 checks them:

```css
.rect-known { top:0; left:0; position:absolute; visibility:hidden;
              width:100px; height:100px; transform:rotate(45deg); }
.rect-ghost { top:0; left:0; position:absolute; visibility:hidden;
              width:0; height:0; }
```

```js
if (IS_BLINK && devicePixelRatio === 1 && knownHash !== '9d9215cc')  // hardcoded expected hash
  documentLie('Element.getClientRects', 'unknown rotate dimensions');

const hasGhostDimensions = Object.keys(ghostDimensions).some((k) => ghostDimensions[k] !== 0);
if (hasGhostDimensions)
  documentLie('Element.getClientRects', 'unknown ghost dimensions');
```

Both probe elements are sized by **explicit CSS lengths**. A 100×100 box rotated 45° has a bounding
box of exactly `100·√2 = 141.42135623730951` on every machine; a `width:0;height:0` box is all
zeros. Neither carries one bit of host entropy — which is why CreepJS can hardcode the answer.

### The fix

Unlike canvas, the hook has the information needed to tell the two cases apart: it runs in
`Element::getClientRects` / `Element::GetBoundingClientRect`, where the `Element` and its
`ComputedStyle` are in hand.

`LobiumRectCarriesHostEntropy()` in `element.cc` skips perturbation when:

1. the rect is zero-area — it says nothing about the host, and
2. `style->Width().IsFixed() && style->Height().IsFixed()` — the box is fully specified by CSS, so
   its geometry is arithmetic, identical everywhere, and reproducible under a transform.

clientRects entropy comes from **text metrics**: a content-sized box is as wide as the font
rasteriser made its glyphs. Those boxes have `auto` on at least one axis and are still perturbed.
The change narrows the noise to where the entropy is; it does not weaken it.

## 3. Harness defects found while measuring

Both pre-existing, both fixed here.

- **`hc4-probe.mjs` reported a false failure** — verdict "HC-4 hook is NOT live in this binary" on a
  binary where it demonstrably is. It asserted verbatim echo of synthetic sentinels, but
  `webgl-runtime-safety` intersects the extension list and clamps precision, so a sentinel can never
  return untouched. Two of three precision fields *were* verbatim sentinels (`77`, `66`) with only
  `precision` clamped `55 → 23`. Now asserts the contract the engine actually has: 5/5.
- **`creepjs-battle.mjs` hardcoded `os: 'linux'`** for the host snapshot. On a Windows build host
  that mislabels the report, and at a higher `--limit` would derive Linux personas for every
  `host-calibrated` situation.

## Verification

- `node ci/validation/creepjs-pixelmods-probe.mjs` — the isolated canvas check, ~1s, gives an exact
  per-channel diff count so a change can be measured instead of guessed at. The full CreepJS run
  takes ~16s and reports one bit.
- `node ci/validation/creepjs-battle.mjs` — the full matrix.
- `node ci/validation/hc4-probe.mjs` — deep-WebGL plumbing, GPU-independent.

None of the canvas or clientRects findings are GPU-dependent: farbling is applied identically on any
renderer, so these results reproduce on real hardware. What real hardware changes is the
WebGL-renderer-coherence question and the formal evidence policy in `detector-matrix.json`.
