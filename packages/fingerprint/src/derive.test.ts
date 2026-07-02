import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineKind, OsFamily } from '@lobster/shared-types';
import { validateFingerprintCoherence } from './coherence.js';
import { deriveFingerprint } from './derive.js';
import { generateSeed } from './seed.js';

const OSES: OsFamily[] = ['windows', 'macos', 'linux'];
const ENGINES: EngineKind[] = ['kernel', 'chromium', 'camoufox'];

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

test('kernel + chromium present Chrome UA & Sec-CH-UA brands; camoufox presents Firefox & none', () => {
  for (let i = 0; i < 25; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      const kernel = deriveFingerprint(seed, { os, engine: 'kernel' });
      const chromium = deriveFingerprint(seed, { os, engine: 'chromium' });
      const camoufox = deriveFingerprint(seed, { os, engine: 'camoufox' });

      assert.match(kernel.navigator.userAgent, /Chrome\//, `kernel UA ${os} seed=${seed}`);
      assert.ok(kernel.navigator.uaBrands.length > 0, `kernel brands ${os} seed=${seed}`);
      assert.match(chromium.navigator.userAgent, /Chrome\//, `chromium UA ${os} seed=${seed}`);
      assert.ok(chromium.navigator.uaBrands.length > 0, `chromium brands ${os} seed=${seed}`);
      assert.match(camoufox.navigator.userAgent, /Firefox\//, `camoufox UA ${os} seed=${seed}`);
      assert.equal(camoufox.navigator.uaBrands.length, 0, `camoufox brands ${os} seed=${seed}`);
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
      // Plausible desktop screen; also guards against the generator's 800x600 placeholder.
      assert.ok(fp.screen.width >= 1024, `screen width ${fp.screen.width} ${os} seed=${seed}`);
      assert.ok(fp.screen.height >= 600, `screen height ${fp.screen.height} ${os} seed=${seed}`);
      assert.ok(fp.screen.availWidth <= fp.screen.width);
      assert.ok(fp.screen.availHeight <= fp.screen.height);
      assert.ok(fp.navigator.hardwareConcurrency > 0);
      assert.equal(fp.locale.locale, fp.navigator.languages[0]);
    }
  }
});
