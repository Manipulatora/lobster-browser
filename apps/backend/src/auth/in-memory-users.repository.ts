import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  loginBackoffUntil,
  type CompletePendingRegistrationResult,
  type CreateUserInput,
  type PendingRegistrationInput,
  type StoredPendingRegistration,
  type StoredUser,
  type UsersRepository,
} from './users.repository';

/** Mirrors the Prisma repository's cap; see it for why a 6-digit code needs one. */
const MAX_VERIFICATION_ATTEMPTS = 5;

/** Two-phase hook used to include the separate in-memory team store in one synchronous mutation. */
export interface PreparedPersonalTeam {
  commit(): void;
  rollback(): void;
}

export type PreparePersonalTeam = (ownerUserId: string, name: string) => PreparedPersonalTeam;

/**
 * In-memory `UsersRepository` backed by a Map. The active implementation until a
 * Postgres instance is provisioned — it lets auth run (and be tested) with no DB.
 *
 * State lives for the lifetime of the process only; it is intentionally NOT durable.
 * Email lookups are case-insensitive so `A@b.com` and `a@b.com` collide as one account.
 */
@Injectable()
export class InMemoryUsersRepository implements UsersRepository {
  private readonly byId = new Map<string, StoredUser>();
  private readonly idByEmail = new Map<string, string>();

  constructor(private readonly preparePersonalTeam: PreparePersonalTeam) {}

  async create(input: CreateUserInput): Promise<StoredUser> {
    const user: StoredUser = {
      id: randomUUID(),
      email: input.email,
      displayName: input.displayName,
      company: input.company,
      passwordHash: input.passwordHash,
      createdAt: new Date().toISOString(),
      // Matches the Prisma implementation: an account only exists after its code was proven, so it
      // is verified at the moment of creation.
      emailVerifiedAt: new Date().toISOString(),
    };
    this.byId.set(user.id, user);
    this.idByEmail.set(this.normalizeEmail(input.email), user.id);
    return user;
  }

  // --- Pending sign-ups ------------------------------------------------------

  private readonly pending = new Map<string, PendingRegistrationInput & { attempts: number }>();

  async upsertPendingRegistration(input: PendingRegistrationInput): Promise<void> {
    // Replaces, so re-registering supersedes the previous code and resets the attempt cap — the cap
    // belongs to the code, not to the address.
    this.pending.set(this.normalizeEmail(input.email), { ...input, attempts: 0 });
  }

  async findPendingRegistration(email: string): Promise<StoredPendingRegistration | null> {
    const row = this.pending.get(this.normalizeEmail(email));
    if (!row) return null;
    return {
      email: row.email,
      passwordHash: row.passwordHash,
      fullName: row.fullName,
      company: row.company,
    };
  }

  async completePendingRegistration(
    email: string,
    codeHash: string,
    now: Date,
  ): Promise<CompletePendingRegistrationResult> {
    const key = this.normalizeEmail(email);
    const row = this.pending.get(key);
    const live =
      row &&
      row.codeHash === codeHash &&
      row.expiresAt.getTime() > now.getTime() &&
      row.attempts < MAX_VERIFICATION_ATTEMPTS;

    if (!live) {
      // Burn an attempt: the verify endpoint is public, so nothing else bounds guessing.
      if (row) row.attempts += 1;
      return { outcome: 'invalid' };
    }

    if (this.idByEmail.has(key)) return { outcome: 'email_conflict' };

    const createdAt = now.toISOString();
    const user: StoredUser = {
      id: randomUUID(),
      email: row.email,
      passwordHash: row.passwordHash,
      displayName: row.fullName,
      company: row.company,
      createdAt,
      emailVerifiedAt: createdAt,
    };
    const teamPlan = this.preparePersonalTeam(user.id, `${row.fullName}'s Team`);

    // Deliberately no await from the validity check through the final delete: concurrent calls run
    // in separate JavaScript turns. The two-phase team hook also lets an exception roll the user
    // and team maps back without consuming the pending code.
    try {
      this.byId.set(user.id, user);
      this.idByEmail.set(key, user.id);
      teamPlan.commit();
      this.pending.delete(key);
      return { outcome: 'created', user };
    } catch (error) {
      this.byId.delete(user.id);
      if (this.idByEmail.get(key) === user.id) this.idByEmail.delete(key);
      teamPlan.rollback();
      throw error;
    }
  }

  async purgeExpiredPendingRegistrations(now: Date): Promise<void> {
    for (const [key, row] of this.pending) {
      if (row.expiresAt.getTime() < now.getTime()) this.pending.delete(key);
    }
  }

  async purgeExpiredEmailVerifications(now: Date): Promise<void> {
    for (const [key, row] of this.verifications) {
      if (row.consumed || row.expiresAt < now.getTime()) this.verifications.delete(key);
    }
  }

  async findByEmail(email: string): Promise<StoredUser | null> {
    const id = this.idByEmail.get(this.normalizeEmail(email));
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async findById(id: string): Promise<StoredUser | null> {
    return this.byId.get(id) ?? null;
  }

  async registerFailedLogin(userId: string, now: Date): Promise<{ lockedUntil: Date | null }> {
    const user = this.byId.get(userId);
    if (!user) return { lockedUntil: null };
    user.failedLoginAttempts = (user.failedLoginAttempts ?? 0) + 1;
    const lockedUntil = loginBackoffUntil(user.failedLoginAttempts, now);
    user.lockedUntil = lockedUntil?.toISOString();
    return { lockedUntil };
  }

  async clearFailedLogins(userId: string): Promise<void> {
    const user = this.byId.get(userId);
    if (!user) return;
    user.failedLoginAttempts = 0;
    user.lockedUntil = undefined;
  }

  private readonly verifications = new Map<
    string,
    { userId: string; expiresAt: number; consumed: boolean; attempts: number }
  >();

  async createEmailVerification(userId: string, codeHash: string, expiresAt: Date): Promise<void> {
    // Re-sending supersedes, matching the Prisma implementation: only the newest code is live.
    for (const row of this.verifications.values()) {
      if (row.userId === userId && !row.consumed) row.expiresAt = 0;
    }
    this.verifications.set(`${userId}:${codeHash}`, {
      userId,
      expiresAt: expiresAt.getTime(),
      consumed: false,
      attempts: 0,
    });
  }

  async consumeEmailVerification(userId: string, codeHash: string): Promise<StoredUser | null> {
    const row = this.verifications.get(`${userId}:${codeHash}`);
    const live =
      row &&
      !row.consumed &&
      row.expiresAt > Date.now() &&
      row.attempts < MAX_VERIFICATION_ATTEMPTS;

    if (!live) {
      // A miss burns an attempt against every live code this user holds, so a 6-digit secret
      // cannot be ground down by looping.
      for (const other of this.verifications.values()) {
        if (other.userId === userId && !other.consumed && other.expiresAt > Date.now()) {
          other.attempts += 1;
        }
      }
      return null;
    }

    row.consumed = true;
    const user = this.byId.get(row.userId);
    if (!user) return null;
    user.emailVerifiedAt ??= new Date().toISOString();
    return user;
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}
