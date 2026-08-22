import { buildChromeBrands, renderChromeBrands } from './pools.js';
import {
  DEVICE_TIER_ENVELOPES,
  HIGH_CORE_MEMORY_FLOOR,
  gpuTierFromRenderer,
} from './device-tiers.js';
import { isPlausibleDisplayMode } from './displays.js';
import type {
  AndroidFingerprint,
  Fingerprint,
  FingerprintOverrides,
  GeoInfo,
  LocaleFingerprint,
  OsFamily,
} from '@lobster/shared-types';

/**
 * Country (ISO-3166 alpha-2) → primary browser locale. Covers the ~70 most common proxy exit
 * countries so that when a proxy lands in, say, Sweden we set a Swedish locale rather than leaving
 * the seed-default en-US next to a `Europe/Stockholm` timezone — a navigator.language/Accept-Language
 * vs timezone mismatch is one of the strongest bot signals. For a still-unmapped country we fall back
 * to {@link TIMEZONE_LOCALE} (deriving the language from the exit timezone) before ever keeping en-US.
 */
const COUNTRY_LOCALE: Record<string, string> = {
  // English-speaking
  US: 'en-US',
  GB: 'en-GB',
  CA: 'en-CA',
  AU: 'en-AU',
  NZ: 'en-NZ',
  IE: 'en-IE',
  ZA: 'en-ZA',
  SG: 'en-SG',
  NG: 'en-NG',
  KE: 'en-KE',
  PH: 'en-PH',
  IN: 'en-IN',
  // Western / Central Europe
  DE: 'de-DE',
  AT: 'de-AT',
  CH: 'de-CH',
  FR: 'fr-FR',
  BE: 'nl-BE',
  LU: 'fr-LU',
  NL: 'nl-NL',
  ES: 'es-ES',
  IT: 'it-IT',
  PT: 'pt-PT',
  // Nordics
  SE: 'sv-SE',
  NO: 'nb-NO',
  DK: 'da-DK',
  FI: 'fi-FI',
  IS: 'is-IS',
  // Eastern Europe / Balkans
  PL: 'pl-PL',
  CZ: 'cs-CZ',
  SK: 'sk-SK',
  HU: 'hu-HU',
  RO: 'ro-RO',
  BG: 'bg-BG',
  HR: 'hr-HR',
  RS: 'sr-RS',
  SI: 'sl-SI',
  GR: 'el-GR',
  UA: 'uk-UA',
  RU: 'ru-RU',
  BY: 'ru-BY',
  EE: 'et-EE',
  LV: 'lv-LV',
  LT: 'lt-LT',
  TR: 'tr-TR',
  // Middle East / North Africa
  IL: 'he-IL',
  AE: 'ar-AE',
  SA: 'ar-SA',
  EG: 'ar-EG',
  MA: 'ar-MA',
  DZ: 'ar-DZ',
  TN: 'ar-TN',
  IR: 'fa-IR',
  // Asia-Pacific
  JP: 'ja-JP',
  KR: 'ko-KR',
  CN: 'zh-CN',
  HK: 'zh-HK',
  TW: 'zh-TW',
  TH: 'th-TH',
  VN: 'vi-VN',
  ID: 'id-ID',
  MY: 'ms-MY',
  PK: 'ur-PK',
  BD: 'bn-BD',
  LK: 'si-LK',
  MM: 'my-MM',
  KZ: 'ru-KZ',
  // Latin America
  BR: 'pt-BR',
  MX: 'es-MX',
  AR: 'es-AR',
  CL: 'es-CL',
  CO: 'es-CO',
  PE: 'es-PE',
  VE: 'es-VE',
  EC: 'es-EC',
  UY: 'es-UY',
  BO: 'es-BO',
  PY: 'es-PY',
  GT: 'es-GT',
  CR: 'es-CR',
  DO: 'es-DO',
};

/**
 * IANA timezone → primary browser locale. Two jobs: (1) when a proxy's country is not in
 * {@link COUNTRY_LOCALE} we derive the language from the exit timezone instead of keeping en-US, and
 * (2) {@link validateFingerprintCoherence} uses it to flag a timezone whose region implies a language
 * that disagrees with the locale. Kept consistent with COUNTRY_LOCALE (same primary language per
 * country) so a fingerprint produced by {@link applyGeoToFingerprint} never flags itself. Under-
 * coverage is safe (an unmapped zone simply skips the check); a *disagreeing* entry would not be.
 */
