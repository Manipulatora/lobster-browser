import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  availableFontFamilies,
  buildFontConfig,
  hasFontPersona,
  writeFontConfig,
} from './fonts.js';

/**
 * A regex source matching an absolute host path as it appears inside the generated XML, on either
 * platform. Interpolating a path straight into `new RegExp` only works on POSIX: a Windows path is
 * dense with regex metacharacters (`C:\Users` reads as the escape `\U`, not a literal backslash), and
 * its separator is `\` where the XML assertions were written with `/`. Escape each segment and accept
 * either separator so one assertion covers both.
 */
function pathPattern(...segments: string[]): string {
  return segments
    .flatMap((segment) => segment.split(/[\\/]/))
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]');
}

async function fixturePack(root: string): Promise<string> {
  const pack = join(root, 'pack');
  const digest = createHash('sha256').update('font').digest('hex');
  await mkdir(join(pack, 'files'), { recursive: true });
  await writeFile(join(pack, 'files', 'LiberationSans-Regular.ttf'), 'font');
  await writeFile(join(pack, 'files', 'DejaVuSans-Regular.ttf'), 'font');
  await writeFile(
    join(pack, 'font-pack.manifest.json'),
    JSON.stringify({
      version: 1,
      packId: 'fixture-pack',
      files: [
        {
          path: 'files/LiberationSans-Regular.ttf',
          sha256: digest,
          families: ['Liberation Sans'],
          license: 'OFL-1.1',
        },
        {
          path: 'files/DejaVuSans-Regular.ttf',
          sha256: digest,
          families: ['DejaVu Sans'],
          license: 'Bitstream-Vera',
        },
      ],
      personas: {
        windows: { families: ['Liberation Sans'] },
        macos: { families: ['Liberation Sans'] },
        linux: { families: ['DejaVu Sans', 'Liberation Sans'] },
        android: { families: ['DejaVu Sans', 'Roboto'], physicalFamilies: ['DejaVu Sans'] },
      },
    }),
  );
  return pack;
}

test('hasFontPersona: EVERY OS is bundled so non-Windows personas cannot leak host fonts', () => {
  assert.equal(hasFontPersona('windows'), true);
  assert.equal(hasFontPersona('macos'), true);
  assert.equal(hasFontPersona('linux'), true);
  assert.equal(hasFontPersona('android'), true);
});

test('private config restores regional Noto CJK selection rules', () => {
  const xml = buildFontConfig(
    'android',
    '/profile/fonts',
    '/profile/cache',
    ['Roboto', 'Noto Sans CJK JP', 'Noto Serif CJK JP'],
    ['Roboto'],
  );
  assert.match(xml, /<string>ko<\/string>[\s\S]*<string>Noto Sans CJK KR<\/string>/);
  assert.match(xml, /<string>zh-cn<\/string>[\s\S]*<string>Noto Sans CJK SC<\/string>/);
  assert.match(xml, /<string>zh-tw<\/string>[\s\S]*<string>Noto Serif CJK TC<\/string>/);
  assert.match(xml, /<string>zh-hk<\/string>[\s\S]*<string>Noto Sans Mono CJK HK<\/string>/);
});

test('modern CSS generic families resolve to intentional readable faces', () => {
  const xml = buildFontConfig(
    'windows',
    '/profile/fonts',
    '/profile/cache',
    [
      'Liberation Sans',
      'Liberation Serif',
      'Liberation Mono',
      'Noto Color Emoji',
      'Noto Sans Math',
    ],
    ['Segoe UI'],
  );
  assert.match(xml, /<family>system-ui<\/family><prefer><family>Liberation Sans<\/family>/);
  assert.match(xml, /<family>ui-serif<\/family><prefer><family>Liberation Serif<\/family>/);
  assert.match(xml, /<family>ui-monospace<\/family><prefer><family>Liberation Mono<\/family>/);
  assert.match(xml, /<family>emoji<\/family><prefer><family>Noto Color Emoji<\/family>/);
  assert.match(xml, /<family>math<\/family><prefer><family>Noto Sans Math<\/family>/);
  assert.match(
    xml,
    /<string>DejaVu Sans<\/string>[\s\S]*binding="strong"><string>Liberation Sans<\/string>/,
  );
});

test('Android uses its own physical allowlist and aliases selected mobile families', async () => {
  const udd = await mkdtemp(join(tmpdir(), 'fonts-android-'));
  try {
    const pack = await fixturePack(udd);
    assert.deepEqual(await availableFontFamilies(pack, 'android'), ['DejaVu Sans']);
    const conf = await writeFontConfig(udd, 'android', pack, ['Roboto', 'Google Sans']);
    const xml = await readFile(conf, 'utf8');
    assert.match(xml, /sans-serif<\/family><prefer><family>DejaVu Sans/);
    assert.match(xml, /<family>Roboto<\/family><prefer><family>DejaVu Sans/);
    assert.doesNotMatch(xml, /etc\/fonts/);
  } finally {
    await rm(udd, { recursive: true, force: true });
  }
});

