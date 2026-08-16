import type { CpuArch, OsFamily, PlannedMobileOsFamily } from './engine.js';

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
  /** Sec-CH-UA-Model / high-entropy model. Empty or omitted on desktop; real device model on Android. */
  uaModel?: string;
  /**
   * Sec-CH-UA-Form-Factors, exactly one of these. Omit to let the engine derive it from `uaMobile`.
   *
   * A TABLET must state it. Real tablet Chrome omits the "Mobile" UA token, so a tablet persona sets
   * `uaMobile: false` — and the mobile-bit derivation would then announce "Desktop" alongside a
   * tablet Sec-CH-UA-Model and an Android platform, which is a one-call contradiction.
   */
  uaFormFactor?: 'Desktop' | 'Mobile' | 'Tablet';
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

/** Result of `getShaderPrecisionFormat(..., ...)` for one shader/precision pair. */
export interface WebGlShaderPrecisionFormat {
  rangeMin: number;
  rangeMax: number;
  precision: number;
}

export interface WebGlShaderPrecisionStage {
  lowFloat: WebGlShaderPrecisionFormat;
  mediumFloat: WebGlShaderPrecisionFormat;
  highFloat: WebGlShaderPrecisionFormat;
  lowInt: WebGlShaderPrecisionFormat;
  mediumInt: WebGlShaderPrecisionFormat;
  highInt: WebGlShaderPrecisionFormat;
}

/** Captured shader precision buckets for vertex + fragment shaders. */
export interface WebGlShaderPrecisionProfile {
  vertex: WebGlShaderPrecisionStage;
  fragment: WebGlShaderPrecisionStage;
}

export interface WebGlFingerprint {
  vendor: string;
  renderer: string;
  /** UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL. */
  unmaskedVendor: string;
  unmaskedRenderer: string;
  /** Numeric GPU limits, overridden natively so MAX_* agree with the renderer string (ENG-8). */
  caps?: WebGlCaps;
  /** `gl.VERSION` captured from the real host backend. */
  version?: string;
  /** `gl.SHADING_LANGUAGE_VERSION` captured from the real host backend. */
  shadingLanguageVersion?: string;
  /**
   * `getSupportedExtensions()` for a WebGL1 context, in Chrome's REGISTRATION order (not sorted —
   * an alphabetised list is a shape no real browser emits).
   */
  extensions?: string[];
  /**
   * The same for a WebGL2 context. Required separately, not derivable from `extensions`: WebGL2
   * folds several WebGL1 extensions into core and adds its own, and the engine matches configured
   * names against the context's own registrations — so a WebGL1 list handed to a WebGL2 context
   * collapses to the few names common to both.
   */
  extensions2?: string[];
  /** `getShaderPrecisionFormat()` buckets captured from the host. */
  shaderPrecision?: WebGlShaderPrecisionProfile;
}

/**
 * `navigator.gpu` adapter identity (`GPUAdapterInfo`).
 *
 * Not part of {@link WebGlFingerprint} even though both describe one GPU: WebGL reports marketing
 * strings through an ANGLE wrapper, WebGPU reports Dawn's lowercase vendor/architecture slugs. They
 * are DERIVED from the same renderer at fingerprint-build time so they cannot disagree, but the two
 * wire shapes are genuinely different and flattening them would lose that.
 */
