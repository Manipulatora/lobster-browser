import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  loginBackoffUntil,
  type CompletePendingRegistrationResult,
  type CreateUserInput,
  type PendingRegistrationInput,
  type StoredPendingRegistration,
  type StoredUser,
  type UsersRepository,
} from './users.repository';

/** Failed guesses allowed against one 6-digit code before it is dead. */
const MAX_VERIFICATION_ATTEMPTS = 5;

/** Throwing across Prisma's callback boundary is what rolls a claimed pending row back. */
class EmailAlreadyRegisteredError extends Error {}

/** The subset of a Prisma `users` row this repository maps to a `StoredUser`. */
interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  company: string | null;
  passwordHash: string | null;
  createdAt: Date;
  emailVerifiedAt: Date | null;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  sessionVersion: number;
}

/**
 * The one write a password change and a password reset share: the new hash, every session revoked,
 * and the sign-in backoff forgotten — as ONE statement, so no reader can see the new password with
 * the old sessions still valid, or a backoff still defending a password that no longer exists.
 */
function passwordChange(passwordHash: string): Prisma.UserUpdateInput {
  return {
    passwordHash,
    sessionVersion: { increment: 1 },
    failedLoginAttempts: 0,
    lockedUntil: null,
  };
}

/**
 * Production `UsersRepository` backed by Postgres via the shared {@link PrismaService}.
 *
 * The auth module wires this as the active provider whenever `DATABASE_URL` is set; without a DB
 * (local dev / tests) the in-memory repository is used instead.
 */
