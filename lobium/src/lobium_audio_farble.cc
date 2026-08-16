// Copyright 2026 The Lobster Browser Authors.
//
// See lobium_audio_farble.h for why this is keyed on the sample value rather than its index, and for
// the oracle that broke the previous design. The definition lives in a .cc (like lobium_farble.cc) so
// the deliberate raw-float pointer indexing opts THIS translation unit out of -Wunsafe-buffer-usage
// without leaking that opt-out into every WebAudio file that includes the header.

#ifdef UNSAFE_BUFFERS_BUILD
#pragma allow_unsafe_buffers
#endif

#include "components/lobium_fp/lobium_audio_farble.h"

#include <cstring>

namespace lobium {

namespace {

// splitmix64 finalizer. Only the seed and the sample's sign+exponent go in, so the key is invariant
// under the mantissa nudge below - which is what makes the perturbation idempotent.
inline uint64_t Mix(uint64_t seed64, uint64_t x) {
  uint64_t z = x * 0x9E3779B97F4A7C15ull ^ seed64;
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
  z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
  z ^= z >> 31;
  return z;
}

// How many bit patterns out of every kClass are eligible. One in five samples moves, which is ample
// to change any hash or sum a fingerprinter computes while keeping the aggregate shift tiny.
constexpr uint32_t kClass = 5u;

// The largest nudge, in float32 ULPs. Two ULPs is a relative deviation below 2.4e-7 - inside the
// honest cross-machine spread of the canonical audio fingerprint.
constexpr uint32_t kMaxUlp = 2u;

inline uint32_t BitsOf(float v) {
  uint32_t u;
  std::memcpy(&u, &v, sizeof(u));
  return u;
}

inline float FromBits(uint32_t u) {
  float v;
  std::memcpy(&v, &u, sizeof(v));
  return v;
}

}  // namespace

void FarbleAudioSamples(float* data, size_t count, uint32_t seed) {
  if (!data || seed == 0u) {
    return;
  }
  const uint64_t seed64 = (static_cast<uint64_t>(seed) << 32) | seed;

  for (size_t k = 0; k < count; ++k) {
    const float v = data[k];

    // Exact zero must stay exact zero: silence renders as silence, and a cleared buffer must read
    // back as one. Nudging 0.0f would emit the smallest denormal, which is both audible-in-principle
    // nonsense and a tell.
    if (v == 0.0f) {
      continue;
    }

    const uint32_t u = BitsOf(v);
    const uint32_t exponent = (u >> 23) & 0xFFu;
    // Skip non-finite (exponent 0xFF) and subnormal/zero-exponent values: their ULP spacing is not
    // the usual relative one, and perturbing them buys nothing.
    if (exponent == 0xFFu || exponent == 0u) {
      continue;
    }

    // Keep the nudge strictly inside the mantissa. If it could carry into the exponent, the key
    // (derived from sign+exponent) would change and the function would stop being idempotent.
    const uint32_t mantissa = u & 0x7FFFFFu;
    if (mantissa < kMaxUlp || mantissa > 0x7FFFFFu - kMaxUlp) {
      continue;
    }

    // Key on the seed and on sign+exponent only - the bits a mantissa nudge cannot touch.
    const uint32_t key32 = static_cast<uint32_t>(Mix(seed64, static_cast<uint64_t>(u >> 23)));

    // Eligible iff the value sits in one residue class of the bit pattern. Computed in 64 bits on
    // purpose: in 32-bit arithmetic `u + key32` can wrap, and 2^32 is not a multiple of kClass, so a
    // pattern that wraps would land in a different class after the nudge than the arithmetic below
    // assumes - breaking idempotence for a vanishing but real fraction of inputs.
    const uint64_t probe = static_cast<uint64_t>(u) + key32;
    if (probe % kClass != 0u) {
      continue;
    }

    // Move by one or two ULPs, in the direction the key selects.
    //
    // Idempotence, concretely: `probe` is a multiple of kClass and, because u is a normal float,
    // probe >= 2^23 > kClass. After the nudge the probe is probe +/- step with no wraparound (the
    // mantissa guard keeps u +/- step inside the same exponent), so its residue is step or
    // kClass - step, both in {1, 2, 3, 4} and therefore never 0. A second pass skips the sample.
    const uint32_t step = 1u + ((key32 >> 8) & 1u);
    const bool up = ((key32 >> 9) & 1u) != 0u;
    data[k] = FromBits(up ? u + step : u - step);
  }
}

}  // namespace lobium
