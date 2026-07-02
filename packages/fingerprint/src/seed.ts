import { randomBytes } from 'node:crypto';
import type { FingerprintSeed } from '@lobster/shared-types';

/** Generate a fresh random per-profile seed (128-bit hex). */
export function generateSeed(): FingerprintSeed {
  return randomBytes(16).toString('hex');
}

/** A seed is a lowercase hex string of at least 8 chars. */
export function isValidSeed(seed: string): boolean {
  return /^[0-9a-f]{8,}$/.test(seed);
}
