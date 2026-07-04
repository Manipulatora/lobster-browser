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
      uint8_t* px = row + static_cast<size_t>(x) * 4u;
      if (px[3] == 0u) {
        continue;  // transparent: encoders may zero RGB here -> keep both surfaces consistent
      }
      const uint32_t ax = static_cast<uint32_t>(origin_x + x);
      for (uint32_t c = 0; c < 3u; ++c) {  // R, G, B only; alpha (index 3) untouched
        // Fold the channel into the hash INPUT (not after the avalanche) so each of R/G/B is an
        // INDEPENDENT draw over {-1,0,+1}. Otherwise all three derive from one mixed value and can
        // never nudge the same direction (dR+dG+dB never reaches +/-3) — a seed-independent tell.
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
  }
}

}  // namespace lobium
