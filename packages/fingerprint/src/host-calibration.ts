import type {
  EngineKind,
  Fingerprint,
  FingerprintSeed,
  HostCalibrationProfile,
  LocaleFingerprint,
  OsFamily,
  ScreenFingerprint,
  WebGlFingerprint,
} from '@lobster/shared-types';
import {
  languagesToAcceptLanguage,
  normalizeColorDepth,
  normalizeDeviceMemory,
  validateFingerprintCoherence,
} from './coherence.js';
import { deriveFromPools } from './derive.js';
import { normalizeDevicePixelRatio } from './displays.js';
import { coherentGpuIdentity } from './webgpu-identity.js';

export interface DeriveFromHostOptions {
  engine: EngineKind;
  /** The exact running Chrome/Lobium build. Defaults to the captured host browserVersion, then catalog. */
  browserVersion?: string;
  /** Optional locale/proxy overlay; callers normally use applyGeoToFingerprint after derivation. */
  locale?: Partial<LocaleFingerprint>;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeHostScreen(
  os: OsFamily,
  host: ScreenFingerprint,
  fallback: ScreenFingerprint,
): ScreenFingerprint {
  const width = clampInt(host.width, 320, 16384);
  const height = clampInt(host.height, 240, 16384);
  const availWidth = Math.min(width, clampInt(host.availWidth, 1, width));
  const availHeight = Math.min(height, clampInt(host.availHeight, 1, height));
  const screen: ScreenFingerprint = {
    width,
    height,
    availWidth,
    availHeight,
    colorDepth: normalizeColorDepth(host.colorDepth),
    // The capture reads window.devicePixelRatio, which folds in the probing tab's page zoom, so an
    // unnoticed 110% zoom would otherwise persist a ratio no display setting can produce.
    devicePixelRatio: normalizeDevicePixelRatio(
      os,
      Number.isFinite(host.devicePixelRatio) && host.devicePixelRatio > 0
        ? host.devicePixelRatio
        : fallback.devicePixelRatio,
    ),
  };

  screen.availLeft =
    host.availLeft === undefined
      ? (fallback.availLeft ?? 0)
      : clampInt(host.availLeft, 0, Math.max(0, width - availWidth));
  screen.availTop =
    host.availTop === undefined
      ? (fallback.availTop ?? (os === 'macos' ? 25 : 0))
      : clampInt(host.availTop, 0, Math.max(0, height - availHeight));

  return screen;
}

function normalizedFonts(hostFonts: readonly string[], fallback: readonly string[]): string[] {
  const unique = [...new Set(hostFonts.map((font) => font.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  return unique.length > 0 ? unique : [...fallback];
}

function cloneHostWebgl(host: WebGlFingerprint): WebGlFingerprint {
  const webgl: WebGlFingerprint = { ...host };
  if (host.extensions) webgl.extensions = [...host.extensions];
  if (host.shaderPrecision) {
    webgl.shaderPrecision = {
      vertex: Object.fromEntries(
        Object.entries(host.shaderPrecision.vertex).map(([key, value]) => [key, { ...value }]),
      ) as typeof host.shaderPrecision.vertex,
      fragment: Object.fromEntries(
        Object.entries(host.shaderPrecision.fragment).map(([key, value]) => [key, { ...value }]),
      ) as typeof host.shaderPrecision.fragment,
    };
  }
  return webgl;
}

/**
 * Canonicalize only unstable formatting in a captured host identity. The GPU model, backend,
 * extensions, limits, shader precision and pixel path remain host-derived.
 */
export function normalizeHostWebglIdentity(host: WebGlFingerprint): WebGlFingerprint {
  const normalize = (value: string): string =>
    value.replaceAll('\0', '').replace(/\s+/g, ' ').trim();
  return {
    ...cloneHostWebgl(host),
    vendor: normalize(host.vendor),
    renderer: normalize(host.renderer),
    unmaskedVendor: normalize(host.unmaskedVendor),
    unmaskedRenderer: normalize(host.unmaskedRenderer),
    ...(host.version ? { version: normalize(host.version) } : {}),
    ...(host.shadingLanguageVersion
      ? { shadingLanguageVersion: normalize(host.shadingLanguageVersion) }
      : {}),
  };
}

/**
 * Primary host-calibrated derivation path: start with the catalog only for Chrome/OS-safe scaffolding
 * (UA, UA-CH brands, locale default), then replace the hardware/deep surfaces with the captured host.
 * This keeps profiles coherent with the user's real machine while still making farbling/profile seeds
 * unique at the native engine layer.
 */
export function deriveFingerprintFromHost(
  seed: FingerprintSeed,
  host: HostCalibrationProfile,
  opts: DeriveFromHostOptions,
): Fingerprint {
  void opts.engine;
  const base = deriveFromPools(
    seed,
    host.os,
    host.arch,
    opts.browserVersion ?? host.browserVersion,
  );
  const locale = opts.locale ? { ...base.locale, ...opts.locale } : base.locale;
  const hostLanguages = host.navigator.languages
    ?.map((language) => language.trim())
    .filter(Boolean);
  const languages =
    hostLanguages && hostLanguages.length > 0 ? hostLanguages : base.navigator.languages;
  const hostLocale = host.navigator.locale?.trim() || languages[0] || base.locale.locale;
  const calibratedLocale: LocaleFingerprint = {
    ...locale,
    timezone: opts.locale?.timezone ?? host.timezone ?? locale.timezone,
    locale: opts.locale?.locale ?? hostLocale,
    acceptLanguage:
      opts.locale?.acceptLanguage ??
      (hostLanguages && hostLanguages.length > 0
        ? languagesToAcceptLanguage(languages)
        : locale.acceptLanguage),
  };
  const webgl = cloneHostWebgl(host.webgl);

  return {
    ...base,
    os: host.os,
    arch: host.arch,
    navigator: {
      ...base.navigator,
      platform: host.navigator.platform,
      languages: [...languages],
      hardwareConcurrency: clampInt(host.navigator.hardwareConcurrency, 1, 128),
      deviceMemory: normalizeDeviceMemory(host.navigator.deviceMemory),
      // Never inherit the host's touch-point count into a DESKTOP persona.
      //
      // Two reasons, one fatal. (1) The coherence gate requires maxTouchPoints === 0 whenever
      // uaMobile is false, so on any touch-capable Windows host — a Surface, most 2-in-1s, plenty
      // of ordinary laptops, all of which report 10 — the derived profile fails validation and
      // startProfile refuses to launch. The product simply does not run on those machines.
      // (2) Even with the gate relaxed it would be a lie: a desktop UA advertising touch points
      // while matchMedia reports `(pointer: fine)` and `(hover: hover)` is incoherent, and the
      // identical non-zero count on every profile is a cross-profile linkage signal.
      //
      // A mobile persona is not derived through this path (it goes through deriveAndroidFingerprint),
      // so clamping to 0 for non-mobile is the whole story here. The native
      // NavigatorEvents::maxTouchPoints hook stores an optional precisely so a configured 0
      // overrides the host rather than reading as "unset".
      maxTouchPoints: base.navigator.uaMobile
        ? Math.max(0, Math.round(host.navigator.maxTouchPoints))
        : 0,
    },
    screen: normalizeHostScreen(host.os, host.screen, base.screen),
    ...coherentGpuIdentity(webgl),
    locale: calibratedLocale,
    fonts: normalizedFonts(host.fonts, base.fonts),
  };
}

/**
 * Validate a host snapshot before it becomes the primary derivation source. This intentionally rejects
 * software renderers; CI/headless can still use `deriveFingerprint` from the fallback catalog.
 */
export interface HostCalibrationValidationOptions {
  /**
   * Development-only escape hatch for explicitly provisional software-GPU runs. Release evidence must
   * never enable this; it exists so no-GPU build hosts can exercise the exact product path honestly.
   */
  allowSoftwareRenderer?: boolean;
}

export function validateHostCalibrationProfile(
  host: HostCalibrationProfile,
  options: HostCalibrationValidationOptions = {},
): string[] {
  const issues: string[] = [];
  if (host.version !== 1) issues.push(`unsupported host calibration version: ${host.version}`);
  if (!host.capturedAt) issues.push('capturedAt is required');
  if (!host.browserVersion?.trim()) issues.push('host browserVersion is required');
  // Fonts are isolated by the packaged per-OS fontconfig set. Host enumeration may be unavailable
  // without an interactive local-font permission; an empty capture safely falls back to the OS pool.
  if (!host.navigator.languages || host.navigator.languages.length === 0)
    issues.push('host navigator.languages is required');
  if (!host.navigator.locale?.trim()) issues.push('host navigator.locale is required');
  if (!host.timezone?.trim()) issues.push('host timezone is required');
  if (
    host.navigator.languages?.length &&
    host.navigator.locale &&
    host.navigator.languages[0] !== host.navigator.locale
  ) {
    issues.push('host navigator.languages[0] does not match host locale');
  }
  if (!host.webgl.extensions || host.webgl.extensions.length === 0) {
    issues.push('host WebGL extension list is empty');
  }
  if (!host.webgl.version?.trim()) issues.push('host WebGL version is required');
  if (!host.webgl.shadingLanguageVersion?.trim()) {
    issues.push('host WebGL shading-language version is required');
  }
  if (!host.webgl.caps) {
    issues.push('host WebGL numeric capabilities are required');
  } else if (
    [
      host.webgl.caps.maxTextureSize,
      host.webgl.caps.maxCubeMapTextureSize,
      host.webgl.caps.maxRenderbufferSize,
      ...host.webgl.caps.maxViewportDims,
      host.webgl.caps.maxVertexAttribs,
      host.webgl.caps.maxVertexUniformVectors,
      host.webgl.caps.maxFragmentUniformVectors,
      host.webgl.caps.maxVaryingVectors,
      host.webgl.caps.maxTextureImageUnits,
      host.webgl.caps.maxVertexTextureImageUnits,
      host.webgl.caps.maxCombinedTextureImageUnits,
    ].some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    issues.push('host WebGL numeric capabilities are incomplete');
  }
  if (!host.webgl.shaderPrecision) {
    issues.push('host WebGL shader-precision profile is required');
  }
  const webglText = `${host.webgl.vendor} ${host.webgl.renderer}`;
  if (
    !options.allowSoftwareRenderer &&
    /SwiftShader|llvmpipe|Software|Microsoft Basic Render/i.test(webglText)
  ) {
    issues.push(`host WebGL uses a software renderer: ${webglText}`);
  }

  const derived = deriveFingerprintFromHost('host-validation', host, { engine: 'lobium' });
  for (const issue of validateFingerprintCoherence(derived)) {
    if (options.allowSoftwareRenderer && /software renderer|SwiftShader|llvmpipe/i.test(issue)) {
      continue;
    }
    issues.push(`derived fingerprint: ${issue}`);
  }
  return issues;
}
