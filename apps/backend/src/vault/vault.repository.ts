/**
 * Storage for a user's wrapped key material.
 *
 * WHAT THIS DELIBERATELY CANNOT DO. There is no method that returns a key, because the server never
 * holds one it can open: it stores the Team Data Key wrapped twice — under an Argon2id key derived
 * from the account password, and under one derived from a printed recovery code — and hands those
 * opaque blobs back to a client that does the unwrapping. A repository method like
 * `getTeamDataKey()` would be the first step of turning zero-knowledge storage into a key escrow, so
 * the shape of this interface is part of the security property, not just its implementation.
 */

/** Argon2id cost an enrollment's wraps were created with. */
export interface VaultArgonCost {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/** The bytes a client needs to attempt an unlock. Every field is opaque to the server. */
export interface VaultEnrollmentRecord {
  userId: string;
  passwordSalt: Buffer;
  recoverySalt: Buffer;
  wrappedByPassword: Buffer;
  wrappedByRecovery: Buffer;
  /**
   * Non-secret fingerprint of the wrapped key, so a client can distinguish "wrong password" from
   * "this is a different vault than the one my snapshots were sealed under" without unwrapping.
   */
  keyFingerprint: string;
  argon: VaultArgonCost;
  enrolledAt: string;
  recoveryCodeUsedAt?: string;
  rotatedAt?: string;
}

/** What a client submits to enroll, or to rewrite its wraps after a password change. */
export interface UpsertVaultEnrollment {
  userId: string;
  passwordSalt: Buffer;
  recoverySalt: Buffer;
  wrappedByPassword: Buffer;
  wrappedByRecovery: Buffer;
  keyFingerprint: string;
  argon: VaultArgonCost;
}

export interface VaultRepository {
  /** The enrollment for a user, or null when they have never enrolled. */
  find(userId: string): Promise<VaultEnrollmentRecord | null>;

  /**
   * Create the enrollment. Fails when one already exists rather than overwriting.
   *
   * Overwriting would destroy the only wraps of the existing key, and every snapshot sealed under it
   * with them — so replacing an enrollment is `rotate`, which the caller has to ask for by name.
   */
  create(input: UpsertVaultEnrollment): Promise<VaultEnrollmentRecord>;

  /**
   * Rewrite the wraps for an EXISTING enrollment, stamping `rotatedAt`.
   *
   * Used after a password change or a recovery-code regeneration. The Team Data Key itself does not
   * change — only what it is wrapped under — so previously sealed snapshots stay readable.
   */
  rotate(input: UpsertVaultEnrollment): Promise<VaultEnrollmentRecord | null>;

  /** Stamp the first use of the recovery code. Idempotent: a second use does not move the timestamp. */
  markRecoveryCodeUsed(userId: string): Promise<void>;
}

/** Nest DI token for the active {@link VaultRepository}. */
export const VAULT_REPOSITORY = Symbol('VAULT_REPOSITORY');
