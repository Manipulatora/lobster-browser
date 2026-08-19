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
import {
  LINUX_RENDERER_PRESETS as PRODUCT_LINUX_RENDERERS,
  MACOS_ARM_RENDERER_PRESETS as PRODUCT_MAC_ARM_RENDERERS,
  MACOS_INTEL_RENDERER_PRESETS as PRODUCT_MAC_INTEL_RENDERERS,
  WINDOWS_RENDERER_PRESETS as PRODUCT_WINDOWS_RENDERERS,
} from './catalog.js';

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
    assert.match(
      preset.webgl.renderer,
      /ANGLE \((NVIDIA|Intel|AMD), .+ \(0x[0-9A-F]+\) Direct3D11/,
    );
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

test('catalog provenance records model sources and counts', async () => {
  const { CATALOG_PROVENANCE } = await import('./catalog.generated.js');
  assert.ok(CATALOG_PROVENANCE.retrievedAt);
  assert.ok(CATALOG_PROVENANCE.counts.windowsFonts >= 300);
  assert.ok(CATALOG_PROVENANCE.counts.macFonts >= 1000);
  assert.ok(CATALOG_PROVENANCE.counts.windowsRenderers >= 300);
});

test('product renderer facade removes malformed/obsolete default choices and states validation scope', () => {
  assert.ok(PRODUCT_WINDOWS_RENDERERS.length >= 50);
  assert.ok(PRODUCT_LINUX_RENDERERS.length >= 50);
  for (const preset of [...PRODUCT_WINDOWS_RENDERERS, ...PRODUCT_LINUX_RENDERERS]) {
    assert.equal(preset.validationLevel, 'model_source_only');
    assert.equal(preset.validationScope, 'model_device_id_only');
    assert.doesNotMatch(preset.label, /\]$/);
    assert.doesNotMatch(preset.webgl.renderer, /\]\s*\(/);
    assert.doesNotMatch(preset.label, /GeForce 6800|Engineering Sample|Mining/i);
  }
  assert.match(PRODUCT_WINDOWS_RENDERERS[0]?.label ?? '', /GTX|RTX|Radeon|Intel/i);
});

test('no product preset carries a pci.ids codename or a stray bracket into the page-visible string', () => {
  // The catalog names GPUs the way pci.ids does — "Intel(R) Coffee Lake-U GT3e [Iris Plus Graphics
  // 655]" — but a driver reports only the marketing half. Both the leftover bracket and the codename
  // are strings no machine has ever produced, and the ANGLE renderer is read by every GPU probe.
  for (const preset of [
    ...PRODUCT_WINDOWS_RENDERERS,
    ...PRODUCT_LINUX_RENDERERS,
    ...PRODUCT_MAC_INTEL_RENDERERS,
    ...PRODUCT_MAC_ARM_RENDERERS,
  ]) {
    assert.doesNotMatch(preset.label, /[[\]]/, `label keeps a bracket: ${preset.label}`);
    assert.doesNotMatch(
      preset.webgl.renderer,
      /[[\]]/,
      `renderer keeps a bracket: ${preset.webgl.renderer}`,
    );
    assert.doesNotMatch(
      preset.label,
      /\b(?:Coffee|Kaby|Comet|Whiskey|Alder|Raptor|Tiger|Rocket|Meteor|Jasper|Elkhart|Gemini|Broadwell|Skylake|Lakefield)\s?Lake|Broadwell|Skylake/i,
      `label keeps a codename: ${preset.label}`,
    );
  }
});

test('the Mac catalog contains only GPUs Apple actually shipped', () => {
  assert.ok(PRODUCT_MAC_ARM_RENDERERS.length >= 12);
  assert.ok(PRODUCT_MAC_INTEL_RENDERERS.length >= 20);
  for (const preset of PRODUCT_MAC_ARM_RENDERERS) {
    // Metal reports the chip, not the GPU-core count: a 7-core and an 8-core M1 both say "Apple M1".
    assert.match(preset.label, /^Apple M\d(?: (?:Pro|Max|Ultra))?$/, preset.label);
  }
  for (const preset of PRODUCT_MAC_INTEL_RENDERERS) {
    assert.doesNotMatch(
      preset.label,
      /Iris Xe|Arc|UHD Graphics (?:6[12]0|7[0-9]0)|Radeon (?:PRO )?W[67]\d00\b(?!X)|RX \d/,
      `not a GPU any Mac shipped: ${preset.label}`,
    );
  }
});
