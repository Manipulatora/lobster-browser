import assert from 'node:assert/strict';
import test from 'node:test';

import { generateSeed, isValidPersistedSeed, isValidSeed } from './seed.js';

test('fingerprint seeds use one exact 128-bit lowercase-hex representation', () => {
  const valid = '0123456789abcdef0123456789abcdef';
  assert.equal(isValidSeed(valid), true);
  assert.equal(isValidSeed(generateSeed()), true);

  for (const seed of [
    '',
    'g123456789abcdef0123456789abcdef',
    '0123456789ABCDEF0123456789ABCDEF',
    '0123456789abcdef0123456789abcde',
    '0123456789abcdef0123456789abcdef0',
    'a'.repeat(1024 * 1024),
  ]) {
    assert.equal(isValidSeed(seed), false, `accepted invalid seed of length ${seed.length}`);
  }
});

test('persisted fingerprint seeds accept only bounded legacy lowercase hex', () => {
  assert.equal(isValidPersistedSeed('deadbeef'), true);
  assert.equal(isValidPersistedSeed('0123456789abcdef0123456789abcdef'), true);
  assert.equal(isValidPersistedSeed('a'.repeat(256)), true);

  for (const seed of [
    '',
    'abcdefg',
    'deadbeeG',
    'DEADBEEF',
    'a'.repeat(257),
    'a'.repeat(1024 * 1024),
  ]) {
    assert.equal(
      isValidPersistedSeed(seed),
      false,
      `accepted invalid persisted seed of length ${seed.length}`,
    );
  }
});
