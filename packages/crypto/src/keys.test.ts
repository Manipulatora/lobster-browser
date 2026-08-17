/**
 * SEC-2 acceptance tests: key hierarchy wrap/unwrap, HKDF PCK stability, wrong-password fail.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  bootstrapTeamKeys,
  decryptProfileBlob,
  deriveKeyId,
  deriveProfileContentKey,
  encryptProfileBlob,
  generateSymmetricKey,
  KeyHierarchyError,
  unlockTeamKeys,
  unwrapKey,
  wrapKey,
  wrapTeamDataKeyForMember,
} from './index.js';

/** Fast Argon2 params for unit tests only (not production). */
const FAST = { memoryKiB: 8, iterations: 1, parallelism: 1 };

describe('SEC-2 key hierarchy', () => {
  it('wraps and unwraps a 32-byte key under AES-GCM', () => {
    const wrapping = generateSymmetricKey();
    const plaintext = generateSymmetricKey();
    const wrapped = wrapKey(plaintext, wrapping);
    assert.equal(wrapped.subarray(0, 4).toString('ascii'), 'LKw1');
    assert.deepEqual(unwrapKey(wrapped, wrapping), plaintext);
    assert.throws(() => unwrapKey(wrapped, generateSymmetricKey()), KeyHierarchyError);
  });

  it('derives a stable PCK + key_id from TDK + profileId', () => {
    const tdk = generateSymmetricKey();
    const a = deriveProfileContentKey(tdk, 'p_abc');
    const b = deriveProfileContentKey(tdk, 'p_abc');
    const c = deriveProfileContentKey(tdk, 'p_other');
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
    assert.equal(a.length, 32);
    assert.deepEqual(deriveKeyId(tdk, 'p_abc'), deriveKeyId(tdk, 'p_abc'));
    assert.notDeepEqual(deriveKeyId(tdk, 'p_abc'), deriveKeyId(tdk, 'p_other'));
  });

  it('bootstraps team keys and unlocks with the same password', async () => {
    const boot = await bootstrapTeamKeys('correct horse battery', FAST);
    const unlocked = await unlockTeamKeys(
      'correct horse battery',
      boot.passwordSalt,
      boot.wrappedUserKeyWrappingKey,
      boot.wrappedTeamDataKey,
      FAST,
    );
    assert.deepEqual(unlocked.userKeyWrappingKey, boot.userKeyWrappingKey);
    assert.deepEqual(unlocked.teamDataKey, boot.teamDataKey);
  });

  it('fails closed on wrong password', async () => {
    const boot = await bootstrapTeamKeys('right-password', FAST);
    await assert.rejects(
      () =>
        unlockTeamKeys(
          'wrong-password',
          boot.passwordSalt,
          boot.wrappedUserKeyWrappingKey,
          boot.wrappedTeamDataKey,
          FAST,
        ),
      KeyHierarchyError,
    );
  });

  it('re-wraps TDK for a new member and encrypts a profile blob under derived PCK', async () => {
    const owner = await bootstrapTeamKeys('owner-pass', FAST);
    const memberUkwk = generateSymmetricKey();
    const wrappedForMember = wrapTeamDataKeyForMember(owner.teamDataKey, memberUkwk);
    const memberTdk = unwrapKey(wrappedForMember, memberUkwk);
    assert.deepEqual(memberTdk, owner.teamDataKey);

    const profileId = 'p_shared_1';
    const pck = deriveProfileContentKey(memberTdk, profileId);
    const keyId = deriveKeyId(memberTdk, profileId);
    const envelope = encryptProfileBlob(
      {
        v: 1,
        profileId,
        exportedAt: '2026-07-09T02:00:00.000Z',
        fingerprintSeed: 'seed-must-stay-secret',
        cookies: [{ name: 'sid', value: 'cookie-secret', domain: 'ex.com' }],
      },
      { key: pck, keyId },
    );
    const wire = envelope.toString('latin1');
    assert.ok(!wire.includes('cookie-secret'));
    assert.ok(!wire.includes('seed-must-stay-secret'));
    const payload = decryptProfileBlob(envelope, pck);
    assert.equal(payload.profileId, profileId);
    assert.equal(payload.fingerprintSeed, 'seed-must-stay-secret');
  });
});

describe('cross-language key derivation', () => {
  it('matches the vectors the Rust desktop asserts against', () => {
    // The SAME file apps/desktop/src-tauri/src/blob_crypto.rs asserts against. A desktop that derives
    // a different Profile Content Key does not fail loudly — it writes a snapshot that will not open
    // on the other side, surfacing as "my backup is corrupt" long after the change that caused it.
    // The two implementations build the HKDF info differently (Rust bakes the ':' into the constant,
    // this side adds it in a template), so equality is a real claim, not an obvious one.
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/key-derivation-vectors.json', import.meta.url), 'utf8'),
    ) as {
      teamDataKeyHex: string;
      vectors: { profileId: string; pck: string; keyId: string }[];
    };
    const tdk = Buffer.from(fixture.teamDataKeyHex, 'hex');
    assert.ok(fixture.vectors.length > 0, 'the fixture must actually contain vectors');

    for (const vector of fixture.vectors) {
      assert.equal(
        deriveProfileContentKey(tdk, vector.profileId).toString('hex'),
        vector.pck,
        `PCK diverged for profileId ${JSON.stringify(vector.profileId)}`,
      );
      assert.equal(
        deriveKeyId(tdk, vector.profileId).toString('hex'),
        vector.keyId,
        `key_id diverged for profileId ${JSON.stringify(vector.profileId)}`,
      );
    }
  });
});
