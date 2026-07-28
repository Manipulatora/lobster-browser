import { copyFile, link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
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
    sans: ['Liberation Sans', 'Noto Sans', 'DejaVu Sans', 'Carlito'],
    serif: ['Liberation Serif', 'Noto Serif', 'DejaVu Serif', 'Caladea'],
    mono: ['DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono'],
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
 * every family the persona CLAIMS but the pack does not physically carry onto the bundled face of the
 * same serif/sans/mono class, so a CSS width-probe / `src:local()` request for e.g. `Arial` or
 * `Segoe UI` resolves (with metric-compatible-ish geometry) instead of falling back to an arbitrary
 * default. This never adds physical faces (so `queryLocalFonts()` still enumerates only the pack —
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
  const skip = new Set<string>([
    ...physicalFamilies,
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
  for (const family of claimedFamilies) {
    if (skip.has(family)) continue;
    skip.add(family);
    lines.push(alias(family, preferByClass[familyClass(family)]));
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
  if (!path || isAbsolute(path) || path.includes('\0')) {
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

/** Families physically represented by files in this provisioned pack for the requested persona. */
export async function availableFontFamilies(
  fontsBaseDir: string,
  os: FontPersona,
): Promise<string[]> {
  const manifest = await loadFontPackManifest(fontsBaseDir);
  const physical = new Set(manifest.files.flatMap((file) => file.families));
  const allowlist = manifest.personas[os].physicalFamilies ?? manifest.personas[os].families;
  return allowlist.filter((family) => physical.has(family));
}

/**
 * Validate the pack and write the exact per-profile family allowlist. Missing packs, files, or requested
 * families fail closed: a configured launch can never silently fall back to host `/etc/fonts`.
 */
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
  const physicalFamilies = await availableFontFamilies(fontsBaseDir, os);
  if (physicalFamilies.length === 0) {
    throw new Error(`font pack ${manifest.packId} exposes no families for ${os}`);
  }
  const claimed = [...new Set(selectedFamilies)].sort((a, b) => a.localeCompare(b, 'en'));
  if (claimed.length === 0) {
    throw new Error(`profile carries no font list for ${os}; refusing host-font fallback`);
  }
  const physicalSet = new Set(physicalFamilies);
  const requiredFiles = manifest.files.filter((file) =>
    file.families.some((family) => physicalSet.has(family)),
  );
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
  try {
    const [ready, fontDirStat, confStat] = await Promise.all([
      readFile(readyPath, 'utf8'),
      stat(fontDir),
      stat(confPath),
    ]);
    if (ready.trim() === provisionKey && fontDirStat.isDirectory() && confStat.isFile()) {
      return confPath;
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
  for (const [index, file] of requiredFiles.entries()) {
    const source = safePackPath(fontsBaseDir, file.path);
    const destination = join(
      fontDir,
      `${String(index).padStart(4, '0')}-${file.sha256.slice(0, 12)}`,
    );
    try {
      await link(source, destination);
    } catch {
      await copyFile(source, destination);
    }
  }
  await mkdir(cacheDir, { recursive: true });
  await writeFile(confPath, buildFontConfig(os, fontDir, cacheDir, physicalFamilies, claimed), {
    mode: 0o600,
  });
  await writeFile(readyPath, `${provisionKey}\n`, { mode: 0o600 });
  return confPath;
}

/** True for supported manifest personas. Physical pack availability is checked asynchronously at launch. */
export function hasFontPersona(os: FontPersona): boolean {
  return os in GENERIC_PREFERENCES;
}
