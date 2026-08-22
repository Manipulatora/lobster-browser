// Copyright 2026 The Lobster Browser Authors.
//
// See lobium_farble.h for the three properties this kernel has to satisfy and the oracle that
// breaks each one. The definition lives here so the deliberate raw-byte pixel arithmetic (bounded by
// the caller's pixmap dimensions) opts THIS translation unit out of -Wunsafe-buffer-usage without
// leaking that opt-out into every blink file that includes the header.

#ifdef UNSAFE_BUFFERS_BUILD
#pragma allow_unsafe_buffers
#endif

#include "components/lobium_fp/lobium_farble.h"

#include <algorithm>
#include <cstring>
#include <vector>

namespace lobium {
namespace {

// Load a pixel as one 32-bit key. memcpy rather than a reinterpret_cast keeps this free of
// strict-aliasing UB; every compiler folds it to a single load.
inline uint32_t PixelKey(const uint8_t* px) {
  uint32_t v;
  std::memcpy(&v, px, sizeof(v));
  return v;
}

// Per-(channel, absolute pixel) mixing constant. Pure function of its inputs, so the same on-screen
// pixel keys identically from getImageData, toDataURL, toBlob, convertToBlob and readPixels.
inline uint32_t ChannelKey(uint32_t seed, uint32_t channel, uint32_t ax, uint32_t ay) {
  uint32_t h = seed ^ (channel * 0x9E3779B1u);
  h ^= ax * 0x85EBCA77u;
  h *= 0xC2B2AE3Du;
  h ^= h >> 15;
  h ^= ay * 0x27D4EB2Fu;
  h *= 0x165667B1u;
  h ^= h >> 13;
  h ^= h >> 16;
  return h;
}

// IDEMPOTENT channel perturbation.
//
// A value is touched only when (v + key) mod 3 == 0, and it is then moved by one, which puts it in
// a DIFFERENT residue class - so the predicate is false for the result and a second application
// changes nothing. That is what defeats the getImageData -> putImageData -> getImageData oracle: a
// plain additive nudge gives b = v + 2d and hands the page the true pixel as 2a - b.
//
// The direction is +1 except at 255, where it is -1 so the clamp cannot swallow the change (255
// would stay 255 while still satisfying the predicate, i.e. not idempotent in effect and simply
// unperturbed). (v-1+key) mod 3 == 2, so the result is out of the class either way.
//
// Roughly a third of eligible channels move by one 8-bit step. That is invisible, and it still
// changes every hash a fingerprinter computes over the pixels.
inline uint8_t FarbleChannel(uint8_t v, uint32_t key) {
  if ((static_cast<uint32_t>(v) + key) % 3u != 0u) {
    return v;
  }
  return v == 255u ? static_cast<uint8_t>(254) : static_cast<uint8_t>(v + 1u);
}

// True when the pixel is part of a flat run: byte-identical to at least one orthogonal neighbour.
// `left`/`right` come from the pristine copy of the current context row, `up` from the pristine copy
// of the row above, `down` straight from the context (rows below the cursor are never written yet,
// even when the context aliases the destination). A null pointer means that neighbour is outside
// the context, which at the canvas edge is also outside the canvas.
inline bool IsFlatRun(uint32_t key,
                      const uint8_t* left,
                      const uint8_t* right,
                      const uint8_t* up,
                      const uint8_t* down) {
  bool has_neighbor = false;
  for (const uint8_t* n : {left, right, up, down}) {
    if (!n) {
      continue;
    }
    has_neighbor = true;
    if (PixelKey(n) == key) {
      return true;
    }
  }
  // No neighbours at all means no edge information. Treat it as flat: such a buffer is far more
  // likely a solid-colour probe than a fingerprint scene. (With a correctly supplied apron this
  // only happens for a 1x1 canvas.)
  return !has_neighbor;
}

// Shared driver.
//
//   ctx      read-only context whose flatness decides which pixels move; may alias dst
//   dst      the buffer actually mutated, located at (dst_x_in_ctx, dst_y_in_ctx) inside ctx
//   y_step   +1 for a top-down buffer, -1 for the bottom-up layout gl.readPixels returns; it only
//            affects the ABSOLUTE key, never the flatness test, which is direction-symmetric
void FarbleImpl(uint8_t* dst,
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
                int y_step,
                uint32_t seed) {
  if (!dst || !ctx || seed == 0u || dst_width <= 0 || dst_height <= 0) {
    return;
  }
  // The context must actually contain the destination, or the apron logic is not what it claims.
  if (dst_x_in_ctx < 0 || dst_y_in_ctx < 0 ||
      dst_x_in_ctx + dst_width > ctx_width || dst_y_in_ctx + dst_height > ctx_height) {
    return;
  }

  const size_t ctx_row_pixels = static_cast<size_t>(ctx_width) * 4u;
  // Pristine copies of context rows cy-1 and cy. They are mandatory even when ctx does not alias
  // dst, and they are the whole point when it does: in raster order the left neighbour and the
  // entire row above have already been rewritten by the time the cursor reaches a pixel, so reading
  // flatness back from the live buffer made every pixel next to an already-moved one look like an
  // edge and the perturbation cascaded across solid interiors.
  std::vector<uint8_t> prev(ctx_row_pixels);
  std::vector<uint8_t> cur(ctx_row_pixels);
  bool have_prev = false;

  const int first_row = std::max(0, dst_y_in_ctx - 1);
  const int last_row = std::min(ctx_height - 1, dst_y_in_ctx + dst_height);

  for (int cy = first_row; cy <= last_row; ++cy) {
    std::memcpy(cur.data(), ctx + static_cast<size_t>(cy) * ctx_row_bytes, ctx_row_pixels);

    const int dy = cy - dst_y_in_ctx;
    if (dy >= 0 && dy < dst_height) {
      uint8_t* drow = dst + static_cast<size_t>(dy) * dst_row_bytes;
      const uint8_t* down = (cy + 1 < ctx_height)
                                ? ctx + static_cast<size_t>(cy + 1) * ctx_row_bytes
                                : nullptr;
      const uint32_t ay = static_cast<uint32_t>(ctx_origin_y + y_step * cy);

      for (int dx = 0; dx < dst_width; ++dx) {
        const int cx = dx + dst_x_in_ctx;
        const uint8_t* src = cur.data() + static_cast<size_t>(cx) * 4u;
        if (src[3] == 0u) {
          continue;  // fully transparent: a cleared canvas must read back all-zero
        }
        const uint32_t key = PixelKey(src);
        const uint8_t* left = cx > 0 ? cur.data() + (static_cast<size_t>(cx) - 1u) * 4u : nullptr;
        const uint8_t* right =
            cx + 1 < ctx_width ? cur.data() + (static_cast<size_t>(cx) + 1u) * 4u : nullptr;
        const uint8_t* up = have_prev ? prev.data() + static_cast<size_t>(cx) * 4u : nullptr;
        const uint8_t* dn = down ? down + static_cast<size_t>(cx) * 4u : nullptr;
        if (IsFlatRun(key, left, right, up, dn)) {
          continue;
        }
        const uint32_t ax = static_cast<uint32_t>(ctx_origin_x + cx);
        uint8_t* out = drow + static_cast<size_t>(dx) * 4u;
        for (uint32_t c = 0; c < 3u; ++c) {  // R, G, B only; alpha is never touched
          out[c] = FarbleChannel(src[c], ChannelKey(seed, c, ax, ay));
        }
      }
    }

    cur.swap(prev);  // this row's pristine bytes become the row above for the next pass
    have_prev = true;
  }
}

}  // namespace

void FarbleCanvasRgba(uint8_t* base,
                      int width,
                      int height,
                      size_t row_bytes,
                      int origin_x,
                      int origin_y,
                      uint32_t seed) {
  FarbleImpl(base, width, height, row_bytes, base, width, height, row_bytes,
             /*dst_x_in_ctx=*/0, /*dst_y_in_ctx=*/0, origin_x, origin_y, /*y_step=*/1, seed);
}

void FarbleCanvasRgbaFlippedRows(uint8_t* base,
                                 int width,
                                 int height,
                                 size_t row_bytes,
                                 int origin_x,
                                 int top_origin_y,
                                 uint32_t seed) {
  FarbleImpl(base, width, height, row_bytes, base, width, height, row_bytes,
             /*dst_x_in_ctx=*/0, /*dst_y_in_ctx=*/0, origin_x, top_origin_y, /*y_step=*/-1, seed);
}

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
                             uint32_t seed) {
  FarbleImpl(dst, dst_width, dst_height, dst_row_bytes, ctx, ctx_width, ctx_height, ctx_row_bytes,
             dst_x_in_ctx, dst_y_in_ctx, ctx_origin_x, ctx_origin_y, /*y_step=*/1, seed);
}

