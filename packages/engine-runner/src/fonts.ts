import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { OsFamily } from '@lobster/shared-types';

export type FontPersona = OsFamily | 'android';

/**
 * Font fingerprint control (ENG-6) — a PACKAGING surface, not a Blink hook. On Linux, Chromium resolves
 * every font-facing surface (CSS width-probe enumeration, `queryLocalFonts()`, `@font-face src:local()`,
 * `measureText` glyph metrics) through the browser process's fontconfig. Point `FONTCONFIG_FILE` at a
 * PRIVATE config that exposes ONLY a bundled, metric-compatible font set (and NOT `/etc/fonts`) and the
 * whole surface collapses to a deterministic, OS-plausible set — stable per profile, host fonts invisible.
 *
 * This module writes that private config into the profile's user-data-dir at launch (absolute paths
 * baked in) and returns its path; the launcher sets `FONTCONFIG_FILE` to it. The bundled faces live under
 * `<fontsBaseDir>/files/` (see repo `lobium/fonts/`); `fontsBaseDir` is resolved by the launcher.
 */

const FONTCONFIG_FILENAME = 'lobium-fonts.conf';
const FONT_PROVISION_CACHE_FILENAME = '.lobium-fonts-ready';
// Bump whenever buildFontConfig semantics change so existing profiles cannot keep a stale XML file
// merely because their selected font binaries are unchanged.
const FONT_CONFIG_SCHEMA_VERSION = 2;
export const FONT_PACK_MANIFEST_FILENAME = 'font-pack.manifest.json';
const verifiedPackFiles = new Set<string>();

export interface FontPackFile {
  path: string;
  sha256: string;
  families: string[];
  license: string;
}

export interface FontPackManifest {
  version: 1;
  packId: string;
  files: FontPackFile[];
  personas: Record<FontPersona, { families: string[]; physicalFamilies?: string[] }>;
}

interface PersonaFontSelection {
  physicalFamilies: string[];
  files: FontPackFile[];
}

const GENERIC_PREFERENCES: Record<
  FontPersona,
  { sans: string[]; serif: string[]; mono: string[] }
> = {
  windows: {
    // CSS generics on Windows conventionally resolve to Arial/Times New Roman. Liberation is the
    // bundled metric-compatible substitute; Carlito/Caladea target Calibri/Cambria and made ordinary
    // web text look noticeably different from a stock browser.
    sans: ['Liberation Sans', 'Carlito', 'Noto Sans', 'DejaVu Sans'],
    serif: ['Liberation Serif', 'Caladea', 'Noto Serif', 'DejaVu Serif'],
    mono: ['Liberation Mono', 'Noto Sans Mono', 'DejaVu Sans Mono'],
  },
  macos: {
    sans: ['Liberation Sans', 'Carlito', 'Noto Sans', 'DejaVu Sans'],
    serif: ['Liberation Serif', 'Caladea', 'Noto Serif', 'DejaVu Serif'],
    mono: ['Liberation Mono', 'Noto Sans Mono', 'DejaVu Sans Mono'],
  },
  linux: {
    sans: ['Ubuntu Sans', 'Ubuntu', 'Liberation Sans', 'Noto Sans', 'DejaVu Sans', 'Carlito'],
    serif: ['Liberation Serif', 'Noto Serif', 'DejaVu Serif', 'Caladea'],
    mono: ['Ubuntu Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono'],
  },
  android: {
    sans: ['Roboto', 'Noto Sans', 'Roboto Condensed', 'DejaVu Sans'],
    serif: ['Noto Serif', 'FreeSerif', 'DejaVu Serif'],
    mono: ['Noto Sans Mono', 'Roboto Mono', 'DejaVu Sans Mono'],
  },
};

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function preferredFamily(
  os: FontPersona,
  kind: 'sans' | 'serif' | 'mono',
  selected: readonly string[],
): string {
  return (
    GENERIC_PREFERENCES[os][kind].find((family) => selected.includes(family)) ?? selected[0] ?? ''
  );
}

/** Canonical native fallback priority: readable sans first, then serif/mono, then coverage. */
export function orderFontFallbackFamilies(
  os: FontPersona,
  physicalFamilies: readonly string[],
): string[] {
  return [
    preferredFamily(os, 'sans', physicalFamilies),
    preferredFamily(os, 'serif', physicalFamilies),
    preferredFamily(os, 'mono', physicalFamilies),
    ...physicalFamilies,
  ].filter((family, index, all) => family && all.indexOf(family) === index);
}

