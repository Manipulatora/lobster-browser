import type { Fingerprint, GeoInfo, LocaleFingerprint, OsFamily } from '@lobster/shared-types';

/** Minimal country → primary locale map. Day 1 expands this from a full locale dataset. */
const COUNTRY_LOCALE: Record<string, string> = {
  US: 'en-US',
  GB: 'en-GB',
  CA: 'en-CA',
  AU: 'en-AU',
  DE: 'de-DE',
  FR: 'fr-FR',
  ES: 'es-ES',
  IT: 'it-IT',
  NL: 'nl-NL',
  BR: 'pt-BR',
  PT: 'pt-PT',
  RU: 'ru-RU',
  JP: 'ja-JP',
  KR: 'ko-KR',
  CN: 'zh-CN',
  IN: 'en-IN',
  MX: 'es-MX',
};

function localeToLanguages(locale: string): string[] {
  const base = locale.split('-')[0] ?? 'en';
  return locale === base ? [locale] : [locale, base];
}

/**
 * Build a plausible Accept-Language value from an ordered languages list. The head language
 * has implicit q=1; each following one gets a descending q so the value leads with the
 * primary locale — the ordering real browsers emit. Shared with {@link deriveFingerprint}
 * so the raw derive output is self-coherent before geo is applied.
 */
export function languagesToAcceptLanguage(languages: readonly string[]): string {
  return languages
    .map((lang, i) => (i === 0 ? lang : `${lang};q=${(1 - i * 0.1).toFixed(1)}`))
    .join(',');
}

/**
 * Rewrite the geo/locale cluster of a fingerprint to match the proxy exit IP. This is the
 * single most important coherence rule: timezone, locale, navigator.languages and
 * Accept-Language must all agree with where the proxy says the user is.
 */
export function applyGeoToFingerprint(fp: Fingerprint, geo: GeoInfo): Fingerprint {
  const locale = COUNTRY_LOCALE[geo.countryCode.toUpperCase()] ?? fp.locale.locale;
  const languages = localeToLanguages(locale);

  const localeFp: LocaleFingerprint = {
    timezone: geo.timezone,
    locale,
    acceptLanguage: languagesToAcceptLanguage(languages),
    ...(geo.latitude !== undefined && geo.longitude !== undefined
      ? { geolocation: { latitude: geo.latitude, longitude: geo.longitude, accuracy: 100 } }
      : {}),
  };

  return {
    ...fp,
    navigator: { ...fp.navigator, languages },
    locale: localeFp,
  };
}

const OS_UA_TOKEN: Record<OsFamily, string> = {
  windows: 'Windows',
  macos: 'Mac',
  linux: 'Linux',
};

/** Sec-CH-UA-Platform value coherent with each claimed OS. */
const OS_UA_PLATFORM: Record<OsFamily, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

/**
 * The only values `navigator.deviceMemory` is allowed to report. The HTML spec quantizes it and
 * **caps it at 8** (a machine with 32 GB still reports 8), so anything above 8 — or off this ladder —
 * is an instant tell. {@link normalizeDeviceMemory} snaps generator data onto this ladder.
 */
export const DEVICE_MEMORY_VALUES: readonly number[] = [0.25, 0.5, 1, 2, 4, 8];

/** A real desktop reports ≥ 4 GB via `navigator.deviceMemory`; 0.25/0.5/1/2 on a desktop UA is a tell. */
export const DESKTOP_MIN_DEVICE_MEMORY = 4;

/** Highest plausible logical-core count per OS. macOS tops out at the 28-core/56-thread Mac Pro. */
const MAX_HW_CONCURRENCY: Record<OsFamily, number> = { windows: 128, linux: 128, macos: 56 };

/** The only real brand names a genuine Chrome build advertises in Sec-CH-UA (plus the GREASE entry). */
const CHROME_UA_BRANDS = new Set(['Google Chrome', 'Chromium']);

/** A greased "Not A;Brand" placeholder — Chromium varies its punctuation/spacing every release. */
function isGreaseBrand(brand: string): boolean {
  return /not.{0,4}a.{0,4}brand/i.test(brand);
}

/** Snap an arbitrary RAM figure (GB) to the nearest spec-legal `navigator.deviceMemory` value (≤ 8). */
export function normalizeDeviceMemory(gb: number): number {
  let best = DEVICE_MEMORY_VALUES[0] as number;
  for (const v of DEVICE_MEMORY_VALUES) {
    if (v <= gb) best = v;
  }
  return best;
}

