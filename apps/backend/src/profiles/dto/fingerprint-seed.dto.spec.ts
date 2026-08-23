import 'reflect-metadata';

import assert from 'node:assert/strict';
import test from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateProfileDto } from './create-profile.dto';
import { ImportProfilesDto } from './import-profiles.dto';

const VALID_SEED = '0123456789abcdef0123456789abcdef';

function createBody(seed?: string): CreateProfileDto {
  return plainToInstance(CreateProfileDto, {
    name: 'Seed boundary',
    engine: 'lobium',
    os: 'windows',
    ...(seed !== undefined ? { fingerprintSeed: seed } : {}),
  });
}

function importBody(seed: string): ImportProfilesDto {
  return plainToInstance(ImportProfilesDto, {
    version: 1,
    profiles: [
      {
        name: 'Imported identity',
        engine: 'lobium',
        os: 'windows',
        fingerprintSeed: seed,
      },
    ],
  });
}

test('create rejects every non-canonical fingerprint seed', async () => {
  const invalid = [
    '',
    'g123456789abcdef0123456789abcdef',
    '0123456789ABCDEF0123456789ABCDEF',
    '0123456789abcdef0123456789abcde',
    '0123456789abcdef0123456789abcdef0',
    'a'.repeat(1024 * 1024),
  ];

  for (const seed of invalid) {
    assert.notEqual(
      (await validate(createBody(seed))).length,
      0,
      `create accepted invalid seed of length ${seed.length}`,
    );
  }
});

test('import rejects malformed or unbounded legacy fingerprint seeds', async () => {
  const invalid = ['', 'abcdefg', 'deadbeeG', 'DEADBEEF', 'a'.repeat(257), 'a'.repeat(1024 * 1024)];

  for (const seed of invalid) {
    assert.notEqual(
      (await validate(importBody(seed))).length,
      0,
      `import accepted invalid seed of length ${seed.length}`,
    );
  }
});

test('create may generate an omitted seed, while an exact seed survives create/import DTOs verbatim', async () => {
  assert.deepEqual(await validate(createBody()), [], 'omission must retain server-side generation');

  const supplied = createBody(VALID_SEED);
  assert.deepEqual(await validate(supplied), []);
  assert.equal(supplied.fingerprintSeed, VALID_SEED);

  const imported = importBody(VALID_SEED);
  assert.deepEqual(await validate(imported), []);
  assert.equal(
    imported.profiles[0]?.fingerprintSeed,
    VALID_SEED,
    'import identity must be preserved',
  );

  const legacy = importBody('deadbeef');
  assert.deepEqual(await validate(legacy), []);
  assert.equal(
    legacy.profiles[0]?.fingerprintSeed,
    'deadbeef',
    'legacy import identity must be preserved without reseeding',
  );
});
