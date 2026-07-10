import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANDROID_PHONE_MODEL_CATALOG,
  ANDROID_TABLET_MODEL_CATALOG,
  MACOS_ARM_RENDERER_PRESETS,
  MACOS_FONT_NAMES,
  MACOS_INTEL_RENDERER_PRESETS,
  WINDOWS_FONT_NAMES,
  WINDOWS_RENDERER_PRESETS,
} from './catalog.generated.js';
import { DEVICE_TEMPLATES } from './pools.js';

function labels(items: ReadonlyArray<{ label: string }>): string[] {
  return items.map((item) => item.label);
}

test('source-generated font catalogs meet the product depth requirement', () => {
  assert.ok(WINDOWS_FONT_NAMES.length >= 300, `Windows fonts: ${WINDOWS_FONT_NAMES.length}`);
  assert.ok(MACOS_FONT_NAMES.length >= 1000, `macOS fonts: ${MACOS_FONT_NAMES.length}`);
  assert.ok(WINDOWS_FONT_NAMES.includes('Segoe UI'));
  assert.ok(MACOS_FONT_NAMES.some((font) => /Helvetica/i.test(font)));
});

test('core desktop pools consume the large OS font catalogs', () => {
  assert.equal(DEVICE_TEMPLATES.windows.fonts.length, WINDOWS_FONT_NAMES.length);
  assert.equal(DEVICE_TEMPLATES.macos.fonts.length, MACOS_FONT_NAMES.length);
});

test('Google Play Android model catalog keeps representative phone and tablet choices', () => {
  const phoneLabels = labels(ANDROID_PHONE_MODEL_CATALOG);
  const tabletLabels = labels(ANDROID_TABLET_MODEL_CATALOG);

  assert.ok(phoneLabels.length >= 300, `Android phones: ${phoneLabels.length}`);
  assert.ok(tabletLabels.length >= 30, `Android tablets: ${tabletLabels.length}`);
  assert.ok(phoneLabels.some((label) => /Xiaomi 11 Lite 5G NE/.test(label)));
  assert.ok(phoneLabels.some((label) => /ROG Phone 5/.test(label)));
  assert.ok(phoneLabels.some((label) => /Magic4 Lite|ANY-LX1/.test(label)));
  assert.ok(tabletLabels.some((label) => /Galaxy Tab A9\+/.test(label)));
  assert.ok(tabletLabels.some((label) => /A301LV/.test(label)));
  assert.ok(tabletLabels.some((label) => /Xiaomi Pad 6/.test(label)));
});

test('renderer catalog depth and backend formats match the claimed OS', () => {
  const macRenderers = [...MACOS_ARM_RENDERER_PRESETS, ...MACOS_INTEL_RENDERER_PRESETS];

  assert.ok(
    WINDOWS_RENDERER_PRESETS.length >= 300,
    `Windows renderers: ${WINDOWS_RENDERER_PRESETS.length}`,
  );
  assert.ok(macRenderers.length >= 200, `macOS renderers: ${macRenderers.length}`);

  for (const preset of WINDOWS_RENDERER_PRESETS) {
    assert.equal(preset.os, 'windows');
    assert.equal(preset.validationLevel, 'verified_source');
    assert.ok(preset.deviceId, `missing deviceId for ${preset.id}`);
    assert.ok(preset.source, `missing source for ${preset.id}`);
    assert.match(preset.webgl.renderer, /ANGLE \((NVIDIA|Intel|AMD), .+ \(0x[0-9A-F]+\) Direct3D11/);
    assert.doesNotMatch(preset.webgl.renderer, /Metal Renderer|OpenGL Engine/);
    assert.ok(preset.webgl.caps, `missing caps for ${preset.id}`);
  }

  for (const preset of macRenderers) {
    assert.equal(preset.os, 'macos');
    assert.equal(preset.validationLevel, 'verified_source');
    assert.ok(preset.deviceId, `missing deviceId for ${preset.id}`);
    assert.ok(preset.source, `missing source for ${preset.id}`);
    assert.match(preset.webgl.renderer, /ANGLE Metal Renderer/);
    assert.doesNotMatch(preset.webgl.renderer, /Direct3D/);
    assert.ok(preset.webgl.caps, `missing caps for ${preset.id}`);
  }
});

test('catalog provenance records verified sources and counts', async () => {
  const { CATALOG_PROVENANCE } = await import('./catalog.generated.js');
  assert.ok(CATALOG_PROVENANCE.retrievedAt);
  assert.ok(CATALOG_PROVENANCE.counts.windowsFonts >= 300);
  assert.ok(CATALOG_PROVENANCE.counts.macFonts >= 1000);
  assert.ok(CATALOG_PROVENANCE.counts.windowsRenderers >= 300);
});
