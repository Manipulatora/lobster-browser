import type { CpuArch, OsFamily } from './engine.js';

/**
 * The persisted per-profile seed. A profile's fingerprint is derived deterministically
 * from this seed so it stays STABLE across restarts (the anti-detect model).
 * Stored as a lowercase hex string.
 */
export type FingerprintSeed = string;

/** navigator.* and User-Agent Client Hints surface. Must be internally coherent. */
export interface NavigatorFingerprint {
  userAgent: string;
  platform: string;
  /** navigator.languages[0] drives Accept-Language; both derive from proxy geo. */
  languages: string[];
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  /** Sec-CH-UA brand list (name + version), including the GREASE entry. */
  uaBrands: Array<{ brand: string; version: string }>;
  uaPlatform: string;
  uaPlatformVersion: string;
  uaMobile: boolean;
  uaFullVersion: string;
}

/** screen / window / matchMedia surface. */
export interface ScreenFingerprint {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  colorDepth: number;
  devicePixelRatio: number;
}

/** WebGL vendor/renderer identity. Populated at the native engine layer (P0). */
export interface WebGlFingerprint {
  vendor: string;
  renderer: string;
  /** UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL. */
  unmaskedVendor: string;
  unmaskedRenderer: string;
}

/** Locale/timezone/geolocation cluster — derived from the proxy exit IP. */
export interface LocaleFingerprint {
  /** IANA timezone, e.g. "America/New_York". */
  timezone: string;
  /** BCP-47 locale, e.g. "en-US". */
  locale: string;
  acceptLanguage: string;
  geolocation?: { latitude: number; longitude: number; accuracy: number };
}

/**
 * A coherent, per-profile fingerprint. The engine-runner fills the deep surfaces
 * (canvas/webgl/audio) at the native engine layer; the JS-safe surfaces here are
 * generated from real-device distributions and applied via clean CDP overrides.
 */
export interface Fingerprint {
  os: OsFamily;
  arch: CpuArch;
  navigator: NavigatorFingerprint;
  screen: ScreenFingerprint;
  webgl: WebGlFingerprint;
  locale: LocaleFingerprint;
  /** Font families the profile exposes, matched to the claimed OS. */
  fonts: string[];
}

/** User-editable overrides applied on top of the seed-derived fingerprint. */
export type FingerprintOverrides = Partial<{
  navigator: Partial<NavigatorFingerprint>;
  screen: Partial<ScreenFingerprint>;
  locale: Partial<LocaleFingerprint>;
  fonts: string[];
}>;
