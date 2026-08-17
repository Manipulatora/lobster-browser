/**
 * Storage for the per-account key that profile snapshots are scrambled with.
 *
 * One key per user, created on first use. The server holds it deliberately — see the note on the
 * `VaultKey` model for why deriving it from the account password was rejected.
 */
export interface VaultRepository {
  /** The user's key, or null when they have never needed one. */
  find(userId: string): Promise<Buffer | null>;

  /**
   * Return the user's key, creating it on first use.
   *
   * Must be safe against two clients racing on the same account: both have to end up with the SAME
   * key, or snapshots sealed by one are unreadable by the other.
   */
  findOrCreate(userId: string, generate: () => Buffer): Promise<Buffer>;
}

/** Nest DI token for the active {@link VaultRepository}. */
export const VAULT_REPOSITORY = Symbol('VAULT_REPOSITORY');
