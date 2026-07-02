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
import { languagesToAcceptLanguage, validateFingerprintCoherence } from './coherence.js';

/** The browsers the Apify generator understands that we map our engines onto. */
export type BrowserName = 'chrome' | 'firefox';

/**
 * How many fingerprints we draw from the generator's real-device distribution per derive.
 * The Bayesian network occasionally emits an internally-incoherent sample (e.g. a macOS UA
 * with a "Linux x86_64" platform), so we generate a small seeded pool and deterministically
 * take the first coherent one. Empirically a pool of 24 already yields a coherent candidate
 * for 100% of seeds across every OS/engine; 32 leaves comfortable margin. Draws are cheap
 * (~1ms each) and the loop almost always exits on the first or second candidate.
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

/** Extract the Firefox version (e.g. "133.0") from its User-Agent; "" if absent. */
function firefoxVersionFromUserAgent(userAgent: string): string {
  return /Firefox\/([\d.]+)/.exec(userAgent)?.[1] ?? '';
}

/** Map one raw generator fingerprint into our stable `Fingerprint` wire shape. */
function toFingerprint(
  raw: GeneratedFingerprint,
  os: OsFamily,
  browser: BrowserName,
  arch: CpuArch,
): Fingerprint {
  const nav = raw.navigator;
  const languages = nav.languages.length > 0 ? [...nav.languages] : ['en-US'];
  const primaryLocale = languages[0] ?? 'en-US';

  // Firefox emits `userAgentData: null` at runtime (Client Hints are Chromium-only), despite
  // the library typing it as always-present — hence the runtime `uad` guard below.
  const uad = nav.userAgentData;
  const isChrome = browser === 'chrome';

  const uaBrands: NavigatorFingerprint['uaBrands'] =
    isChrome && uad ? uad.brands.map((b) => ({ brand: b.brand, version: b.version })) : [];
  const uaFullVersion =
    isChrome && uad ? uad.uaFullVersion : firefoxVersionFromUserAgent(nav.userAgent);
  const uaPlatformVersion = isChrome && uad ? uad.platformVersion : '';
  const uaMobile = isChrome && uad ? uad.mobile : false;

  const navigator: NavigatorFingerprint = {
    userAgent: nav.userAgent,
    platform: nav.platform,
    languages,
    hardwareConcurrency: nav.hardwareConcurrency,
    // Firefox does not expose navigator.deviceMemory; default to a common value.
    deviceMemory: nav.deviceMemory ?? 8,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    uaBrands,
    uaPlatform: OS_TO_UA_PLATFORM[os],
    uaPlatformVersion,
    uaMobile,
    uaFullVersion,
  };

  const screen: ScreenFingerprint = {
    width: raw.screen.width,
    height: raw.screen.height,
    availWidth: raw.screen.availWidth,
    availHeight: raw.screen.availHeight,
    colorDepth: raw.screen.colorDepth,
    devicePixelRatio: raw.screen.devicePixelRatio,
  };

  // The generator exposes a single vendor/renderer pair; the masked and unmasked WebGL
  // strings are the same real GPU (the engine layer owns any further masking).
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
 * A candidate is usable only if it is fully coherent, describes a realistic desktop screen, AND
 * matches the engine's brand contract: Chromium engines (kernel/chromium) must advertise
 * Sec-CH-UA brands and a full version, while Firefox (camoufox) must advertise none.
 * `validateFingerprintCoherence` is engine-agnostic, so the brand contract is enforced here.
 */
function isSelectable(fp: Fingerprint, browser: BrowserName): boolean {
  if (validateFingerprintCoherence(fp).length !== 0) {
    return false;
  }
  if (fp.screen.width < MIN_DESKTOP_SCREEN_WIDTH || fp.screen.height < MIN_DESKTOP_SCREEN_HEIGHT) {
    return false;
  }
  // A real device always exposes fonts; the generator occasionally emits an empty list.
  if (fp.fonts.length === 0) {
    return false;
  }
  if (browser === 'chrome') {
    return fp.navigator.uaBrands.length > 0 && fp.navigator.uaFullVersion.length > 0;
  }
  return fp.navigator.uaBrands.length === 0;
}

/**
 * Deterministically derive a real-device fingerprint from `seed` using the Apify generator.
 * Returns the first coherent+selectable candidate from a seeded pool, or `null` if the whole
 * pool is unusable (astronomically unlikely) so the caller can fall back to the built-in pools.
 *
 * OsFamily values ('windows' | 'macos' | 'linux') are exactly the generator's operatingSystems
 * tokens, so `os` is passed through directly; devices are 'desktop' for now.
 */
export function generateFingerprint(
  seed: string,
  os: OsFamily,
  browser: BrowserName,
  arch: CpuArch,
): Fingerprint | null {
  return withSeededMathRandom(seed, () => {
    for (let i = 0; i < CANDIDATE_POOL_SIZE; i++) {
      const raw = generator.getFingerprint({
        operatingSystems: [os],
        browsers: [browser],
        devices: ['desktop'],
        locales: ['en-US'],
      }).fingerprint;
      const fp = toFingerprint(raw, os, browser, arch);
      if (isSelectable(fp, browser)) {
        return fp;
      }
    }
    return null;
  });
}
