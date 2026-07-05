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

// Perturb R/G/B (never A) of one RGBA pixel by a per-channel-INDEPENDENT delta in {-1,0,+1}, keyed on
// (seed, absolute TOP-DOWN coordinate, channel). Folding the channel into the hash INPUT (not after the
// avalanche) makes each of R/G/B an independent draw — otherwise dR+dG+dB could never reach +/-3, a
// seed-independent tell. Transparent pixels are skipped so encoders that zero RGB stay consistent.
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
  // Top-down buffer (getImageData / toDataURL snapshot): buffer row y is (origin_y + y) rows from top.
  for (int y = 0; y < height; ++y) {
    uint8_t* row = base + static_cast<size_t>(y) * row_bytes;
    const uint32_t ay = static_cast<uint32_t>(origin_y + y);
    for (int x = 0; x < width; ++x) {
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
  // Bottom-up buffer (GL gl.readPixels): buffer row y maps to the TOP-DOWN coordinate
  // (top_origin_y - y). Keying on that top-down ay makes a given screen pixel get the SAME delta here
  // as via the top-down toDataURL/toBlob snapshot path — so a detector cross-checking readPixels
  // against the encoded image sees consistent, coherent per-profile noise (no cross-path tell).
  for (int y = 0; y < height; ++y) {
    uint8_t* row = base + static_cast<size_t>(y) * row_bytes;
    const uint32_t ay = static_cast<uint32_t>(top_origin_y - y);
    for (int x = 0; x < width; ++x) {
      FarblePixel(row + static_cast<size_t>(x) * 4u,
                  static_cast<uint32_t>(origin_x + x), ay, seed);
    }
  }
}

}  // namespace lobium
