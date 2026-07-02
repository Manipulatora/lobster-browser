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
import { CHROME_VERSIONS, DEVICE_TEMPLATES, FIREFOX_VERSIONS } from './pools.js';
import { type BrowserName, generateFingerprint } from './generate.js';

export interface DeriveOptions {
  os: OsFamily;
  engine: EngineKind;
  arch?: CpuArch;
}

/** Map an engine to the browser the fingerprint should impersonate. */
function browserForEngine(engine: EngineKind): BrowserName {
  // kernel and chromium are both Chromium-based; camoufox is Firefox-based.
  return engine === 'camoufox' ? 'firefox' : 'chrome';
}

/**
 * Derive a coherent fingerprint from a seed. Deterministic: the same (seed, options) always
 * produces the same fingerprint, so a profile's identity is stable across restarts.
 *
 * The primary source is Apify's fingerprint-generator, driven by a seed-derived PRNG so its
 * real-device distributions stay reproducible. If generation throws or (astronomically
 * unlikely) yields no coherent candidate, we fall back to the built-in device pools so the
 * function never fails and always returns a coherent fingerprint.
 *
 * Locale/timezone default to en-US and are meant to be overwritten by
 * {@link applyGeoToFingerprint} once the proxy exit IP is known.
 */
export function deriveFingerprint(seed: FingerprintSeed, opts: DeriveOptions): Fingerprint {
  const { os, engine, arch = 'x86_64' } = opts;
  const browser = browserForEngine(engine);

  try {
    const generated = generateFingerprint(seed, os, browser, arch);
    if (generated) {
      return generated;
    }
  } catch {
    // Deliberate robustness fallback: a broken generator (e.g. corrupt data files) must never
    // take down profile derivation. Fall through to the deterministic built-in pools below.
    // Day N: surface this via telemetry once the package has a logger.
  }

  return deriveFromPools(seed, os, browser, arch);
}

function buildUserAgent(osToken: string, browser: BrowserName, version: string): string {
  if (browser === 'firefox') {
    // Firefox UA. Gecko token is fixed by convention.
    const rv = version.split('.')[0];
    const ffToken = osToken.replace('; Win64; x64', '; Win64; x64; rv:' + rv + '.0');
    return `Mozilla/5.0 (${ffToken}) Gecko/20100101 Firefox/${version}`;
  }
  // Chromium UA.
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
 * Deterministic fallback using the small built-in device pools. Kept as a safety net for the
 * rare case the real-device generator is unavailable; every pool entry is itself coherent.
 */
function deriveFromPools(
  seed: FingerprintSeed,
  os: OsFamily,
  browser: BrowserName,
  arch: CpuArch,
): Fingerprint {
  const rng = new SeededRandom(seed);
  const tpl = DEVICE_TEMPLATES[os];

  const webgl = rng.pick(tpl.webgl);
  const screen = rng.pick(tpl.screens);
  const hardwareConcurrency = rng.pick(tpl.hardwareConcurrency);
  const deviceMemory = rng.pick(tpl.deviceMemory);
  const version = rng.pick(browser === 'firefox' ? FIREFOX_VERSIONS : CHROME_VERSIONS);

  const primaryLocale = 'en-US';
  const languages = [primaryLocale, 'en'];

  const navigator: NavigatorFingerprint = {
    userAgent: buildUserAgent(tpl.osToken, browser, version),
    platform: tpl.platform,
    languages,
    hardwareConcurrency,
    deviceMemory,
    maxTouchPoints: 0,
    // Chromium-family engines (kernel + chromium) send Sec-CH-UA brands; Firefox-based Camoufox does not.
    uaBrands: browser === 'firefox' ? [] : buildBrands(version),
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
