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

test('Apple Silicon reports the Metal family Dawn actually emits', () => {
  // Apple GPUs expose no deviceID through Metal, so Dawn cannot pattern-match them the way it does
  // PCI parts. PhysicalDeviceMTL.mm reports the highest supported family instead, which on macOS 13+
  // is "metal-3". "apple-silicon" appears nowhere in Dawn - it was a value no adapter could report.
  const id = webgpuIdentityFor(
    gl('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'),
  );
  assert.equal(id.vendor, 'apple');
  assert.equal(id.architecture, 'metal-3');
  assert.equal(id.adapterType, 'integrated');
  assert.equal(id.description, 'Apple M2');
});

test('every architecture we can emit is a name that exists in Dawn gpu_info.json', () => {
  // The defect class this closes: a plausible-sounding slug ('ada-lovelace', 'xe', 'apple-silicon')
  // that Dawn has no way of producing. Any such value identifies the product on the first
  // adapter.info read, so the whole emitted vocabulary is pinned here.
  const DAWN_ARCHITECTURES = new Set([
    '',
    // Nvidia
    'fermi', 'kepler', 'maxwell', 'pascal', 'volta', 'turing', 'ampere', 'lovelace', 'blackwell',
    // AMD / Samsung
    'terascale-2', 'gcn-1', 'gcn-2', 'gcn-3', 'gcn-4', 'gcn-5', 'cdna-1',
    'rdna-1', 'rdna-2', 'rdna-3', 'rdna-4',
    // Intel
    'gen-7', 'gen-8', 'gen-9', 'gen-11', 'gen-12lp', 'gen-12hp',
    'xe-lpg', 'xe-2lpg', 'xe-2hpg', 'xe-3lpg', 'xe-3lpg-xs',
    // Apple (Metal families), ARM, Qualcomm, Img Tec, software adapters
    'common-1', 'common-2', 'common-3', 'metal-3',
    'midgard', 'bifrost', 'valhall', 'gen-5',
    'adreno-4xx', 'adreno-5xx', 'adreno-6xx', 'adreno-7xx', 'adreno-8xx',
    'rogue', 'furian', 'b-series', 'd-series', 'videocore', 'maleoon',
    'swiftshader', 'warp', 'software',
  ]);
  for (const tpl of Object.values(DEVICE_TEMPLATES)) {
    for (const device of tpl.devices) {
      const id = webgpuIdentityFor(device.webgl);
      assert.ok(
        DAWN_ARCHITECTURES.has(id.architecture),
        `${device.id}: architecture "${id.architecture}" is not a name Dawn can emit`,
      );
    }
  }
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

test('mobile GPUs resolve a real architecture instead of falling through to the host', () => {
  // REGRESSION. ARM and Qualcomm architectures were named in the VENDORS comments and never mapped
  // in ARCHITECTURES, so every Android persona resolved to the vendor fallback of ''. An empty
  // architecture is what the engine treats as "no override", so the adapter reported the HOST's
  // instead: measured on a GPU-less box, a Mali-G68 persona answered architecture "swiftshader"
  // beside a spoofed "ANGLE (ARM, Mali-G68, OpenGL ES 3.2)" WebGL renderer - the software backend
  // named on the very surface the WebGL hook exists to hide.
  const arch = (renderer: string): string =>
    webgpuIdentityFor({ unmaskedRenderer: renderer, renderer } as never).architecture;

  assert.equal(arch('ANGLE (ARM, Mali-G68, OpenGL ES 3.2)'), 'valhall');
  assert.equal(arch('ANGLE (ARM, Mali-G78, OpenGL ES 3.2)'), 'valhall');
  // Longest-digits-first: G710 must not be captured by the G71 (Bifrost) pattern.
  assert.equal(arch('ANGLE (ARM, Mali-G710, OpenGL ES 3.2)'), 'valhall');
  assert.equal(arch('ANGLE (ARM, Mali-G715, OpenGL ES 3.2)'), 'valhall');
  assert.equal(arch('ANGLE (ARM, Mali-G76, OpenGL ES 3.2)'), 'bifrost');
  assert.equal(arch('ANGLE (ARM, Mali-T880, OpenGL ES 3.2)'), 'midgard');

  assert.equal(arch('ANGLE (Qualcomm, Adreno (TM) 619, OpenGL ES 3.2)'), 'adreno-6xx');
  assert.equal(arch('ANGLE (Qualcomm, Adreno (TM) 660, OpenGL ES 3.2)'), 'adreno-6xx');
  assert.equal(arch('ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)'), 'adreno-7xx');
  assert.equal(arch('ANGLE (Qualcomm, Adreno (TM) 750, OpenGL ES 3.2)'), 'adreno-7xx');

  // Never the product family, which is what a naive mapping would emit and no adapter reports.
  for (const r of ['ANGLE (ARM, Mali-G68, OpenGL ES 3.2)', 'ANGLE (Qualcomm, Adreno (TM) 660, OpenGL ES 3.2)']) {
    const a = arch(r);
    assert.ok(a !== 'mali' && a !== 'adreno', `${r} resolved to a product family: ${a}`);
    assert.ok(a.length > 0, `${r} resolved to an empty architecture, which the engine treats as no-override`);
  }
});
