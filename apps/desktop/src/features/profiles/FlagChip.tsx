import { Icon } from '../../ui/Icon';

/**
 * `Intl.DisplayNames` is built into the WebView's ICU, so full country names cost zero bytes and no
 * request. Constructed once rather than per row — an instance per cell is measurable on a long table.
 */
const REGION_NAMES: Intl.DisplayNames | null = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' });
  } catch {
    return null; // very old WebView2: fall back to the bare code
  }
})();

export function countryName(code: string): string {
  try {
    return REGION_NAMES?.of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    // .of() throws on a structurally invalid region code.
    return code.toUpperCase();
  }
}

/**
 * A country marker with no image set: the ISO 3166-1 alpha-2 code in a flag-shaped box.
 *
 * NOT an emoji flag. Windows ships no flag glyphs in Segoe UI Emoji, so a regional-indicator pair
 * renders as two boxed letters — which is exactly what the old `countryFlag()` helper was drawing on
 * every install. A sprite sheet would be ~250 SVGs, and a CDN is blocked by the app's CSP.
 *
 * Deliberately MONOCHROME: the status ring is the row's only meaningful colour, and any per-country
 * palette would be invented — the chip would assert a fact it does not have.
 */
export function FlagChip({ code }: { code?: string }): JSX.Element {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) {
    return (
      <span className="flag-chip flag-chip--unknown" title="Country unknown — run a proxy check">
        <Icon name="GlobeAltIcon" aria-hidden />
      </span>
    );
  }
  const cc = code.toUpperCase();
  const name = countryName(cc);
  return (
    <span className="flag-chip" title={name} role="img" aria-label={name}>
      {cc}
    </span>
  );
}