const TIMEZONE_LOCALE: Record<string, string> = {
  // North America (English / Spanish / Portuguese)
  'America/New_York': 'en-US',
  'America/Detroit': 'en-US',
  'America/Chicago': 'en-US',
  'America/Denver': 'en-US',
  'America/Phoenix': 'en-US',
  'America/Los_Angeles': 'en-US',
  'America/Anchorage': 'en-US',
  'Pacific/Honolulu': 'en-US',
  'America/Toronto': 'en-CA',
  'America/Vancouver': 'en-CA',
  'America/Edmonton': 'en-CA',
  'America/Winnipeg': 'en-CA',
  'America/Halifax': 'en-CA',
  'America/Mexico_City': 'es-MX',
  'America/Sao_Paulo': 'pt-BR',
  'America/Argentina/Buenos_Aires': 'es-AR',
  'America/Santiago': 'es-CL',
  'America/Bogota': 'es-CO',
  'America/Lima': 'es-PE',
  'America/Caracas': 'es-VE',
  'America/Guayaquil': 'es-EC',
  'America/Montevideo': 'es-UY',
  'America/La_Paz': 'es-BO',
  'America/Asuncion': 'es-PY',
  'America/Guatemala': 'es-GT',
  'America/Costa_Rica': 'es-CR',
  'America/Santo_Domingo': 'es-DO',
  // Europe
  'Europe/London': 'en-GB',
  'Europe/Dublin': 'en-IE',
  'Europe/Berlin': 'de-DE',
  'Europe/Vienna': 'de-AT',
  'Europe/Zurich': 'de-CH',
  'Europe/Paris': 'fr-FR',
  'Europe/Brussels': 'nl-BE',
  'Europe/Luxembourg': 'fr-LU',
  'Europe/Amsterdam': 'nl-NL',
  'Europe/Madrid': 'es-ES',
  'Europe/Rome': 'it-IT',
  'Europe/Lisbon': 'pt-PT',
  'Europe/Stockholm': 'sv-SE',
  'Europe/Oslo': 'nb-NO',
  'Europe/Copenhagen': 'da-DK',
  'Europe/Helsinki': 'fi-FI',
  'Atlantic/Reykjavik': 'is-IS',
  'Europe/Warsaw': 'pl-PL',
  'Europe/Prague': 'cs-CZ',
  'Europe/Bratislava': 'sk-SK',
  'Europe/Budapest': 'hu-HU',
  'Europe/Bucharest': 'ro-RO',
  'Europe/Sofia': 'bg-BG',
  'Europe/Zagreb': 'hr-HR',
  'Europe/Belgrade': 'sr-RS',
  'Europe/Ljubljana': 'sl-SI',
  'Europe/Athens': 'el-GR',
  'Europe/Kyiv': 'uk-UA',
  'Europe/Kiev': 'uk-UA',
  'Europe/Moscow': 'ru-RU',
  'Europe/Minsk': 'ru-BY',
  'Europe/Tallinn': 'et-EE',
  'Europe/Riga': 'lv-LV',
  'Europe/Vilnius': 'lt-LT',
  'Europe/Istanbul': 'tr-TR',
  // Middle East / Africa
  'Asia/Jerusalem': 'he-IL',
  'Asia/Dubai': 'ar-AE',
  'Asia/Riyadh': 'ar-SA',
  'Asia/Tehran': 'fa-IR',
  'Africa/Cairo': 'ar-EG',
  'Africa/Casablanca': 'ar-MA',
  'Africa/Algiers': 'ar-DZ',
  'Africa/Tunis': 'ar-TN',
  'Africa/Johannesburg': 'en-ZA',
  'Africa/Lagos': 'en-NG',
  'Africa/Nairobi': 'en-KE',
  // Asia-Pacific
  'Asia/Tokyo': 'ja-JP',
  'Asia/Seoul': 'ko-KR',
  'Asia/Shanghai': 'zh-CN',
  'Asia/Hong_Kong': 'zh-HK',
  'Asia/Taipei': 'zh-TW',
  'Asia/Bangkok': 'th-TH',
  'Asia/Ho_Chi_Minh': 'vi-VN',
  'Asia/Jakarta': 'id-ID',
  'Asia/Singapore': 'en-SG',
  'Asia/Kuala_Lumpur': 'ms-MY',
  'Asia/Manila': 'en-PH',
  'Asia/Karachi': 'ur-PK',
  'Asia/Dhaka': 'bn-BD',
  'Asia/Colombo': 'si-LK',
  'Asia/Yangon': 'my-MM',
  'Asia/Almaty': 'ru-KZ',
  'Asia/Kolkata': 'en-IN',
  // Oceania
  'Australia/Sydney': 'en-AU',
  'Australia/Melbourne': 'en-AU',
  'Australia/Brisbane': 'en-AU',
  'Australia/Perth': 'en-AU',
  'Australia/Adelaide': 'en-AU',
  'Pacific/Auckland': 'en-NZ',
};

/** Base language subtag of a BCP-47 locale, e.g. "sv-SE" → "sv", "en" → "en". */
function baseLanguage(locale: string): string {
  return locale.split('-')[0] ?? locale;
}