/**
 * Families the pack can imitate at the level a fingerprinting probe actually measures.
 *
 * A font probe compares ADVANCE WIDTHS, so "same class" is not the bar — metric compatibility is.
 * Liberation Sans/Serif/Mono are exact metric clones of Arial/Times New Roman/Courier New, and the
 * pack also carries Carlito and Caladea, which are exact clones of Calibri and Cambria. Those two
 * were shipped and then never used: the class heuristic sent Calibri to Liberation Sans and Cambria
 * to Liberation Serif, so a persona claiming Calibri measured as Arial — an inconsistency any width
 * probe reads directly, on a font every Windows install has.
 *
 * Everything not listed here still falls back to its class face, which is a real and measurable tell:
 * ~358 of a Windows persona's 435 claimed families land on Liberation Sans and so share one advance-
 * width vector. Reporting them absent instead would leave a Windows persona exposing a few dozen
 * families where a real install exposes hundreds, which is no better. Closing it needs more
 * metric-compatible faces in the pack, not another rule here. Recorded in docs/ENGINEERING.md §2.
 */
const METRIC_CLONES: Record<string, string> = {
  Arial: 'Liberation Sans',
  Helvetica: 'Liberation Sans',
  'Arial Narrow': 'Liberation Sans Narrow',
  'Times New Roman': 'Liberation Serif',
  Times: 'Liberation Serif',
  'Courier New': 'Liberation Mono',
  Courier: 'Liberation Mono',
  Calibri: 'Carlito',
  Cambria: 'Caladea',
};

/** The metric clone for `name` when the pack physically carries it. */
function metricClone(name: string, physicalFamilies: readonly string[]): string | undefined {
  const clone = METRIC_CLONES[name];
  return clone && physicalFamilies.includes(clone) ? clone : undefined;
}

/**
 * Classify an arbitrary font-family name into a serif/sans/mono bucket by its name, so a claimed
 * family with no bundled face still resolves to a metric-class-appropriate open face.
 */
function familyClass(name: string): 'sans' | 'serif' | 'mono' {
  if (/(mono|courier|consol|typewriter|terminal|\bcode\b|fixed)/i.test(name)) return 'mono';
  if (
    /(serif|times|georgia|roman|garamond|cambria|palatino|book antiqua|minion|century|ming|song|batang|sung|mincho)/i.test(
      name,
    )
  ) {
    return 'serif';
  }
  return 'sans';
}

export interface FontAliasPlan {
  aliases: Record<string, string>;
  /** Claimed names backed by a pack face with documented metric compatibility. */
  metricCompatible: string[];
  /** Claimed names backed only by a serif/sans/mono approximation. */
  classFallback: string[];
}

const RESERVED_FONT_ALIAS_NAMES = new Set([
  'sans-serif',
  'system-ui',
  'ui-sans-serif',
  '-apple-system',
  'BlinkMacSystemFont',
  'serif',
  'ui-serif',
  'monospace',
  'ui-monospace',
  'emoji',
  'math',
  'cursive',
  'fantasy',
]);

/**
 * Build the one canonical claimed-family -> physical-family plan used by Linux fontconfig and the
 * Windows FontDataService CSS path. This does not fabricate Local Font Access or PostScript names.
 */
export function planFontAliases(
  os: FontPersona,
  physicalFamilies: readonly string[],
  claimedFamilies: readonly string[],
): FontAliasPlan {
  const preferByClass: Record<'sans' | 'serif' | 'mono', string> = {
    sans: preferredFamily(os, 'sans', physicalFamilies),
    serif: preferredFamily(os, 'serif', physicalFamilies),
    mono: preferredFamily(os, 'mono', physicalFamilies),
  };
  const physical = new Set(physicalFamilies);
  const aliases: Record<string, string> = {};
  const metricCompatible: string[] = [];
  const classFallback: string[] = [];
  for (const family of [...new Set(claimedFamilies)].sort((a, b) => a.localeCompare(b, 'en'))) {
    if (physical.has(family) || RESERVED_FONT_ALIAS_NAMES.has(family)) continue;
    const clone = metricClone(family, physicalFamilies);
    const target = clone ?? preferByClass[familyClass(family)];
    if (!target) continue;
    aliases[family] = target;
    (clone ? metricCompatible : classFallback).push(family);
  }
  return { aliases, metricCompatible, classFallback };
}

/**
 * A Noto CJK collection contains several region-specific faces in the same physical file. The normal
 * distro rules selecting those faces are intentionally not inherited by the private config, so repeat
 * the small language-sensitive part here. Otherwise every Chinese/Korean locale resolves to the JP
 * face merely because it is the first face in the collection.
 */
function cjkLanguageRules(physicalFamilies: readonly string[]): string {
  if (!physicalFamilies.includes('Noto Sans CJK JP')) return '';
  const locales = [
    ['ja', 'JP'],
    ['ko', 'KR'],
    ['zh-cn', 'SC'],
    ['zh-sg', 'SC'],
    ['zh-tw', 'TC'],
    ['zh-hk', 'HK'],
    ['zh-mo', 'HK'],
  ] as const;
  const generics = [
    ['sans-serif', 'Noto Sans CJK'],
    ['serif', 'Noto Serif CJK'],
    ['monospace', 'Noto Sans Mono CJK'],
  ] as const;
  return locales
    .flatMap(([lang, region]) =>
      generics.map(
        ([generic, family]) => `  <match target="pattern">
    <test name="lang"><string>${lang}</string></test>
    <test qual="any" name="family"><string>${generic}</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>${family} ${region}</string></edit>
  </match>`,
      ),
    )
    .join('\n');
}

