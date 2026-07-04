// Copyright 2026 The Lobster Browser Authors.
//
// See lobium_audio_farble.h. Definition lives in a .cc (like lobium_farble.cc) so the deliberate
// raw-float pointer indexing opts THIS translation unit out of -Wunsafe-buffer-usage without leaking
// that opt-out into every WebAudio file that includes the header.

#ifdef UNSAFE_BUFFERS_BUILD
#pragma allow_unsafe_buffers
#endif

#include "components/lobium_fp/lobium_audio_farble.h"

namespace lobium {

namespace {

// splitmix64 finalizer over (seed, absolute sample index). 64-bit so a large frame index never aliases
// (a 32-bit key would collide past ~4.3e9 samples); the whole 64-bit key is a pure function of the
// inputs, so the perturbation is identical on every read and every re-render of the same profile.
inline uint64_t Mix(uint64_t seed64, uint64_t index) {
  uint64_t z = index * 0x9E3779B97F4A7C15ull ^ seed64;
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
  z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
  z ^= z >> 31;
  return z;
}

}  // namespace

void FarbleAudioSamples(float* data, size_t count, size_t base_index, uint32_t seed) {
  if (!data || seed == 0u) {
    return;
  }
  // Peak relative offset. +/-0.15% (~ -56 dBFS) is far below any audible / functional threshold — real
  // cross-machine DSP + resampling differences dwarf it — yet, applied PER SAMPLE with a distinct
  // sign+magnitude, it is NOT a constant ratio (dividing two seeded fingerprints does not recover one
  // factor) and it reliably shifts every addend of the sample-sum / bit-hash a fingerprinter computes.
  constexpr double kAmplitude = 1.5e-3;
  const uint64_t seed64 = (static_cast<uint64_t>(seed) << 32) | seed;
  for (size_t k = 0; k < count; ++k) {
    const uint64_t z = Mix(seed64, static_cast<uint64_t>(base_index) + k);
    // Top 53 bits -> u in [0, 1) with full double precision, then eps in [-A, +A].
    const double u = static_cast<double>(z >> 11) * (1.0 / 9007199254740992.0);
    const double eps = kAmplitude * (2.0 * u - 1.0);
    // Relative multiply: scale-invariant (inaudible on loud and quiet samples alike) and sign/range
    // preserving (PCM stays ~[-1,1], negative-dB spectra stay negative) — no clamp needed.
    data[k] = static_cast<float>(static_cast<double>(data[k]) * (1.0 + eps));
  }
}

}  // namespace lobium
