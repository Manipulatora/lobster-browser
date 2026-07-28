// Curated option data for the profile form's manual-mode dropdowns (Geolocation / Language / Timezone).
// These replace free-text entry so users pick a valid value from a list instead of typing one that can
// be malformed or incoherent. Timezones come from the platform's IANA database; locales and locations
// are a curated set covering the markets these profiles are actually used for.

/** All valid IANA timezone ids from the platform (WebKitGTK exposes Intl.supportedValuesOf). */
export const TIMEZONE_OPTIONS: readonly string[] = (() => {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const zones = intl.supportedValuesOf?.('timeZone');
  if (zones && zones.length > 0) return zones;
  // Fallback for the rare runtime without supportedValuesOf: the zones we map to locales elsewhere.
  return [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Sao_Paulo',
    'America/Mexico_City',
    'America/Toronto',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Madrid',
    'Europe/Rome',
    'Europe/Amsterdam',
    'Europe/Warsaw',
    'Europe/Moscow',
    'Europe/Istanbul',
    'Africa/Cairo',
    'Africa/Johannesburg',
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Bangkok',
    'Asia/Singapore',
    'Asia/Shanghai',
    'Asia/Tokyo',
    'Asia/Seoul',
    'Asia/Hong_Kong',
    'Australia/Sydney',
    'Pacific/Auckland',
    'UTC',
  ];
})();

/** Common BCP-47 locales, primary-market first. The value is the primary locale; the form expands it
 *  to an ordered `navigator.languages` list (e.g. "de-DE" -> ["de-DE","de","en-US","en"]-style). */
export const LOCALE_OPTIONS: readonly string[] = [
  'en-US',
  'en-GB',
  'en-CA',
  'en-AU',
  'en-IN',
  'en-NZ',
  'en-IE',
  'en-ZA',
  'de-DE',
  'de-AT',
  'de-CH',
  'fr-FR',
  'fr-CA',
  'fr-BE',
  'fr-CH',
  'es-ES',
  'es-MX',
  'es-AR',
  'es-CO',
  'es-CL',
  'pt-BR',
  'pt-PT',
  'it-IT',
  'nl-NL',
  'nl-BE',
  'sv-SE',
  'nb-NO',
  'da-DK',
  'fi-FI',
  'pl-PL',
  'cs-CZ',
  'ro-RO',
  'hu-HU',
  'el-GR',
  'tr-TR',
  'ru-RU',
  'uk-UA',
  'ar-SA',
  'ar-AE',
  'ar-EG',
  'he-IL',
  'hi-IN',
  'th-TH',
  'vi-VN',
  'id-ID',
  'ms-MY',
  'ja-JP',
  'ko-KR',
  'zh-CN',
  'zh-TW',
  'zh-HK',
];

export interface GeoLocationOption {
  /** Human label shown in the dropdown. */
  label: string;
  latitude: number;
  longitude: number;
  /** Coherent IANA timezone + locale for this place, offered so the profile can stay consistent. */
  timezone: string;
  locale: string;
}

/** Major cities with real coordinates + their coherent timezone/locale. Picking one fills the
 *  geolocation fields; the label is matched back from the stored lat/lng for display. */