@Injectable()
export class PrismaUsersRepository implements UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateUserInput): Promise<StoredUser> {
    const row = await this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
        displayName: input.displayName ?? null,
        company: input.company ?? null,
        // Created only after the emailed code was proven (see PendingRegistration), so the address
        // is verified at the instant the row exists. Stamping it here rather than leaving it null
        // avoids an account that is real but permanently unverified.
        emailVerifiedAt: new Date(),
      },
    });
    return this.toStoredUser(row);
  }

  // --- Pending sign-ups ------------------------------------------------------

  async claimPendingRegistration(input: PendingRegistrationInput, now: Date): Promise<boolean> {
    // A dead row is nobody's: clear it first — and only it, the predicate cannot touch a live one.
    await this.prisma.pendingRegistration.deleteMany({
      where: { email: input.email, expiresAt: { lte: now } },
    });
    // The insert IS the claim. `skipDuplicates` is ON CONFLICT DO NOTHING on the email primary key,
    // so of any number of concurrent callers exactly one gets count 1, and a live row is never
    // rewritten — which is the whole point. Two statements because Prisma has no conditional
    // upsert; the gap between them can only lose to another claimant, never overwrite one.
    const inserted = await this.prisma.pendingRegistration.createMany({
      data: [
        {
          email: input.email,
          passwordHash: input.passwordHash,
          fullName: input.fullName,
          company: input.company ?? null,
          codeHash: input.codeHash,
          expiresAt: input.expiresAt,
        },
      ],
      skipDuplicates: true,
    });
    return inserted.count === 1;
  }

  async upsertPendingRegistration(input: PendingRegistrationInput): Promise<void> {
    const data = {
      passwordHash: input.passwordHash,
      fullName: input.fullName,
      company: input.company ?? null,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
      // Reset on re-send: the cap belongs to the code, not to the address, or one exhausted code
      // would lock the address out permanently.
      attempts: 0,
    };
    await this.prisma.pendingRegistration.upsert({
      where: { email: input.email },
      create: { email: input.email, ...data },
      update: data,
    });
  }

  async findPendingRegistration(email: string): Promise<StoredPendingRegistration | null> {
    const row = await this.prisma.pendingRegistration.findUnique({ where: { email } });
    if (!row) return null;
    return {
      email: row.email,
      passwordHash: row.passwordHash,
      fullName: row.fullName,
      company: row.company ?? undefined,
      expiresAt: row.expiresAt,
    };
  }

  async completePendingRegistration(
    email: string,
    codeHash: string,
    now: Date,
  ): Promise<CompletePendingRegistrationResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const validity = {
          email,
          codeHash,
          expiresAt: { gt: now },
          attempts: { lt: MAX_VERIFICATION_ATTEMPTS },
        };
        const row = await tx.pendingRegistration.findFirst({ where: validity });

        if (!row) {
          // Wrong, expired or exhausted. Burn an attempt so a six-digit code cannot be ground down
          // against an endpoint that has no session to rate-limit against.
          await tx.pendingRegistration.updateMany({
            where: { email },
            data: { attempts: { increment: 1 } },
          });
          return { outcome: 'invalid' } as const;
        }

        // Conditional deletion is the claim: concurrent correct submissions may both read the row,
        // but only one can delete it and continue to create an account.
        const deleted = await tx.pendingRegistration.deleteMany({ where: validity });
        if (deleted.count === 0) return { outcome: 'invalid' } as const;

        // This error must cross the transaction boundary. Returning a conflict from inside the
        // callback would commit the delete and destroy the user's only still-valid code.
        if (await tx.user.findUnique({ where: { email } })) {
          throw new EmailAlreadyRegisteredError();
        }

        const userRow = await tx.user.create({
          data: {
            email: row.email,
            passwordHash: row.passwordHash,
            displayName: row.fullName,
            company: row.company,
            emailVerifiedAt: now,
          },
        });
        const team = await tx.team.create({
          data: { ownerUserId: userRow.id, name: `${row.fullName}'s Team` },
        });
        await tx.membership.create({
          data: { teamId: team.id, userId: userRow.id, role: 'admin' },
        });

        return { outcome: 'created', user: this.toStoredUser(userRow) } as const;
      });
    } catch (error) {
      if (error instanceof EmailAlreadyRegisteredError) {
        return { outcome: 'email_conflict' };
      }
      // A user inserted concurrently can win after our explicit lookup. Its unique-email error
      // still rolls this transaction back; confirm the conflicting row before mapping the result.
      if (this.isUniqueConstraintError(error)) {
        const existing = await this.prisma.user.findUnique({ where: { email } });
        if (existing) return { outcome: 'email_conflict' };
      }
      throw error;
    }
  }

  async purgeExpiredPendingRegistrations(now: Date): Promise<void> {
    await this.prisma.pendingRegistration.deleteMany({ where: { expiresAt: { lt: now } } });
  }

  async purgeExpiredEmailVerifications(now: Date): Promise<void> {
    // A consumed row is as dead as an expired one — the code is single-use, so nothing reads it
    // again — but it may still be inside its window, hence the two conditions rather than one.
    await this.prisma.emailVerification.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { consumedAt: { not: null } }] },
    });
  }

  async findByEmail(email: string): Promise<StoredUser | null> {
    const row = await this.prisma.user.findUnique({ where: { email } });
    return row ? this.toStoredUser(row) : null;
  }

  async createEmailVerification(userId: string, codeHash: string, expiresAt: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Re-sending supersedes: expire whatever was outstanding so only the newest code works.
      await tx.emailVerification.updateMany({
        where: { userId, consumedAt: null },
        data: { expiresAt: new Date(0) },
      });
      await tx.emailVerification.create({ data: { userId, tokenHash: codeHash, expiresAt } });
    });
  }

  /**
   * Consume a code and stamp the user verified in ONE transaction.
   *
   * The claim is a conditional `updateMany` — scoped to this user, still unconsumed, unexpired,
   * and under the attempt cap — so two submissions at the same instant cannot both succeed. Doing
   * it as read-then-write would leave exactly that race.
   *
   * A miss burns an attempt against every live code the user has. Without that counter a six-digit
   * secret is guessable in a quarter of an hour by anyone willing to loop.
   */
  async consumeEmailVerification(userId: string, codeHash: string): Promise<StoredUser | null> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const claimed = await tx.emailVerification.updateMany({
        where: {
          userId,
          tokenHash: codeHash,
          consumedAt: null,
          expiresAt: { gt: now },
          attempts: { lt: MAX_VERIFICATION_ATTEMPTS },
        },
        data: { consumedAt: now },
      });

      if (claimed.count === 0) {
        await tx.emailVerification.updateMany({
          where: { userId, consumedAt: null, expiresAt: { gt: now } },
          data: { attempts: { increment: 1 } },
        });
        return null;
      }

      const user = await tx.user.update({
        where: { id: userId },
        // Keep the FIRST verification instant: re-proving an address later does not change when
        // it was first proven.
        data: { emailVerifiedAt: { set: now } },
      });
      return this.toStoredUser(user);
    });
  }

  async findById(id: string): Promise<StoredUser | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? this.toStoredUser(row) : null;
  }

  async registerFailedLogin(userId: string, now: Date): Promise<{ lockedUntil: Date | null }> {
    return this.prisma.$transaction(async (tx) => {
      // Increment in the statement rather than read-then-write: several guesses land at once by
      // design here, and counting them in JavaScript would let a parallel spray register as one.
      const row = await tx.user.update({
        where: { id: userId },
        data: { failedLoginAttempts: { increment: 1 } },
      });
      const lockedUntil = loginBackoffUntil(row.failedLoginAttempts, now);
      if (lockedUntil) {
        await tx.user.update({ where: { id: userId }, data: { lockedUntil } });
      }
      return { lockedUntil };
    });
  }

  async clearFailedLogins(userId: string): Promise<void> {
    await this.prisma.user.updateMany({
      // Scoped so the ordinary sign-in — the overwhelming majority — costs no write at all.
      where: {
        id: userId,
        OR: [{ failedLoginAttempts: { gt: 0 } }, { lockedUntil: { not: null } }],
      },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  }

  // --- Sessions ----------------------------------------------------------------

  async revokeSessions(userId: string): Promise<StoredUser | null> {
    // Incremented in the statement, never read-then-written: two revocations landing together must
    // each move the version past every token minted before them, not collapse into one step.
    return this.updateUser(userId, { sessionVersion: { increment: 1 } });
  }

  async changePassword(userId: string, passwordHash: string): Promise<StoredUser | null> {
    return this.updateUser(userId, passwordChange(passwordHash));
  }

  // --- Password reset ------------------------------------------------------------

  async createPasswordReset(userId: string, codeHash: string, expiresAt: Date): Promise<void> {
    await this.prisma.passwordReset.upsert({
      where: { userId },
      create: { userId, codeHash, expiresAt },
      // Supersedes: the previous code dies with its attempt count. The cap belongs to the code.
      update: { codeHash, expiresAt, attempts: 0 },
    });
  }

  /**
   * The claim is the DELETE, predicated on everything that makes the code live — this user, this
   * hash, unexpired, under the cap — so two correct submissions at the same instant cannot both
   * match a row only one of them can remove, and a consumed code leaves nothing behind to replay.
   * The password write follows inside the same transaction: a failure between them rolls the claim
   * back rather than spending the code for nothing.
   */
  async resetPasswordWithCode(
    userId: string,
    codeHash: string,
    passwordHash: string,
    now: Date,
  ): Promise<StoredUser | null> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordReset.deleteMany({
        where: {
          userId,
          codeHash,
          expiresAt: { gt: now },
          attempts: { lt: MAX_VERIFICATION_ATTEMPTS },
        },
      });

      if (claimed.count === 0) {
        // Wrong, expired or exhausted: burn an attempt against whatever this user has outstanding.
        await tx.passwordReset.updateMany({
          where: { userId },
          data: { attempts: { increment: 1 } },
        });
        return null;
      }

      const row = await tx.user.update({
        where: { id: userId },
        data: passwordChange(passwordHash),
      });
      return this.toStoredUser(row);
    });
  }

  async purgeExpiredPasswordResets(now: Date): Promise<void> {
    await this.prisma.passwordReset.deleteMany({ where: { expiresAt: { lt: now } } });
  }

  /** One conditional write on the account row; null, not a throw, when the account is gone. */
  private async updateUser(
    userId: string,
    data: Prisma.UserUpdateInput,
  ): Promise<StoredUser | null> {
    try {
      const row = await this.prisma.user.update({ where: { id: userId }, data });
      return this.toStoredUser(row);
    } catch (error) {
      // P2025: no such row. An account deleted under a still-valid token is a 401 for the caller,
      // not an internal error.
      if (this.isRecordNotFoundError(error)) return null;
      throw error;
    }
  }

  private toStoredUser(row: UserRow): StoredUser {
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName ?? undefined,
      company: row.company ?? undefined,
      // A user created through AuthService always has a hash; default to '' defensively
      // for any legacy row that predates password auth.
      passwordHash: row.passwordHash ?? '',
      createdAt: row.createdAt.toISOString(),
      emailVerifiedAt: row.emailVerifiedAt?.toISOString(),
      failedLoginAttempts: row.failedLoginAttempts,
      lockedUntil: row.lockedUntil?.toISOString(),
      sessionVersion: row.sessionVersion,
    };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return this.prismaErrorCode(error) === 'P2002';
  }

  private isRecordNotFoundError(error: unknown): boolean {
    return this.prismaErrorCode(error) === 'P2025';
  }

  private prismaErrorCode(error: unknown): unknown {
    return typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  }
}
