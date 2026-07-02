import assert from 'node:assert/strict';
import test from 'node:test';
import type { CpuArch, EngineKind, OsFamily } from '@lobster/shared-types';
import { DESKTOP_MIN_DEVICE_MEMORY, validateFingerprintCoherence } from './coherence.js';
import { deriveFingerprint, deriveFromPools } from './derive.js';
import { generateSeed } from './seed.js';

const OSES: OsFamily[] = ['windows', 'macos', 'linux'];
const ENGINES: EngineKind[] = ['lobium', 'chromium'];

test('deriveFingerprint is deterministic across 50 seeds x OS x engine', () => {
  for (let i = 0; i < 50; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      for (const engine of ENGINES) {
        const a = deriveFingerprint(seed, { os, engine });
        const b = deriveFingerprint(seed, { os, engine });
        assert.deepEqual(a, b, `non-deterministic for ${os}/${engine} seed=${seed}`);
      }
    }
  }
});

test('a fixed seed produces byte-identical output (stable profile identity)', () => {
  const a = deriveFingerprint('fixed-seed-001', { os: 'windows', engine: 'chromium' });
  const b = deriveFingerprint('fixed-seed-001', { os: 'windows', engine: 'chromium' });
  assert.deepEqual(a, b);
});

test('generated fingerprints are internally coherent across 50 seeds x OS x engine', () => {
  for (let i = 0; i < 50; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      for (const engine of ENGINES) {
        const fp = deriveFingerprint(seed, { os, engine });
        assert.deepEqual(
          validateFingerprintCoherence(fp),
          [],
          `incoherent ${os}/${engine} seed=${seed}`,
        );
      }
    }
  }
});

test('every engine presents a Chrome UA + Sec-CH-UA brands (both engines are Chromium-based)', () => {
  for (let i = 0; i < 25; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      for (const engine of ENGINES) {
        const fp = deriveFingerprint(seed, { os, engine });
        assert.match(fp.navigator.userAgent, /Chrome\//, `${engine} UA ${os} seed=${seed}`);
        assert.ok(fp.navigator.uaBrands.length > 0, `${engine} brands ${os} seed=${seed}`);
        assert.ok(fp.navigator.uaFullVersion.length > 0, `${engine} version ${os} seed=${seed}`);
      }
    }
  }
});

test('derives real-device data (rich fonts, real GPU, plausible screen) from the generator', () => {
  for (let i = 0; i < 25; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      const fp = deriveFingerprint(seed, { os, engine: 'chromium' });

      assert.ok(fp.fonts.length > 0, `fonts empty ${os} seed=${seed}`);
      assert.ok(fp.webgl.renderer.length > 0, `webgl renderer empty ${os} seed=${seed}`);
      assert.ok(fp.webgl.vendor.length > 0, `webgl vendor empty ${os} seed=${seed}`);
      assert.equal(fp.webgl.unmaskedRenderer, fp.webgl.renderer);
      assert.ok(fp.screen.width >= 1024, `screen width ${fp.screen.width} ${os} seed=${seed}`);
      assert.ok(fp.screen.height >= 600, `screen height ${fp.screen.height} ${os} seed=${seed}`);
      assert.ok(fp.screen.availWidth <= fp.screen.width);
      assert.ok(fp.screen.availHeight <= fp.screen.height);
      assert.ok(fp.navigator.hardwareConcurrency > 0);
      assert.equal(fp.locale.locale, fp.navigator.languages[0]);
    }
  }
});

test('no desktop profile advertises an implausibly low deviceMemory (>= 4 GB, capped at 8)', () => {
  for (let i = 0; i < 200; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      const fp = deriveFingerprint(seed, { os, engine: 'chromium' });
      assert.ok(
        fp.navigator.deviceMemory >= DESKTOP_MIN_DEVICE_MEMORY && fp.navigator.deviceMemory <= 8,
        `deviceMemory ${fp.navigator.deviceMemory} out of [${DESKTOP_MIN_DEVICE_MEMORY},8] for ${os} seed=${seed}`,
      );
    }
  }
});

test('the built-in pool fallback is itself coherent for every OS/arch', () => {
  const ARCHES: CpuArch[] = ['x86_64', 'arm64'];
  for (let i = 0; i < 25; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      for (const arch of ARCHES) {
        const fp = deriveFromPools(seed, os, arch);
        assert.deepEqual(
          validateFingerprintCoherence(fp),
          [],
          `incoherent pool fallback ${os}/${arch} seed=${seed}`,
        );
      }
    }
  }
});