export const LOCATION_OPTIONS: readonly GeoLocationOption[] = [
  {
    label: 'New York, United States',
    latitude: 40.7128,
    longitude: -74.006,
    timezone: 'America/New_York',
    locale: 'en-US',
  },
  {
    label: 'Los Angeles, United States',
    latitude: 34.0522,
    longitude: -118.2437,
    timezone: 'America/Los_Angeles',
    locale: 'en-US',
  },
  {
    label: 'Chicago, United States',
    latitude: 41.8781,
    longitude: -87.6298,
    timezone: 'America/Chicago',
    locale: 'en-US',
  },
  {
    label: 'Toronto, Canada',
    latitude: 43.6532,
    longitude: -79.3832,
    timezone: 'America/Toronto',
    locale: 'en-CA',
  },
  {
    label: 'Mexico City, Mexico',
    latitude: 19.4326,
    longitude: -99.1332,
    timezone: 'America/Mexico_City',
    locale: 'es-MX',
  },
  {
    label: 'São Paulo, Brazil',
    latitude: -23.5505,
    longitude: -46.6333,
    timezone: 'America/Sao_Paulo',
    locale: 'pt-BR',
  },
  {
    label: 'Buenos Aires, Argentina',
    latitude: -34.6037,
    longitude: -58.3816,
    timezone: 'America/Argentina/Buenos_Aires',
    locale: 'es-AR',
  },
  {
    label: 'London, United Kingdom',
    latitude: 51.5074,
    longitude: -0.1278,
    timezone: 'Europe/London',
    locale: 'en-GB',
  },
  {
    label: 'Dublin, Ireland',
    latitude: 53.3498,
    longitude: -6.2603,
    timezone: 'Europe/Dublin',
    locale: 'en-IE',
  },
  {
    label: 'Paris, France',
    latitude: 48.8566,
    longitude: 2.3522,
    timezone: 'Europe/Paris',
    locale: 'fr-FR',
  },
  {
    label: 'Berlin, Germany',
    latitude: 52.52,
    longitude: 13.405,
    timezone: 'Europe/Berlin',
    locale: 'de-DE',
  },
  {
    label: 'Frankfurt, Germany',
    latitude: 50.1109,
    longitude: 8.6821,
    timezone: 'Europe/Berlin',
    locale: 'de-DE',
  },
  {
    label: 'Amsterdam, Netherlands',
    latitude: 52.3676,
    longitude: 4.9041,
    timezone: 'Europe/Amsterdam',
    locale: 'nl-NL',
  },
  {
    label: 'Madrid, Spain',
    latitude: 40.4168,
    longitude: -3.7038,
    timezone: 'Europe/Madrid',
    locale: 'es-ES',
  },
  {
    label: 'Rome, Italy',
    latitude: 41.9028,
    longitude: 12.4964,
    timezone: 'Europe/Rome',
    locale: 'it-IT',
  },
  {
    label: 'Zurich, Switzerland',
    latitude: 47.3769,
    longitude: 8.5417,
    timezone: 'Europe/Zurich',
    locale: 'de-CH',
  },
  {
    label: 'Stockholm, Sweden',
    latitude: 59.3293,
    longitude: 18.0686,
    timezone: 'Europe/Stockholm',
    locale: 'sv-SE',
  },
  {
    label: 'Warsaw, Poland',
    latitude: 52.2297,
    longitude: 21.0122,
    timezone: 'Europe/Warsaw',
    locale: 'pl-PL',
  },
  {
    label: 'Moscow, Russia',
    latitude: 55.7558,
    longitude: 37.6173,
    timezone: 'Europe/Moscow',
    locale: 'ru-RU',
  },
  {
    label: 'Istanbul, Turkey',
    latitude: 41.0082,
    longitude: 28.9784,
    timezone: 'Europe/Istanbul',
    locale: 'tr-TR',
  },
  {
    label: 'Dubai, United Arab Emirates',
    latitude: 25.2048,
    longitude: 55.2708,
    timezone: 'Asia/Dubai',
    locale: 'ar-AE',
  },
  {
    label: 'Tel Aviv, Israel',
    latitude: 32.0853,
    longitude: 34.7818,
    timezone: 'Asia/Jerusalem',
    locale: 'he-IL',
  },
  {
    label: 'Mumbai, India',
    latitude: 19.076,
    longitude: 72.8777,
    timezone: 'Asia/Kolkata',
    locale: 'en-IN',
  },
  {
    label: 'Singapore',
    latitude: 1.3521,
    longitude: 103.8198,
    timezone: 'Asia/Singapore',
    locale: 'en-SG',
  },
  {
    label: 'Bangkok, Thailand',
    latitude: 13.7563,
    longitude: 100.5018,
    timezone: 'Asia/Bangkok',
    locale: 'th-TH',
  },
  {
    label: 'Hong Kong',
    latitude: 22.3193,
    longitude: 114.1694,
    timezone: 'Asia/Hong_Kong',
    locale: 'zh-HK',
  },
  {
    label: 'Shanghai, China',
    latitude: 31.2304,
    longitude: 121.4737,
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
  },
  {
    label: 'Tokyo, Japan',
    latitude: 35.6762,
    longitude: 139.6503,
    timezone: 'Asia/Tokyo',
    locale: 'ja-JP',
  },
  {
    label: 'Seoul, South Korea',
    latitude: 37.5665,
    longitude: 126.978,
    timezone: 'Asia/Seoul',
    locale: 'ko-KR',
  },
  {
    label: 'Sydney, Australia',
    latitude: -33.8688,
    longitude: 151.2093,
    timezone: 'Australia/Sydney',
    locale: 'en-AU',
  },
  {
    label: 'Auckland, New Zealand',
    latitude: -36.8485,
    longitude: 174.7633,
    timezone: 'Pacific/Auckland',
    locale: 'en-NZ',
  },
  {
    label: 'Johannesburg, South Africa',
    latitude: -26.2041,
    longitude: 28.0473,
    timezone: 'Africa/Johannesburg',
    locale: 'en-ZA',
  },
  {
    label: 'Cairo, Egypt',
    latitude: 30.0444,
    longitude: 31.2357,
    timezone: 'Africa/Cairo',
    locale: 'ar-EG',
  },
];

/** Expand a primary locale into an ordered navigator.languages string, e.g. "de-DE" -> "de-DE, de". */
export function expandLocaleToLanguages(primary: string): string {
  const base = primary.split('-')[0];
  const list = base && base !== primary ? [primary, base] : [primary];
  // Always keep the profile reachable with English as a trailing fallback unless it already is English.
  if (base !== 'en') list.push('en-US', 'en');
  return list.join(', ');
}

/** The primary locale currently held in a comma-separated languages string (for dropdown display). */
export function primaryLocaleOf(languages: string): string {
  return languages.split(',')[0]?.trim() ?? '';
}
