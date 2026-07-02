import assert from 'node:assert/strict';
import test from 'node:test';
import type { OsFamily } from '@lobster/shared-types';
import { validateFingerprintCoherence } from './coherence.js';
import { generateFingerprint, type BrowserName } from './generate.js';
import { generateSeed } from './seed.js';

const OSES: OsFamily[] = ['windows', 'macos', 'linux'];
const BROWSERS: BrowserName[] = ['chrome', 'firefox'];

// Proves the Apify generator path actually produces a coherent fingerprint — NOT the built-in
// fallback pools. deriveFingerprint() swallows generator errors and falls back, so this test calls
// the generator directly and asserts non-null + coherent for the whole matrix.
test('generateFingerprint returns a coherent, non-null fingerprint from real-device data', () => {
  for (let i = 0; i < 20; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      for (const browser of BROWSERS) {
        const fp = generateFingerprint(seed, os, browser, 'x86_64');
        assert.ok(fp !== null, `generator returned null for ${os}/${browser} seed=${seed}`);
        assert.deepEqual(
          validateFingerprintCoherence(fp),
          [],
          `incoherent ${os}/${browser} seed=${seed}`,
        );
      }
    }
  }
});
