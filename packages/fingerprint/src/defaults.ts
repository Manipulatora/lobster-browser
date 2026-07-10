/**
 * Default font-selection strategy for the Create Profile Fingerprint tab.
 *
 * Research notes (2026-07):
 * - Windows 10/11 English installs expose ~300–500 families via the MS Learn lists we
 *   already verify (`WINDOWS_FONT_NAMES`, 506). A typical consumer Win11 desktop reports
 *   ~400–450 families to font fingerprint scripts (core Latin + CJK + emoji + a slice of
 *   optional language packs). Target default size: **435**.
 * - macOS Support pages list many face/version rows (`MACOS_FONT_NAMES`, 2565). Real
 *   Chrome `document.fonts` enumerations are closer to family names; we collapse version
 *   suffixes and prefer system UI / Apple / common Latin families, then fill to **435**.
 * - Linux verified Ubuntu package families (`LINUX_FONT_NAMES`, 314) are already below
 *   435, so the default is the **full** verified set (honest ceiling for that catalog).
 *
 * Defaults are always a subset of the verified catalogs — never invented names.
 */
import {
  LINUX_FONT_NAMES,
  MACOS_FONT_NAMES,
  WINDOWS_FONT_NAMES,
  type AndroidDeviceCatalogEntry,
} from './catalog.generated.js';

export const DEFAULT_FONT_SELECTION_TARGET = 435;

/** Core Win11-ish families that should always be in the Windows default set when present. */
const WINDOWS_PRIORITY_FONTS = [
  'Segoe UI',
  'Segoe UI Symbol',
  'Segoe UI Emoji',
  'Segoe UI Historic',
  'Arial',
  'Arial Black',
  'Calibri',
  'Cambria',
  'Cambria Math',
  'Candara',
  'Comic Sans MS',
  'Consolas',
  'Constantia',
  'Corbel',
  'Courier New',
  'Georgia',
  'Impact',
  'Lucida Console',
  'Lucida Sans Unicode',
  'Microsoft Sans Serif',
  'Palatino Linotype',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
  'Wingdings',
  'Wingdings 2',
  'Wingdings 3',
  'Symbol',
  'Webdings',
  'MS Gothic',
  'MS PGothic',
  'MS UI Gothic',
  'Yu Gothic',
  'Yu Gothic UI',
  'Malgun Gothic',
  'Microsoft YaHei',
  'Microsoft YaHei UI',
  'SimSun',
  'NSimSun',
  'Nirmala UI',
  'Gabriola',
  'Ink Free',
  'Javanese Text',
  'Leelawadee UI',
  'Myanmar Text',
  'Sitka Text',
  'Bahnschrift',
  'HoloLens MDL2 Assets',
  'Cascadia Code',
  'Cascadia Mono',
  'Ebrima',
  'Franklin Gothic Medium',
  'Gadugi',
  'Microsoft Himalaya',
  'Microsoft JhengHei',
  'Microsoft New Tai Lue',
  'Microsoft PhagsPa',
  'Microsoft Tai Le',
  'Microsoft Yi Baiti',
  'Mongolian Baiti',
  'MV Boli',
  'Myanmar Text',
  'Nirmala UI',
  'Segoe MDL2 Assets',
  'Segoe Print',
  'Segoe Script',
] as const;

/** Prefer these macOS family stems when collapsing Apple Support versioned rows. */
const MACOS_PRIORITY_STEMS = [
  'Helvetica',
  'Helvetica Neue',
  'SF Pro',
  'SF Compact',
  'SF Mono',
  'SF Arabic',
  'Menlo',
  'Monaco',
  'Geneva',
  'Arial',
  'Times',
  'Times New Roman',
  'Courier',
  'Courier New',
  'Avenir',
  'Avenir Next',
  'Optima',
  'Palatino',
  'Gill Sans',
  'Futura',
  'Baskerville',
  'Didot',
  'American Typewriter',
  'Apple Color Emoji',
  'Apple Symbols',
  'PingFang SC',
  'PingFang TC',
  'PingFang HK',
  'Hiragino Sans',
  'Hiragino Mincho ProN',
  'Apple SD Gothic Neo',
  'Thonburi',
  'Geeza Pro',
  'Kohinoor Devanagari',
  'Noto Sans',
  'Noto Serif',
] as const;

function uniquePreserveOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Strip trailing Apple Support version tokens like `13.0d2e27` from family labels. */
export function normalizeMacFontFamily(name: string): string {
  return name
    .replace(/\s+\d+(?:\.\d+)*d\d+e\d+\s*$/i, '')
    .replace(/\s+\d+(?:\.\d+){1,3}\s*$/i, '')
    .trim();
}

