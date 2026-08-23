import { createHash } from 'node:crypto';

export const CANONICAL_FINGERPRINT_SEED = /^[0-9a-f]{32}$/;

/** Turn a stable human-readable fixture label into the production 128-bit seed representation. */
export function canonicalFingerprintSeed(label) {
  if (typeof label !== 'string' || label.length === 0) {
    throw new TypeError('fingerprint seed label must be a non-empty string');
  }
  return createHash('sha256').update(label, 'utf8').digest('hex').slice(0, 32);
}

/** Keep environment overrides literal, but reject values the production launch boundary rejects. */
export function assertCanonicalFingerprintSeed(seed, source = 'fingerprint seed') {
  if (!CANONICAL_FINGERPRINT_SEED.test(seed)) {
    throw new Error(`${source} must be exactly 32 lowercase hexadecimal characters`);
  }
  return seed;
}