test('macOS persona exposes only physically bundled open-family names, no proprietary aliases', async () => {
  const udd = await mkdtemp(join(tmpdir(), 'fonts-mac-'));
  try {
    const pack = await fixturePack(udd);
    assert.deepEqual(await availableFontFamilies(pack, 'macos'), ['Liberation Sans']);
    const conf = await writeFontConfig(udd, 'macos', pack, ['Liberation Sans']);
    const xml = await readFile(conf, 'utf8');
    assert.match(xml, new RegExp(`<dir>${pathPattern(udd, 'font-files')}</dir>`));
    assert.doesNotMatch(xml, /etc\/fonts/);
    assert.match(xml, /Liberation Sans/);
    assert.doesNotMatch(xml, /Helvetica|Arial|Times New Roman/);
  } finally {
    await rm(udd, { recursive: true, force: true });
  }
});

test('writeFontConfig writes a private fontconfig exposing ONLY the persona dir (no /etc/fonts)', async () => {
  const udd = await mkdtemp(join(tmpdir(), 'fonts-'));
  try {
    const pack = await fixturePack(udd);
    const conf = await writeFontConfig(udd, 'windows', pack, ['Liberation Sans']);
    assert.equal(conf, join(udd, 'lobium-fonts.conf'));
    const xml = await readFile(conf, 'utf8');
    assert.match(xml, new RegExp(`<dir>${pathPattern(udd, 'font-files')}</dir>`));
    assert.match(xml, /<reset-dirs \/>/);
    assert.doesNotMatch(xml, /<include/);
    assert.doesNotMatch(xml, /etc\/fonts/);
    // Private, per-profile cache dir (so no jitter / no writes to a shared cache).
    assert.match(xml, new RegExp(`<cachedir>${pathPattern(udd, 'fc-cache')}</cachedir>`));
    assert.equal((await readdir(join(udd, 'font-files'))).length, 1);
    assert.match(xml, /sans-serif<\/family><prefer><family>Liberation Sans/);
    // Generics must ALSO carry a strong prepend, not only the weak <alias>. Without this, `sans-serif`
    // weak-matches every "Liberation <X>" face equally and fontconfig's tie-break silently picks
    // Liberation Mono, rendering body text monospaced. Guard the strong binding for sans-serif.
    assert.match(
      xml,
      /<test qual="any" name="family"><string>sans-serif<\/string><\/test>\s*<edit name="family" mode="prepend" binding="strong"><string>Liberation Sans/,
    );
    // Every pattern ends with a weak sans last-resort so an unmapped family degrades to readable sans
    // instead of the first-on-disk (mono) face.
    assert.match(xml, /mode="append_last" binding="weak"><string>Liberation Sans/);
    // Resetting /etc/fonts must not also reset the raster-quality policy to fontconfig's crude
    // full-hinting/no-antialias defaults. Grayscale AA (rgba=none) is intentional: Lobium renders on a
    // virtual framebuffer viewed over VNC/screenshots, where subpixel/LCD produces colored fringing.
    assert.match(xml, /name="antialias" mode="assign"><bool>true<\/bool>/);
    assert.match(xml, /name="hintstyle" mode="assign"><const>hintslight<\/const>/);
    assert.match(xml, /name="rgba" mode="assign"><const>none<\/const>/);
    assert.match(xml, /name="lcdfilter" mode="assign"><const>none<\/const>/);
  } finally {
    await rm(udd, { recursive: true, force: true });
  }
});

test('repeat launch reuses the verified per-profile font provision', async () => {
  const udd = await mkdtemp(join(tmpdir(), 'fonts-cache-'));
  try {
    const pack = await fixturePack(udd);
    const conf = await writeFontConfig(udd, 'windows', pack, ['Arial', 'Segoe UI']);
    const before = await stat(conf);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await writeFontConfig(udd, 'windows', pack, ['Arial', 'Segoe UI']);
    const after = await stat(again);
    assert.equal(again, conf);
    assert.equal(after.mtimeMs, before.mtimeMs, 'cache hit must not rewrite the font config');
  } finally {
    await rm(udd, { recursive: true, force: true });
  }
});

