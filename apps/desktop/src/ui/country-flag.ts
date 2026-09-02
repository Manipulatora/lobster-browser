/**
 * Country → emoji flag, for the tiny region marker beside a proxy's title.
 *
 * A flag is two regional-indicator code points derived from the ISO 3166-1 alpha-2 code, so no
 * sprite sheet, no CDN (blocked by the app's CSP), and no per-country asset. The known caveat is
 * Windows: Segoe UI Emoji ships no flag glyphs — but .flag-chip loads a bundled flags-only face
 * (Twemoji Country Flags, styles.css) scoped to the flag codepoints, so the pair renders as real
 * flag art on every OS. Outside that class the pair would fall back to the two boxed letters of the
 * code itself ("🇺🇸" → "US") — a legible degradation the owner accepted in exchange for real flags
 * everywhere else.
 *
 * Pure and dependency-free on purpose: `country-flag.test.mjs` runs it under `node --test`.
 */

/** What renders when the region is unknown — a neutral globe, never a wrong flag. */
export const UNKNOWN_REGION_FLAG = '🌐';

/** An ISO 3166-1 alpha-2 code, the only thing a flag can be derived from. */
const ALPHA2 = /^[A-Za-z]{2}$/;

/**
 * Separators a stored proxy `location` uses between its parts. ProxiesView writes
 * "CC · region · city", but imported/edited rows can carry commas or slashes.
 */
const LOCATION_SEPARATORS = /[·,|/]/;

/**
 * Common country NAMES → alpha-2, for data that spells the country out instead of coding it (an
 * imported proxy list, a provider label). Keyed lowercase. Deliberately not exhaustive — an
 * unmatched name falls back to the globe rather than to a guess.
 */
const NAME_TO_CODE: Readonly<Record<string, string>> = {
  'united states': 'US',
  'united states of america': 'US',
  usa: 'US',
  america: 'US',
  'united kingdom': 'GB',
  uk: 'GB',
  'great britain': 'GB',
  england: 'GB',
  germany: 'DE',
  france: 'FR',
  netherlands: 'NL',
  holland: 'NL',
  spain: 'ES',
  italy: 'IT',
  portugal: 'PT',
  ireland: 'IE',
  belgium: 'BE',
  switzerland: 'CH',
  austria: 'AT',
  sweden: 'SE',
  norway: 'NO',
  denmark: 'DK',
  finland: 'FI',
  poland: 'PL',
  czechia: 'CZ',
  'czech republic': 'CZ',
  romania: 'RO',
  bulgaria: 'BG',
  hungary: 'HU',
  greece: 'GR',
  ukraine: 'UA',
  russia: 'RU',
  turkey: 'TR',
  israel: 'IL',
  'saudi arabia': 'SA',
  'united arab emirates': 'AE',
  uae: 'AE',
  india: 'IN',
  pakistan: 'PK',
  bangladesh: 'BD',
  china: 'CN',
  'hong kong': 'HK',
  taiwan: 'TW',
  japan: 'JP',
  'south korea': 'KR',
  korea: 'KR',
  vietnam: 'VN',
  thailand: 'TH',
  singapore: 'SG',
  malaysia: 'MY',
  indonesia: 'ID',
  philippines: 'PH',
  australia: 'AU',
  'new zealand': 'NZ',
  canada: 'CA',
  mexico: 'MX',
  brazil: 'BR',
  argentina: 'AR',
  chile: 'CL',
  colombia: 'CO',
  peru: 'PE',
  'south africa': 'ZA',
  egypt: 'EG',
  nigeria: 'NG',
  kenya: 'KE',
  morocco: 'MA',
};

/**
 * The alpha-2 code hiding in `value`, or undefined.
 *
 * Accepts the three shapes the app actually holds: a bare code ("US", "de"), a spelled-out name
 * ("United States"), or a stored proxy location string ("US · New York · New York" — the leading
 * segment is what identifies the country; see `resultLocation` in ProxiesView, which writes it).
 */
export function countryCodeFrom(value: string | undefined): string | undefined {
  const leading = value?.split(LOCATION_SEPARATORS)[0]?.trim();
  if (!leading) return undefined;
  if (ALPHA2.test(leading)) return leading.toUpperCase();
  return NAME_TO_CODE[leading.replace(/\s+/g, ' ').toLowerCase()];
}

/**
 * The emoji flag for a code or a country name, or {@link UNKNOWN_REGION_FLAG} when the region
 * cannot be identified. Alpha-2 letters map to Regional Indicator Symbols (U+1F1E6 + offset); any
 * pair of them is a well-formed emoji sequence, so an exotic-but-valid code degrades to its own
 * boxed letters rather than to a broken glyph.
 */
export function countryFlag(value: string | undefined): string {
  const code = countryCodeFrom(value);
  if (!code) return UNKNOWN_REGION_FLAG;
  const offset = (letter: string): number => 0x1f1e6 + (letter.charCodeAt(0) - 0x41);
  return String.fromCodePoint(offset(code[0]!), offset(code[1]!));
}

/**
 * `Intl.DisplayNames` is built into the WebView's ICU (and Node's), so full country names cost zero
 * bytes and no request. Constructed once — an instance per table cell is measurable on a long list.
 */
const REGION_NAMES: Intl.DisplayNames | null = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' });
  } catch {
    return null; // very old WebView2: fall back to the bare code
  }
})();

/** Human-readable country name for a code or name, for tooltips and accessible labels. */
export function countryName(value: string): string {
  const code = countryCodeFrom(value) ?? value.toUpperCase();
  try {
    return REGION_NAMES?.of(code) ?? code;
  } catch {
    // .of() throws on a structurally invalid region code.
    return code;
  }
}