/**
 * Build the private fontconfig XML.
 *
 * The bundled open pack (`physicalFamilies`) is the ONLY physical source. On top of that we alias
 * every family the persona CLAIMS but the pack does not physically carry onto its metric clone where
 * one exists and onto the bundled face of the same serif/sans/mono class otherwise, so a CSS
 * width-probe / `src:local()` request for e.g. `Arial` or `Segoe UI` resolves instead of falling back
 * to an arbitrary default. Only the clones match real advance widths; the class fallback does not,
 * and that gap is documented in docs/ENGINEERING.md §2. This never adds physical faces (so `queryLocalFonts()` still enumerates only the pack —
 * full enumeration fidelity needs licensed bundles + a native hook), and it never fails the launch.
 */
export function buildFontConfig(
  os: FontPersona,
  fontDir: string,
  cacheDir: string,
  physicalFamilies: readonly string[],
  claimedFamilies: readonly string[] = [],
): string {
  const alias = (family: string, prefer: string): string =>
    `  <alias><family>${xmlEscape(family)}</family><prefer><family>${xmlEscape(prefer)}</family></prefer></alias>`;
  const strongPreference = (family: string, prefer: string): string => `  <match target="pattern">
    <test qual="any" name="family"><string>${xmlEscape(family)}</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>${xmlEscape(prefer)}</string></edit>
  </match>`;
  const preferByClass: Record<'sans' | 'serif' | 'mono', string> = {
    sans: preferredFamily(os, 'sans', physicalFamilies),
    serif: preferredFamily(os, 'serif', physicalFamilies),
    mono: preferredFamily(os, 'mono', physicalFamilies),
  };
  const emoji = physicalFamilies.includes('Noto Color Emoji')
    ? 'Noto Color Emoji'
    : preferByClass.sans;
  const math = physicalFamilies.includes('Noto Sans Math') ? 'Noto Sans Math' : preferByClass.serif;
  // Every CSS generic and system-UI keyword is bound to its class-appropriate bundled face with a
  // STRONG preference (not just a weak <alias><prefer>). This is essential, not cosmetic: because the
  // substitutes are all named "Liberation <X>", a weak alias for `sans-serif` partial-matches all three
  // Liberation faces equally and fontconfig's tie-break then picks whichever file sorts first — which is
  // Liberation *Mono*. That silently renders default body text (and any unmapped family such as
  // `Helvetica`) in a monospace face: the "awkward/ugly/unfamiliar fonts" symptom. A strong prepend
  // binds deterministically and beats the tie. The weak <alias> is kept alongside for enumeration
  // semantics (queryLocalFonts / generic <default> chains).
  const genericToFace: ReadonlyArray<readonly [string, string]> = [
    ['sans-serif', preferByClass.sans],
    ['system-ui', preferByClass.sans],
    ['ui-sans-serif', preferByClass.sans],
    ['-apple-system', preferByClass.sans],
    ['BlinkMacSystemFont', preferByClass.sans],
    ['serif', preferByClass.serif],
    ['ui-serif', preferByClass.serif],
    ['monospace', preferByClass.mono],
    ['ui-monospace', preferByClass.mono],
    // The open pack has no persona-correct ornamental/script family. A readable same-persona sans
    // fallback is preferable to fontconfig selecting an arbitrary file by directory order.
    ['cursive', preferByClass.sans],
    ['fantasy', preferByClass.sans],
  ];
  const lines: string[] = [
    ...genericToFace.flatMap(([generic, face]) => [
      alias(generic, face),
      strongPreference(generic, face),
    ]),
    alias('emoji', emoji),
    alias('math', math),
    // Fontconfig's <alias><prefer> values are weak bindings. For these two character-class
    // generics, a broad DejaVu face would otherwise beat the purpose-built color/math font.
    strongPreference('emoji', emoji),
    strongPreference('math', math),
  ];
  if (os !== 'linux') {
    // Chromium's Linux port resolves CSS `system-ui` from the host desktop setting before the page's
    // OS persona is considered (this VPS resolves it as DejaVu Sans). Intercept the common Linux UI
    // names with strong bindings so a Windows/macOS/Android profile does not visibly inherit the
    // build host's desktop typography.
    lines.push(
      strongPreference('DejaVu Sans', preferByClass.sans),
      strongPreference('DejaVu Serif', preferByClass.serif),
      strongPreference('DejaVu Sans Mono', preferByClass.mono),
      strongPreference('Ubuntu', preferByClass.sans),
      strongPreference('Ubuntu Sans', preferByClass.sans),
      strongPreference('Ubuntu Mono', preferByClass.mono),
      strongPreference('Cantarell', preferByClass.sans),
    );
  }
  // Alias claimed-but-not-physical families onto the class-appropriate bundled face.
  const plan = planFontAliases(os, physicalFamilies, claimedFamilies);
  for (const [family, target] of Object.entries(plan.aliases)) {
    lines.push(alias(family, target));
  }
  const cjkRules = cjkLanguageRules(physicalFamilies);
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <!-- Reset inherited sources. The open-font pack below is the sole physical source. -->
  <reset-dirs />
  <dir>${xmlEscape(fontDir)}</dir>
  <cachedir>${xmlEscape(cacheDir)}</cachedir>
${lines.join('\n')}
${cjkRules}
  <!-- Universal last-resort. Any family with no explicit rule above (an arbitrary web-declared name,
       or a persona family the pack cannot physically carry) would otherwise resolve to whichever pack
       file sorts first on disk — Liberation Mono — rendering ordinary text monospaced. Append the
       persona sans face as a weak final fallback so unmapped requests degrade to readable sans, while
       every strong prepend above (mono/serif/emoji/CJK) still wins for its own request. -->
  <match target="pattern">
    <edit name="family" mode="append_last" binding="weak"><string>${xmlEscape(preferByClass.sans)}</string></edit>
  </match>
  <!-- The private config deliberately excludes the host font configuration, so carry deterministic
       raster defaults here. Without these, fontconfig reports no antialias/subpixel policy and full
       hinting; unhinted Roboto in particular looks heavy and jagged at normal website sizes.
       Grayscale antialiasing (rgba=none) is used deliberately instead of subpixel/LCD: subpixel
       rendering assumes a physical RGB-stripe panel, but Lobium runs on a virtual X framebuffer
       (Xvfb) and is frequently viewed over VNC/RDP/screenshots, where subpixel positioning shows up
       as ugly colored fringing on glyph edges. Grayscale is crisp and identical across every display
       pipeline, and it keeps canvas text rasterization deterministic across host display hardware. -->
  <match target="font">
    <edit name="antialias" mode="assign"><bool>true</bool></edit>
    <edit name="hinting" mode="assign"><bool>true</bool></edit>
    <edit name="hintstyle" mode="assign"><const>hintslight</const></edit>
    <edit name="rgba" mode="assign"><const>none</const></edit>
    <edit name="lcdfilter" mode="assign"><const>none</const></edit>
  </match>
  <config></config>
</fontconfig>
`;
}

function safePackPath(base: string, path: string): string {
  const segments = path.split('/');
  if (
    !path ||
    isAbsolute(path) ||
    /[\\\x00-\x1f<>:"|?*]/.test(path) ||
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment),
    )
  ) {
    throw new Error(`font pack manifest contains unsafe path "${path}"`);
  }
  const root = resolve(base);
  const absolute = resolve(root, normalize(path));
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`font pack manifest path escapes pack root: "${path}"`);
  }
  return absolute;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
  return [...new Set(value)].sort((a, b) => a.localeCompare(b, 'en'));
}

/** Read and structurally validate the deterministic build-time font manifest. */
export async function loadFontPackManifest(fontsBaseDir: string): Promise<FontPackManifest> {
  const manifestPath = join(fontsBaseDir, FONT_PACK_MANIFEST_FILENAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `required Lobium font pack is absent or unreadable at ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid Lobium font pack manifest at ${manifestPath}`);
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.packId !== 'string' || !Array.isArray(raw.files)) {
    throw new Error(`unsupported Lobium font pack manifest at ${manifestPath}`);
  }
  const files: FontPackFile[] = raw.files.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`invalid font pack file entry ${index}`);
    }
    const item = value as Record<string, unknown>;
    const families = asStringArray(item.families);
    if (
      typeof item.path !== 'string' ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      typeof item.license !== 'string' ||
      !families?.length
    ) {
      throw new Error(`invalid font pack file entry ${index}`);
    }
    safePackPath(fontsBaseDir, item.path);
    return { path: item.path, sha256: item.sha256, families, license: item.license };
  });
  const rawPersonas = raw.personas;
  if (!rawPersonas || typeof rawPersonas !== 'object' || Array.isArray(rawPersonas)) {
    throw new Error(`font pack manifest has no personas`);
  }
  const personas = {} as FontPackManifest['personas'];
  for (const os of ['windows', 'macos', 'linux', 'android'] as const) {
    const rawPersona = (rawPersonas as Record<string, unknown>)[os];
    const families =
      rawPersona && typeof rawPersona === 'object' && !Array.isArray(rawPersona)
        ? asStringArray((rawPersona as Record<string, unknown>).families)
        : undefined;
    if (!families?.length) throw new Error(`font pack manifest has no ${os} families`);
    const physicalFamilies = asStringArray(
      (rawPersona as Record<string, unknown>).physicalFamilies,
    );
    personas[os] = { families, ...(physicalFamilies?.length ? { physicalFamilies } : {}) };
  }
  return { version: 1, packId: raw.packId, files, personas };
}

// Exactly the extensions the deterministic provisioner admits.
const WINDOWS_FONT_EXTENSIONS = new Set(['.ttf', '.ttc', '.otf']);

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

/**
 * Verify the exact font-file ledger before Windows passes a pack directory to native DirectWrite.
 *
 * The native loader intentionally scans `<pack>/files` recursively so nested provisioner layouts
 * work, but that means manifest existence alone is not an integrity boundary: a replaced file or an
 * extra font file would otherwise be registered too. This check hashes every declared file, rejects
 * links, and requires the discovered font-file set to equal the manifest set.
 */
export async function verifyFontPackFiles(fontsBaseDir: string): Promise<FontPackManifest> {
  const root = resolve(fontsBaseDir);
  const filesRoot = join(root, 'files');
  const [rootStat, filesRootStat, manifestStat] = await Promise.all([
    lstat(root),
    lstat(filesRoot),
    lstat(join(root, FONT_PACK_MANIFEST_FILENAME)),
  ]);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`font pack root is not an ordinary directory: ${root}`);
  }
  if (!filesRootStat.isDirectory() || filesRootStat.isSymbolicLink()) {
    throw new Error(`font pack files root is not an ordinary directory: ${filesRoot}`);
  }
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`font pack manifest is not an ordinary file: ${root}`);
  }

  const manifest = await loadFontPackManifest(root);
  if (!manifest.files.length) {
    throw new Error(`font pack ${manifest.packId} declares no files`);
  }

  const declared = new Set<string>();
  for (const file of manifest.files) {
    const absolute = safePackPath(root, file.path);
    const canonical = portableRelative(root, absolute);
    if (
      !canonical.startsWith('files/') ||
      !WINDOWS_FONT_EXTENSIONS.has(extname(canonical).toLowerCase())
    ) {
      throw new Error(`font pack manifest declares a non-font files path: ${file.path}`);
    }
    if (declared.has(canonical)) {
      throw new Error(`font pack manifest declares a duplicate path: ${file.path}`);
    }
    declared.add(canonical);

    let fileStat;
    try {
      fileStat = await lstat(absolute);
    } catch {
      throw new Error(`required font pack file is absent: ${absolute}`);
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(`required font pack path is not an ordinary file: ${absolute}`);
    }
    const sha256 = createHash('sha256')
      .update(await readFile(absolute))
      .digest('hex');
    if (sha256 !== file.sha256) {
      throw new Error(`font pack file failed SHA-256 verification: ${absolute}`);
    }
  }

  const discovered = new Set<string>();
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const entryStat = await lstat(absolute);
      if (entryStat.isSymbolicLink()) {
        throw new Error(`font pack files tree contains a link: ${absolute}`);
      }
      if (entryStat.isDirectory()) {
        await visit(absolute);
      } else if (
        entryStat.isFile() &&
        WINDOWS_FONT_EXTENSIONS.has(extname(entry.name).toLowerCase())
      ) {
        discovered.add(portableRelative(root, absolute));
      }
    }
  };
  await visit(filesRoot);

  const undeclared = [...discovered].filter((path) => !declared.has(path)).sort();
  const undiscovered = [...declared].filter((path) => !discovered.has(path)).sort();
  if (undeclared.length || undiscovered.length) {
    throw new Error(
      `font pack file ledger mismatch (undeclared: ${undeclared.join(', ') || 'none'}; ` +
        `missing: ${undiscovered.join(', ') || 'none'})`,
    );
  }
  return manifest;
}

/** Families physically represented by files in this provisioned pack for the requested persona. */
export async function availableFontFamilies(
  fontsBaseDir: string,
  os: FontPersona,
): Promise<string[]> {
  const manifest = await loadFontPackManifest(fontsBaseDir);
  return selectPersonaFontFiles(manifest, os).physicalFamilies;
}

function selectPersonaFontFiles(manifest: FontPackManifest, os: FontPersona): PersonaFontSelection {
  const physical = new Set(manifest.files.flatMap((file) => file.families));
  const allowlist = manifest.personas[os].physicalFamilies ?? manifest.personas[os].families;
  const physicalFamilies = orderFontFallbackFamilies(
    os,
    allowlist.filter((family) => physical.has(family)),
  );
  const selected = new Set(physicalFamilies);
  const files = manifest.files.filter((file) =>
    file.families.some((family) => selected.has(family)),
  );
  for (const file of files) {
    const outsidePersona = file.families.filter((family) => !selected.has(family));
    if (outsidePersona.length) {
      throw new Error(
        `font pack file ${file.path} exposes families outside the ${os} persona: ${outsidePersona.join(', ')}`,
      );
    }
  }
  const familyRank = new Map(physicalFamilies.map((family, index) => [family, index]));
  const manifestRank = new Map(manifest.files.map((file, index) => [file.path, index]));
  files.sort((a, b) => {
    const rank = (file: FontPackFile): number =>
      Math.min(...file.families.map((family) => familyRank.get(family) ?? Number.MAX_SAFE_INTEGER));
    return rank(a) - rank(b) || manifestRank.get(a.path)! - manifestRank.get(b.path)!;
  });
  return { physicalFamilies, files };
}

const NATIVE_FONT_PACKS_DIRNAME = 'native-font-packs';
// Bumped to 2 when the staged layout was shortened for MAX_PATH (see stagedFontRelativePath). The
// version is inside the content key, so every profile re-stages into a new short directory and no
// existing stage is ever read with the new naming.
const NATIVE_FONT_PACK_STAGE_VERSION = 2;
const NATIVE_FONT_PACK_MARKER = 'font-pack.stage.json';

/**
 * How many hex characters of the content key name the stage directory.
 *
 * 16 rather than the full 64. This is a per-user-data-dir cache key, not a security boundary — the
 * bytes are verified face by face against their own sha256 in `verifyStagedNativeFontPack` — so 64
 * bits of collision resistance is ample, and the other 48 characters were pure MAX_PATH cost.
 */
const NATIVE_FONT_PACK_KEY_CHARS = 16;

/**
 * Where one face lands inside the staged pack. SHORT ON PURPOSE.
 *
 * MAX_PATH. Windows still refuses a non-`\\?\` path longer than 260 characters, `LongPathsEnabled`
 * is 0 on a default install, and the engine calls bare `::GetFileAttributes` on these files
 * (`IsUnsafePackPath` in `lobium_fonts.cc`). An over-length face therefore reads back as
 * INVALID_FILE_ATTRIBUTES, `FontPackFaces` clears the WHOLE pack, and an empty pack fails the
 * browser's DirectWrite initialisation — which happens LAZILY, on the first font resolution, well
 * after the CDP endpoint is published. So the product reports the launch successful and the browser
 * dies seconds later.
 *
 * The old layout was `files/<index4>-<sha12>-<basename>`, and pack basenames already carry their own
 * 16-hex content prefix (`379010e87421a883-LiberationSerif-BoldItalic.ttf`, 47 chars). Together with
 * a 64-hex key directory that put 155 characters below the user-data-dir, leaving a budget of 105 —
 * while the real profile path is `…\com.lobster.browser\profiles\prf_<32hex>`, i.e. 91 plus the
 * length of the Windows username. `Administrator` (13) landed on 259, one character inside the
 * limit; any username of 15 characters or more was permanently over it, on every launch of every
 * profile on that machine.
 *
 * The index alone suffices. The engine enumerates `files/`, filters on the extension and SORTS by
 * path — it never parses the name — so a zero-padded index preserves an ordering that the sha and
 * the family name never contributed to anyway. 8 characters instead of 65.
 */
function stagedFontRelativePath(index: number, file: FontPackFile): string {
  const name = basename(file.path);
  const dot = name.lastIndexOf('.');
  // The extension is load-bearing: IsFontFile() in the engine selects on it.
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '.ttf';
  return `files/${String(index).padStart(4, '0')}${ext}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function verifyStagedNativeFontPack(
  root: string,
  key: string,
  files: readonly FontPackFile[],
): Promise<void> {
  const rootStat = await lstat(root);
  const filesRoot = join(root, 'files');
  const filesStat = await lstat(filesRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`native font-pack stage is not an ordinary directory: ${root}`);
  }
  if (!filesStat.isDirectory() || filesStat.isSymbolicLink()) {
    throw new Error(`native font-pack files stage is not an ordinary directory: ${filesRoot}`);
  }
  const marker = JSON.parse(await readFile(join(root, NATIVE_FONT_PACK_MARKER), 'utf8'));
  if (marker?.version !== NATIVE_FONT_PACK_STAGE_VERSION || marker?.key !== key) {
    throw new Error(`native font-pack stage marker does not match its content key: ${root}`);
  }

  const expected = new Map(
    files.map((file, index) => [stagedFontRelativePath(index, file), file.sha256]),
  );
  const discovered = new Set<string>();
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const entryStat = await lstat(absolute);
      if (entryStat.isSymbolicLink()) {
        throw new Error(`native font-pack stage contains a link: ${absolute}`);
      }
      if (entryStat.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entryStat.isFile()) {
        throw new Error(`native font-pack stage contains a non-file entry: ${absolute}`);
      }
      const relativePath = portableRelative(root, absolute);
      discovered.add(relativePath);
      const sha256 = expected.get(relativePath);
      if (!sha256)
        throw new Error(`native font-pack stage contains an undeclared file: ${absolute}`);
      const actual = createHash('sha256')
        .update(await readFile(absolute))
        .digest('hex');
      if (actual !== sha256)
        throw new Error(`native font-pack staged file failed SHA-256: ${absolute}`);
    }
  };
  await visit(filesRoot);
  const missing = [...expected.keys()].filter((path) => !discovered.has(path));
  if (missing.length) {
    throw new Error(`native font-pack stage is missing files: ${missing.join(', ')}`);
  }
}

