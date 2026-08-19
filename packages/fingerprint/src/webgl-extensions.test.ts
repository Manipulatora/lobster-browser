import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WEBGL1_REGISTRATION_ORDER,
  WEBGL2_REGISTRATION_ORDER,
  isAppleSiliconRenderer,
  webgl1ExtensionsFor,
  webgl2ExtensionsFor,
} from './webgl-extensions.js';
import { deriveFingerprint } from './derive.js';

test('the extension list is in Chrome registration order, never alphabetical', () => {
  // The order is a property of the Chromium build (the sequence of RegisterExtension<T>() calls),
  // not of the GPU. An alphabetised list is a shape no real Chrome emits, and was the exact defect
  // in the old host-calibration path.
  for (const os of ['windows', 'macos', 'linux'] as const) {
    const list = webgl1ExtensionsFor(os);
    const alphabetical = [...list].sort((a, b) => a.localeCompare(b));
    assert.notDeepEqual(list, alphabetical, `${os} WebGL1 list is alphabetised`);

    // Every entry must appear in the canonical order, and in the same relative sequence.
    const canonical: readonly string[] = WEBGL1_REGISTRATION_ORDER;
    const positions = list.map((n) => canonical.indexOf(n));
    assert.ok(
      positions.every((p) => p >= 0),
      `${os} emitted a name absent from the registration order`,
    );
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
      `${os} order scrambled`,
    );
  }
});

test('a PC GPU gets the desktop block-compression formats and no mobile ones', () => {
  for (const os of ['windows', 'linux'] as const) {
    const list = new Set(webgl1ExtensionsFor(os, { appleSilicon: false }));
    for (const n of [
      'WEBGL_compressed_texture_s3tc',
      'WEBGL_compressed_texture_s3tc_srgb',
      'EXT_texture_compression_bptc',
      'EXT_texture_compression_rgtc',
    ]) {
      assert.ok(list.has(n), `${os} should expose ${n}`);
    }
    for (const n of [
      'WEBGL_compressed_texture_astc',
      'WEBGL_compressed_texture_etc',
      'WEBGL_compressed_texture_etc1',
      'WEBGL_compressed_texture_pvrtc',
    ]) {
      assert.ok(!list.has(n), `${os} must not expose the mobile format ${n}`);
    }
  }
});

test('Apple Silicon flips the compression family, because its GPU is mobile-derived', () => {
  // Getting this backwards is a hard contradiction: an M-series Mac exposing S3TC/BPTC, or lacking
  // ASTC/ETC, is a combination no real machine produces.
  const list = new Set(webgl1ExtensionsFor('macos', { appleSilicon: true }));
  for (const n of ['WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc']) {
    assert.ok(list.has(n), `Apple Silicon should expose ${n}`);
  }
  for (const n of ['WEBGL_compressed_texture_s3tc', 'EXT_texture_compression_bptc']) {
    assert.ok(!list.has(n), `Apple Silicon must not expose ${n}`);
  }
  assert.ok(!list.has('WEBGL_compressed_texture_pvrtc'), 'PVRTC is PowerVR-only, never a Mac');
});

test('macOS omits the timer query, which the Metal backend does not implement', () => {
  assert.ok(!webgl1ExtensionsFor('macos').includes('EXT_disjoint_timer_query'));
  assert.ok(!webgl2ExtensionsFor('macos').includes('EXT_disjoint_timer_query_webgl2'));
  assert.ok(webgl1ExtensionsFor('windows').includes('EXT_disjoint_timer_query'));
});

test('WebGL2 is a different list, not a superset of WebGL1', () => {
  // WebGL2 folds several WebGL1 extensions into core, so they must NOT appear in its list. Serving
  // the WebGL1-calibrated list to a WebGL2 context is a distinct audit finding.
  const gl2 = new Set(webgl2ExtensionsFor('windows'));
  for (const foldedIntoCore of [
    'ANGLE_instanced_arrays',
    'OES_vertex_array_object',
    'WEBGL_depth_texture',
    'WEBGL_draw_buffers',
    'OES_texture_float',
    'OES_element_index_uint',
  ]) {
    assert.ok(
      !gl2.has(foldedIntoCore),
      `${foldedIntoCore} is core in WebGL2 and must not be listed`,
    );
  }
  assert.ok(gl2.has('EXT_color_buffer_float'), 'WebGL2-only extension missing');
  assert.notDeepEqual(webgl1ExtensionsFor('windows'), webgl2ExtensionsFor('windows'));
});

test('no name is duplicated and none is empty', () => {
  for (const order of [WEBGL1_REGISTRATION_ORDER, WEBGL2_REGISTRATION_ORDER]) {
    assert.equal(new Set(order).size, order.length, 'duplicate extension name');
    assert.ok(
      order.every((n) => /^[A-Z][A-Za-z0-9_]+$/.test(n)),
      'malformed extension name',
    );
  }
});

test('isAppleSiliconRenderer recognises the M-series renderer strings', () => {
  assert.ok(
    isAppleSiliconRenderer(
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)',
    ),
  );
  assert.ok(
    !isAppleSiliconRenderer(
      'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ),
  );
});

test('a derived persona actually carries the deep WebGL surfaces', () => {
  // Regression: the catalog used to supply only vendor/renderer/caps, so version, GLSL version and
  // the extension list fell through to the HOST — a persona claiming one GPU while presenting
  // another GPU's extension set.
  for (const os of ['windows', 'macos', 'linux'] as const) {
    const fp = deriveFingerprint(`deep-${os}`, { os, engine: 'lobium' });
    assert.equal(fp.webgl.version, 'WebGL 1.0 (OpenGL ES 2.0 Chromium)', os);
    assert.equal(
      fp.webgl.shadingLanguageVersion,
      'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      os,
    );
    assert.ok((fp.webgl.extensions?.length ?? 0) >= 30, `${os} extension list too short`);
    assert.ok(fp.webgl.extensions?.includes('WEBGL_debug_renderer_info'), os);
  }
});
