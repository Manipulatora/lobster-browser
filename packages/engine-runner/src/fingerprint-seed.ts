import { isValidPersistedSeed } from '@lobster/fingerprint';

/** Fail closed before any profile seed reaches persona derivation or an engine process. */
export function assertValidFingerprintSeed(
  seed: unknown,
  profileId: string,
): asserts seed is string {
  if (typeof seed === 'string' && isValidPersistedSeed(seed)) return;
  throw new Error(
    `refusing to launch profile ${profileId}: invalid fingerprint seed; ` +
      'expected 8 to 256 lowercase hexadecimal characters',
  );
}
