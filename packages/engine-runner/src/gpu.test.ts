import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGpuArgs, isSoftwareRenderer, resolveGpuMode } from './gpu.js';

test('resolveGpuMode defaults to auto with no env and preserves prior behavior (no flags)', () => {
  assert.equal(resolveGpuMode({}), 'auto');
  assert.deepEqual(buildGpuArgs({ env: {} }), []);
});

test('resolveGpuMode reads truthy/software aliases from LOBSTER_GPU', () => {
  for (const v of ['gpu', 'on', '1', 'true', 'hardware', 'real']) {
    assert.equal(resolveGpuMode({ LOBSTER_GPU: v }), 'gpu', v);
  }
  for (const v of ['software', 'swiftshader', 'off', '0', 'false']) {
    assert.equal(resolveGpuMode({ LOBSTER_GPU: v }), 'software', v);
  }
  // Unknown values fall back to auto rather than silently forcing a mode.
  assert.equal(resolveGpuMode({ LOBSTER_GPU: 'banana' }), 'auto');
});

test('gpu mode forces ANGLE onto the physical driver (default Vulkan) and never SwiftShader', () => {
  const args = buildGpuArgs({ mode: 'gpu', env: {} });
  assert.ok(args.includes('--use-gl=angle'));
  assert.ok(args.includes('--use-angle=vulkan'));
  assert.ok(args.includes('--ignore-gpu-blocklist'));
  assert.ok(!args.some((a) => a.includes('swiftshader')));
});

test('gpu mode honors an explicit ANGLE backend override', () => {
  assert.ok(buildGpuArgs({ mode: 'gpu', angleBackend: 'gl' }).includes('--use-angle=gl'));
  assert.ok(
    buildGpuArgs({ mode: 'gpu', env: { LOBSTER_ANGLE_BACKEND: 'metal' } }).includes(
      '--use-angle=metal',
    ),
  );
});

test('software mode forces SwiftShader deterministically (CI/no-GPU)', () => {
  const args = buildGpuArgs({ mode: 'software', env: {} });
  assert.ok(args.includes('--use-angle=swiftshader'));
  assert.ok(args.includes('--enable-unsafe-swiftshader'));
});

test('isSoftwareRenderer flags SwiftShader/llvmpipe and clears real GPU strings', () => {
  assert.equal(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3 (SwiftShader Device))'), true);
  assert.equal(isSoftwareRenderer('ANGLE (Mesa, llvmpipe (LLVM 20.1.2), OpenGL 4.5)'), true);
  assert.equal(
    isSoftwareRenderer('ANGLE (NVIDIA, Vulkan 1.4.312 (NVIDIA GeForce RTX 5090), NVIDIA)'),
    false,
  );
  assert.equal(isSoftwareRenderer(null), false);
});
