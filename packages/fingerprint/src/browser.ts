/**
 * Browser-safe entry for `@lobster/fingerprint`.
 *
 * The package root (`index.ts`) also re-exports `generateSeed` from `seed.ts`, which imports
 * `node:crypto` and breaks Vite/browser bundles. Desktop UI only needs derive / coherence /
 * overrides — export those here and point Vite at this file.
 */
export { deriveFingerprint, deriveFromPools } from './derive.js';
export type { DeriveOptions } from './derive.js';
export {
  applyGeoToFingerprint,
  validateFingerprintCoherence,
  normalizeDeviceMemory,
  normalizeColorDepth,
  DEVICE_MEMORY_VALUES,
  DESKTOP_MIN_DEVICE_MEMORY,
} from './coherence.js';
export { applyOverrides } from './overrides.js';
export {
  deriveFingerprintFromHost,
  validateHostCalibrationProfile,
} from './host-calibration.js';
export type { DeriveFromHostOptions } from './host-calibration.js';
