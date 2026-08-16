import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANDROID_PHONE_MODEL_CATALOG,
  LINUX_FONT_NAMES,
  MACOS_FONT_NAMES,
  WINDOWS_FONT_NAMES,
} from './catalog.generated.js';
import {
  DEFAULT_FONT_SELECTION_TARGET,
  defaultFontsForOs,
  defaultLinuxFonts,
  defaultMacosFonts,
  defaultWindowsFonts,
  filterAndroidCatalogByOsVersion,
  normalizeMacFontFamily,
} from './defaults.js';

test('default Windows font set targets ~435 verified families', () => {
  const fonts = defaultWindowsFonts();
  assert.equal(fonts.length, Math.min(DEFAULT_FONT_SELECTION_TARGET, WINDOWS_FONT_NAMES.length));
  assert.ok(fonts.includes('Segoe UI'));
  assert.ok(fonts.every((font) => WINDOWS_FONT_NAMES.includes(font)));
});

test('default macOS font set collapses versioned Support rows to ~435 families', () => {
  const fonts = defaultMacosFonts();
  assert.ok(fonts.length <= DEFAULT_FONT_SELECTION_TARGET);
  assert.ok(fonts.length >= 200, `macOS default fonts: ${fonts.length}`);
  assert.ok(fonts.some((font) => /Helvetica|SF |Menlo|Arial/i.test(font)));
  for (const font of fonts) {
    assert.equal(font, normalizeMacFontFamily(font));
  }
});

test('default Linux font set uses the full verified Ubuntu package catalog when under 435', () => {
  const fonts = defaultLinuxFonts();
  assert.equal(fonts.length, LINUX_FONT_NAMES.length);
  assert.deepEqual(fonts, [...LINUX_FONT_NAMES]);
});

test('defaultFontsForOs routes by desktop OS family', () => {
  assert.equal(defaultFontsForOs('windows').length, defaultWindowsFonts().length);
  assert.equal(defaultFontsForOs('macos').length, defaultMacosFonts().length);
  assert.equal(defaultFontsForOs('linux').length, defaultLinuxFonts().length);
});

test('Android OS-version filter keeps modern devices for Android 15+', () => {
  const filtered = filterAndroidCatalogByOsVersion(ANDROID_PHONE_MODEL_CATALOG, 'Android 15');
  assert.ok(filtered.length >= 80, `filtered phones: ${filtered.length}`);
  assert.ok(filtered.some((entry) => /Galaxy S2[1-9]|Pixel [6-9]/i.test(entry.label)));
  const broad = filterAndroidCatalogByOsVersion(ANDROID_PHONE_MODEL_CATALOG, 'Android 13');
  assert.equal(broad.length, ANDROID_PHONE_MODEL_CATALOG.length);
});

test('macOS Support font names normalize without inventing families', () => {
  assert.equal(normalizeMacFontFamily('Helvetica Neue 13.0d2e27'), 'Helvetica Neue');
  assert.ok(
    MACOS_FONT_NAMES.some(
      (font) => normalizeMacFontFamily(font) === 'Helvetica Neue' || font.includes('Helvetica'),
    ),
  );
});

test('the Windows font catalog contains every family Blink resolves a CSS generic to', () => {
  // The native font filter blocks families the persona does not claim. If the catalog omitted one of
  // these, `font-family: monospace` would stop resolving Consolas and code would render in a
  // proportional face - visibly broken, and a tell in its own right, since no real Windows Chrome
  // does that.
  //
  // The engine also hard-allows these regardless of config (lobium/src/lobium_fonts.cc,
  // kAlwaysAllowed), so this is defence in depth rather than the only guard. It exists because a
  // failure here has a clear cause and a clear fix, whereas the same defect discovered through the
  // engine looks like "text renders wrong".
  const fonts = new Set(defaultFontsForOs('windows').map((f) => f.toLowerCase()));
  const generics = [
    'Times New Roman', // standard + serif
    'Arial',           // sans-serif
    'Consolas',        // monospace
    'Courier New',     // monospace fallback
    'Comic Sans MS',   // cursive
    'Impact',          // fantasy
    'Cambria Math',    // math
  ];
  const missing = generics.filter((f) => !fonts.has(f.toLowerCase()));
  assert.deepEqual(missing, [], 'Windows persona font catalog is missing generic-family defaults');
});

test('every OS font catalog is free of duplicates and blank entries', () => {
  // A duplicate is measurable: enumeration APIs would report the same family twice, which no real
  // machine does. A blank entry is worse - it reaches the engine as an empty allow-prefix, and an
  // empty prefix matches every unique name, silently disabling the local() filter.
  for (const os of ['windows', 'macos', 'linux'] as const) {
    const list = defaultFontsForOs(os);
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const f of list) {
      const key = f.toLowerCase();
      if (seen.has(key)) dupes.push(f);
      seen.add(key);
    }
    assert.deepEqual(dupes, [], `${os} font catalog has duplicates`);
    assert.equal(list.filter((f) => f.trim() === '').length, 0, `${os} font catalog has blank entries`);
  }
});
