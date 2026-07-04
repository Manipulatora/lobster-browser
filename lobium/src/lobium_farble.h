// Copyright 2026 The Lobster Browser Authors.
//
// Deterministic per-profile canvas farbling — the shared kernel used by both canvas-2D readback hooks
// (getImageData, and the toDataURL/toBlob snapshot). Kept skia-free (operates on a raw RGBA8888 buffer)
// so //components/lobium_fp stays a //base-only leaf; the blink hooks pass their SkPixmap's pixels in.

#ifndef COMPONENTS_LOBIUM_FP_LOBIUM_FARBLE_H_
#define COMPONENTS_LOBIUM_FP_LOBIUM_FARBLE_H_

#include <cstddef>
#include <cstdint>

namespace lobium {

// Nudge R/G/B (never A) of each visible pixel by a delta in {-1, 0, +1} keyed on
// (seed, ABSOLUTE canvas coordinate, channel). Properties:
//   - stable across repeated reads AND restarts (the seed persists with the profile),
//   - identical between getImageData and toDataURL/toBlob for the same pixel (absolute-coordinate keyed,
//     so a getImageData sub-rect read and a full-canvas toDataURL perturb each pixel the same way),
//   - distinct per seed and distinct from the unfarbled host, and +/-1 LSB => visually imperceptible.
//
// `base` is a writable RGBA8888 UNPREMULTIPLIED buffer (straight alpha, so nudging RGB independent of A
// is valid). (origin_x, origin_y) is the absolute canvas coordinate of this buffer's pixel (0,0): (0,0)
// for a full snapshot, (sx, sy) for a getImageData sub-rect. No-op when `seed` is 0 or `base` is null.
void FarbleCanvasRgba(uint8_t* base,
                      int width,
                      int height,
                      size_t row_bytes,
                      int origin_x,
                      int origin_y,
                      uint32_t seed);

}  // namespace lobium

#endif  // COMPONENTS_LOBIUM_FP_LOBIUM_FARBLE_H_
