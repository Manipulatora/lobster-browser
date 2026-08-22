/**
 * The visual identity of one profile: the initials, the short word and the violet tint that the
 * launched browser window's OS icon and the manager's row avatar both carry.
 *
 * WHY A REDUCTION AT ALL. A title-bar icon is 16px and a taskbar icon 32px. That holds one or two
 * glyphs, not a 120-character profile name, so the icon can only ever show a reduction of the name.
 * The full name still goes where there is room for it - the window title, which is also what the
 * taskbar tooltip and the window-list entry read.
 *
 * WHY THE REDUCTION IS DERIVED HERE RATHER THAN IN THE ENGINE. A reduction is only useful if every
 * surface reduces the same way: an app that shows "AS" next to a window that shows "AL" is worse
 * than no icon at all. Splitting a name into words and a word into its first glyph is Unicode work -
 * combining marks, emoji sequences, scripts with no case, an uppercase mapping that is two
 * characters long - so doing it twice, once in TypeScript for the manager and once in C++ for the
 * engine, produces two answers the first time a name is not plain ASCII. The engine therefore
 * derives nothing: it renders the strings it is handed on --lobium-profile-initials /
 * --lobium-profile-word / --lobium-profile-tint, and falls back to the stock Chromium icon when they
 * are absent.
 *
 * THIS FILE EXISTS TWICE, BYTE FOR BYTE: packages/engine-runner/src/runners/profile-mark.ts and
 * apps/desktop/src/ui/profile-mark.ts. The manager is a browser bundle that does not depend on the
 * sidecar, so there is no module both can import. profile-mark.test.ts compares the two files and
 * fails if they drift, which is what keeps "one rule" true rather than aspirational.
 */

/**
 * The brand violet ramp, --brand-500 .. --brand-800 from apps/desktop/src/ui/tokens.css.
 *
 * Only the four dark stops: the mark carries white text, and --brand-400 and lighter do not reach a
 * readable contrast against it. Every stop is unmistakably the product violet, so the SHADE is a
 * secondary cue and the letters carry the identity - which is the right way round at 16px, where two
 * violets one ramp step apart are not tellable but two letters are.
 */
const BRAND_TINTS = ['#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95'] as const;

/** Whitespace and the separators people actually type inside a profile name ("acme-us", "qa_02"). */
const WORD_BOUNDARY = /[\s_\-/\\|]+/u;

/** A word starts the initials only if it starts with something a reader would read as a letter. */
const STARTS_WITH_LETTER_OR_DIGIT = /^[\p{L}\p{N}]/u;

/**
 * How much of the NAME the large icon carries.
 *
 * This used to be the first word only, so "Acme US East" marked as "Acme" and the icon could not be
 * told apart from "Acme US West". The engine wraps the label over two lines and shrinks it to fit,
 * so the whole name is worth sending; the cut exists only so a pathological 200-character name
 * cannot shrink the type to noise. Spaces are PRESERVED - they are where the engine may break.
 */
const MAX_LABEL_GRAPHEMES = 24;

/**
 * Grapheme clusters, not code units: `[...'👩‍🚀'][0]` is half an emoji sequence and `'ñ'[0]` is a bare
 * `n` when the name arrived decomposed. Pinned to one locale so the split cannot vary with the
 * host's language settings.
 */
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** The visual identity of one profile, in the three pieces every surface needs. */
export interface ProfileMark {
  /** One or two glyphs. Empty when the name has no glyphs at all, in which case there is no mark. */
  initials: string;
  /**
   * The profile NAME, cut to {@link MAX_LABEL_GRAPHEMES}, spaces intact so the renderer can wrap it.
   * Drawn on the larger icon slots; the small ones fall back to {@link ProfileMark.initials}.
   */
  word: string;
  /** A `#rrggbb` stop on the brand violet ramp, stable for the lifetime of the profile. */
  tint: string;
}

function graphemes(value: string): string[] {
  return [...GRAPHEMES.segment(value)].map((part) => part.segment);
}

function firstGrapheme(value: string): string {
  return graphemes(value)[0] ?? '';
}

/**
 * The uppercase first glyph of a word.
 *
 * Clamped back to one grapheme after the case mapping because uppercasing can LENGTHEN a string -
 * 'ß' becomes 'SS' - and a two-word name whose first word starts with one of those would otherwise
 * render three characters into a box sized for two.
 */
function initialOf(word: string): string {
  const glyph = firstGrapheme(word);
  return firstGrapheme(glyph.toUpperCase()) || glyph;
}

/** FNV-1a, 32-bit. Small, dependency-free, and stable across runtimes - all this needs of a hash. */
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Derive one profile's mark from its name and id.
 *
 * Two words give two initials ("Acme US" -> "AU"); a single word gives ONE ("Alice" -> "A"), because
 * a single glyph is what stays legible at 16px and a second letter of the same word adds no
 * information a reader would use. Words that do not start with a letter or a digit are skipped when
 * choosing which words to read, so "* Rocket" marks as "R" rather than as an asterisk, but a name
 * made only of such words still gets its first glyph rather than nothing.
 *
 * The tint comes from the profile ID, not the name, so renaming a profile does not recolour it.
 */
export function profileMark(name: string, profileId: string): ProfileMark {
  const words = name.normalize('NFC').trim().split(WORD_BOUNDARY).filter(Boolean);
  const readable = words.filter((word) => STARTS_WITH_LETTER_OR_DIGIT.test(word));
  const source = readable.length > 0 ? readable : words;
  const first = source[0] ?? '';
  const second = source[1] ?? '';
  return {
    initials: first === '' ? '' : initialOf(first) + (second === '' ? '' : initialOf(second)),
    // The whole name, not just its first word: at icon sizes that fit text, "Acme US East" and
    // "Acme US West" must not both render as "Acme".
    word: graphemes(words.join(' ')).slice(0, MAX_LABEL_GRAPHEMES).join('').trim(),
    tint: BRAND_TINTS.at(fnv1a32(profileId) % BRAND_TINTS.length) ?? BRAND_TINTS[0],
  };
}