/** Real Chrome reports a 24-bit color depth on effectively every desktop (30 on a few wide-gamut). */
export function normalizeColorDepth(depth: number): number {
  return depth === 30 ? 30 : 24;
}

/** Extract the Chrome major version from a UA string, or null if it isn't a Chrome UA. */
function chromeMajorFromUserAgent(ua: string): string | null {
  const m = /Chrome\/(\d+)\./.exec(ua);
  return m ? (m[1] ?? null) : null;
}

/**
 * navigator.platform values that are coherent with each claimed OS. Windows always reports
 * "Win32" (even on 64-bit), Intel + Apple-Silicon Macs both report "MacIntel", and Linux
 * reports a "Linux <arch>" string (x86_64 / aarch64 / armv8l). A fingerprint that mismatches
 * these is a hard tell — the fingerprint-generator's Bayesian network can occasionally emit
 * one, so we reject those candidates during derivation.
 */
const OS_PLATFORM_MATCHERS: Record<OsFamily, (platform: string) => boolean> = {
  windows: (platform) => platform === 'Win32',
  macos: (platform) => platform === 'MacIntel',
  linux: (platform) => platform.startsWith('Linux'),
};

/**
 * Return a list of coherence problems (empty = coherent). Used by the fingerprint editor
 * and the CI validation gate to catch a profile that describes an implausible machine.
 */
