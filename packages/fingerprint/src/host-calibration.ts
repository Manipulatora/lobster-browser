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
  normalizeColorDepth,
  normalizeDeviceMemory,
  validateFingerprintCoherence,
} from './coherence.js';
import { deriveFromPools } from './derive.js';

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

function positiveNumber(n: number, fallback: number): number {
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
    devicePixelRatio: positiveNumber(host.devicePixelRatio, fallback.devicePixelRatio),
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
      vertex: { ...host.shaderPrecision.vertex },
      fragment: { ...host.shaderPrecision.fragment },
    };
  }
  return webgl;
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

  return {
    ...base,
    os: host.os,
    arch: host.arch,
    navigator: {
      ...base.navigator,
      platform: host.navigator.platform,
      hardwareConcurrency: clampInt(host.navigator.hardwareConcurrency, 1, 128),
      deviceMemory: normalizeDeviceMemory(host.navigator.deviceMemory),
      maxTouchPoints: Math.max(0, Math.round(host.navigator.maxTouchPoints)),
    },
    screen: normalizeHostScreen(host.os, host.screen, base.screen),
    webgl: cloneHostWebgl(host.webgl),
    locale,
    fonts: normalizedFonts(host.fonts, base.fonts),
  };
}

/**
 * Validate a host snapshot before it becomes the primary derivation source. This intentionally rejects
 * software renderers; CI/headless can still use `deriveFingerprint` from the fallback catalog.
 */
export function validateHostCalibrationProfile(host: HostCalibrationProfile): string[] {
  const issues: string[] = [];
  if (host.version !== 1) issues.push(`unsupported host calibration version: ${host.version}`);
  if (!host.capturedAt) issues.push('capturedAt is required');
  if (host.fonts.length === 0) issues.push('host font list is empty');
  if (!host.webgl.extensions || host.webgl.extensions.length === 0) {
    issues.push('host WebGL extension list is empty');
  }
  const webglText = `${host.webgl.vendor} ${host.webgl.renderer}`;
  if (/SwiftShader|llvmpipe|Software|Microsoft Basic Render/i.test(webglText)) {
    issues.push(`host WebGL uses a software renderer: ${webglText}`);
  }

  const derived = deriveFingerprintFromHost('host-validation', host, { engine: 'lobium' });
  for (const issue of validateFingerprintCoherence(derived)) {
    issues.push(`derived fingerprint: ${issue}`);
  }
  return issues;
}
