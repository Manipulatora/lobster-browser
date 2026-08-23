import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCanonicalFingerprintSeed,
  canonicalFingerprintSeed,
} from './canonical-seed.mjs';

test('human-readable detector fixture labels map to stable production-shaped seeds', () => {
  const first = canonicalFingerprintSeed('fleet-win-nvidia-3080');
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.equal(first, canonicalFingerprintSeed('fleet-win-nvidia-3080'));
  assert.notEqual(first, canonicalFingerprintSeed('fleet-win-nvidia-1660'));
});

test('literal environment overrides fail early unless they already use the canonical shape', () => {
  const canonical = '0123456789abcdef0123456789abcdef';
  assert.equal(assertCanonicalFingerprintSeed(canonical, 'TEST_SEED'), canonical);
  assert.throws(
    () => assertCanonicalFingerprintSeed('human-readable-seed', 'TEST_SEED'),
    /TEST_SEED must be exactly 32 lowercase hexadecimal characters/,
  );
});
