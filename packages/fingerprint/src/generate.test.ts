import assert from 'node:assert/strict';
import test from 'node:test';
import type { OsFamily } from '@lobster/shared-types';
import { validateFingerprintCoherence } from './coherence.js';
import { generateFingerprint } from './generate.js';

const OSES: OsFamily[] = ['windows', 'macos', 'linux'];

// Proves the Apify generator path — NOT the built-in fallback pools — produces our fingerprints, and
// that whatever it returns is always coherent. deriveFingerprint() swallows generator misses and falls
// back, so this calls the generator directly. It does NOT claim 100%: the generator legitimately rejects
// some real-device samples (foreign/HeadlessChrome brands, empty brands, incoherent version pairs), most
// often on Linux, so we assert the generator path DOMINATES (>= 90%) rather than never missing. Fixed
// seeds keep the result reproducible.
test('generateFingerprint produces coherent Chrome fingerprints from real-device data (path dominates)', () => {
  const N = 60;
  for (const os of OSES) {
    let nonNull = 0;
    for (let i = 0; i < N; i++) {
      const fp = generateFingerprint(`gen-${os}-${i}`, os, 'x86_64');
      if (fp === null) continue; // rare: the deterministic fallback (deriveFingerprint) covers it
      nonNull++;
      assert.deepEqual(validateFingerprintCoherence(fp), [], `incoherent ${os} i=${i}`);
      assert.ok(fp.navigator.uaBrands.length > 0, `expected Sec-CH-UA brands ${os} i=${i}`);
    }
    assert.ok(
      nonNull >= N * 0.9,
      `generator path too weak for ${os}: only ${nonNull}/${N} non-null`,
    );
  }
});
