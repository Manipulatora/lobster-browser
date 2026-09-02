import { UNKNOWN_REGION_FLAG, countryFlag, countryName } from '../../ui/country-flag';

/**
 * The tiny national flag beside a proxy's title: an emoji flag derived from the ISO 3166-1 alpha-2
 * code (owner decision — this replaced the monochrome boxed-code chip).
 *
 * Emoji flags are regional-indicator pairs, so they need no sprite sheet and no CDN (the app's CSP
 * blocks one anyway). Windows ships no flag glyphs in Segoe UI Emoji, so .flag-chip pins a bundled
 * flags-only face (Twemoji Country Flags — see the @font-face in styles.css) that gives every OS
 * the same real flag art; without it the pair would degrade to two boxed letters there.
 * An UNKNOWN region shows a neutral globe rather than a guessed flag; the tooltip says how to find
 * out (a proxy check resolves the exit country).
 */
export function FlagChip({ code }: { code?: string }): JSX.Element {
  const flag = countryFlag(code);
  if (flag === UNKNOWN_REGION_FLAG) {
    return (
      <span
        className="flag-chip flag-chip--unknown"
        title="Country unknown — run a proxy check"
        role="img"
        aria-label="Country unknown"
      >
        {flag}
      </span>
    );
  }
  const name = countryName(code ?? '');
  return (
    <span className="flag-chip" title={name} role="img" aria-label={name}>
      {flag}
    </span>
  );
}
