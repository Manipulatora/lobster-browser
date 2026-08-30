import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import {
  availableFontFamilies,
  buildFontConfig,
  hasFontPersona,
  orderFontFallbackFamilies,
  planFontAliases,
  stageNativeFontPack,
  verifyFontPackFiles,
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

test('Windows CSS alias plan distinguishes metric clones from class approximations', () => {
  const plan = planFontAliases(
    'windows',
    ['Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'Carlito', 'Caladea'],
    ['Arial', 'Calibri', 'Cambria', 'Consolas', 'Segoe UI', 'sans-serif'],
  );
  assert.deepEqual(plan.aliases, {
    Arial: 'Liberation Sans',
    Calibri: 'Carlito',
    Cambria: 'Caladea',
    Consolas: 'Liberation Mono',
    'Segoe UI': 'Liberation Sans',
  });
  assert.deepEqual(plan.metricCompatible, ['Arial', 'Calibri', 'Cambria']);
  assert.deepEqual(plan.classFallback, ['Consolas', 'Segoe UI']);
});

test('native fallback order puts persona sans/serif/mono ahead of alphabetical coverage', () => {
  assert.deepEqual(
    orderFontFallbackFamilies('android', [
      'Noto Color Emoji',
      'Noto Music',
      'Noto Sans',
      'Noto Sans Mono',
      'Noto Serif',
    ]).slice(0, 3),
    ['Noto Sans', 'Noto Serif', 'Noto Sans Mono'],
  );
  assert.deepEqual(
    orderFontFallbackFamilies('windows', [
      'Caladea',
      'Carlito',
      'Liberation Mono',
      'Liberation Sans',
      'Liberation Serif',
    ]).slice(0, 3),
    ['Liberation Sans', 'Liberation Serif', 'Liberation Mono'],
  );
});

test('verifyFontPackFiles accepts only the exact manifest-hashed font ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fonts-ledger-'));
  try {
    const pack = await fixturePack(root);
    const manifest = await verifyFontPackFiles(pack);
    assert.equal(manifest.packId, 'fixture-pack');

    await writeFile(join(pack, 'files', 'LiberationSans-Regular.ttf'), 'tampered');
    await assert.rejects(
      () => verifyFontPackFiles(pack),
      /failed SHA-256 verification/,
      'a declared file with different bytes must never reach DirectWrite',
    );

    await writeFile(join(pack, 'files', 'LiberationSans-Regular.ttf'), 'font');
    await writeFile(join(pack, 'files', 'undeclared.otf'), 'font');
    await assert.rejects(
      () => verifyFontPackFiles(pack),
      /ledger mismatch \(undeclared: files\/undeclared\.otf; missing: none\)/,
      'a font outside the manifest would still be discovered by the native recursive loader',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native stage contains only the selected persona files and is content-keyed/reusable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fonts-native-stage-'));
  try {
    const pack = await fixturePack(root);
    const first = await stageNativeFontPack(root, 'android', pack);
    assert.deepEqual(first.physicalFamilies, ['DejaVu Sans']);
    const stagedFiles = await readdir(join(first.dir, 'files'));
    assert.equal(stagedFiles.length, 1);
    const stagedFile = stagedFiles[0];
    assert.ok(stagedFile);
    // The staged NAME is deliberately just an index plus the extension. The engine enumerates
    // files/, filters on the extension and sorts by path — it never parses the name — and every
    // character here is charged against Windows MAX_PATH (see stagedFontRelativePath).
    assert.match(stagedFile, /^\d{4}\.ttf$/, `staged name must be short and indexed: ${stagedFile}`);
    assert.ok(!stagedFile.includes('LiberationSans'), 'only the persona selection is staged');

    const second = await stageNativeFontPack(root, 'android', pack);
    assert.equal(
      second.dir,
      first.dir,
      'same verified content and persona reuse the immutable stage',
    );

    await writeFile(join(first.dir, 'files', 'undeclared.ttf'), 'font');
    await assert.rejects(
      () => stageNativeFontPack(root, 'android', pack),
      /stage contains an undeclared file/,
      'a profile-local file dropped into the stage must never reach native recursion',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native stage rejects a multi-family file that escapes the persona inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fonts-native-companion-'));
  try {
    const pack = await fixturePack(root);
    const manifestPath = join(pack, 'font-pack.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files[1].families.push('Undeclared TTC Companion');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      () => stageNativeFontPack(root, 'android', pack),
      /exposes families outside the android persona: Undeclared TTC Companion/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('a reinstalled pack with identical contents still re-links the profile', async () => {
  // The provision key is derived from the pack CONTENTS, so an installer that lays down the same
  // font pack again reproduces it byte for byte - while giving every pack file a brand new inode.
  // The hard links in the profile then reference inodes the pack no longer shares, and the profile
  // is silently holding a private copy of the whole pack. A key check alone calls that a cache hit
  // and never reclaims it, so this asserts on the inode rather than on the key.
  const udd = await mkdtemp(join(tmpdir(), 'fonts-relink-'));
  try {
    const pack = await fixturePack(udd);
    const packFile = join(pack, 'files', 'LiberationSans-Regular.ttf');
    await writeFontConfig(udd, 'windows', pack, ['Arial']);

    const provisioned = async (): Promise<{ ino: number; nlink: number }> => {
      const dir = join(udd, 'font-files');
      const [name] = (await readdir(dir)).sort();
      assert.ok(name, 'the provision must produce at least one font file');
      const s = await stat(join(dir, name));
      return { ino: s.ino, nlink: s.nlink };
    };

    const linkedFirst = await provisioned();
    assert.equal(linkedFirst.ino, (await stat(packFile)).ino, 'first provision must hard-link');

    // Reinstall: identical bytes, new inode. rm+write is exactly what an installer does.
    await rm(packFile);
    await writeFile(packFile, 'font');
    const reinstalled = await stat(packFile);
    assert.notEqual(reinstalled.ino, linkedFirst.ino, 'the fixture must model a replaced inode');
    assert.equal(linkedFirst.nlink, 2, 'the profile copy was the only other reference');

    await writeFontConfig(udd, 'windows', pack, ['Arial']);
    const after = await provisioned();
    assert.equal(after.ino, reinstalled.ino, 'the profile must re-link to the reinstalled pack');
  } finally {
    await rm(udd, { recursive: true, force: true });
  }
});

test('a provision that had to copy is not rebuilt on every launch', async () => {
  // On a filesystem where link() cannot work the fallback copy is correct and permanent: its inode
  // will never match the pack, so re-verifying the link would rebuild the whole directory on every
  // single launch. The stamp records which of the two happened; only a linked provision is checked.
  const udd = await mkdtemp(join(tmpdir(), 'fonts-copied-'));
  try {
    const pack = await fixturePack(udd);
    const conf = await writeFontConfig(udd, 'windows', pack, ['Arial']);
    const stamp = JSON.parse(await readFile(join(udd, '.lobium-fonts-ready'), 'utf8')) as {
      key: string;
      linked: boolean;
    };
    assert.equal(stamp.linked, true, 'the fixture filesystem does support hard links');

    // Restamp as a copied provision, leaving the files exactly as they are.
    await writeFile(
      join(udd, '.lobium-fonts-ready'),
      `${JSON.stringify({ key: stamp.key, linked: false })}\n`,
    );
    const before = await stat(conf);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFontConfig(udd, 'windows', pack, ['Arial']);
    const after = await stat(conf);
    assert.equal(after.mtimeMs, before.mtimeMs, 'a copied provision must still be a cache hit');
  } finally {
    await rm(udd, { recursive: true, force: true });
  }
});

test('the staged pack fits MAX_PATH under a realistic Windows profile path', async () => {
  // WHY THIS IS A TEST AND NOT A COMMENT.
  //
  // Windows refuses a non-`\?\` path over 260 characters, LongPathsEnabled is 0 on a default
  // install, and the engine calls bare ::GetFileAttributes on these files. An over-length face
  // reads back as INVALID_FILE_ATTRIBUTES, FontPackFaces clears the ENTIRE pack, and an empty pack
  // fails the browser's DirectWrite init — lazily, on first font resolution, which is AFTER the CDP
  // endpoint is published. The product has already reported the launch successful by then, so the
  // browser simply vanishes and `stop` answers "not running".
  //
  // The old layout spent 155 characters below the user-data-dir, leaving 105. A real profile path is
  // C:\Users\<user>\AppData\Roaming\com.lobster.browser\profiles\prf_<32 hex> = 91 + len(username),
  // so "Administrator" landed on 259 — one character inside the limit — and any username of 15
  // characters or more was permanently broken, on every launch of every profile.
  const root = await mkdtemp(join(tmpdir(), 'fonts-maxpath-'));
  try {
    const SEP = String.fromCharCode(92); // a literal backslash, without escaping games
    const pack = await fixturePack(root);
    const staged = await stageNativeFontPack(root, 'android', pack);
    const files = await readdir(join(staged.dir, 'files'));
    assert.ok(files.length > 0);

    // Longest path the layout adds below the user-data-dir: <packs>\<key>\files\<name>
    const key = basename(staged.dir);
    const longest = files.reduce((a, b) => (a.length >= b.length ? a : b));
    const belowUdd = ['native-font-packs', key, 'files', longest].join(SEP).length + 1;

    // A 20-character Windows username, which is ordinary, must still fit.
    const profileDir =
      [`C:${SEP}Users`, 'a'.repeat(20), 'AppData', 'Roaming', 'com.lobster.browser', 'profiles',
        `prf_${'0'.repeat(32)}`].join(SEP);
    assert.ok(
      profileDir.length + belowUdd <= 260,
      `staged font path would exceed MAX_PATH for a 20-char username: ` +
        `${profileDir.length} + ${belowUdd} = ${profileDir.length + belowUdd} > 260. ` +
        `The pack then reads as empty and the browser dies after reporting a successful launch.`,
    );

    // And keep real headroom rather than sitting one character inside the limit.
    assert.ok(
      belowUdd <= 80,
      `the staged layout costs ${belowUdd} chars below the user-data-dir; keep it small`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