/**
 * Chromium's OWN default Accept-Language list, per UI locale.
 *
 * Extracted from components/strings/components_locale_settings_*.xtb (message
 * IDS_ACCEPT_LANGUAGES), which is what components/language/core/browser/language_prefs.cc seeds the
 * accept-languages preference with - and navigator.languages IS that preference.
 *
 * This exists because the previous derivation returned at most TWO entries, always: the locale and
 * its base language. Real Chrome almost never looks like that. Of the 52 locales Chromium
 * ships a default for, the counts run 2-6 and the commonest is FOUR ("de-DE,de,en-US,en"): most of
 * the world's Chrome installs carry English after their own language. A profile reporting exactly
 * two entries for de/fr/ja/ru is therefore distinguishable from a default install of the browser it
 * claims to be, on a value every page can read.
 *
 * Note also the HEAD tags: ja, ar, fa, lt, am, sw and fil are BARE here, not region-qualified.
 * Chromium does not emit "ja-JP".
 */
const CHROME_DEFAULT_LANGUAGES: Readonly<Record<string, readonly string[]>> = {
  'am': ['am', 'en-GB', 'en'],
  'ar': ['ar', 'en-US', 'en'],
  'bg': ['bg-BG', 'bg'],
  'bn': ['bn-IN', 'bn', 'en-US', 'en'],
  'ca': ['ca-ES', 'ca'],
  'cs': ['cs-CZ', 'cs'],
  'da': ['da-DK', 'da', 'en-US', 'en'],
  'de': ['de-DE', 'de', 'en-US', 'en'],
  'el': ['el-GR', 'el'],
  'en-GB': ['en-GB', 'en-US', 'en'],
  'en-US': ['en-US', 'en'],
  'es': ['es-ES', 'es'],
  'es-419': ['es-419', 'es'],
  'et': ['et-EE', 'et', 'en-US', 'en'],
  'fa': ['fa', 'en-US', 'en'],
  'fi': ['fi-FI', 'fi', 'en-US', 'en'],
  'fil': ['fil', 'fil-PH', 'tl', 'en-US', 'en'],
  'fr': ['fr-FR', 'fr', 'en-US', 'en'],
  'gu': ['gu-IN', 'gu', 'hi-IN', 'hi', 'en-US', 'en'],
  'he': ['he-IL', 'he', 'en-US', 'en'],
  'hi': ['hi-IN', 'hi', 'en-US', 'en'],
  'hr': ['hr-HR', 'hr', 'en-US', 'en'],
  'hu': ['hu-HU', 'hu', 'en-US', 'en'],
  'id': ['id-ID', 'id', 'en-US', 'en'],
  'it': ['it-IT', 'it', 'en-US', 'en'],
  'ja': ['ja', 'en-US', 'en'],
  'kn': ['kn-IN', 'kn', 'en-US', 'en'],
  'ko': ['ko-KR', 'ko', 'en-US', 'en'],
  'lt': ['lt', 'en-US', 'en', 'ru', 'pl'],
  'lv': ['lv-LV', 'lv', 'en-US', 'en'],
  'ml': ['ml-IN', 'ml', 'en-US', 'en'],
  'mr': ['mr-IN', 'mr', 'hi-IN', 'hi', 'en-US', 'en'],
  'nb': ['nb-NO', 'nb', 'no', 'nn', 'en-US', 'en'],
  'nl': ['nl-NL', 'nl', 'en-US', 'en'],
  'pl': ['pl-PL', 'pl', 'en-US', 'en'],
  'pt-BR': ['pt-BR', 'pt', 'en-US', 'en'],
  'pt-PT': ['pt-PT', 'pt', 'en-US', 'en'],
  'ro': ['ro-RO', 'ro', 'en-US', 'en'],
  'ru': ['ru-RU', 'ru', 'en-US', 'en'],
  'sk': ['sk-SK', 'sk', 'cs', 'en-US', 'en'],
  'sl': ['sl-SI', 'sl', 'en-GB', 'en'],
  'sr': ['sr-RS', 'sr', 'en-US', 'en'],
  'sv': ['sv-SE', 'sv', 'en-US', 'en'],
  'sw': ['sw', 'en-GB', 'en'],
  'ta': ['ta-IN', 'ta', 'en-US', 'en'],
  'te': ['te-IN', 'te', 'hi-IN', 'hi', 'en-US', 'en'],
  'th': ['th-TH', 'th'],
  'tr': ['tr-TR', 'tr', 'en-US', 'en'],
  'uk': ['uk-UA', 'uk', 'en-US', 'en'],
  'vi': ['vi-VN', 'vi', 'fr-FR', 'fr', 'en-US', 'en'],
  'zh-CN': ['zh-CN', 'zh'],
  'zh-TW': ['zh-TW', 'zh', 'en-US', 'en'],
};