function fillToTarget(
  priority: readonly string[],
  catalog: readonly string[],
  target: number,
): string[] {
  const available = new Set(catalog);
  const selected = uniquePreserveOrder(priority.filter((font) => available.has(font)));
  if (selected.length >= target) return selected.slice(0, target);
  for (const font of catalog) {
    if (selected.length >= target) break;
    if (!selected.includes(font)) selected.push(font);
  }
  return selected;
}

export function defaultWindowsFonts(
  catalog: readonly string[] = WINDOWS_FONT_NAMES,
  target = DEFAULT_FONT_SELECTION_TARGET,
): string[] {
  return fillToTarget(WINDOWS_PRIORITY_FONTS, catalog, Math.min(target, catalog.length));
}

export function defaultMacosFonts(
  catalog: readonly string[] = MACOS_FONT_NAMES,
  target = DEFAULT_FONT_SELECTION_TARGET,
): string[] {
  const collapsed = uniquePreserveOrder(catalog.map(normalizeMacFontFamily));
  const priority = MACOS_PRIORITY_STEMS.filter((stem) =>
    collapsed.some((font) => font === stem || font.startsWith(`${stem} `)),
  ).flatMap((stem) => collapsed.filter((font) => font === stem || font.startsWith(`${stem} `)));
  return fillToTarget(priority, collapsed, Math.min(target, collapsed.length));
}

export function defaultLinuxFonts(
  catalog: readonly string[] = LINUX_FONT_NAMES,
  target = DEFAULT_FONT_SELECTION_TARGET,
): string[] {
  // Verified Ubuntu package set is the honest ceiling (<435 today).
  return catalog.slice(0, Math.min(target, catalog.length));
}

export type DesktopFontOs = 'windows' | 'macos' | 'linux';

export function defaultFontsForOs(
  os: DesktopFontOs,
  target = DEFAULT_FONT_SELECTION_TARGET,
): string[] {
  if (os === 'macos') return defaultMacosFonts(undefined, target);
  if (os === 'linux') return defaultLinuxFonts(undefined, target);
  return defaultWindowsFonts(undefined, target);
}

/**
 * Play `supported_devices.csv` has no API level column. Filter by publicly known generation
 * heuristics so Android 15+ profiles prefer modern flagships while older majors stay broad.
 * Unknown / unmatched labels remain available for Android ≤14 (and for 15+ when the catalog
 * would otherwise be too thin).
 */
export function androidMajorFromOsVersionLabel(osVersion: string): number | undefined {
  const match = /\b(\d{2})\b/.exec(osVersion);
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isInteger(major) && major >= 10 ? major : undefined;
}

function androidGenerationScore(label: string): number {
  const text = label.toLowerCase();
  if (/galaxy s2[4-9]|galaxy z fold[6-9]|galaxy z flip[6-9]|pixel (8|9|10)\b|xiaomi 1[4-5]|oneplus 1[2-5]/i.test(text)) {
    return 16;
  }
  if (/galaxy s2[2-3]|galaxy z fold[4-5]|galaxy z flip[4-5]|pixel [67]\b|xiaomi 1[2-3]|oneplus 1[01]|nothing phone/i.test(text)) {
    return 14;
  }
  if (/galaxy s21|galaxy note20|pixel 5|xiaomi 11|oneplus 9|rog phone [56]/i.test(text)) {
    return 12;
  }
  if (/galaxy s20|galaxy note10|pixel [34]|xiaomi 10|oneplus [78]/i.test(text)) {
    return 11;
  }
  if (/galaxy s1[0-9]|pixel [12]|xiaomi [89]|oneplus [56]/i.test(text)) {
    return 10;
  }
  // Tablets / midrange without a clear generation — treat as broadly Android 13-capable.
  if (/galaxy tab s[89]|galaxy tab a9|pixel tablet|xiaomi pad [67]|oneplus pad|matepad/i.test(text)) {
    return 13;
  }
  return 0;
}

export function filterAndroidCatalogByOsVersion(
  catalog: ReadonlyArray<AndroidDeviceCatalogEntry>,
  osVersion: string,
): AndroidDeviceCatalogEntry[] {
  const major = androidMajorFromOsVersionLabel(osVersion);
  if (major === undefined || major <= 13) return [...catalog];

  const minScore = major >= 16 ? 14 : major >= 15 ? 12 : 11;
  const filtered = catalog.filter((entry) => {
    const score = androidGenerationScore(entry.label);
    return score === 0 || score >= minScore;
  });
  // Never starve the picker — fall back to the full catalog if the heuristic is too aggressive.
  return filtered.length >= 80 ? filtered : [...catalog];
}
