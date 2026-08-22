// Copyright 2026 The Lobster Browser Authors.
//
// Deterministic per-profile canvas farbling - the shared kernel behind every canvas-2D and WebGL
// pixel readback hook. Kept skia-free (it operates on a raw RGBA8888 buffer) so
// //components/lobium_fp stays a //base-only leaf; the Blink hooks pass their SkPixmap's pixels in.

#ifndef COMPONENTS_LOBIUM_FP_LOBIUM_FARBLE_H_
#define COMPONENTS_LOBIUM_FP_LOBIUM_FARBLE_H_

#include <cstddef>
#include <cstdint>

namespace lobium {

// THE THREE PROPERTIES THIS KERNEL MUST HAVE, and the oracle that breaks each one if it does not.
//
// 1. READ-RECTANGLE INDEPENDENCE. A given on-screen pixel must be perturbed identically no matter
//    which rectangle the page asked for. Otherwise:
//        const big = ctx.getImageData(0, 0, W, H);         // farbled
//        const one = ctx.getImageData(x, y, 1, 1);         // must agree with big at (x, y)
//    Any disagreement both PROVES tampering and lets the page recover the pristine canvas one pixel
//    at a time. This is why the "is this pixel on a flat run" test is evaluated against a CONTEXT
//    buffer that carries a one-pixel apron around the requested rectangle, never against the
//    requested rectangle itself: a 1x1 read has no neighbours of its own, but its apron does.
//
// 2. IDEMPOTENCE. Reading, writing the result back, and reading again must return the SAME bytes:
//        const a = ctx.getImageData(0, 0, W, H);
//        ctx.putImageData(a, 0, 0);
//        const b = ctx.getImageData(0, 0, W, H);           // must equal a
//    A plain additive nudge fails this: b = v + 2d, so the page recovers the true pixel as 2a - b
//    and simultaneously proves tampering. The perturbation below is therefore a projection - it
//    moves a value out of the residue class that triggers it, so applying it twice is a no-op.
//
// 3. KNOWN-INPUT FIDELITY. A page that draws something whose exact output it can predict - a solid
//    fillRect, a hard edge between two fills, a cleared canvas - must read those pixels back
//    EXACTLY. That is the cheapest tamper check there is, and the one CreepJS reports as a canvas
//    lie. Hence the flat-run rule: a pixel is perturbed only when it is byte-identical to NONE of
//    its four orthogonal neighbours, which is true of anti-aliased and blended pixels (where a
//    canvas fingerprint's entropy actually lives) and false of every flat region and hard edge.
//
// KNOWN LIMITATIONS, stated rather than papered over:
//   * A shallow gradient quantises into runs of byte-identical pixels and is therefore treated as
//     flat and left alone. Text, emoji and blended scenes are unaffected.
//   * A page that can predict its own ANTI-ALIASED output exactly can still tell the output was
//     perturbed. No farbling scheme survives that; the goal here is that no CHEAP oracle does.
//   * The perturbation only touches R/G/B of 8-bit unpremultiplied RGBA. Callers must not hand it a
//     float16/float32 or premultiplied buffer - see the colour-type guard at each hook site.

// Perturb a whole top-down RGBA8888 buffer in place. `(origin_x, origin_y)` is the absolute canvas
// coordinate of pixel (0,0), so the same on-screen pixel keys identically from every surface.
// Because the whole buffer is present, it is its own apron context. No-op when `seed` is 0.
void FarbleCanvasRgba(uint8_t* base,
                      int width,
                      int height,
                      size_t row_bytes,
                      int origin_x,
                      int origin_y,
                      uint32_t seed);

// Same, for a BOTTOM-UP buffer - the layout `gl.readPixels` returns. Buffer row `y` maps to the
// top-down coordinate `top_origin_y - y`, so WebGL readPixels and the (top-down) WebGL
// toDataURL/toBlob snapshot perturb the same on-screen pixel identically. Callers pass
// `top_origin_y = H - 1 - y_gl`, where H is the drawing-buffer height and y_gl the readPixels y.
void FarbleCanvasRgbaFlippedRows(uint8_t* base,
                                 int width,
                                 int height,
                                 size_t row_bytes,
                                 int origin_x,
                                 int top_origin_y,
                                 uint32_t seed);

// Perturb a SUB-RECTANGLE, deciding flatness from a larger read-only context that includes the
// rectangle's one-pixel apron. This is what getImageData(sx, sy, sw, sh) must use: passing only the
// requested rectangle would make the result depend on the rectangle (property 1 above).
//
//   dst / dst_*        the buffer to mutate (the fresh ImageData allocation)
//   ctx / ctx_*        read-only pixels covering the rectangle plus an apron, clipped at the canvas
//                      edge - a clipped apron is correct, because a full-canvas read sees the same
//                      clipping for the same pixel
//   dst_x_in_ctx, dst_y_in_ctx   where dst's (0,0) sits inside ctx
//   ctx_origin_x, ctx_origin_y   absolute canvas coordinate of ctx's (0,0)
//
// `ctx` may alias `dst` (whole-canvas case); the implementation reads flatness from pristine copies
// either way. No-op when `seed` is 0 or the context does not contain the destination.
void FarbleCanvasRgbaSubRect(uint8_t* dst,
                             int dst_width,
                             int dst_height,
                             size_t dst_row_bytes,
                             const uint8_t* ctx,
                             int ctx_width,
                             int ctx_height,
                             size_t ctx_row_bytes,
                             int dst_x_in_ctx,
                             int dst_y_in_ctx,
                             int ctx_origin_x,
                             int ctx_origin_y,
                             uint32_t seed);

// Sub-pixel client-rect noise for getClientRects / getBoundingClientRect.
//
// Keyed on the rect's own VALUES, not on a call index. That is what preserves geometric
// coincidence: honest Chrome returns exactly equal doubles for a child that fills its parent, for
// sibling A's bottom against sibling B's top, and for two identically laid-out elements. An
// index-keyed nudge gives those independent noise and breaks the equality - a few lines of JS to
// detect. Value keying gives equal inputs equal outputs, so every such relation survives.
//
// The delta is one LayoutUnit (1/64 CSS px), the quantum Blink itself lays out on, so the values
// stay plausible and Math.round(bcr.width) still matches offsetWidth. No-op when `seed` is 0.
// Does a client rect actually carry HOST entropy worth hiding?
//
// clientRects fingerprinting reads sub-pixel geometry that varies by machine, and that variation
// comes from TEXT METRICS - a content-sized box is as wide as the font rasteriser made its glyphs.
// A box whose width and height are explicit CSS lengths is pure arithmetic: 100px is 100px on every
// machine, and stays exactly reproducible under a transform. Perturbing it hides nothing and is
// trivially detectable, because the detector can compute what the value must have been (CreepJS
// does exactly that with .rect-known and .rect-ghost).
//
// The POLICY lives here rather than at the call sites because two separate Blink paths produce the
// same rect - Element::GetBoundingClientRect and IntersectionGeometry - and if they answer this
// question differently the two contradict each other, which is the defect this shared helper
// exists to prevent. Each caller does its own ComputedStyle lookup and passes the two booleans in.
bool ClientRectCarriesHostEntropy(float width,
                                  float height,
                                  bool css_width_is_fixed,
                                  bool css_height_is_fixed);

void FarbleClientRect(float* x,
                      float* y,
                      float* width,
                      float* height,
                      uint32_t seed);

}  // namespace lobium

#endif  // COMPONENTS_LOBIUM_FP_LOBIUM_FARBLE_H_
