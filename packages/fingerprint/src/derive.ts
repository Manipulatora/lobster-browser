import type {
  CpuArch,
  EngineKind,
  Fingerprint,
  FingerprintSeed,
  NavigatorFingerprint,
  OsFamily,
  ScreenFingerprint,
} from '@lobster/shared-types';
import { SeededRandom } from './prng.js';
import { languagesToAcceptLanguage } from './coherence.js';
import { CHROME_VERSIONS, DEVICE_TEMPLATES } from './pools.js';
import { generateFingerprint } from './generate.js';

export interface DeriveOptions {
  os: OsFamily;
  /** The engine (lobium | chromium). Both are Chromium-based, so it does not change the fingerprint. */
  engine: EngineKind;
  arch?: CpuArch;
}

/**
 * Derive a coherent Chrome fingerprint from a seed. Deterministic: the same (seed, options) always
 * produces the same fingerprint, so a profile's identity is stable across restarts.
 *
 * The primary source is Apify's fingerprint-generator, driven by a seed-derived PRNG so its
 * real-device distributions stay reproducible. If generation throws or (rarely — mainly a fraction of
 * Linux seeds) yields no coherent candidate, we fall back to the built-in device pools so the function
 * never fails and always returns a coherent fingerprint.
 *
 * Locale/timezone default to en-US and are meant to be overwritten by {@link applyGeoToFingerprint}
 * once the proxy exit IP is known.
 */
export function deriveFingerprint(seed: FingerprintSeed, opts: DeriveOptions): Fingerprint {
  const { os, arch = 'x86_64' } = opts;

  try {
    const generated = generateFingerprint(seed, os, arch);
    if (generated) {
      return generated;
    }
  } catch {
    // Robustness fallback: a broken generator (e.g. corrupt data files) must never take down
    // profile derivation. Fall through to the deterministic built-in pools below.
  }

  return deriveFromPools(seed, os, arch);
}

function buildUserAgent(osToken: string, version: string): string {
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

function buildBrands(version: string): NavigatorFingerprint['uaBrands'] {
  const major = version.split('.')[0] ?? '131';
  return [
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
    { brand: 'Not_A Brand', version: '24' },
  ];
}

/**
 * Deterministic fallback using the small built-in device pools. Kept as a safety net for the rare
 * case the real-device generator is unavailable or exhausts its candidate pool; every pool entry is
 * itself coherent. Exported so tests can assert that guarantee directly.
 */
export function deriveFromPools(seed: FingerprintSeed, os: OsFamily, arch: CpuArch): Fingerprint {
  const rng = new SeededRandom(seed);
  const tpl = DEVICE_TEMPLATES[os];

  const webgl = rng.pick(tpl.webgl);
  const screen = rng.pick(tpl.screens);
  const hardwareConcurrency = rng.pick(tpl.hardwareConcurrency);
  const deviceMemory = rng.pick(tpl.deviceMemory);
  const version = rng.pick(CHROME_VERSIONS);

  const primaryLocale = 'en-US';
  const languages = [primaryLocale, 'en'];

  const navigator: NavigatorFingerprint = {
    userAgent: buildUserAgent(tpl.osToken, version),
    platform: tpl.platform,
    languages,
    hardwareConcurrency,
    deviceMemory,
    maxTouchPoints: 0,
    uaBrands: buildBrands(version),
    uaPlatform: tpl.uaPlatform,
    uaPlatformVersion: tpl.uaPlatformVersion,
    uaMobile: false,
    uaFullVersion: version,
  };

  const screenFp: ScreenFingerprint = {
    width: screen.width,
    height: screen.height,
    availWidth: screen.width,
    availHeight: screen.height - 40,
    colorDepth: 24,
    devicePixelRatio: screen.dpr,
  };

  return {
    os,
    arch,
    navigator,
    screen: screenFp,
    webgl: { ...webgl },
    locale: {
      timezone: 'America/New_York',
      locale: primaryLocale,
      acceptLanguage: languagesToAcceptLanguage(languages),
    },
    fonts: [...tpl.fonts],
  };
}
