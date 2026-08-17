import type { User } from '@lobster/shared-types';

/**
 * A persisted user record: the public `User` wire type plus the backend-only
 * `passwordHash`. The hash never leaves the server — AuthService strips it before
 * returning a user to any client.
 */
export interface StoredUser extends User {
  passwordHash: string;
  /** ISO instant the address was proven; undefined while unverified. */
  emailVerifiedAt?: string;
}

/** Fields required to create a user. The repository owns `id` + `createdAt`. */
export interface CreateUserInput {
  email: string;
  passwordHash: string;
  displayName?: string;
}

/**
 * Persistence boundary for users. AuthService depends on this interface (via the
 * `USERS_REPOSITORY` DI token) rather than a concrete class, so the storage backend
 * can be swapped without touching the business logic.
 *
 * Implementations:
 *   - InMemoryUsersRepository — a Map; the active provider until Postgres is available.
 *   - PrismaUsersRepository   — production persistence via the generated Prisma client.
 */
export interface UsersRepository {
  create(input: CreateUserInput): Promise<StoredUser>;
  findByEmail(email: string): Promise<StoredUser | null>;
  findById(id: string): Promise<StoredUser | null>;

  /**
   * Record an issued verification code. Only its SHA-256 is ever stored.
   *
   * Supersedes any code already outstanding for that user, so re-sending invalidates the previous
   * one instead of leaving several valid codes in flight.
   */
  createEmailVerification(userId: string, codeHash: string, expiresAt: Date): Promise<void>;

  /**
   * Consume a code for THIS user and mark them verified, atomically.
   *
   * SCOPED BY USER on purpose: six digits collide across accounts, so a global lookup by hash
   * would let a code entered by one person match a pending row belonging to someone else.
   *
   * Returns the verified user, or null when the code is wrong, already consumed, expired, or has
   * had too many failed attempts — the caller cannot tell which, and must not be able to.
   */
  consumeEmailVerification(userId: string, codeHash: string): Promise<StoredUser | null>;
}

/**
 * Nest DI token for the active `UsersRepository`. Using a token (not a class) lets us
 * bind the interface to different implementations from the module without callers caring.
 */
export const USERS_REPOSITORY = Symbol('UsersRepository');
