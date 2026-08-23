import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOverrides, deriveFingerprint, webgpuIdentityFor } from './index.js';

test('applyOverrides merges navigator/screen/locale/fonts and leaves the rest untouched', () => {
  const base = deriveFingerprint('seed-ov', { os: 'windows', engine: 'lobium' });

  const out = applyOverrides(base, {
    navigator: { hardwareConcurrency: 16 },
    locale: { timezone: 'Europe/Paris' },
    fonts: ['Custom Font'],
  });

  assert.equal(out.navigator.hardwareConcurrency, 16);
  assert.equal(out.navigator.userAgent, base.navigator.userAgent, 'UA left untouched');
  assert.equal(out.locale.timezone, 'Europe/Paris');
  assert.equal(out.locale.locale, base.locale.locale, 'other locale fields untouched');
  assert.deepEqual(out.fonts, ['Custom Font']);
});

test('applyOverrides with no overrides returns the fingerprint unchanged', () => {
  const base = deriveFingerprint('seed-ov2', { os: 'macos', engine: 'lobium' });
  assert.deepEqual(applyOverrides(base), base);
  assert.deepEqual(applyOverrides(base, {}), base);
});

test('a legacy WebGL override atomically re-derives WebGPU identity', () => {
  const base = deriveFingerprint('seed-gpu-override', { os: 'windows', engine: 'lobium' });
  const out = applyOverrides(base, {
    webgl: {
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684), D3D11)',
      unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684), D3D11)',
    },
  });

  assert.notDeepEqual(out.webgpu, base.webgpu);
  assert.deepEqual(out.webgpu, webgpuIdentityFor(out.webgl));
});
