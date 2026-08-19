import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebGlFingerprint } from '@lobster/shared-types';
import { webgpuIdentityFor } from './webgpu-identity.js';
import { deriveFingerprint } from './derive.js';
import { DEVICE_TEMPLATES } from './pools.js';

function gl(renderer: string): WebGlFingerprint {
  return {
    vendor: 'Google Inc.',
    renderer,
    unmaskedVendor: 'Google Inc.',
    unmaskedRenderer: renderer,
  };
}

test('an NVIDIA ANGLE renderer maps to Dawn vendor + architecture slugs', () => {
  const id = webgpuIdentityFor(
    gl('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503), D3D11-31.0.15.3179)'),
  );
  assert.equal(id.vendor, 'nvidia');
  assert.equal(id.architecture, 'ampere');
  assert.equal(id.description, 'NVIDIA GeForce RTX 3060');
  assert.equal(id.device, '0x00002503');
  assert.equal(id.adapterType, 'discrete');
});

test('an Intel iGPU is classified integrated and loses its shader-model tail', () => {
  const id = webgpuIdentityFor(
    gl('ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)'),
  );
  assert.equal(id.vendor, 'intel');
  assert.equal(id.architecture, 'gen-9');
  assert.equal(id.adapterType, 'integrated');
  // The D3D11 shader-model tail is driver noise, not part of the adapter name.
  assert.equal(id.description, 'Intel(R) UHD Graphics 630');
});

test('AMD is recognised under its ATI Technologies ANGLE vendor field', () => {
  const id = webgpuIdentityFor(
    gl('ANGLE (ATI Technologies Inc., AMD Radeon RX 6800 XT, D3D11-27.20.1034.6)'),
  );
  assert.equal(id.vendor, 'amd');
  assert.equal(id.architecture, 'rdna-2');
});

test('Apple Silicon is integrated with a unified-memory architecture slug', () => {
  const id = webgpuIdentityFor(
    gl('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'),
  );
  assert.equal(id.vendor, 'apple');
  assert.equal(id.architecture, 'apple-silicon');
  assert.equal(id.adapterType, 'integrated');
  assert.equal(id.description, 'Apple M2');
});

test('no catalog device is ever a CPU adapter, so isFallbackAdapter stays false', () => {
  // A persona always claims real hardware. adapterType 'cpu' would flip adapter.isFallbackAdapter
  // to true, contradicting every other GPU surface the same page can read.
  for (const tpl of Object.values(DEVICE_TEMPLATES)) {
    for (const device of tpl.devices) {
      assert.notEqual(webgpuIdentityFor(device.webgl).adapterType, 'cpu', device.webgl.renderer);
    }
  }
});

test('every catalog device yields a deterministic, well-formed identity', () => {
  for (const tpl of Object.values(DEVICE_TEMPLATES)) {
    for (const device of tpl.devices) {
      const a = webgpuIdentityFor(device.webgl);
      const b = webgpuIdentityFor(device.webgl);
      assert.deepEqual(a, b, `not deterministic: ${device.webgl.renderer}`);
      assert.match(a.device, /^0x[0-9a-f]{4}(?:[0-9a-f]{4})?$/, device.webgl.renderer);
      assert.ok(a.description.length > 0, `empty description: ${device.webgl.renderer}`);
      // An unresolved vendor would report the literal string "unknown" to every page — a marker no
      // real adapter emits, and worse than any specific vendor being slightly wrong.
      assert.notEqual(a.vendor, 'unknown', device.webgl.renderer);
    }
  }
});

test('a derived persona s WebGPU identity names the same GPU as its WebGL renderer', () => {
  // This is the exact cross-check a detector runs between navigator.gpu and
  // WEBGL_debug_renderer_info. Deriving one from the other makes disagreement unrepresentable.
  for (let seed = 1; seed <= 40; seed += 1) {
    for (const os of ['windows', 'macos', 'linux'] as const) {
      const fp = deriveFingerprint(`webgpu-coherence-${seed}`, { os, engine: 'lobium' });
      assert.ok(fp.webgpu, `seed ${seed} / ${os} has no webgpu block`);
      assert.deepEqual(webgpuIdentityFor(fp.webgl), fp.webgpu);
    }
  }
});