/**
 * Materialize the exact persona subset the Windows engine may sideload. The source manifest is
 * verified first; a content-keyed immutable stage then prevents pack files for another persona from
 * entering unnamed/default matching or character fallback merely because they share one source pack.
 */
export async function stageNativeFontPack(
  userDataDir: string,
  os: FontPersona,
  fontsBaseDir: string,
): Promise<{ dir: string; physicalFamilies: string[] }> {
  const manifest = await verifyFontPackFiles(fontsBaseDir);
  const selection = selectPersonaFontFiles(manifest, os);
  if (!selection.physicalFamilies.length || !selection.files.length) {
    throw new Error(`font pack ${manifest.packId} exposes no physical ${os} families`);
  }
  const key = createHash('sha256')
    .update(
      JSON.stringify({
        version: NATIVE_FONT_PACK_STAGE_VERSION,
        packId: manifest.packId,
        os,
        physicalFamilies: selection.physicalFamilies,
        files: selection.files.map((file) => [file.path, file.sha256, file.families]),
      }),
    )
    .digest('hex')
    .slice(0, NATIVE_FONT_PACK_KEY_CHARS);
  const stagesRoot = join(userDataDir, NATIVE_FONT_PACKS_DIRNAME);
  const destination = join(stagesRoot, key);
  await mkdir(stagesRoot, { recursive: true, mode: 0o700 });
  if (await pathExists(destination)) {
    await verifyStagedNativeFontPack(destination, key, selection.files);
    return { dir: destination, physicalFamilies: selection.physicalFamilies };
  }

  const temporary = await mkdtemp(join(stagesRoot, `${key}.tmp-`));
  let published = false;
  try {
    await mkdir(join(temporary, 'files'), { recursive: true, mode: 0o700 });
    for (const [index, file] of selection.files.entries()) {
      const source = safePackPath(fontsBaseDir, file.path);
      const target = join(temporary, ...stagedFontRelativePath(index, file).split('/'));
      try {
        await link(source, target);
      } catch {
        await copyFile(source, target);
      }
    }
    await writeFile(
      join(temporary, NATIVE_FONT_PACK_MARKER),
      `${JSON.stringify({ version: NATIVE_FONT_PACK_STAGE_VERSION, key })}\n`,
      { mode: 0o600 },
    );
    await verifyStagedNativeFontPack(temporary, key, selection.files);
    try {
      await rename(temporary, destination);
      published = true;
    } catch (error) {
      if (!(await pathExists(destination))) throw error;
      await verifyStagedNativeFontPack(destination, key, selection.files);
    }
    return { dir: destination, physicalFamilies: selection.physicalFamilies };
  } finally {
    if (!published && (await pathExists(temporary))) {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

/**
 * Validate the pack and write the exact per-profile family allowlist. Missing packs, files, or requested
 * families fail closed: a configured launch can never silently fall back to host `/etc/fonts`.
 */
interface FontProvisionRecord {
  key: string;
  /** Whether the previous provision hard-linked to the pack rather than copying out of it. */
  linked: boolean;
}

/**
 * Reads the readiness stamp. Anything that is not the current JSON shape - including the bare hex
 * key written before this file recorded link state - returns null, so the directory is rebuilt once
 * and stamped in the new form.
 */
function parseProvisionRecord(raw: string): FontProvisionRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { key, linked } = parsed as Record<string, unknown>;
    if (typeof key !== 'string' || typeof linked !== 'boolean') return null;
    return { key, linked };
  } catch {
    return null;
  }
}

/** True only if every provisioned file is still the same inode as the pack file it was linked from. */
async function stillLinkedToPack(
  requiredFiles: readonly FontPackFile[],
  fontsBaseDir: string,
  destinationFor: (index: number, sha256: string) => string,
): Promise<boolean> {
  try {
    for (const [index, file] of requiredFiles.entries()) {
      const [source, destination] = await Promise.all([
        stat(safePackPath(fontsBaseDir, file.path)),
        stat(destinationFor(index, file.sha256)),
      ]);
      if (source.ino !== destination.ino || source.dev !== destination.dev) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function writeFontConfig(
  userDataDir: string,
  os: FontPersona,
  fontsBaseDir: string,
  selectedFamilies: readonly string[],
): Promise<string> {
  const manifest = await loadFontPackManifest(fontsBaseDir);
  // Physical faces: the full bundled open pack for this OS is always shipped, so text renders and a
  // metric-compatible target exists for every alias. The persona's claimed families (`selectedFamilies`)
  // are the JS-visible list — they are aliased onto the pack in buildFontConfig, NOT required to be
  // physically present (they never can be for a real OS persona vs. an open pack).
  const selection = selectPersonaFontFiles(manifest, os);
  const { physicalFamilies } = selection;
  if (physicalFamilies.length === 0) {
    throw new Error(`font pack ${manifest.packId} exposes no families for ${os}`);
  }
  const claimed = [...new Set(selectedFamilies)].sort((a, b) => a.localeCompare(b, 'en'));
  if (claimed.length === 0) {
    throw new Error(`profile carries no font list for ${os}; refusing host-font fallback`);
  }
  const requiredFiles = selection.files;
  if (!requiredFiles.length) throw new Error(`font pack has no files for the ${os} open set`);
  const fontDir = join(userDataDir, 'font-files');
  const cacheDir = join(userDataDir, 'fc-cache');
  const confPath = join(userDataDir, FONTCONFIG_FILENAME);
  const readyPath = join(userDataDir, FONT_PROVISION_CACHE_FILENAME);
  const provisionKey = createHash('sha256')
    .update(
      JSON.stringify({
        configVersion: FONT_CONFIG_SCHEMA_VERSION,
        packId: manifest.packId,
        os,
        claimed,
        files: requiredFiles.map((file) => [file.path, file.sha256]),
      }),
    )
    .digest('hex');
  const destinationFor = (index: number, sha256: string): string =>
    join(fontDir, `${String(index).padStart(4, '0')}-${sha256.slice(0, 12)}`);
  try {
    const [ready, fontDirStat, confStat] = await Promise.all([
      readFile(readyPath, 'utf8'),
      stat(fontDir),
      stat(confPath),
    ]);
    const record = parseProvisionRecord(ready);
    if (record?.key === provisionKey && fontDirStat.isDirectory() && confStat.isFile()) {
      // A matching key is NOT on its own proof that the provision is still cheap. The key is derived
      // from the pack contents, so reinstalling the SAME pack reproduces it exactly - while the
      // installer has replaced every file in the pack with a fresh inode. The hard links this
      // directory was built from then point at inodes nothing else references, and each profile is
      // silently carrying a private ~119 MB copy of the font pack that no later launch would ever
      // reclaim, because the key still matches.
      //
      // So when the last provision managed to link, re-verify that it is still linked: same inode as
      // the pack file it came from. A provision that had to fall back to copying is exempt - on a
      // filesystem without usable hard links the inodes never match and re-checking would rebuild
      // the directory on every single launch.
      if (
        !record.linked ||
        (await stillLinkedToPack(requiredFiles, fontsBaseDir, destinationFor))
      ) {
        return confPath;
      }
    }
  } catch {
    // First launch or an incomplete prior provision: validate and rebuild below.
  }
  for (const file of requiredFiles) {
    const absolute = safePackPath(fontsBaseDir, file.path);
    let fileStat;
    try {
      fileStat = await stat(absolute);
    } catch {
      throw new Error(`required font pack file is absent: ${absolute}`);
    }
    if (!fileStat.isFile()) throw new Error(`required font pack path is not a file: ${absolute}`);
    const verificationKey = `${absolute}:${fileStat.size}:${fileStat.mtimeMs}:${file.sha256}`;
    if (!verifiedPackFiles.has(verificationKey)) {
      const sha256 = createHash('sha256')
        .update(await readFile(absolute))
        .digest('hex');
      if (sha256 !== file.sha256) {
        throw new Error(`font pack file failed SHA-256 verification: ${absolute}`);
      }
      verifiedPackFiles.add(verificationKey);
    }
  }
  // Build a physical per-profile allowlist. Fontconfig's accept/reject precedence varies by distro;
  // giving it a directory containing only selected files is unambiguous and independently probeable.
  await rm(fontDir, { recursive: true, force: true });
  await mkdir(fontDir, { recursive: true, mode: 0o700 });
  let linked = true;
  for (const [index, file] of requiredFiles.entries()) {
    const source = safePackPath(fontsBaseDir, file.path);
    const destination = destinationFor(index, file.sha256);
    try {
      await link(source, destination);
    } catch {
      await copyFile(source, destination);
      linked = false;
    }
  }
  await mkdir(cacheDir, { recursive: true });
  await writeFile(confPath, buildFontConfig(os, fontDir, cacheDir, physicalFamilies, claimed), {
    mode: 0o600,
  });
  await writeFile(readyPath, `${JSON.stringify({ key: provisionKey, linked })}\n`, {
    mode: 0o600,
  });
  return confPath;
}

/** True for supported manifest personas. Physical pack availability is checked asynchronously at launch. */
export function hasFontPersona(os: FontPersona): boolean {
  return os in GENERIC_PREFERENCES;
}
