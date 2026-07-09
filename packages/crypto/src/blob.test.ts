/**
 * SEC-1 acceptance tests for the LBv1 envelope.
 *
 * Roadmap criteria: wire/store bytes contain no cleartext cookie/domain (grep test);
 * tamper fails decrypt.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BlobCryptoError,
  decryptBlob,
  decryptBlobUtf8,
  decryptProfileBlob,
  encryptBlob,
  encryptBlobUtf8,
  encryptProfileBlob,
  generateKeyId,
  generateProfileContentKey,
  isLBv1Envelope,
  LB_V1_ALG_A256GCM,
  LB_V1_HEADER_LEN,
  LB_V1_KEY_ID_LEN,
  LB_V1_MAGIC,
  LB_V1_TAG_LEN,
  type ProfileBlobPayload,
} from './index.js';

const COOKIE_DOMAIN = 'accounts.example.com';
const COOKIE_VALUE = 'session-token-hunter2-secret';

function samplePayload(): ProfileBlobPayload {
  return {
    v: 1,
    profileId: 'p_test_sec1',
    exportedAt: '2026-07-09T00:00:00.000Z',
    fingerprintSeed: '0123456789abcdef0123456789abcdef',
    cookies: [
      {
        name: 'session',
        value: COOKIE_VALUE,
        domain: COOKIE_DOMAIN,
        path: '/',
        httpOnly: true,
        secure: true,
      },
    ],
    storage: { localStorage: { token: COOKIE_VALUE } },
  };
}

describe('LBv1 envelope (SEC-1)', () => {
  it('round-trips plaintext and never embeds cleartext secrets in the envelope', () => {
    const key = generateProfileContentKey();
    const keyId = generateKeyId();
    const plaintext = Buffer.from(
      JSON.stringify({ cookie: COOKIE_VALUE, domain: COOKIE_DOMAIN }),
      'utf8',
    );

    const envelope = encryptBlob(plaintext, { key, keyId });
    assert.equal(isLBv1Envelope(envelope), true);
    assert.ok(envelope.subarray(0, 4).equals(LB_V1_MAGIC));
    assert.equal(envelope[4 + LB_V1_KEY_ID_LEN], LB_V1_ALG_A256GCM);
    assert.ok(envelope.length >= LB_V1_HEADER_LEN + LB_V1_TAG_LEN);

    // Grep-style acceptance: cleartext cookie/domain must not appear in wire bytes.
    const asLatin1 = envelope.toString('latin1');
    assert.equal(asLatin1.includes(COOKIE_VALUE), false);
    assert.equal(asLatin1.includes(COOKIE_DOMAIN), false);
    assert.equal(asLatin1.includes('hunter2'), false);

    const decrypted = decryptBlob(envelope, key);
    assert.ok(decrypted.plaintext.equals(plaintext));
    assert.ok(decrypted.keyId.equals(keyId));
    assert.equal(decrypted.alg, LB_V1_ALG_A256GCM);
  });

  it('uses a fresh nonce so identical plaintext yields distinct envelopes', () => {
    const key = generateProfileContentKey();
    const a = encryptBlobUtf8('same-payload', { key });
    const b = encryptBlobUtf8('same-payload', { key });
    assert.equal(a.equals(b), false);
    assert.equal(decryptBlobUtf8(a, key), 'same-payload');
    assert.equal(decryptBlobUtf8(b, key), 'same-payload');
  });

  it('rejects tampered ciphertext, wrong key, and bad magic', () => {
    const key = generateProfileContentKey();
    const envelope = encryptBlobUtf8('secret-blob', { key });

    const flipped = Buffer.from(envelope);
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 0xff;
    assert.throws(() => decryptBlob(flipped, key), BlobCryptoError);

    const wrongKey = generateProfileContentKey();
    assert.throws(() => decryptBlob(envelope, wrongKey), BlobCryptoError);

    const badMagic = Buffer.from(envelope);
    badMagic[0] = 'X'.charCodeAt(0);
    assert.throws(() => decryptBlob(badMagic, key), /magic is not LBv1/);

    assert.throws(() => decryptBlob(Buffer.from('short'), key), /too short/);
  });

  it('encrypts ProfileBlobPayload without leaking cookie/domain/seed on the wire', () => {
    const key = generateProfileContentKey();
    const payload = samplePayload();
    const envelope = encryptProfileBlob(payload, { key });

    const wire = envelope.toString('latin1');
    assert.equal(wire.includes(COOKIE_VALUE), false);
    assert.equal(wire.includes(COOKIE_DOMAIN), false);
    assert.equal(wire.includes(payload.fingerprintSeed!), false);
    assert.equal(wire.includes('p_test_sec1'), false);

    const roundTrip = decryptProfileBlob(envelope, key);
    assert.deepEqual(roundTrip, payload);
  });

  it('rejects non-v1 JSON after a successful decrypt', () => {
    const key = generateProfileContentKey();
    const envelope = encryptBlobUtf8(JSON.stringify({ v: 2, profileId: 'x' }), { key });
    assert.throws(() => decryptProfileBlob(envelope, key), /ProfileBlobPayload v1/);
  });

  it('base64 wire form used by POST /profiles/:id/sync stays opaque', () => {
    const key = generateProfileContentKey();
    const envelope = encryptProfileBlob(samplePayload(), { key });
    const wireB64 = envelope.toString('base64');
    // Server stores base64; decoded bytes must still be LBv1 and free of secrets.
    const decoded = Buffer.from(wireB64, 'base64');
    assert.equal(isLBv1Envelope(decoded), true);
    assert.equal(decoded.toString('utf8').includes(COOKIE_VALUE), false);
    assert.equal(decoded.toString('utf8').includes(COOKIE_DOMAIN), false);
  });
});
