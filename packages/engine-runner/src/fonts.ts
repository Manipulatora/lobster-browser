import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OsFamily } from '@lobster/shared-types';

/**
 * Font fingerprint control (ENG-6) — a PACKAGING surface, not a Blink hook. On Linux, Chromium resolves
 * every font-facing surface (CSS width-probe enumeration, `queryLocalFonts()`, `@font-face src:local()`,
 * `measureText` glyph metrics) through the browser process's fontconfig. Point `FONTCONFIG_FILE` at a
 * PRIVATE config that exposes ONLY a bundled, metric-compatible font set (and NOT `/etc/fonts`) and the
 * whole surface collapses to a deterministic, OS-plausible set — stable per profile, host fonts invisible.
 *
 * This module writes that private config into the profile's user-data-dir at launch (absolute paths
 * baked in) and returns its path; the launcher sets `FONTCONFIG_FILE` to it. The bundled faces live under
 * `<fontsBaseDir>/<os>/` (see repo `lobium/fonts/`); `fontsBaseDir` is resolved by the launcher.
 */

const FONTCONFIG_FILENAME = 'lobium-fonts.conf';

/**
 * Per-OS family renames: the bundled metric-compatible face (scanned family) → the persona family name
 * a page expects. The metric-compatible clones (Liberation ≈ Arial/Times/Courier) carry Windows/mac
 * metrics, and the scan-rename makes enumeration + matching report the persona names.
 */
interface FontPersona {
  /** subdir under fontsBaseDir holding the bundled faces */
  dir: string;
  /** scanned-family → persona-family renames */
  renames: Array<{ from: string; to: string }>;
  /** generic-family → persona-family preferences */
  generics: { sans: string; serif: string; mono: string };
}

const PERSONAS: Partial<Record<OsFamily, FontPersona>> = {
  windows: {
    dir: 'windows',
    renames: [
      { from: 'Liberation Sans', to: 'Arial' },
      { from: 'Liberation Serif', to: 'Times New Roman' },
      { from: 'Liberation Mono', to: 'Courier New' },
    ],
    generics: { sans: 'Arial', serif: 'Times New Roman', mono: 'Courier New' },
  },
};

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build the private fontconfig XML for a persona, with absolute bundle + cache dirs baked in. */
export function buildFontConfig(persona: FontPersona, fontDir: string, cacheDir: string): string {
  const scan = persona.renames
    .map(
      (r) =>
        `  <match target="scan"><test name="family"><string>${xmlEscape(r.from)}</string></test>` +
        `<edit name="family" mode="assign"><string>${xmlEscape(r.to)}</string></edit></match>`,
    )
    .join('\n');
  const alias = (family: string, prefer: string): string =>
    `  <alias><family>${family}</family><prefer><family>${xmlEscape(prefer)}</family></prefer></alias>`;
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <!-- The bundled persona dir is the ONLY font source; the system font directories are intentionally
       never referenced, so every host font is invisible to the browser. -->
  <dir>${xmlEscape(fontDir)}</dir>
  <cachedir>${xmlEscape(cacheDir)}</cachedir>
${scan}
${alias('sans-serif', persona.generics.sans)}
${alias('serif', persona.generics.serif)}
${alias('monospace', persona.generics.mono)}
  <config></config>
</fontconfig>
`;
}

/**
 * Write the per-profile private fontconfig into `userDataDir` and return its absolute path, or `undefined`
 * when no bundle exists for this OS (the caller then leaves fonts as the host default). Deterministic:
 * same os + same dirs => byte-identical config => stable font fingerprint across launches.
 */
export async function writeFontConfig(
  userDataDir: string,
  os: OsFamily,
  fontsBaseDir: string,
): Promise<string | undefined> {
  const persona = PERSONAS[os];
  if (!persona) {
    return undefined;
  }
  const fontDir = join(fontsBaseDir, persona.dir);
  const cacheDir = join(userDataDir, 'fc-cache');
  await mkdir(cacheDir, { recursive: true });
  const confPath = join(userDataDir, FONTCONFIG_FILENAME);
  await writeFile(confPath, buildFontConfig(persona, fontDir, cacheDir), { mode: 0o600 });
  return confPath;
}

/** True when a bundled persona font set exists for this OS. */
export function hasFontPersona(os: OsFamily): boolean {
  return PERSONAS[os] !== undefined;
}