bool ClientRectCarriesHostEntropy(float width,
                                  float height,
                                  bool css_width_is_fixed,
                                  bool css_height_is_fixed) {
  // A zero-area box says nothing about the host, and noise here is what produced CreepJS's
  // "unknown ghost dimensions". Checked first because it holds however the box was sized.
  if (width == 0.0f && height == 0.0f) {
    return false;
  }
  // Both axes fixed => fully specified by CSS. Either axis auto/percentage/content-driven means
  // layout decided it, and layout is where the machine shows through.
  return !(css_width_is_fixed && css_height_is_fixed);
}

void FarbleClientRect(float* x,
                      float* y,
                      float* width,
                      float* height,
                      uint32_t seed) {
  if (!x || !y || !width || !height || seed == 0u) {
    return;
  }
  // Key on the VALUES, not on a call index. Equal geometry must stay equal: honest Chrome returns
  // exactly equal doubles when a child fills its parent, when one element's bottom is the next
  // one's top, and for two identically laid-out elements. Index keying gave those independent
  // nudges and broke every such equality - a handful of lines of JS to detect.
  const auto bits = [](float v) {
    uint32_t u;
    std::memcpy(&u, &v, sizeof(u));
    return u;
  };
  const auto mix = [&](uint32_t a, uint32_t b) {
    uint32_t h = seed ^ (a * 0x9E3779B1u) ^ (b * 0x85EBCA77u);
    h ^= h >> 16;
    h *= 0x7FEB352Du;
    h ^= h >> 15;
    h *= 0x846CA68Bu;
    h ^= h >> 16;
    return h;
  };
  // One LayoutUnit - the quantum Blink itself lays out on, so the values stay plausible and
  // Math.round(rect.width) still equals offsetWidth.
  constexpr float kUnit = 1.0f / 64.0f;
  const auto nudge = [&](float v, uint32_t salt) {
    return v + ((mix(bits(v), salt) & 1u) ? kUnit : -kUnit);
  };
  // Position and size are keyed independently, but each is a pure function of its own value, so
  // two rects that share an edge coordinate still share it after farbling.
  const float nx = nudge(*x, 0x11u);
  const float ny = nudge(*y, 0x22u);
  *x = nx;
  *y = ny;
  *width = std::max(kUnit, nudge(*width, 0x33u));
  *height = std::max(kUnit, nudge(*height, 0x44u));
}

}  // namespace lobium
