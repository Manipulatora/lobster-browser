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
  return issues;
}
