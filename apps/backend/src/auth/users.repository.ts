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
  company?: string;
}

/**
 * A sign-up that has been started but not yet proven by entering the emailed code.
 *
 * Deliberately NOT a `User`. No account, team or token exists while this row does — see the model
 * comment in schema.prisma for why registration no longer creates one up front.
 */
export interface PendingRegistrationInput {
  email: string;
  passwordHash: string;
  fullName: string;
  company?: string;
  codeHash: string;
  expiresAt: Date;
}

/** A pending sign-up, as read back for completion or for re-sending its code. */
export interface StoredPendingRegistration {
  email: string;
  passwordHash: string;
  fullName: string;
  company?: string;
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

  // --- Pending sign-ups ------------------------------------------------------

  /**
   * Record (or replace) a sign-up awaiting its code.
   *
   * Replaces on conflict, so re-registering the same address supersedes the previous code instead
   * of leaving several valid at once, and resets the attempt counter for the new code.
   */
  upsertPendingRegistration(input: PendingRegistrationInput): Promise<void>;

  /** Read a pending sign-up without consuming it — used to re-send its code. */
  findPendingRegistration(email: string): Promise<StoredPendingRegistration | null>;

  /**
   * Redeem a pending sign-up, atomically.
   *
   * Increments the attempt counter on a wrong code and refuses the row once too many have been
   * made: the endpoint is necessarily public (there is no session yet), so a six-digit code is
   * otherwise brute-forceable in minutes.
   *
   * Returns the stored details on success and deletes the row, so the same code cannot be redeemed
   * twice. Returns null when the code is wrong, expired, exhausted or unknown — the caller cannot
   * distinguish these, and must not be able to.
   */
  consumePendingRegistration(
    email: string,
    codeHash: string,
    now: Date,
  ): Promise<StoredPendingRegistration | null>;

  /** Housekeeping. Expiry is already enforced in `consumePendingRegistration`. */
  purgeExpiredPendingRegistrations(now: Date): Promise<void>;
}

/**
 * Nest DI token for the active `UsersRepository`. Using a token (not a class) lets us
 * bind the interface to different implementations from the module without callers caring.
 */
export const USERS_REPOSITORY = Symbol('UsersRepository');
