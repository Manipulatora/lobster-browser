/**
 * Browser-safe entry for `@lobster/fingerprint`.
 *
 * The package root (`index.ts`) also re-exports `generateSeed` from `seed.ts`, which imports
 * `node:crypto` and breaks Vite/browser bundles. Desktop UI only needs derive / coherence /
 * overrides — export those here and point Vite at this file.
 */
export { deriveDevicePersona, deriveFingerprint, deriveFromPools } from './derive.js';
export { ENGINE_CHROME } from './pools.js';
export type { DeriveDeviceOptions, DeriveOptions, DerivedDevicePersona } from './derive.js';
export {
  DEVICE_TIER_ENVELOPES,
  HIGH_CORE_MEMORY_FLOOR,
  gpuTierFromRenderer,
} from './device-tiers.js';
export type { DeviceTierEnvelope, GpuTier } from './device-tiers.js';
export {
  MACOS_APPLE_SILICON_MODES,
  MACOS_INTEL_MODES,
  MACOS_RETINA_MODES,
  displayModesFor,
  isPlausibleDisplayMode,
  normalizeDevicePixelRatio,
} from './displays.js';
export type { DisplayMode } from './displays.js';
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
export { deriveFingerprintFromHost, validateHostCalibrationProfile } from './host-calibration.js';
export type { DeriveFromHostOptions } from './host-calibration.js';
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
  WINDOWS_RENDERER_PRESETS,
  resolveSourcedRendererPreset,
} from './catalog.js';
export type { AndroidDeviceCatalogEntry, RendererCatalogEntry } from './catalog.generated.js';
export type { ProductRendererCatalogEntry } from './catalog.js';
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