/**
 * Map a persona locale onto the Chromium UI locale whose default list applies.
 *
 * Chromium has no per-region entry for most languages: an Austrian install resolves to the `de`
 * bundle, an Australian one to `en-GB`. Returning undefined means "Chromium ships no default for
 * this language", and the caller keeps its own conservative derivation rather than inventing one.
 */
function chromeUiLocaleFor(locale: string): string | undefined {
  if (CHROME_DEFAULT_LANGUAGES[locale]) return locale;
  const base = baseLanguage(locale);
  // English has no bare bundle: US is its own, everything else resolves to the en-GB bundle.
  if (base === 'en') return locale === 'en-US' ? 'en-US' : 'en-GB';
  // Portuguese and Chinese ship only regional bundles; Brazil/Taiwan match exactly above.
  if (base === 'pt') return 'pt-PT';
  if (base === 'zh') return 'zh-CN';
  return CHROME_DEFAULT_LANGUAGES[base] ? base : undefined;
}

/**
 * Canonicalise a persona locale to the tag Chromium itself would lead with.
 *
 * For most languages Chromium's default is region-qualified ("de-DE", "fr-FR", "ru-RU") and a
 * regional variant is a shape a real user can produce ("de-AT"). But for several languages its
 * default head carries NO region at all - ja, ar, fa, lt, am, sw, fil - and Chrome has never emitted
 * "ja-JP" as navigator.language. Region-qualifying those is a value no Chrome produces, readable
 * directly from navigator.language, so the country map's "ja-JP"/"lt-LT" are normalised back here
 * rather than in a hand-maintained list that would drift from the table above.
 */
function chromeCanonicalLocale(locale: string): string {
  const key = chromeUiLocaleFor(locale);
  const head = key ? CHROME_DEFAULT_LANGUAGES[key]?.[0] : undefined;
  if (!head) return locale;
  const base = baseLanguage(locale);
  // Only collapse when Chromium's own head for this language is itself region-free.
  return baseLanguage(head) === base && head === base ? head : locale;
}

function localeToLanguages(locale: string): string[] {
  const base = baseLanguage(locale);
  const key = chromeUiLocaleFor(locale);
  const table = key ? CHROME_DEFAULT_LANGUAGES[key] : undefined;
  if (!table || table.length === 0) {
    // No Chromium default for this language: keep the old conservative pair rather than inventing
    // a list. Being short is a smaller lie than being confidently wrong.
    return locale === base ? [locale] : [locale, base];
  }
  const head = table[0]!;
  // The persona already names exactly what Chromium leads with.
  if (head === locale) return [...table];
  // A regional variant of the same language (persona de-AT vs Chromium's de-DE head): lead with the
  // persona's own tag and keep the tail. That is the shape Chrome produces when a user adds that
  // regional variant in language settings.
  if (baseLanguage(head) === base) return [locale, ...table.slice(1)];
  // Different language entirely (should not happen via chromeUiLocaleFor, but stay total).
  return [locale, ...table];
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
export function applyGeoToFingerprint<T extends Fingerprint | AndroidFingerprint>(
  fp: T,
  geo: GeoInfo,
): T {
  // Prefer the country's primary locale; if the country is unmapped, derive the language from the
  // exit timezone (e.g. an unmapped country reporting `Europe/Stockholm` still gets Swedish) so we
  // never leave the seed-default en-US next to a foreign timezone. Only when both are unknown (e.g.
  // `Etc/UTC`, which implies no language) do we keep the seed default.
  const locale = chromeCanonicalLocale(
    COUNTRY_LOCALE[geo.countryCode.toUpperCase()] ??
      TIMEZONE_LOCALE[geo.timezone] ??
      fp.locale.locale,
  );
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
  } as T;
}

/**
 * Resolve the independent Language / Timezone / Geolocation / Fonts persona modes selected in the
 * profile UI. `base` is the seed/host-derived identity before editable values; `overridden` is the same
 * identity after ordinary FingerprintOverrides have been merged.
 *
 * This distinction matters for `real`: merely applying the overrides and then conditionally applying
 * geo cannot undo a stale manual value when the user changes its mode back to Real. It also matters for
 * `manual` language: the UI supplies navigator.languages, while locale + Accept-Language are dependent
 * fields that must be rebuilt from that selection or the engine's coherence gate rejects the profile.
 *
 * Undefined modes preserve legacy behavior: user overrides win without geo; when proxy geo is present,
 * the full locale cluster follows the exit IP as it did before persona modes were introduced.
 */
