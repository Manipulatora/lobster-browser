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
export { generateSeed, isValidPersistedSeed, isValidSeed } from './seed.js';
export { deriveDevicePersona, deriveFingerprint, deriveFromPools } from './derive.js';
export { ENGINE_CHROME } from './pools.js';
export {
  DEVICE_TIER_ENVELOPES,
  HIGH_CORE_MEMORY_FLOOR,
  catalogRendererCounts,
  gpuTierFromRenderer,
} from './device-tiers.js';
export {
  MACOS_APPLE_SILICON_MODES,
  MACOS_INTEL_MODES,
  MACOS_RETINA_MODES,
  displayModesFor,
  isPlausibleDisplayMode,
  normalizeDevicePixelRatio,
} from './displays.js';
export { deriveAndroidFingerprint, validateAndroidFingerprintCoherence } from './android.js';
export {
  applyGeoToFingerprint,
  resolveFingerprintPersonaModes,
  validateFingerprintCoherence,
  normalizeDeviceMemory,
  normalizeColorDepth,
  DEVICE_MEMORY_VALUES,
  DESKTOP_DEVICE_MEMORY_VALUES,
  DESKTOP_MIN_DEVICE_MEMORY,
} from './coherence.js';
export { applyOverrides } from './overrides.js';
export {
  coherentGpuIdentity,
  webgpuIdentityFor,
  webgpuIdentityMatches,
} from './webgpu-identity.js';
export {
  deriveFingerprintFromHost,
  normalizeHostWebglIdentity,
  validateHostCalibrationProfile,
} from './host-calibration.js';
export {
  ANDROID_PHONE_MODEL_CATALOG,
  ANDROID_TABLET_MODEL_CATALOG,
  CATALOG_PROVENANCE,
  FINGERPRINT_CATALOG_SOURCES,
  LINUX_FONT_NAMES,
  MACOS_FONT_NAMES,
  WINDOWS_FONT_NAMES,
} from './catalog.generated.js';
export {
  LINUX_RENDERER_PRESETS,
  MACOS_ARM_RENDERER_PRESETS,
  MACOS_INTEL_RENDERER_PRESETS,
  resolveValidatedRendererPreset,
  resolveSourcedRendererPreset,
  VALIDATED_RENDERER_PRESETS,
  WINDOWS_RENDERER_PRESETS,
} from './catalog.js';
export type { DeriveDeviceOptions, DeriveOptions, DerivedDevicePersona } from './derive.js';
export type { DeviceTierEnvelope, GpuTier } from './device-tiers.js';
export type { DisplayMode } from './displays.js';
export type { DeriveAndroidOptions } from './android.js';
export type { DeriveFromHostOptions } from './host-calibration.js';
export type { AndroidDeviceCatalogEntry, RendererCatalogEntry } from './catalog.generated.js';
export type { FullCaptureRendererCatalogEntry, ProductRendererCatalogEntry } from './catalog.js';
export {
  DEFAULT_FONT_SELECTION_TARGET,
  androidMajorFromOsVersionLabel,
  defaultFontsForOs,
  defaultLinuxFonts,
  defaultMacosFonts,
  defaultWindowsFonts,
  filterAndroidCatalogByOsVersion,
  normalizeMacFontFamily,
} from './defaults.js';
export type { DesktopFontOs } from './defaults.js';
