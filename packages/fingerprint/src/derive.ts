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

export interface DeriveOptions {
  os: OsFamily;
  /** The engine (lobium | chromium). Both are Chromium-based, so it does not change the fingerprint. */
  engine: EngineKind;
  arch?: CpuArch;
}

/**
 * Derive a coherent Chrome fingerprint from a seed, using Lobster's OWN internal device catalog
 * (pools.ts) — no third-party fingerprint-generation API. Deterministic: the same (seed, os) always
 * produces the same fingerprint (a profile's identity is stable across restarts), while different
 * seeds select distinct-but-coherent device classes.
 *
 * Realism comes from curated device CLASSES, not random field-mixing: a seed picks one whole
 * {@link DeviceProfile} (GPU + screen + cores + memory bundled as a real machine), so no field can
 * drift out of its device's plausible range.
 *
 * Locale/timezone default to en-US and are meant to be overwritten by {@link applyGeoToFingerprint}
 * once the proxy exit IP is known — the network identity is applied as an overlay ON TOP of this base
 * device identity, never mixed into device generation.
 */
export function deriveFingerprint(seed: FingerprintSeed, opts: DeriveOptions): Fingerprint {
  const { os, arch = 'x86_64' } = opts;
  return deriveFromPools(seed, os, arch);
}

function buildUserAgent(osToken: string, version: string): string {
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

function buildBrands(version: string): NavigatorFingerprint['uaBrands'] {
  const major = version.split('.')[0] ?? '152';
  return [
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
    { brand: 'Not_A Brand', version: '24' },
  ];
}

/**
 * Deterministically derive a coherent fingerprint by selecting ONE device class from the OS's catalog
 * and one Chrome version, both seeded. Every catalog entry is itself coherent, so the result always
 * passes validateFingerprintCoherence. Exported so tests can assert that guarantee and the seed→device
 * determinism/diversity directly.
 */
export function deriveFromPools(seed: FingerprintSeed, os: OsFamily, arch: CpuArch): Fingerprint {
  const rng = new SeededRandom(seed);
  const tpl = DEVICE_TEMPLATES[os];

  // Pick a whole machine (GPU + screen + cores + memory stay a coherent set), then a Chrome version.
  const device = rng.pick(tpl.devices);
  const version = rng.pick(CHROME_VERSIONS);

  const primaryLocale = 'en-US';
  const languages = [primaryLocale, 'en'];

  const navigator: NavigatorFingerprint = {
    userAgent: buildUserAgent(tpl.osToken, version),
    platform: tpl.platform,
    languages,
    hardwareConcurrency: device.hardwareConcurrency,
    deviceMemory: device.deviceMemory,
    maxTouchPoints: 0,
    uaBrands: buildBrands(version),
    uaPlatform: tpl.uaPlatform,
    uaPlatformVersion: tpl.uaPlatformVersion,
    uaMobile: false,
    uaFullVersion: version,
  };

  const screenFp: ScreenFingerprint = {
    width: device.screen.width,
    height: device.screen.height,
    availWidth: device.screen.width,
    availHeight: device.screen.height - 40,
    colorDepth: 24,
    devicePixelRatio: device.screen.dpr,
  };

  return {
    os,
    arch,
    navigator,
    screen: screenFp,
    webgl: { ...device.webgl },
    locale: {
      timezone: 'America/New_York',
      locale: primaryLocale,
      acceptLanguage: languagesToAcceptLanguage(languages),
    },
    fonts: [...tpl.fonts],
  };
}
