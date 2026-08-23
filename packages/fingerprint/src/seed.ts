import { randomBytes } from 'node:crypto';
import type { FingerprintSeed } from '@lobster/shared-types';

/** Generate a fresh random per-profile seed (128-bit hex). */
export function generateSeed(): FingerprintSeed {
  return randomBytes(16).toString('hex');
}

/** The canonical persisted identity: one 128-bit value encoded as exactly 32 lowercase hex chars. */
export function isValidSeed(seed: string): boolean {
  return /^[0-9a-f]{32}$/.test(seed);
}

/** A bounded historical identity accepted only when loading/importing an existing profile. */
export function isValidPersistedSeed(seed: string): boolean {
  return /^[0-9a-f]{8,256}$/.test(seed);
}
