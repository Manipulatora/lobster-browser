import assert from 'node:assert/strict';
import test from 'node:test';
import type { OsFamily } from '@lobster/shared-types';
import { validateFingerprintCoherence } from './coherence.js';
import { generateFingerprint } from './generate.js';
import { generateSeed } from './seed.js';

const OSES: OsFamily[] = ['windows', 'macos', 'linux'];

// Proves the Apify generator path actually produces a coherent Chrome fingerprint — NOT the built-in
// fallback pools. deriveFingerprint() swallows generator errors and falls back, so this test calls
// the generator directly and asserts non-null + coherent + Chrome brands across the matrix.
test('generateFingerprint returns a coherent, non-null Chrome fingerprint from real-device data', () => {
  for (let i = 0; i < 30; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      const fp = generateFingerprint(seed, os, 'x86_64');
      assert.ok(fp !== null, `generator returned null for ${os} seed=${seed}`);
      assert.deepEqual(validateFingerprintCoherence(fp), [], `incoherent ${os} seed=${seed}`);
      assert.ok(
        fp.navigator.uaBrands.length > 0,
        `expected Chrome Sec-CH-UA brands ${os} seed=${seed}`,
      );
    }
  }
});
