import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANDROID_PHONE_MODEL_CATALOG,
  ANDROID_TABLET_MODEL_CATALOG,
  MACOS_ARM_RENDERER_PRESETS,
  MACOS_FONT_NAMES,
  MACOS_INTEL_RENDERER_PRESETS,
  WINDOWS_10_FONT_NAMES,
  WINDOWS_11_FONT_NAMES,
  WINDOWS_BASE_FONT_NAMES,
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

test('the Windows font catalog is FAMILIES, the thing a page can actually match', () => {
  // This used to demand >= 300 Windows names, a floor only the old face-name extraction could clear
  // - so the assertion actively protected the defect. The MS Learn tables are
  // `Family | Font Name | File Name | Version` and the generator read column 1, collecting every
  // FACE: 506 rows, 336 ending in a style token. "Arial Bold" is not a family and
  // `font-family: "Arial Bold"` does not resolve on Windows; bold is a weight of Arial. Column 0 is
  // the family, and it is blank on the continuation rows that list a family's other faces.
  assert.equal(WINDOWS_11_FONT_NAMES.length, 141, 'Windows 11 ships 141 font families');
  assert.equal(WINDOWS_10_FONT_NAMES.length, 137, 'Windows 10 ships 137 font families');
  assert.ok(WINDOWS_FONT_NAMES.includes('Segoe UI'));
  assert.ok(MACOS_FONT_NAMES.some((font) => /Helvetica/i.test(font)));

  // No entry may be a style face. This is the regression that mattered.
  const STYLE =
    /\s(Bold|Italic|Oblique|Light|Semilight|Semibold|Demibold|Black|Heavy|Thin|Regular)(\s(Bold|Italic|Oblique))*$/;
  const faces = WINDOWS_FONT_NAMES.filter((f) => STYLE.test(f));
  // Microsoft genuinely names a few families with a weight - "Aharoni Bold" and
  // "BIZ UDMincho Medium" ship in one weight only - so the bar is "almost none", not "none".
  assert.ok(faces.length <= 6, `style faces leaked into the family list: ${faces.join(', ')}`);

  // Windows 11 really does add four families Windows 10 never had; merging the lists handed a
  // Windows 10 persona fonts from a later release.
  const onlyIn11 = WINDOWS_11_FONT_NAMES.filter((f) => !WINDOWS_10_FONT_NAMES.includes(f));
  assert.deepEqual(onlyIn11.slice().sort(), [
    'Cascadia Code',
    'Cascadia Mono',
    'Segoe Fluent Icons',
    'Segoe UI Variable',
  ]);

  // Only the first table is installed everywhere; every later table is a language Feature-On-Demand
  // pack that Windows adds with the language, not with the OS.
  assert.equal(WINDOWS_BASE_FONT_NAMES.length, 63, 'the always-present Windows base set');
  assert.ok(WINDOWS_BASE_FONT_NAMES.every((f) => WINDOWS_11_FONT_NAMES.includes(f)));
  assert.ok(WINDOWS_BASE_FONT_NAMES.includes('Segoe UI'));
  // Nirmala UI genuinely ships by default, so it is NOT a good negative. These are: Angsana New
  // arrives with the Thai pack, Arabic Typesetting with the Arabic pack.
  for (const packFont of ['Angsana New', 'Arabic Typesetting', 'DengXian']) {
    assert.ok(WINDOWS_11_FONT_NAMES.includes(packFont), `${packFont} should be in the full list`);
    assert.ok(
      !WINDOWS_BASE_FONT_NAMES.includes(packFont),
      `${packFont} arrives with a language pack, not with the OS`,
    );
  }
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

test('Windows ANGLE strings carry an 8-digit zero-padded device id, as gl::FmtHex emits', () => {
  // ANGLE builds the D3D11 renderer string with gl::FmtHex(DXGI_ADAPTER_DESC::DeviceId). FmtHexAutoSized
  // sizes the field as sizeof(T) * 2, and DeviceId is a UINT, so the field is always EIGHT uppercase
  // zero-padded hex digits. A four-digit "(0x2503)" is a shape no Chrome on Windows ever reports, and
  // it was what every one of these presets emitted. The real capture in host-calibration for this very
  // machine shows the same eight-wide field: "(0x0000C0DE)".
  assert.ok(WINDOWS_RENDERER_PRESETS.length > 0);
  for (const preset of WINDOWS_RENDERER_PRESETS) {
    const found = preset.webgl.unmaskedRenderer.match(/\((0x[0-9A-Fa-f]+)\)/);
    const hex = found?.[1];
    assert.ok(hex, `no device id in ${preset.webgl.unmaskedRenderer}`);
    assert.match(hex, /^0x[0-9A-F]{8}$/, `${preset.id}: ${hex} is not an 8-digit uppercase field`);
    // The raw PCI id stays four wide - the padding belongs to the rendered string, not the provenance.
    assert.equal(
      hex.slice(2).replace(/^0+/, '').toUpperCase(),
      preset.deviceId.replace(/^0x/i, '').replace(/^0+/, '').toUpperCase(),
      `${preset.id}: padded id must be the same device as deviceId`,
    );
  }
});

test('per-backend WebGL limits match what ANGLE computes for that backend', () => {
  // These are not style preferences; each is a number ANGLE derives in code, so a persona that
  // reports anything else is caught by one getParameter call. Sources, all in
  // third_party/angle/src/libANGLE/renderer:
  //
  //   d3d11/renderer11_utils.cpp  maxViewportWidth = D3D11_VIEWPORT_BOUNDS_MAX (32767), NOT the
  //                               texture size; maxVertexUniformVectors =
  //                               D3D11_REQ_CONSTANT_BUFFER_ELEMENT_COUNT (4096).
  //   metal/DisplayMtl.mm         maxViewportWidth = max2DTextureSize (16384);
  //                               maxVaryingVectors = 31 - 1 ("exclude [[position]]" on macOS).
  //   gl/renderergl_utils.cpp     maxVertexUniformVectors = std::min(1024, driver value) - a hard
  //                               clamp, so >1024 is unreachable on Linux however capable the GPU.
  const expectations = [
    // vertexUniforms is vendor-dependent on D3D11, so it is asserted per preset below rather than here.
    { presets: PRODUCT_WINDOWS_RENDERERS, backend: 'D3D11', viewport: 32767 },
    { presets: PRODUCT_MAC_ARM_RENDERERS, backend: 'Metal', viewport: 16384, varying: 30 },
    { presets: PRODUCT_MAC_INTEL_RENDERERS, backend: 'Metal', viewport: 16384, varying: 30 },
    { presets: PRODUCT_LINUX_RENDERERS, backend: 'GL', viewport: 16384, vertexUniforms: 1024 },
  ];
  for (const e of expectations) {
    assert.ok(e.presets.length > 0, `${e.backend} presets must not be empty`);
    for (const preset of e.presets) {
      const caps = preset.webgl.caps;
      assert.ok(caps, `${preset.id} has no caps`);
      assert.deepEqual(
        caps.maxViewportDims,
        [e.viewport, e.viewport],
        `${preset.id} (${e.backend}): MAX_VIEWPORT_DIMS`,
      );
      if (e.vertexUniforms !== undefined) {
        assert.equal(
          caps.maxVertexUniformVectors,
          e.vertexUniforms,
          `${preset.id} (${e.backend}): MAX_VERTEX_UNIFORM_VECTORS`,
        );
      }
      if (e.varying !== undefined) {
        assert.equal(
          caps.maxVaryingVectors,
          e.varying,
          `${preset.id} (${e.backend}): MAX_VARYING_VECTORS`,
        );
      }
    }
  }

  // D3D11 splits by vendor: ANGLE enables skipVSConstantRegisterZero on NVIDIA and only NVIDIA,
  // which subtracts one from D3D11_REQ_CONSTANT_BUFFER_ELEMENT_COUNT. A GeForce persona reporting
  // 4096 contradicts its own renderer string.
  for (const preset of PRODUCT_WINDOWS_RENDERERS) {
    const expected = preset.vendorFamily === 'NVIDIA' ? 4095 : 4096;
    assert.equal(
      preset.webgl.caps?.maxVertexUniformVectors,
      expected,
      `${preset.id} (${preset.vendorFamily}): MAX_VERTEX_UNIFORM_VECTORS`,
    );
  }
});

test('every Apple Silicon persona pairs a chip with a panel Apple actually sold together', () => {
  // The defect class: a coherent-looking Mac that Apple never made. A base M1 with a 14" MacBook Pro
  // panel is two individually-plausible values whose COMBINATION is impossible - and a page reads
  // both at once, from screen.* and the WebGL/WebGPU renderer. The 14" and 16" Pro chassis only ever
  // took Pro/Max chips; the base chips shipped in the Air and the 13" Pro (and, from M3, the 14").
  const RETINA_DEFAULTS: Record<string, ReadonlyArray<readonly [number, number]>> = {
    // chip -> the "looks like" CSS sizes Apple ships it in
    M1: [[1440, 900], [1280, 800], [2048, 1152]], // Air 13", Pro 13", iMac 24"
    M2: [[1470, 956], [1280, 800]], //               Air 13.6", Pro 13"
    M3: [[1470, 956], [1710, 1107], [1512, 982], [2048, 1152]], // Air 13.6"/15.3", Pro 14", iMac 24"
    'M1 Pro': [[1512, 982], [1728, 1117]],
    'M1 Max': [[1512, 982], [1728, 1117]],
    'M2 Pro': [[1512, 982], [1728, 1117]],
    'M2 Max': [[1512, 982], [1728, 1117]],
    'M3 Pro': [[1512, 982], [1728, 1117]],
    'M3 Max': [[1512, 982], [1728, 1117]],
  };
  let checked = 0;
  for (const device of DEVICE_TEMPLATES.macos.devices) {
    const chip = /Apple\s+(M\d(?:\s+(?:Pro|Max|Ultra))?)/.exec(device.webgl.renderer)?.[1];
    if (!chip) continue; // Intel Macs are covered by their own rows
    const allowed = RETINA_DEFAULTS[chip];
    if (!allowed) continue; // a chip this test does not yet model rather than a silent pass
    checked += 1;
    const got: readonly [number, number] = [device.screen.width, device.screen.height];
    assert.ok(
      allowed.some(([w, h]) => w === got[0] && h === got[1]),
      `${device.id}: Apple never sold ${chip} with a ${got[0]}x${got[1]} panel ` +
        `(valid: ${allowed.map(([w, h]) => `${w}x${h}`).join(', ')})`,
    );
    assert.equal(device.screen.dpr, 2, `${device.id}: every Retina Mac reports devicePixelRatio 2`);
  }
  assert.ok(checked >= 3, `expected several Apple Silicon personas, checked ${checked}`);
});

test('Linux renderer strings are driver-shaped, never a bare PCI id', () => {
  // Each Linux driver reports its own thing, and none of them puts a hex device id where this
  // catalog used to: NVIDIA appends "/PCIe/SSE2", Mesa radeonsi appends
  // "(radeonsi, <gfx>, LLVM ..., DRM ..., <kernel>)", Mesa iris appends "(<ARCH> GTn)". The old
  // template emitted "<model> (0x1B01)" for all three - a shape no Linux GL_RENDERER contains.
  assert.ok(PRODUCT_LINUX_RENDERERS.length > 0);
  for (const preset of PRODUCT_LINUX_RENDERERS) {
    const r = preset.webgl.unmaskedRenderer;
    assert.ok(!/\(0x[0-9A-Fa-f]+\)/.test(r), `${preset.id}: bare PCI id in a Linux renderer: ${r}`);
    if (preset.vendorFamily === 'NVIDIA') {
      assert.match(r, /\/PCIe\/SSE2, OpenGL 4\.6\.0\)$/, `${preset.id}: NVIDIA proprietary shape`);
    } else if (preset.vendorFamily === 'AMD') {
      assert.match(r, /\(radeonsi, [a-z0-9]+, LLVM [\d.]+, DRM [\d.]+, [\d.]+\), OpenGL 4\.6\)$/,
        `${preset.id}: Mesa radeonsi shape`);
    } else {
      assert.match(r, /^ANGLE \(Intel, Mesa Intel\(R\) .+, OpenGL 4\.6\)$/, `${preset.id}: Mesa iris shape`);
    }
  }
});
