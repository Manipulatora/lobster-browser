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
  /** Consecutive failed sign-ins since the last successful one. */
  failedLoginAttempts?: number;
  /** ISO instant before which sign-in is refused regardless of the password. */
  lockedUntil?: string;
  /**
   * Which generation of sessions is current. Every session token carries the version it was minted
   * under (`JwtPayload.sv`) and the guard refuses any other — so bumping this is how "sign out
   * everywhere", a password change and a password reset end tokens that are otherwise valid for up
   * to a year. See `AuthService.authenticate`.
   */
  sessionVersion: number;
}

/** Wrong passwords tolerated at full speed before sign-in starts backing off. */
export const LOGIN_ATTEMPTS_BEFORE_BACKOFF = 5;

/** Ceiling on the backoff. See {@link loginBackoffUntil} for why there has to be one. */
export const LOGIN_BACKOFF_MAX_MS = 15 * 60 * 1000;

/**
 * When an account may next be tried, given its consecutive-failure count.
 *
 * BACKOFF, NOT A LOCKOUT, and the distinction is the whole design. A hard lock after N failures
 * hands anybody who knows an email address a way to keep its owner out of their account for free —
 * the countermeasure becomes the attack. A delay that doubles instead makes guessing at any useful
 * rate impossible while leaving a real user at worst a few minutes behind, and it clears the moment
 * they get in.
 *
 * The cap exists for the same reason: unbounded doubling is a permanent lock with extra steps.
 *
 * Shared by both repositories so the policy has exactly one definition — an in-memory store that
 * throttled differently from Postgres would make the tests prove the wrong thing.
 */
