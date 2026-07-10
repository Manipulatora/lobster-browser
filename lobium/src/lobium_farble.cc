// Copyright 2026 The Lobster Browser Authors.
//
// See lobium_farble.h. Definition lives here so the deliberate raw-byte pixel arithmetic (bounded by
// the caller's pixmap dimensions) opts THIS translation unit out of -Wunsafe-buffer-usage without
// leaking that opt-out into every blink file that includes the header.

#ifdef UNSAFE_BUFFERS_BUILD
#pragma allow_unsafe_buffers
#endif

#include "components/lobium_fp/lobium_farble.h"

namespace lobium {
namespace {

// Edge-aware canvas farbling (CreepJS-safe):
// CreepJS flags "pixel data modified" when fillRect(solid) → getImageData returns a different RGB.
// It also checks a cleared canvas is all-zero and known low-entropy AA patterns. We therefore:
//   - never touch transparent pixels (alpha == 0),
//   - never touch a pixel whose RGB equals ALL four orthogonal neighbors (solid interior),
//   - only nudge anti-aliased / textured edge pixels by {-1,0,+1} on R/G/B.
// Text/emoji fingerprint scenes still diverge per seed; solid fills and clearRect stay exact.

inline bool IsSolidInterior(const uint8_t* base,
                            int width,
                            int height,
                            size_t row_bytes,
                            int x,
                            int y) {
  const uint8_t* px = base + static_cast<size_t>(y) * row_bytes + static_cast<size_t>(x) * 4u;
  auto same_rgb = [&](int nx, int ny) -> bool {
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
      return true;  // treat OOB as matching so edge-of-buffer solids still skip
    }
    const uint8_t* n =
        base + static_cast<size_t>(ny) * row_bytes + static_cast<size_t>(nx) * 4u;
    return n[0] == px[0] && n[1] == px[1] && n[2] == px[2] && n[3] == px[3];
  };
  return same_rgb(x - 1, y) && same_rgb(x + 1, y) && same_rgb(x, y - 1) && same_rgb(x, y + 1);
}

inline void FarblePixel(uint8_t* px, uint32_t ax, uint32_t ay, uint32_t seed) {
  if (px[3] == 0u) {
    return;
  }
  for (uint32_t c = 0; c < 3u; ++c) {  // R, G, B only; alpha (index 3) untouched
    uint32_t h = seed ^ (c * 0x9E3779B1u);
    h ^= ax * 0x85EBCA77u;
    h *= 0xC2B2AE3Du;
    h ^= h >> 15;
    h ^= ay * 0x27D4EB2Fu;
    h *= 0x165667B1u;
    h ^= h >> 13;
    h ^= h >> 16;
    const int delta = static_cast<int>(h % 3u) - 1;  // {-1, 0, +1}
    const int v = static_cast<int>(px[c]) + delta;
    px[c] = static_cast<uint8_t>(v < 0 ? 0 : (v > 255 ? 255 : v));
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
  if (!base || seed == 0u) {
    return;
  }
  for (int y = 0; y < height; ++y) {
    uint8_t* row = base + static_cast<size_t>(y) * row_bytes;
    const uint32_t ay = static_cast<uint32_t>(origin_y + y);
    for (int x = 0; x < width; ++x) {
      if (IsSolidInterior(base, width, height, row_bytes, x, y)) {
        continue;
      }
      FarblePixel(row + static_cast<size_t>(x) * 4u,
                  static_cast<uint32_t>(origin_x + x), ay, seed);
    }
  }
}

void FarbleCanvasRgbaFlippedRows(uint8_t* base,
                                 int width,
                                 int height,
                                 size_t row_bytes,
                                 int origin_x,
                                 int top_origin_y,
                                 uint32_t seed) {
  if (!base || seed == 0u) {
    return;
  }
  for (int y = 0; y < height; ++y) {
    uint8_t* row = base + static_cast<size_t>(y) * row_bytes;
    const uint32_t ay = static_cast<uint32_t>(top_origin_y - y);
    for (int x = 0; x < width; ++x) {
      if (IsSolidInterior(base, width, height, row_bytes, x, y)) {
        continue;
      }
      FarblePixel(row + static_cast<size_t>(x) * 4u,
                  static_cast<uint32_t>(origin_x + x), ay, seed);
    }
  }
}

void FarbleClientRect(float* x,
                      float* y,
                      float* width,
                      float* height,
                      uint32_t rect_index,
                      uint32_t seed) {
  // CreepJS hashes known rotated/ghost DOMRect dimensions (e.g. Blink dpr=1 hash 9d9215cc). Any
  // sub-pixel nudge fails "unknown rotate/ghost dimensions". Keep the hook wired (seed path) but
  // do not mutate geometry until a non-detectable strategy exists. Unlinkability for rects is
  // deferred; canvas/WebGL/audio remain the active farbling surfaces.
  (void)x;
  (void)y;
  (void)width;
  (void)height;
  (void)rect_index;
  (void)seed;
}

}  // namespace lobium
