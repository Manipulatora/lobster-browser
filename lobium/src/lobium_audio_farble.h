// Copyright 2026 The Lobster Browser Authors.
//
// Seeded Web Audio farbling kernel — the audio analogue of lobium_farble.h (canvas). Deterministically
// perturbs float PCM samples by an imperceptible, per-sample relative amount so a rendered-audio
// fingerprint (OfflineAudioContext + DynamicsCompressor → getChannelData/copyFromChannel, the dominant
// vector) becomes stable-per-profile, distinct-per-seed, and differs from the host — without being a
// constant multiplier (which a detector could divide back out of two fingerprints).
//
// Kept dependency-light (no Blink / WebAudio / //base headers beyond <cstddef>/<cstdint>) so the
// //components/lobium_fp module stays //base-only and links into any consumer.

#ifndef COMPONENTS_LOBIUM_FP_LOBIUM_AUDIO_FARBLE_H_
#define COMPONENTS_LOBIUM_FP_LOBIUM_AUDIO_FARBLE_H_

#include <cstddef>
#include <cstdint>

namespace lobium {

// Multiply each of `count` float samples of `data` IN PLACE by (1 + eps), where eps in [-A, +A]
// (A ~= 1.5e-3, ~ -56 dBFS) is a pure function of (seed, base_index + k) via a splitmix64 finalizer.
// `base_index` is the sample's absolute offset within the logical signal, so a chunked/partial read
// farbles each sample identically to a whole-buffer read (getChannelData vs copyFromChannel agree).
// Stable across reads AND restarts (eps is a pure function; the seed persists with the profile),
// distinct per seed, and always != host for seed != 0 (eps != 0). No-op when `data` is null or seed 0.
//
// Use the SAME (seed, index) key for every channel of a multi-channel buffer — do NOT fold the channel
// into the seed. Honest Chrome upmixes mono to bit-identical channels; a per-channel key would make them
// diverge, a cheap detectable oracle. One eps sequence keeps identical channels identical (the factor
// cancels in the inter-channel ratio) yet farbles genuinely-distinct channels distinctly.
// Relative (not additive) so it is scale-invariant/inaudible and sign/range preserving (PCM stays
// ~[-1,1], negative-dB spectra stay negative) — no clamp; works for PCM and dB float spectra alike.
//
// CALLER CONTRACT: pass ONLY buffers on their way to JavaScript as a fingerprint READBACK (the
// finalized OfflineAudioContext result buffer, or an analyser's JS destination array). NEVER pass audio
// destined for playback or an AudioNode's internal FFT/smoothing state — the perturbation is one-way and
// would corrupt real audio. Apply exactly ONCE per logical read to a PRISTINE source (re-running on
// already-farbled data compounds).
void FarbleAudioSamples(float* data, size_t count, size_t base_index, uint32_t seed);

}  // namespace lobium

#endif  // COMPONENTS_LOBIUM_FP_LOBIUM_AUDIO_FARBLE_H_