export function validateFingerprintCoherence(fp: Fingerprint): string[] {
  const issues: string[] = [];
  const ua = fp.navigator.userAgent;

  if (!ua.includes(OS_UA_TOKEN[fp.os])) {
    issues.push(`User-Agent OS token does not match claimed OS "${fp.os}": ${ua}`);
  }
  if (fp.navigator.languages[0] !== fp.locale.locale) {
    issues.push(
      `navigator.languages[0] (${fp.navigator.languages[0]}) does not match locale (${fp.locale.locale})`,
    );
  }
  if (!fp.locale.acceptLanguage.startsWith(fp.locale.locale)) {
    issues.push(
      `Accept-Language (${fp.locale.acceptLanguage}) does not lead with locale (${fp.locale.locale})`,
    );
  }
  if (!OS_PLATFORM_MATCHERS[fp.os](fp.navigator.platform)) {
    issues.push(
      `navigator.platform "${fp.navigator.platform}" is not coherent with claimed OS "${fp.os}"`,
    );
  }
  if (fp.screen.availHeight > fp.screen.height || fp.screen.availWidth > fp.screen.width) {
    issues.push('screen avail dimensions exceed physical dimensions');
  }
  // WebGL vendor/renderer must describe a real GPU and agree with the OS. Direct3D is a
  // Windows-only graphics backend, so a Direct3D renderer on macOS/Linux is an obvious tell.
  if (fp.webgl.vendor.length === 0 || fp.webgl.renderer.length === 0) {
    issues.push('WebGL vendor/renderer must not be empty');
  }
  if (fp.os !== 'windows' && /Direct3D/i.test(fp.webgl.renderer)) {
    issues.push(
      `WebGL renderer uses the Windows-only Direct3D backend on OS "${fp.os}": ${fp.webgl.renderer}`,
    );
  }

  // --- User-Agent Client Hints must agree with the User-Agent string ------------------------------
  const nav = fp.navigator;
  const chromeMajor = chromeMajorFromUserAgent(ua);
  if (chromeMajor) {
    // The Sec-CH-UA "Google Chrome"/"Chromium" brand major must equal the UA Chrome major.
    const chromeBrand = nav.uaBrands.find(
      (b) => b.brand === 'Google Chrome' || b.brand === 'Chromium',
    );
    if (chromeBrand && chromeBrand.version !== chromeMajor) {
      issues.push(
        `Sec-CH-UA brand version (${chromeBrand.version}) does not match the UA Chrome major (${chromeMajor})`,
      );
    }
    // Every advertised brand must be a real Chrome brand or the GREASE placeholder. A foreign or
    // automation brand — most importantly "HeadlessChrome" — is a definitive bot tell, and the
    // generator's real-device data occasionally ships one behind an otherwise-clean Chrome UA.
    const foreign = nav.uaBrands.find(
      (b) => !CHROME_UA_BRANDS.has(b.brand) && !isGreaseBrand(b.brand),
    );
    if (foreign) {
      issues.push(
        `Sec-CH-UA advertises a non-Chrome brand "${foreign.brand}" (automation/foreign tell)`,
      );
    }
    // A Chrome UA must advertise a real Chrome/Chromium brand — not just a GREASE placeholder or an
    // empty brand list. (We deliberately do NOT require the "Google Chrome" brand specifically: many
    // real Linux Chromium samples ship only "Chromium", and requiring it would starve the candidate
    // pool and cluster Linux profiles onto the fallback — a worse tell than the omission.)
    if (!nav.uaBrands.some((b) => CHROME_UA_BRANDS.has(b.brand))) {
      issues.push('Sec-CH-UA has no "Google Chrome"/"Chromium" brand for a Chrome UA');
    }
    // uaFullVersion (e.g. "131.0.6778.86") must be present and share the UA major.
    const fullMajor = nav.uaFullVersion.split('.')[0] ?? '';
    if (!nav.uaFullVersion) {
      issues.push('uaFullVersion is empty for a Chrome UA');
    } else if (fullMajor !== chromeMajor) {
      issues.push(
        `uaFullVersion (${nav.uaFullVersion}) major does not match the UA Chrome major (${chromeMajor})`,
      );
    }
  }
  // Sec-CH-UA-Platform must match the claimed OS.
  if (nav.uaPlatform !== OS_UA_PLATFORM[fp.os]) {
    issues.push(`Sec-CH-UA-Platform "${nav.uaPlatform}" does not match claimed OS "${fp.os}"`);
  }
  // Chrome 110+ dropped Windows 7/8/8.1 (NT 6.x). A modern Chrome on "Windows NT 6.1" is impossible —
  // the generator's real-device data occasionally pairs an old OS with a new browser, a hard tell.
  if (fp.os === 'windows' && chromeMajor) {
    const nt = /Windows NT (\d+)\.\d+/.exec(ua);
    if (nt && Number(nt[1]) < 10 && Number(chromeMajor) >= 110) {
      issues.push(
        `Windows NT ${nt[1]}.x cannot run Chrome ${chromeMajor} (Chrome 110+ requires Windows 10+)`,
      );
    }
  }

  // --- Form factor ---------------------------------------------------------------------------------
  // A desktop profile must not advertise itself as mobile, and touch points must match the form factor.
  if (nav.uaMobile) {
    issues.push(`uaMobile is true for desktop OS "${fp.os}"`);
  }
  if (!nav.uaMobile && nav.maxTouchPoints !== 0) {
    issues.push(`maxTouchPoints (${nav.maxTouchPoints}) must be 0 for a non-mobile profile`);
  }

  // --- Hardware realism ----------------------------------------------------------------------------
  // navigator.deviceMemory is a spec-quantized value capped at 8 — 16/32 is an instant tell, and a
  // desktop reporting < 4 GB (e.g. the 0.25 GB a raw generator 0 would snap to) is equally implausible.
  if (!DEVICE_MEMORY_VALUES.includes(nav.deviceMemory)) {
    issues.push(
      `navigator.deviceMemory (${nav.deviceMemory}) is not a spec value (one of ${DEVICE_MEMORY_VALUES.join('/')})`,
    );
  } else if (!nav.uaMobile && nav.deviceMemory < DESKTOP_MIN_DEVICE_MEMORY) {
    issues.push(
      `navigator.deviceMemory (${nav.deviceMemory}) is implausibly low for a desktop (min ${DESKTOP_MIN_DEVICE_MEMORY})`,
    );
  }
  const maxHw = MAX_HW_CONCURRENCY[fp.os];
  if (
    !Number.isInteger(nav.hardwareConcurrency) ||
    nav.hardwareConcurrency < 1 ||
    nav.hardwareConcurrency > maxHw
  ) {
    issues.push(
      `hardwareConcurrency (${nav.hardwareConcurrency}) is outside the plausible 1–${maxHw} range for "${fp.os}"`,
    );
  }

  // --- Display realism -----------------------------------------------------------------------------
  if (fp.screen.colorDepth !== 24 && fp.screen.colorDepth !== 30) {
    issues.push(`screen.colorDepth (${fp.screen.colorDepth}) is not a realistic value (24 or 30)`);
  }
  // devicePixelRatio: allow genuine fractional-scaling / zoomed displays (< 1) but reject nonsense.
  if (fp.screen.devicePixelRatio <= 0 || fp.screen.devicePixelRatio > 4) {
    issues.push(
      `devicePixelRatio (${fp.screen.devicePixelRatio}) is outside the plausible (0, 4] range`,
    );
  }

  return issues;
}
