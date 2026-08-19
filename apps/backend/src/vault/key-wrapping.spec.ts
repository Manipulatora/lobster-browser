import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import type { ConfigService } from '@nestjs/config';

import { VaultKeyWrapper } from './key-wrapping';

function configOf(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const MASTER = randomBytes(32).toString('base64');

test('a wrapped key round-trips and does not resemble the key it holds', () => {
  const wrapper = new VaultKeyWrapper(configOf({ VAULT_MASTER_KEY: MASTER }));
  const dataKey = randomBytes(32);

  const stored = wrapper.wrap(dataKey);
  assert.ok(!stored.includes(dataKey), 'the stored bytes must not contain the key itself');
  assert.deepEqual(wrapper.unwrap(stored), dataKey);

  // Fresh nonce each time, or two wraps of the same key would be a distinguisher.
  assert.notDeepEqual(wrapper.wrap(dataKey), stored);
});

test('a row written before wrapping existed is still readable', () => {
  const wrapper = new VaultKeyWrapper(configOf({ VAULT_MASTER_KEY: MASTER }));
  const legacy = randomBytes(32);
  // Turning wrapping on must not lock every existing account out of its own profiles.
  assert.deepEqual(wrapper.unwrap(legacy), legacy);
});

test('a tampered envelope is refused rather than half-decrypted', () => {
  const wrapper = new VaultKeyWrapper(configOf({ VAULT_MASTER_KEY: MASTER }));
  const stored = wrapper.wrap(randomBytes(32));
  stored[stored.length - 1] ^= 0xff;

  assert.throws(() => wrapper.unwrap(stored));
});

test('another deployment’s master key does not open these rows', () => {
  const stored = new VaultKeyWrapper(configOf({ VAULT_MASTER_KEY: MASTER })).wrap(randomBytes(32));
  const other = new VaultKeyWrapper(
    configOf({ VAULT_MASTER_KEY: randomBytes(32).toString('base64') }),
  );

  // The point of the whole exercise: the dump travels, the master key does not.
  assert.throws(() => other.unwrap(stored));
});

test('a master key of the wrong size is refused at construction, not at first use', () => {
  assert.throws(
    () => new VaultKeyWrapper(configOf({ VAULT_MASTER_KEY: randomBytes(16).toString('base64') })),
    /32 bytes/,
  );
});

test('production refuses to start without a master key unless told to in writing', () => {
  assert.throws(
    () => new VaultKeyWrapper(configOf({ NODE_ENV: 'production' })),
    /VAULT_MASTER_KEY is required/,
  );

  const acknowledged = new VaultKeyWrapper(
    configOf({ NODE_ENV: 'production', ALLOW_PLAINTEXT_VAULT_KEYS: '1' }),
  );
  const dataKey = randomBytes(32);
  assert.deepEqual(acknowledged.wrap(dataKey), dataKey, 'unwrapped, as acknowledged');
});

test('an unconfigured dev instance stores keys as they always were', () => {
  const wrapper = new VaultKeyWrapper(configOf({}));
  const dataKey = randomBytes(32);
  assert.deepEqual(wrapper.unwrap(wrapper.wrap(dataKey)), dataKey);
});

test('a wrapped row with the master key gone is a loud failure, not a wrong key', () => {
  const stored = new VaultKeyWrapper(configOf({ VAULT_MASTER_KEY: MASTER })).wrap(randomBytes(32));
  // Handing back garbage would seal the next snapshot under a key nothing can read again.
  assert.throws(() => new VaultKeyWrapper(configOf({})).unwrap(stored), /VAULT_MASTER_KEY/);
});
