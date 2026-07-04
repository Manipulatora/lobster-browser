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
import { ENGINE_CHROME, chromeVersionForms, DEVICE_TEMPLATES } from './pools.js';

export interface DeriveOptions {
  os: OsFamily;
  /** The engine (lobium | chromium). Both are Chromium-based, so it does not change the fingerprint. */
  engine: EngineKind;
  arch?: CpuArch;
  /**
   * The full Chrome build the running engine actually is (e.g. "152.0.7928.0"). The UA version MUST
   * match the engine or a feature-probe / fullVersionList read catches it as a lie, so this is pinned
   * to the engine — never a random pool. Defaults to the Lobium build ({@link ENGINE_CHROME}).
   */
  browserVersion?: string;
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
  const { os, arch = 'x86_64', browserVersion } = opts;
  return deriveFromPools(seed, os, arch, browserVersion);
}

function buildUserAgent(osToken: string, reducedVersion: string): string {
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reducedVersion} Safari/537.36`;
}

function buildBrands(major: string): NavigatorFingerprint['uaBrands'] {
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
export function deriveFromPools(
  seed: FingerprintSeed,
  os: OsFamily,
  arch: CpuArch,
  browserVersion?: string,
): Fingerprint {
  const rng = new SeededRandom(seed);
  const tpl = DEVICE_TEMPLATES[os];

  // Pick a whole machine (GPU + screen + cores + memory stay a coherent set). The Chrome version is NOT
  // seed-diverse — it is pinned to the running engine (all profiles share one binary), so the UA never
  // contradicts a feature-probe or the fullVersionList high-entropy read. The UA string carries the
  // reduced form (major.0.0.0); uaFullVersion carries the real build, exactly as Chrome 152 reports.
  const device = rng.pick(tpl.devices);
  const ver = chromeVersionForms(browserVersion ?? ENGINE_CHROME.full);

  const primaryLocale = 'en-US';
  const languages = [primaryLocale, 'en'];

  const navigator: NavigatorFingerprint = {
    userAgent: buildUserAgent(tpl.osToken, ver.reduced),
    platform: tpl.platform,
    languages,
    hardwareConcurrency: device.hardwareConcurrency,
    deviceMemory: device.deviceMemory,
    maxTouchPoints: 0,
    uaBrands: buildBrands(ver.major),
    uaPlatform: tpl.uaPlatform,
    uaPlatformVersion: tpl.uaPlatformVersion,
    uaMobile: false,
    uaFullVersion: ver.full,
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
