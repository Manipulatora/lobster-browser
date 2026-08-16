// Copyright 2026 The Lobster Browser Authors.
//
// Seeded Web Audio farbling kernel - the audio analogue of lobium_farble.h (canvas). Deterministically
// perturbs float PCM samples so a rendered-audio fingerprint (OfflineAudioContext + DynamicsCompressor
// -> getChannelData/copyFromChannel, the dominant vector) becomes stable-per-profile and
// distinct-per-seed.
//
// Kept dependency-light (no Blink / WebAudio / //base headers beyond <cstddef>/<cstdint>) so the
// //components/lobium_fp module stays //base-only and links into any consumer.

#ifndef COMPONENTS_LOBIUM_FP_LOBIUM_AUDIO_FARBLE_H_
#define COMPONENTS_LOBIUM_FP_LOBIUM_AUDIO_FARBLE_H_

#include <cstddef>
#include <cstdint>

namespace lobium {

// Perturb `count` float samples of `data` IN PLACE, by AT MOST two float32 ULPs each, keyed on the
// sample's own VALUE. No-op when `data` is null or `seed` is 0.
//
// WHY VALUE KEYING, NOT INDEX KEYING. The previous kernel multiplied sample k by (1 + eps) where eps
// was a function of (seed, absolute index k). That is detectable in five lines, with no knowledge of
// the host and no false positives on any honest browser:
//
//     const ctx = new OfflineAudioContext(1, 8192, 44100);
//     const s = new ConstantSourceNode(ctx, { offset: 0.5 });
//     s.connect(ctx.destination); s.start();
//     const d = (await ctx.startRendering()).getChannelData(0);
//     const lied = d.some(v => v !== 0.5);
//
// Honest Chrome renders that graph through `std::ranges::fill` and a byte copy - no arithmetic at
// all - so every frame holds exactly 0x3F000000 on every platform, CPU and GPU backend that has ever
// existed. Index keying makes 8192 DIFFERENT values out of one constant input. Crucially, lowering
// the amplitude does not help: at one ULP the array is still non-constant. The keying itself had to
// change.
//
// Keying on the value gives equal inputs equal outputs, which buys four things at once:
//   * a constant/known input renders exactly flat again;
//   * an honest mono-to-stereo upmix stays bit-identical between channels for free, with no
//     special-casing (a per-channel key would have broken it - that is a `channelData(0)[k] ===
//     channelData(1)[k]` oracle);
//   * the function is IDEMPOTENT (see below), so a sample that passes through two farbled taps -
//     an offline AudioWorklet or ScriptProcessorNode feeding the farbled destination buffer - is
//     perturbed once, not twice. Index keying produced (1+eps)^2 on that route against (1+eps) on a
//     direct one, a contradiction honest Chrome cannot produce;
//   * routes that read the same sample through different index domains (the analyser paths, which
//     have no meaningful absolute index) can no longer disagree, because no index is involved.
//
// IDEMPOTENCE. A value is moved only when its bit pattern falls in one residue class, and the move
// takes it out of that class, so f(f(x)) == f(x). The key is derived from the sign+exponent bits
// only, which a mantissa nudge cannot change, and values whose mantissa sits within two ULPs of an
// exponent boundary are skipped so the nudge can never carry into the exponent.
//
// AMPLITUDE. At most two ULPs, i.e. a relative deviation under 2.4e-7. For scale: the honest
// cross-machine spread of the canonical FingerprintJS audio sum (triangle oscillator ->
// DynamicsCompressor, summed over 500 samples) is about 2e-7 relative within the x86 desktop
// population, and Blink's only genuine source of cross-OS divergence there is the host libm
// `powf`/`log10f` that audio_utilities.cc calls per sample. The previous 1.5e-3 amplitude was ~12,600
// ULP - it randomised the bottom ~13.6 of the 24 significand bits, and shifted that sum by ~190x the
// entire honest population spread, placing every profile off the manifold that whitelist-style audio
// checks compare against. Perturbing whole ULPs also means every emitted value is one that honest
// float arithmetic could plausibly have produced.
//
// RESIDUAL, stated rather than hidden: a page that knows the exact expected output can still see
// that some samples differ by a ULP. No farbling scheme survives ground truth. The point is that the
// cheap oracles - constant input, upmix equality, double-application, cross-route disagreement, and
// distance to the known-value cluster - no longer fire.
//
// CALLER CONTRACT: pass ONLY buffers on their way to JavaScript as a fingerprint READBACK (the
// finalized OfflineAudioContext result buffer, or an analyser's JS destination array). NEVER pass
// audio destined for playback or an AudioNode's internal FFT/smoothing state. Unlike the previous
// kernel, applying this one twice is harmless - but it is still the wrong buffer to touch.
void FarbleAudioSamples(float* data, size_t count, uint32_t seed);

}  // namespace lobium

#endif  // COMPONENTS_LOBIUM_FP_LOBIUM_AUDIO_FARBLE_H_
