import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allowProvisionalSoftwareGpu,
  buildGpuArgs,
  isSoftwareRenderer,
  resolveGpuMode,
} from './gpu.js';

test('auto mode permits the software GL fallback so WebGL is never simply absent', () => {
  assert.equal(resolveGpuMode({}), 'auto');
  // Auto used to emit nothing at all. On a host with no usable GPU that produced a browser whose
  // canvas.getContext('webgl') returned null - no 3D content, and a louder headless tell than any
  // renderer string, since real Chrome always has WebGL. The fallback is a permission, not a
  // preference: a real driver is still used wherever one exists.
  assert.deepEqual(buildGpuArgs({ env: {} }), ['--enable-unsafe-swiftshader']);
  // It must not *force* software: no backend is pinned in auto mode.
  assert.ok(!buildGpuArgs({ env: {} }).some((a) => a.startsWith('--use-angle=')));
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

test('gpu mode targets the physical driver and never SELECTS SwiftShader as the backend', () => {
  const args = buildGpuArgs({ mode: 'gpu', env: {} });
  assert.ok(args.includes('--use-gl=angle'));
  assert.ok(args.includes('--use-angle=vulkan'));
  assert.ok(args.includes('--ignore-gpu-blocklist'));
  // The backend must never be swiftshader here - that is what "forces the physical driver" means.
  assert.ok(!args.includes('--use-angle=swiftshader'));
  // But the software path stays PERMITTED: if the driver cannot come up, the alternative to a slow
  // context is no context, which breaks 3D and advertises a headless host.
  assert.ok(args.includes('--enable-unsafe-swiftshader'));
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

test('software calibration requires an explicit provisional acknowledgement', () => {
  assert.equal(allowProvisionalSoftwareGpu({}), false);
  assert.equal(
    allowProvisionalSoftwareGpu({ LOBSTER_ALLOW_SOFTWARE_GPU_CALIBRATION: 'true' }),
    true,
  );
  assert.equal(allowProvisionalSoftwareGpu({ LOBSTER_ALLOW_SOFTWARE_GPU_CALIBRATION: '0' }), false);
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
