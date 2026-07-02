import { FingerprintGenerator } from 'fingerprint-generator';
import type { Fingerprint as GeneratedFingerprint } from 'fingerprint-generator';
import type {
  CpuArch,
  Fingerprint,
  NavigatorFingerprint,
  OsFamily,
  ScreenFingerprint,
  WebGlFingerprint,
} from '@lobster/shared-types';
import { hashStringToUint32, mulberry32 } from './prng.js';
import {
  DESKTOP_MIN_DEVICE_MEMORY,
  languagesToAcceptLanguage,
  normalizeColorDepth,
  normalizeDeviceMemory,
  validateFingerprintCoherence,
} from './coherence.js';

/**
 * How many fingerprints we draw from the generator's real-device distribution per derive.
 * The Bayesian network occasionally emits an internally-incoherent sample (e.g. a macOS UA
 * with a "Linux x86_64" platform, a HeadlessChrome brand, or an end-of-life OS), so we generate a
 * small seeded pool and deterministically take the first coherent one. A pool of 32 finds a coherent
 * candidate for the vast majority of seeds; the rare exhausted seed falls back to the built-in pools.
 */
const CANDIDATE_POOL_SIZE = 32;

/** Sec-CH-UA-Platform value per OS. Set from the claimed OS so it is always coherent. */
const OS_TO_UA_PLATFORM: Record<OsFamily, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

/**
 * Construct the generator once. It loads a Bayesian network on construction, which is
 * expensive; the instance is stateless across calls (all of its randomness flows through
 * Math.random), so reusing it is both correct and fast.
 */
const generator = new FingerprintGenerator();

/**
 * Run `fn` with Math.random temporarily replaced by a PRNG seeded from `seed`, restoring the
 * original in a `finally`. This is what makes fingerprint-generator — which samples via
 * Math.random internally — deterministic: the same seed drives the same sequence of draws and
 * therefore the same fingerprint, so a profile's identity is stable across restarts.
 */
function withSeededMathRandom<T>(seed: string, fn: () => T): T {
  const original = globalThis.Math.random;
  globalThis.Math.random = mulberry32(hashStringToUint32(seed));
  try {
    return fn();
  } finally {
    globalThis.Math.random = original;
  }
}

/** Map one raw generator fingerprint into our stable `Fingerprint` wire shape (Chrome only). */
function toFingerprint(raw: GeneratedFingerprint, os: OsFamily, arch: CpuArch): Fingerprint {
  const nav = raw.navigator;
  const languages = nav.languages.length > 0 ? [...nav.languages] : ['en-US'];
  const primaryLocale = languages[0] ?? 'en-US';

  // Both engines are Chromium-based, so User-Agent Client Hints are always present. Guard defensively
  // (the library types `userAgentData` as non-null but can emit null for non-Chromium samples).
  const uad = nav.userAgentData;

  const navigator: NavigatorFingerprint = {
    userAgent: nav.userAgent,
    platform: nav.platform,
    languages,
    hardwareConcurrency: nav.hardwareConcurrency,
    // navigator.deviceMemory is spec-quantized and capped at 8; snap the raw figure onto that ladder.
    // The generator emits 0 as a placeholder for a non-trivial slice of desktop samples — treat any
    // non-positive value as "unknown" (→ 8) and floor desktops at 4 GB so we never manufacture a
    // 0.25 GB (256 MB) desktop, which `0 ?? 8` would have let through (0 is not nullish).
    deviceMemory: Math.max(
      DESKTOP_MIN_DEVICE_MEMORY,
      normalizeDeviceMemory(nav.deviceMemory && nav.deviceMemory > 0 ? nav.deviceMemory : 8),
    ),
    // Desktop generation: the launched engine has no touch input, so 0 is both honest and coherent.
    maxTouchPoints: 0,
    uaBrands: uad ? uad.brands.map((b) => ({ brand: b.brand, version: b.version })) : [],
    uaPlatform: OS_TO_UA_PLATFORM[os],
    uaPlatformVersion: uad ? uad.platformVersion : '',
    uaMobile: uad ? uad.mobile : false,
    uaFullVersion: uad ? uad.uaFullVersion : '',
  };

  const screen: ScreenFingerprint = {
    width: raw.screen.width,
    height: raw.screen.height,
    availWidth: raw.screen.availWidth,
    availHeight: raw.screen.availHeight,
    colorDepth: normalizeColorDepth(raw.screen.colorDepth),
    devicePixelRatio: raw.screen.devicePixelRatio,
  };

  // The generator exposes a single vendor/renderer pair; the masked and unmasked WebGL strings are
  // the same real GPU (the engine layer owns any further masking).
  const webgl: WebGlFingerprint = {
    vendor: raw.videoCard.vendor,
    renderer: raw.videoCard.renderer,
    unmaskedVendor: raw.videoCard.vendor,
    unmaskedRenderer: raw.videoCard.renderer,
  };

  return {
    os,
    arch,
    navigator,
    screen,
    webgl,
    // Locale/timezone default to en-US / America/New_York and are meant to be overwritten by
    // applyGeoToFingerprint once the proxy exit IP is known. locale mirrors languages[0] and
    // Accept-Language leads with it so the raw derive output is already self-coherent.
    locale: {
      timezone: 'America/New_York',
      locale: primaryLocale,
      acceptLanguage: languagesToAcceptLanguage(languages),
    },
    fonts: [...raw.fonts],
  };
}

/**
 * Smallest desktop screen we accept. The generator's distribution includes tiny/placeholder
 * viewports (e.g. 800x600 and even 384px wide) that are implausible for a real desktop and a
 * quick tell; we skip those candidates in favour of a realistic one from the pool.
 */
const MIN_DESKTOP_SCREEN_WIDTH = 1024;
const MIN_DESKTOP_SCREEN_HEIGHT = 600;

/**
 * A candidate is usable only if it is fully coherent, describes a realistic desktop screen, exposes
 * fonts, and advertises the Chromium Sec-CH-UA brand contract (non-empty brands + full version).
 * `validateFingerprintCoherence` is engine-agnostic, so the brand contract is enforced here.
 */
function isSelectable(fp: Fingerprint): boolean {
  if (validateFingerprintCoherence(fp).length !== 0) {
    return false;
  }
  if (fp.screen.width < MIN_DESKTOP_SCREEN_WIDTH || fp.screen.height < MIN_DESKTOP_SCREEN_HEIGHT) {
    return false;
  }
  if (fp.fonts.length === 0) {
    return false;
  }
  return fp.navigator.uaBrands.length > 0 && fp.navigator.uaFullVersion.length > 0;
}

/**
 * Deterministically derive a real-device (Chrome) fingerprint from `seed` using the Apify
 * generator. Returns the first coherent+selectable candidate from a seeded pool, or `null` if the
 * whole pool is unusable (astronomically unlikely) so the caller can fall back to the built-in pools.
 *
 * OsFamily values ('windows' | 'macos' | 'linux') are exactly the generator's operatingSystems
 * tokens, so `os` is passed through directly; devices are 'desktop' for now.
 */
export function generateFingerprint(seed: string, os: OsFamily, arch: CpuArch): Fingerprint | null {
  return withSeededMathRandom(seed, () => {
    for (let i = 0; i < CANDIDATE_POOL_SIZE; i++) {
      const raw = generator.getFingerprint({
        operatingSystems: [os],
        browsers: ['chrome'],
        devices: ['desktop'],
        locales: ['en-US'],
      }).fingerprint;
      const fp = toFingerprint(raw, os, arch);
      if (isSelectable(fp)) {
        return fp;
      }
    }
    return null;
  });
}
