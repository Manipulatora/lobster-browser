/**
 * @lobster/fingerprint
 *
 * Turns a per-profile seed into a coherent, STABLE fingerprint and keeps it consistent
 * with the proxy geo. The deep surfaces (canvas/webgl/audio pixel hashes) are handled by
 * the native engine layer in the engine-runner; this package owns the deterministic,
 * describable surfaces and the coherence rules that tie them together.
 *
 * Day 1 replaces the built-in device pools (`pools.ts`) with Apify fingerprint-suite's
 * real-device distributions while keeping this same public API.
 */
export { SeededRandom, hashStringToUint32, mulberry32 } from './prng.js';
export { generateSeed, isValidSeed } from './seed.js';
export { deriveFingerprint } from './derive.js';
export { applyGeoToFingerprint, validateFingerprintCoherence } from './coherence.js';
export { applyOverrides } from './overrides.js';
export type { DeriveOptions } from './derive.js';
