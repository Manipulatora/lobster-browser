import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { CreateUserInput, StoredUser, UsersRepository } from './users.repository';

/** Failed guesses allowed against one 6-digit code before it is dead. */
const MAX_VERIFICATION_ATTEMPTS = 5;

/** The subset of a Prisma `users` row this repository maps to a `StoredUser`. */
interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  passwordHash: string | null;
  createdAt: Date;
  emailVerifiedAt: Date | null;
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
      },
    });
    return this.toStoredUser(row);
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

  private toStoredUser(row: UserRow): StoredUser {
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName ?? undefined,
      // A user created through AuthService always has a hash; default to '' defensively
      // for any legacy row that predates password auth.
      passwordHash: row.passwordHash ?? '',
      createdAt: row.createdAt.toISOString(),
      emailVerifiedAt: row.emailVerifiedAt?.toISOString(),
    };
  }
}