export function resolveFingerprintPersonaModes<T extends Fingerprint | AndroidFingerprint>(
  base: T,
  overridden: T,
  overrides: FingerprintOverrides | undefined,
  geo?: GeoInfo,
): T {
  const geoFingerprint = geo ? applyGeoToFingerprint(base, geo) : undefined;
  const legacyMode = geo ? 'based_ip' : 'manual';
  const languageMode = overrides?.languageMode ?? legacyMode;
  const timezoneMode = overrides?.timezoneMode ?? legacyMode;
  const geolocationMode = overrides?.geolocationMode ?? legacyMode;
  const fontsMode = overrides?.fontsMode ?? 'manual';

  const languageSource =
    languageMode === 'real'
      ? base
      : languageMode === 'based_ip'
        ? (geoFingerprint ?? base)
        : overridden;
  const languages = [...languageSource.navigator.languages];
  let locale = languageSource.locale.locale;
  let acceptLanguage = languageSource.locale.acceptLanguage;
  if (languageMode === 'manual') {
    // New-profile UI exposes a languages list, not a second locale field. Treat its first entry as the
    // primary locale unless an explicit locale override exists (the advanced editor exposes both).
    locale = overrides?.locale?.locale ?? languages[0] ?? locale;
    acceptLanguage = languagesToAcceptLanguage(languages);
  }

  const timezone =
    timezoneMode === 'real'
      ? base.locale.timezone
      : timezoneMode === 'based_ip'
        ? (geoFingerprint?.locale.timezone ?? base.locale.timezone)
        : overridden.locale.timezone;

  const geolocation =
    geolocationMode === 'real'
      ? base.locale.geolocation
      : geolocationMode === 'based_ip'
        ? geoFingerprint?.locale.geolocation
        : overridden.locale.geolocation;

  const resolvedLocale: LocaleFingerprint = {
    timezone,
    locale,
    acceptLanguage,
    ...(geolocation ? { geolocation: { ...geolocation } } : {}),
  };
  const fonts = fontsMode === 'real' || fontsMode === 'based_ip' ? base.fonts : overridden.fonts;

  return {
    ...overridden,
    navigator: { ...overridden.navigator, languages },
    locale: resolvedLocale,
    fonts: [...fonts],
  } as T;
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

/**
 * The `navigator.deviceMemory` values a desktop profile may carry — the spec ladder above the desktop
 * floor. Offering the full ladder in a desktop picker offers values the launch gate then refuses, so
 * the UI builds its choices from this rather than from {@link DEVICE_MEMORY_VALUES}. The sub-4 rungs
 * remain legal on Android, where 2 GB phones are ordinary.
 */
export const DESKTOP_DEVICE_MEMORY_VALUES: readonly number[] = DEVICE_MEMORY_VALUES.filter(
  (value) => value >= DESKTOP_MIN_DEVICE_MEMORY,
);

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
  if (!Object.prototype.hasOwnProperty.call(OS_UA_TOKEN, fp.os)) {
    return [`Unsupported desktop fingerprint OS "${String(fp.os)}"`];
  }

  if (!ua.includes(OS_UA_TOKEN[fp.os])) {
    issues.push(`User-Agent OS token does not match claimed OS "${fp.os}": ${ua}`);
  }
  if (!ua || /[\u0000-\u001f\u007f]/.test(ua)) {
    issues.push('User-Agent must be a non-empty string without control characters');
  }
  if (fp.navigator.languages.length === 0) {
    issues.push('navigator.languages must contain at least one language');
  }
  for (const language of fp.navigator.languages) {
    try {
      if (Intl.getCanonicalLocales(language).length !== 1) {
        issues.push(`navigator.languages contains an invalid BCP-47 tag "${language}"`);
      }
    } catch {
      issues.push(`navigator.languages contains an invalid BCP-47 tag "${language}"`);
    }
  }
  try {
    if (Intl.getCanonicalLocales(fp.locale.locale).length !== 1) {
      issues.push(`locale "${fp.locale.locale}" is not a valid BCP-47 tag`);
    }
  } catch {
    issues.push(`locale "${fp.locale.locale}" is not a valid BCP-47 tag`);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: fp.locale.timezone }).format(0);
  } catch {
    issues.push(`timezone "${fp.locale.timezone}" is not a valid IANA timezone`);
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
  const expectedAcceptLanguage = languagesToAcceptLanguage(fp.navigator.languages);
  if (fp.locale.acceptLanguage !== expectedAcceptLanguage) {
    issues.push(
      `Accept-Language (${fp.locale.acceptLanguage}) does not match navigator.languages (${expectedAcceptLanguage})`,
    );
  }
  const geo = fp.locale.geolocation;
  if (geo) {
    if (!Number.isFinite(geo.latitude) || geo.latitude < -90 || geo.latitude > 90) {
      issues.push(`geolocation latitude (${geo.latitude}) must be within [-90, 90]`);
    }
    if (!Number.isFinite(geo.longitude) || geo.longitude < -180 || geo.longitude > 180) {
      issues.push(`geolocation longitude (${geo.longitude}) must be within [-180, 180]`);
    }
    if (!Number.isFinite(geo.accuracy) || geo.accuracy <= 0) {
      issues.push(`geolocation accuracy (${geo.accuracy}) must be a positive finite number`);
    }
  }
  // Do NOT require the browser language to be the local language of the timezone. English Chrome in
  // Berlin, Japanese Chrome in New York, and expatriate/multilingual setups are ordinary real devices.
  // `applyGeoToFingerprint` still chooses the exit country's primary language for Based-on-IP mode,
  // but manual/real persona modes are intentionally independent and must not be mislabeled impossible.
  if (!OS_PLATFORM_MATCHERS[fp.os](fp.navigator.platform)) {
    issues.push(
      `navigator.platform "${fp.navigator.platform}" is not coherent with claimed OS "${fp.os}"`,
    );
  }
  for (const [field, value] of Object.entries({
    width: fp.screen.width,
    height: fp.screen.height,
    availWidth: fp.screen.availWidth,
    availHeight: fp.screen.availHeight,
  })) {
    if (!Number.isInteger(value) || value <= 0 || value > 16_384) {
      issues.push(`screen.${field} (${value}) must be an integer in 1-16384`);
    }
  }
  if (fp.screen.availHeight > fp.screen.height || fp.screen.availWidth > fp.screen.width) {
    issues.push('screen avail dimensions exceed physical dimensions');
  }
  // macOS always reserves a top menu bar (~25px), so a Mac persona MUST report availTop>0 (M6/FP-2). A
  // Mac with availTop=0 but availHeight<height implies a bottom dock and no menu bar — impossible on
  // default macOS. Windows/Linux keep the deficit at the bottom (availTop=0).
  const availTop = fp.screen.availTop ?? 0;
  const availLeft = fp.screen.availLeft ?? 0;
  if (
    !Number.isInteger(availTop) ||
    !Number.isInteger(availLeft) ||
    availTop < 0 ||
    availLeft < 0 ||
    availTop + fp.screen.availHeight > fp.screen.height ||
    availLeft + fp.screen.availWidth > fp.screen.width
  ) {
    issues.push(
      'screen available rect must be an integer rect contained within the physical screen',
    );
  }
  if (fp.os === 'macos' && availTop < 24) {
    issues.push(
      `macOS screen.availTop (${availTop}) must reserve the ~25px menu bar (availTop>=24)`,
    );
  }
  if (fp.os === 'windows' && availTop !== 0) {
    issues.push(
      `screen.availTop (${availTop}) must be 0 on windows (the supported persona uses a bottom taskbar)`,
    );
  }
  // WebGL vendor/renderer must describe a real GPU and agree with the OS. Direct3D is a
  // Windows-only graphics backend, so a Direct3D renderer on macOS/Linux is an obvious tell.
  if (
    fp.webgl.vendor.length === 0 ||
    fp.webgl.renderer.length === 0 ||
    fp.webgl.unmaskedVendor.length === 0 ||
    fp.webgl.unmaskedRenderer.length === 0
  ) {
    issues.push('WebGL vendor/renderer and unmasked vendor/renderer must not be empty');
  }
  // Masked GL_VENDOR/GL_RENDERER and WEBGL_debug_renderer_info's unmasked pair legitimately differ
  // on real Chromium, so do not require string equality. The native hook applies the unmasked pair
  // atomically; all four fields merely need to be present.
  if (fp.os !== 'windows' && /Direct3D/i.test(fp.webgl.renderer)) {
    issues.push(
      `WebGL renderer uses the Windows-only Direct3D backend on OS "${fp.os}": ${fp.webgl.renderer}`,
    );
  }
  // A software rasterizer (SwiftShader / llvmpipe / Microsoft Basic Render) means no real GPU — the
  // hallmark of a headless/VM automation host, and a hard tell on any OS. The generator's real-device
  // distribution ships these for a large slice of samples, so reject them during derivation.
  const webglText = `${fp.webgl.vendor} ${fp.webgl.renderer}`;
  if (/SwiftShader|llvmpipe|Software|Microsoft Basic Render/i.test(webglText)) {
    issues.push(`WebGL uses a software renderer (no real GPU) — an automation tell: ${webglText}`);
  }
  // Real Windows Chrome renders through ANGLE's Direct3D backend and exposes a "Google Inc. (…)"
  // WebGL vendor + an "ANGLE (…, … Direct3D11 …)" renderer. A macOS/Apple-format GPU string — a bare
  // OpenGL vendor like "Intel Inc.", a legacy "… OpenGL Engine" renderer, or an "ANGLE Metal Renderer"
  // (Metal is Apple-only) — on a Windows profile is a platform mismatch tell.
  if (fp.os === 'windows') {
    if (!(/\bANGLE\b/.test(fp.webgl.renderer) && /Direct3D/i.test(fp.webgl.renderer))) {
      issues.push(
        `WebGL renderer on Windows must use the ANGLE Direct3D backend (e.g. "ANGLE (Intel, … Direct3D11 …)"): ${fp.webgl.renderer}`,
      );
    }
    if (/Intel Inc\.|ATI Technologies Inc\.|OpenGL Engine|Metal Renderer/i.test(webglText)) {
      issues.push(`WebGL uses a macOS/Apple-format GPU string on a Windows profile: ${webglText}`);
    }
  }
  // POSITIVE per-OS GPU-backend checks (M5): macOS Chrome renders through ANGLE's Metal backend; Linux
  // through Mesa/OpenGL. A mac persona without a Metal renderer, or a Linux persona carrying Metal
  // (Apple-only) or Direct3D (Windows-only), is a backend-vs-OS mismatch a detector cross-checks.
  if (fp.os === 'macos' && !/ANGLE Metal Renderer/i.test(fp.webgl.renderer)) {
    issues.push(`WebGL renderer on macOS must use the ANGLE Metal backend: ${fp.webgl.renderer}`);
  }
  if (fp.os === 'linux') {
    if (/Metal Renderer|Direct3D/i.test(fp.webgl.renderer)) {
      issues.push(
        `WebGL renderer on Linux must not use Metal/Direct3D (Apple/Windows backends): ${fp.webgl.renderer}`,
      );
    }
    if (!/Mesa|OpenGL|ANGLE/i.test(webglText)) {
      issues.push(
        `WebGL renderer on Linux should present a Mesa/OpenGL/ANGLE backend: ${fp.webgl.renderer}`,
      );
    }
  }

  // --- CPU architecture must agree with the GPU (Apple-Silicon coherence, FP-3) --------------------
  // An Apple-Silicon Mac (Metal renderer "Apple M<n>") is arm64; anything else in the catalog is x86_64.
  // A persona claiming an "Apple M2 Pro" GPU while reporting Sec-CH-UA-Arch=x86 (arch x86_64) is a glaring
  // cross-check tell, and vice-versa (arm64 arch must carry an Apple-Silicon GPU).
  const isAppleSilicon = /Apple M\d/.test(fp.webgl.renderer);
  if (isAppleSilicon && fp.arch !== 'arm64') {
    issues.push(
      `arch "${fp.arch}" contradicts the Apple-Silicon GPU "${fp.webgl.renderer}" (must be arm64)`,
    );
  }
  if (!isAppleSilicon && fp.arch === 'arm64') {
    issues.push(
      `arch "arm64" requires an Apple-Silicon GPU, but the renderer is "${fp.webgl.renderer}"`,
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
    // STRICT conformance: Chromium derives the whole brand list — decoy spelling, decoy version and
    // the order of all three entries — from the UA major. The checks above only prove the list is
    // "Chrome-shaped", which a stale hardcoded list also is: `Not_A Brand` is the M131 decoy and
    // passes every loose test while being flatly wrong for 152. Sec-CH-UA is low-entropy and rides
    // every request, so an edge with a Chrome-major -> brand-string table catches it for free.
    // Compare against the algorithm itself; anything else is a lie the persona tells on every hop.
    // Two list shapes are legitimate: the Google-Chrome-branded three-entry list, and the two-entry
    // list an unbranded Chromium build sends. Accept either, but require an EXACT algorithmic match to
    // whichever shape is present — that is what separates a real Chromium persona from a stale
    // hardcoded one.
    try {
      const actual = renderChromeBrands(nav.uaBrands);
      const branded = renderChromeBrands(buildChromeBrands(chromeMajor));
      const chromiumOnly = renderChromeBrands(buildChromeBrands(chromeMajor, { branded: false }));
      if (actual !== branded && actual !== chromiumOnly) {
        issues.push(
          `Sec-CH-UA brand list is not one Chrome ${chromeMajor} can emit — got ${actual}; ` +
            `expected ${branded} (Chrome) or ${chromiumOnly} (unbranded Chromium)`,
        );
      }
    } catch {
      issues.push(`Sec-CH-UA brand list cannot be validated for UA major "${chromeMajor}"`);
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

  // --- Sec-CH-UA-Platform-Version --------------------------------------------------------------------
  // Chromium's GetUserAgentPlatformVersion() has no Linux source and returns an EMPTY string there,
  // so every real Chrome on Linux answers getHighEntropyValues(['platformVersion']) with "". A
  // kernel-shaped value like "6.8.0" is one no Chrome has ever emitted, and reading it costs a single
  // call. Windows and macOS conversely always report a version, so an empty one is equally wrong.
  if (fp.os === 'linux' && nav.uaPlatformVersion !== '') {
    issues.push(
      `Sec-CH-UA-Platform-Version must be empty on Linux (real Chrome reports no platform version there), got "${nav.uaPlatformVersion}"`,
    );
  }
  if ((fp.os === 'windows' || fp.os === 'macos') && !nav.uaPlatformVersion) {
    issues.push(`Sec-CH-UA-Platform-Version must be set on ${fp.os}`);
  }

  // --- Form factor ---------------------------------------------------------------------------------
  // A desktop profile must not advertise itself as mobile, and touch points must match the form factor.
  if (nav.uaMobile) {
    issues.push(`uaMobile is true for desktop OS "${fp.os}"`);
  }
  if (!nav.uaMobile && nav.maxTouchPoints !== 0) {
    issues.push(`maxTouchPoints (${nav.maxTouchPoints}) must be 0 for a non-mobile profile`);
  }
  // Sec-CH-UA-Form-Factors must be stated and must be Desktop here. Leaving it unset makes the engine
  // fall back to a binary Mobile/Desktop split off the mobile bit, which is right for desktop but
  // silently mislabels a tablet — so requiring it explicitly keeps the two paths honest.
  if (nav.uaFormFactor !== 'Desktop') {
    issues.push(
      `Sec-CH-UA-Form-Factors must be "Desktop" for a desktop profile, got ${JSON.stringify(nav.uaFormFactor)}`,
    );
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
  // A machine is not a bag of independent numbers. Cores, memory and GPU are bought together, so the
  // combination is checkable even when every value is individually legal: 24 cores next to 4 GB and an
  // integrated GPU is not a machine anyone owns, and a detector comparing those three does not need any
  // one of them to be out of range to know it.
  const tier = gpuTierFromRenderer(fp.webgl.unmaskedRenderer || fp.webgl.renderer);
  const envelope = DEVICE_TIER_ENVELOPES[tier];
  if (
    Number.isInteger(nav.hardwareConcurrency) &&
    (nav.hardwareConcurrency < envelope.minCores || nav.hardwareConcurrency > envelope.maxCores)
  ) {
    issues.push(
      `hardwareConcurrency (${nav.hardwareConcurrency}) is outside the ${tier} GPU tier's plausible ` +
        `${envelope.minCores}–${envelope.maxCores} cores: ${fp.webgl.renderer}`,
    );
  }
  if (nav.deviceMemory < envelope.minDeviceMemory) {
    issues.push(
      `navigator.deviceMemory (${nav.deviceMemory}) is below the ${tier} GPU tier's minimum ` +
        `${envelope.minDeviceMemory}: ${fp.webgl.renderer}`,
    );
  }
  if (
    nav.hardwareConcurrency >= HIGH_CORE_MEMORY_FLOOR.cores &&
    nav.deviceMemory < HIGH_CORE_MEMORY_FLOOR.deviceMemory
  ) {
    issues.push(
      `navigator.deviceMemory (${nav.deviceMemory}) is implausible on a ` +
        `${nav.hardwareConcurrency}-thread machine (min ${HIGH_CORE_MEMORY_FLOOR.deviceMemory})`,
    );
  }

  // --- Display realism -----------------------------------------------------------------------------
  if (fp.screen.colorDepth !== 24 && fp.screen.colorDepth !== 30) {
    issues.push(`screen.colorDepth (${fp.screen.colorDepth}) is not a realistic value (24 or 30)`);
  }
  // screen size and devicePixelRatio are one measurement, not two: the CSS size is the panel divided by
  // the OS scale factor. A pair that no panel/scale step produces (1920x1080 at dpr 1.5 would need a
  // 2880x1620 panel; 1536x864 at dpr 2 a 3072x1728 one) is a contradiction a page reads in two lines.
  if (
    !isPlausibleDisplayMode(fp.os, {
      width: fp.screen.width,
      height: fp.screen.height,
      dpr: fp.screen.devicePixelRatio,
    })
  ) {
    issues.push(
      `screen ${fp.screen.width}x${fp.screen.height} at devicePixelRatio ` +
        `${fp.screen.devicePixelRatio} is not a mode any real ${fp.os} display produces`,
    );
  }

  if (fp.fonts.length === 0) issues.push('font persona must contain at least one family');
  if (fp.fonts.some((font) => !font.trim() || /[\u0000-\u001f\u007f]/.test(font))) {
    issues.push('font persona contains an empty/control-character family name');
  }
  if (new Set(fp.fonts).size !== fp.fonts.length) {
    issues.push('font persona contains duplicate family names');
  }

  return issues;
}
