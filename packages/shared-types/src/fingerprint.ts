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
  /**
   * Origin of the available rect (screen minus OS chrome). Optional (default 0). `availTop` is the key
   * coherence signal: macOS always has a top menu bar (~25px) so a Mac persona MUST report availTop>0,
   * while Windows/Linux with a bottom taskbar keep availTop=0. The native Screen::GetRect hook reads
   * these; absent => 0.
   */
  availLeft?: number;
  availTop?: number;
  colorDepth: number;
  devicePixelRatio: number;
}

/** WebGL vendor/renderer identity. Populated at the native engine layer (P0). */
/**
 * WebGL numeric/structural capability limits. Overriding vendor/renderer STRINGS alone is a tell: the
 * MAX_* limits, viewport dims and aliased ranges still describe the real backend. On a software
 * (SwiftShader) backend these read distinctly low (e.g. MAX_TEXTURE_SIZE 8192) next to a real-GPU
 * renderer string — a cross-check a detector reads directly. These are overridden natively (ENG-8) to a
 * coherent real-ANGLE profile for the claimed GPU class. (The extension list + shader-precision buckets
 * need per-GPU capture to be exact — the real-GPU boundary — so they are left to the backend for now.)
 */
export interface WebGlCaps {
  maxTextureSize: number;
  maxCubeMapTextureSize: number;
  maxRenderbufferSize: number;
  maxViewportDims: [number, number];
  maxVertexAttribs: number;
  maxVertexUniformVectors: number;
  maxFragmentUniformVectors: number;
  maxVaryingVectors: number;
  maxTextureImageUnits: number;
  maxVertexTextureImageUnits: number;
  maxCombinedTextureImageUnits: number;
  aliasedLineWidthRange: [number, number];
  aliasedPointSizeRange: [number, number];
}

export interface WebGlFingerprint {
  vendor: string;
  renderer: string;
  /** UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL. */
  unmaskedVendor: string;
  unmaskedRenderer: string;
  /** Numeric GPU limits, overridden natively so MAX_* agree with the renderer string (ENG-8). */
  caps?: WebGlCaps;
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
