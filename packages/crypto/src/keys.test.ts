/**
 * SEC-2 acceptance tests: key hierarchy wrap/unwrap, HKDF PCK stability, wrong-password fail.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bootstrapTeamKeys,
  deriveRecoveryKey,
  deriveUserMasterKey,
  generatePasswordSalt,
  generateRecoveryCode,
  normalizeRecoveryCode,
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

describe('recovery code (SEC-2 account recovery)', () => {
  it('is 128 bits in six Crockford groups, and never contains an ambiguous symbol', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const code = generateRecoveryCode();
      assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}$/, code);
      // I, L, O and U are excluded by construction — they are the symbols a human confuses.
      assert.ok(!/[ILOU]/.test(code), `${code} contains an ambiguous symbol`);
      seen.add(code);
    }
    assert.equal(seen.size, 200, 'codes must not repeat');
  });

  it('folds the transcription slips Crockford is designed for, and rejects the rest', () => {
    const code = generateRecoveryCode();
    const canonical = normalizeRecoveryCode(code);

    // Case, separators and whitespace are all how a human actually types it back.
    assert.equal(normalizeRecoveryCode(code.toLowerCase()), canonical);
    assert.equal(normalizeRecoveryCode(code.replace(/-/g, '')), canonical);
    assert.equal(normalizeRecoveryCode(code.replace(/-/g, ' ')), canonical);

    // I/L read as 1 and O as 0, so a slip lands on the intended digit.
    assert.equal(normalizeRecoveryCode('IIIII-LLLLL-OOOOO-00000-11111-22222'), '1'.repeat(10) + '0'.repeat(10) + '1'.repeat(5) + '2'.repeat(5));

    // U is excluded precisely so it cannot be confused with V; mapping it would accept a code that
    // was never issued.
    assert.throws(() => normalizeRecoveryCode('UUUUU-UUUUU-UUUUU-UUUUU-UUUUU-UUUUU'), /not in the alphabet/);
    assert.throws(() => normalizeRecoveryCode('TOO-SHORT'), /must be 30 symbols/);
  });

  it('unwraps the same key as the password does, and a wrong code does not', async () => {
    // Reduced Argon2id cost: this asserts the wiring, not the KDF's hardness.
    const cheap = { memoryKiB: 64, iterations: 1 };
    const tdk = generateSymmetricKey();

    const passwordSalt = generatePasswordSalt();
    const recoverySalt = generatePasswordSalt();
    const code = generateRecoveryCode();

    const passwordKey = await deriveUserMasterKey('correct horse battery staple', passwordSalt, cheap);
    const recoveryKey = await deriveRecoveryKey(code, recoverySalt, cheap);

    // The SAME key, wrapped twice. Either path recovers it; that is the whole point.
    const underPassword = wrapKey(tdk, passwordKey);
    const underRecovery = wrapKey(tdk, recoveryKey);

    assert.deepEqual(unwrapKey(underPassword, passwordKey), tdk);
    assert.deepEqual(unwrapKey(underRecovery, recoveryKey), tdk);

    // Distinct salts mean the two wrapping keys are unrelated, so neither wrap opens with the other's
    // key — and rotating the password cannot invalidate the recovery code.
    assert.notDeepEqual(passwordKey, recoveryKey);
    assert.throws(() => unwrapKey(underRecovery, passwordKey), KeyHierarchyError);
    assert.throws(() => unwrapKey(underPassword, recoveryKey), KeyHierarchyError);

    // A wrong code derives a different key and fails closed.
    const wrong = await deriveRecoveryKey(generateRecoveryCode(), recoverySalt, cheap);
    assert.throws(() => unwrapKey(underRecovery, wrong), /unwrap failed/);
  });

  it('is case- and separator-insensitive end to end, so a paper copy actually works', async () => {
    const cheap = { memoryKiB: 64, iterations: 1 };
    const tdk = generateSymmetricKey();
    const salt = generatePasswordSalt();
    const code = generateRecoveryCode();
    const wrapped = wrapKey(tdk, await deriveRecoveryKey(code, salt, cheap));

    // How someone types it off a printout: lowercase, spaces instead of dashes.
    const asTyped = code.toLowerCase().replace(/-/g, ' ');
    assert.deepEqual(unwrapKey(wrapped, await deriveRecoveryKey(asTyped, salt, cheap)), tdk);
  });
});
