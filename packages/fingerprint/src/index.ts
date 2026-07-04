/**
 * @lobster/fingerprint
 *
 * Turns a per-profile seed into a coherent, STABLE fingerprint and keeps it consistent
 * with the proxy geo. The deep surfaces (canvas/webgl/audio pixel hashes) are handled by
 * the native engine layer in the engine-runner; this package owns the deterministic,
 * describable surfaces and the coherence rules that tie them together.
 *
 * The device model is the built-in coherent catalog (`pools.ts`), derived deterministically
 * (FNV-1a → mulberry32). An earlier plan to source distributions from Apify's fingerprint-suite was
 * dropped (commit 9499136) to own the model and remove the supply-chain dependency.
 */
export { SeededRandom, hashStringToUint32, mulberry32 } from './prng.js';
export { generateSeed, isValidSeed } from './seed.js';
export { deriveFingerprint, deriveFromPools } from './derive.js';
export {
  applyGeoToFingerprint,
  validateFingerprintCoherence,
  normalizeDeviceMemory,
  normalizeColorDepth,
  DEVICE_MEMORY_VALUES,
  DESKTOP_MIN_DEVICE_MEMORY,
} from './coherence.js';
export { applyOverrides } from './overrides.js';
export type { DeriveOptions } from './derive.js';