test('stale font-config cache markers force regeneration', async () => {
  const udd = await mkdtemp(join(tmpdir(), 'fonts-cache-version-'));
  try {
    const pack = await fixturePack(udd);
    const conf = await writeFontConfig(udd, 'windows', pack, ['Arial']);
    const before = await stat(conf);
    await writeFile(join(udd, '.lobium-fonts-ready'), 'legacy-config-key\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFontConfig(udd, 'windows', pack, ['Arial']);
    const after = await stat(conf);
    assert.ok(after.mtimeMs > before.mtimeMs, 'stale cache must rebuild the private config');
  } finally {
    await rm(udd, { recursive: true, force: true });
  }
});

test('linux persona keeps DejaVu/Liberation names (real Linux fonts) but restricted to the bundle', async () => {
  const udd = await mkdtemp(join(tmpdir(), 'fonts-lin-'));
  try {
    const pack = await fixturePack(udd);
    const conf = await writeFontConfig(udd, 'linux', pack, ['DejaVu Sans']);
    assert.equal(conf, join(udd, 'lobium-fonts.conf'));
    const xml = await readFile(conf, 'utf8');
    assert.match(xml, new RegExp(`<dir>${pathPattern(udd, 'font-files')}</dir>`));
    assert.doesNotMatch(xml, /etc\/fonts/);
    assert.match(xml, /sans-serif<\/family><prefer><family>Liberation Sans/);
  } finally {
    await rm(udd, { recursive: true, force: true });
  }
});

test('writeFontConfig aliases claimed proprietary families onto the open pack (no crash)', async () => {
  const udd = await mkdtemp(join(tmpdir(), 'fonts-alias-'));
  try {
    const pack = await fixturePack(udd);
    // A real Windows persona claims proprietary families the open pack cannot physically carry. Those
    // must be ALIASED onto a class-appropriate bundled face (so probes resolve), never rejected.
    const conf = await writeFontConfig(udd, 'windows', pack, [
      'Arial',
      'Times New Roman',
      'Courier New',
    ]);
    const xml = await readFile(conf, 'utf8');
    // Sans/serif/mono classification aliases each claimed family onto the bundled sans face
    // (the fixture pack only ships Liberation Sans).
    assert.match(xml, /<family>Arial<\/family><prefer><family>Liberation Sans/);
    assert.match(xml, /<family>Times New Roman<\/family><prefer><family>Liberation Sans/);
    assert.match(xml, /<family>Courier New<\/family><prefer><family>Liberation Sans/);
    // Still never leaks host fonts.
    assert.doesNotMatch(xml, /etc\/fonts/);
  } finally {
    await rm(udd, { recursive: true, force: true });
  }
});

test('writeFontConfig fails clearly for absent packs/files', async () => {
  const udd = await mkdtemp(join(tmpdir(), 'fonts-fail-'));
  try {
    await assert.rejects(
      () => writeFontConfig(udd, 'linux', join(udd, 'missing'), ['DejaVu Sans']),
      /required Lobium font pack is absent/,
    );
    const pack = await fixturePack(udd);
    await rm(join(pack, 'files', 'LiberationSans-Regular.ttf'));
    await assert.rejects(
      () => writeFontConfig(udd, 'windows', pack, ['Liberation Sans']),
      /required font pack file is absent/,
    );
  } finally {
    await rm(udd, { recursive: true, force: true });
  }
});

test('a claimed family resolves to its metric clone when the pack carries one', () => {
  // A font probe compares advance widths, so "same class" is not the bar. Carlito and Caladea are
  // exact metric clones of Calibri and Cambria and ship in the pack; before this they were never
  // used as alias targets, so a Windows persona claiming Calibri measured identically to Arial —
  // an inconsistency a width probe reads directly, on a font every Windows install has.
  const physical = ['Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'Carlito', 'Caladea'];
  const xml = buildFontConfig('windows', '/profile/fonts', '/profile/cache', physical, [
    'Arial',
    'Times New Roman',
    'Courier New',
    'Calibri',
    'Cambria',
  ]);
  const aliasFor = (family: string): string | undefined =>
    new RegExp(`<alias><family>${family}</family><prefer><family>([^<]+)</family>`).exec(xml)?.[1];

  assert.equal(aliasFor('Calibri'), 'Carlito');
  assert.equal(aliasFor('Cambria'), 'Caladea');
  // The mappings that were already metric-correct must not regress.
  assert.equal(aliasFor('Arial'), 'Liberation Sans');
  assert.equal(aliasFor('Times New Roman'), 'Liberation Serif');
  assert.equal(aliasFor('Courier New'), 'Liberation Mono');
});

test('a metric clone that the pack does not carry falls back to its class face', () => {
  // The table is a claim about the PACK, not a wish list: mapping Calibri onto a Carlito that is not
  // installed would resolve to fontconfig's own last-resort pick instead of a chosen face.
  const xml = buildFontConfig(
    'windows',
    '/profile/fonts',
    '/profile/cache',
    ['Liberation Sans', 'Liberation Serif', 'Liberation Mono'],
    ['Calibri'],
  );
  assert.match(xml, /<alias><family>Calibri<\/family><prefer><family>Liberation Sans<\/family>/);
});