export function loginBackoffUntil(attempts: number, now: Date): Date | null {
  if (attempts <= LOGIN_ATTEMPTS_BEFORE_BACKOFF) return null;
  const doublings = attempts - LOGIN_ATTEMPTS_BEFORE_BACKOFF - 1;
  const delay = Math.min(LOGIN_BACKOFF_MAX_MS, 1000 * 2 ** doublings);
  return new Date(now.getTime() + delay);
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

/** A pending sign-up, as read back for completion, for re-sending its code, or for a retry. */
export interface StoredPendingRegistration {
  email: string;
  passwordHash: string;
  fullName: string;
  company?: string;
  /** Returned even when past, so the caller can tell a live sign-up from a dead one. */
  expiresAt: Date;
}

/** Result of atomically turning a proven pending sign-up into its initial account graph. */
export type CompletePendingRegistrationResult =
  { outcome: 'created'; user: StoredUser } | { outcome: 'invalid' } | { outcome: 'email_conflict' };

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
   * Count one failed sign-in against an account and return when it may next be tried.
   *
   * PER-ACCOUNT, and stored WITH the account, because the per-IP limiter in front of the app is
   * per-instance and per-address: spraying one password across many accounts from many addresses
   * never fills any one bucket, so the only place the pattern is visible is the account being
   * guessed. Kept in the same store as the password so every instance sees the same count.
   */
  registerFailedLogin(userId: string, now: Date): Promise<{ lockedUntil: Date | null }>;

  /** Forget the failures. Called on a successful sign-in, so a legitimate user is never punished. */
  clearFailedLogins(userId: string): Promise<void>;

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
   * Install a sign-up for an address that has no LIVE one, atomically.
   *
   * Returns false, and changes nothing, when an unexpired pending row already holds the address —
   * whoever wrote it. That refusal is the fix for a takeover: with an unconditional replace, a
   * second registration for an address mid-sign-up swapped in the second caller's password hash,
   * and the mailbox owner then proved the code for credentials that were not theirs. A dead row
   * (past `expiresAt`) is nobody's and is replaced.
   *
   * Implementations must make the claim one conflict-arbitrated write, not a read followed by a
   * write: two callers racing for a free address must not both believe they won.
   */
  claimPendingRegistration(input: PendingRegistrationInput, now: Date): Promise<boolean>;

  /**
   * Replace a pending sign-up outright: new code, fresh expiry, attempt counter back to zero.
   *
   * UNCONDITIONAL, so it is for callers that have already established a right to the row — a
   * re-send, or a retry that proved the pending password. The sign-up path itself must use
   * {@link claimPendingRegistration}; replacing from there is exactly the overwrite it exists to
   * prevent. Resetting the attempts is deliberate: the cap belongs to the code, not to the address,
   * or one exhausted code would lock the address out for the rest of its window.
   */
  upsertPendingRegistration(input: PendingRegistrationInput): Promise<void>;

  /**
   * Read a pending sign-up without consuming it. An expired row is returned too — with its
   * `expiresAt`, so the caller decides what expiry means for its purpose.
   */
  findPendingRegistration(email: string): Promise<StoredPendingRegistration | null>;

  /**
   * Redeem a pending sign-up and create its User, personal Team and admin Membership atomically.
   *
   * Keeping the whole graph behind one repository call is load-bearing: consuming the code first
   * and then issuing separate writes can strand an account without its team, or destroy the only
   * usable code when a later write fails. Implementations must roll every write back together.
   *
   * A miss still increments the attempt counter and refuses the row once too many guesses have
   * been made. `invalid` deliberately combines wrong, expired, exhausted, already-used and unknown
   * codes so this public endpoint does not reveal which addresses have a sign-up in flight.
   */
  completePendingRegistration(
    email: string,
    codeHash: string,
    now: Date,
  ): Promise<CompletePendingRegistrationResult>;

  /** Housekeeping. Expiry is already enforced in `completePendingRegistration`. */
  purgeExpiredPendingRegistrations(now: Date): Promise<void>;

  /**
   * Housekeeping. Expiry and single-use are already enforced in `consumeEmailVerification`, and a
   * re-send supersedes the previous code by expiring it — so this table accumulates a row per
   * verification attempt for the life of the deployment unless something drops the dead ones.
   */
  purgeExpiredEmailVerifications(now: Date): Promise<void>;

  // --- Sessions ----------------------------------------------------------------

  /**
   * Bump the session version, so every token minted before now is refused by the guard.
   *
   * Returns the user as it now stands — a caller that mints a replacement token must mint it from
   * THAT version, never from a copy read earlier — or null when the account no longer exists.
   */
  revokeSessions(userId: string): Promise<StoredUser | null>;

  /**
   * Replace the password, revoke every session, and forget the sign-in backoff, in ONE write.
   *
   * One statement rather than three so there is no instant at which the new password is in place
   * but a token minted under the old one still works, and none at which the backoff — which was
   * defending a password that no longer exists — outlives it.
   */
  changePassword(userId: string, passwordHash: string): Promise<StoredUser | null>;

  // --- Password reset ------------------------------------------------------------

  /**
   * Record an issued reset code for THIS user. Only its SHA-256 is ever stored, and it supersedes
   * any code already outstanding, so re-requesting never leaves several valid at once.
   */
  createPasswordReset(userId: string, codeHash: string, expiresAt: Date): Promise<void>;

  /**
   * Consume a live reset code for THIS user and apply the new password as one atomic step — the
   * same write as {@link changePassword}, so a reset also ends every session.
   *
   * Scoped by user, never looked up by hash: six digits collide across accounts. A miss burns an
   * attempt and answers null whether the code was wrong, expired, exhausted or never issued; the
   * caller cannot tell which and must not be able to.
   */
  resetPasswordWithCode(
    userId: string,
    codeHash: string,
    passwordHash: string,
    now: Date,
  ): Promise<StoredUser | null>;

  /** Housekeeping. Expiry is already enforced in `resetPasswordWithCode`. */
  purgeExpiredPasswordResets(now: Date): Promise<void>;
}

/**
 * Nest DI token for the active `UsersRepository`. Using a token (not a class) lets us
 * bind the interface to different implementations from the module without callers caring.
 */
export const USERS_REPOSITORY = Symbol('UsersRepository');