export interface WebGpuFingerprint {
  /** Dawn vendor slug, lowercase — "nvidia", "amd", "intel", "apple". */
  vendor: string;
  /** Dawn GPU-family slug, lowercase — "ada-lovelace", "rdna-3", "gen-9". */
  architecture: string;
  /** PCI device id formatted as Chrome formats it, e.g. "0x2503". */
  device: string;
  /** Human-readable adapter name, e.g. "NVIDIA GeForce RTX 3060". */
  description: string;
  driver: string;
  /**
   * Drives `adapter.isFallbackAdapter`, which Chrome derives from the adapter type — only a `cpu`
   * adapter is a fallback. A persona claiming a discrete GPU while reporting a fallback adapter
   * contradicts itself in a single object read.
   */
  adapterType: 'discrete' | 'integrated' | 'cpu';
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

/** How WebRTC should expose network candidates for a launched profile. */
export type WebRtcPolicy =
  'default_public_interface_only' | 'disable_non_proxied_udp' | 'proxy_only' | 'disabled';

/**
 * Product persona mode for Language / Timezone / Geolocation / WebRTC / Fonts.
 * - `real`: do not override (use host / seed defaults)
 * - `manual`: use the user-supplied value
 * - `based_ip`: derive from proxy exit IP (geo overlay)
 */
export type PersonaMode = 'real' | 'manual' | 'based_ip';

/** Android device type for the create-profile Fingerprint tab. */
export type AndroidDeviceType = 'mobile' | 'tablet';

/** User-facing deterministic noise switches. Unsupported switches must be surfaced in UI. */
export interface HardwareNoisePolicy {
  webgl: boolean;
  canvas: boolean;
  audio: boolean;
  clientRects: boolean;
}

/** Stable media-device counts and identity policy for camera/mic/speaker enumeration. */
export interface MediaDeviceProfile {
  cameras: number;
  microphones: number;
  speakers: number;
  stableDeviceIds: boolean;
}

/** Renderer policy. Arbitrary foreign renderer strings are intentionally not the default model. */
export type RendererPolicy =
  { mode: 'host' } | { mode: 'normalized_host' } | { mode: 'validated_preset'; presetId: string };

/**
 * Policy fields resolved from profile UI choices and carried to the engine launch path. These configure
 * native behavior around the fingerprint rather than replacing ordinary JS-readable values.
 */
export interface FingerprintLaunchPolicy {
  renderer: RendererPolicy;
  webrtc: WebRtcPolicy;
  hardwareNoise: HardwareNoisePolicy;
  mediaDevices: MediaDeviceProfile;
}

/**
 * A coherent, per-profile fingerprint. Production launches serialize this shape into Lobium's native
 * config channel so profile-visible values are owned by the engine layer. CDP helpers may still consume
 * it in internal harnesses, but they are not the production fingerprint path.
 */
export interface Fingerprint {
  os: OsFamily;
  arch: CpuArch;
  navigator: NavigatorFingerprint;
  screen: ScreenFingerprint;
  webgl: WebGlFingerprint;
  /**
   * Optional so snapshots persisted before WebGPU support still load. When absent the engine leaves
   * `navigator.gpu` reporting the host adapter, which on a persona claiming a different GPU is a
   * contradiction — so derivation always populates it; only old stored fingerprints lack it.
   */
  webgpu?: WebGpuFingerprint;
  locale: LocaleFingerprint;
  /** Font families the profile exposes, matched to the claimed OS. */
  fonts: string[];
}

export interface AndroidDeviceFingerprint {
  brand: string;
  manufacturer: string;
  model: string;
  device: string;
  androidVersion: string;
  apiLevel: number;
  buildId: string;
  buildFingerprint: string;
  formFactor: 'phone' | 'tablet';
  cpuAbi: 'arm64-v8a';
}

/**
 * Android is intentionally modeled separately from launchable desktop fingerprints. It can be derived,
 * validated, and persisted as a future mobile target, but it must not be passed to the desktop runner.
 */
export interface AndroidFingerprint {
  os: PlannedMobileOsFamily;
  arch: 'arm64';
  android: AndroidDeviceFingerprint;
  navigator: NavigatorFingerprint;
  screen: ScreenFingerprint;
  webgl: WebGlFingerprint;
  locale: LocaleFingerprint;
  fonts: string[];
}

export type AnyFingerprint = Fingerprint | AndroidFingerprint;

export interface HostNavigatorProfile {
  platform: string;
  /** Host browser language order captured before any persona is applied (for PersonaMode `real`). */
  languages?: string[];
  /** Host Intl locale captured alongside languages; older v1 snapshots may omit it. */
  locale?: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
}

/**
 * Host-calibration snapshot captured once per install. This is not a page-visible fingerprint by
 * itself; `@lobster/fingerprint` combines it with the profile seed and proxy geo to produce one.
 */
export interface HostCalibrationProfile {
  version: 1;
  capturedAt: string;
  os: OsFamily;
  arch: CpuArch;
  browserVersion?: string;
  navigator: HostNavigatorProfile;
  screen: ScreenFingerprint;
  webgl: WebGlFingerprint;
  fonts: string[];
  timezone?: string;
  warnings?: string[];
}

/** User-editable overrides applied on top of the seed-derived fingerprint. */
export type FingerprintOverrides = Partial<{
  navigator: Partial<NavigatorFingerprint>;
  screen: Partial<ScreenFingerprint>;
  locale: Partial<LocaleFingerprint>;
  webgl: Partial<WebGlFingerprint>;
  renderer: RendererPolicy;
  webrtc: WebRtcPolicy;
  hardwareNoise: Partial<HardwareNoisePolicy>;
  mediaDevices: Partial<MediaDeviceProfile>;
  fonts: string[];
  /** Persona modes for UI-driven locale/fonts/WebRTC resolution at launch. */
  fontsMode: PersonaMode;
  languageMode: PersonaMode;
  timezoneMode: PersonaMode;
  geolocationMode: PersonaMode;
  webrtcMode: PersonaMode;
  /** Android-only device picker (Play CSV). Desktop Lobium launch remains fail-closed. */
  androidDeviceType: AndroidDeviceType;
  androidDeviceModel: string;
  androidDeviceCode: string;
}>;
