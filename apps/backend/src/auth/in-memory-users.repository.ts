import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { CreateUserInput, StoredUser, UsersRepository } from './users.repository';

/** Mirrors the Prisma repository's cap; see it for why a 6-digit code needs one. */
const MAX_VERIFICATION_ATTEMPTS = 5;

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

  async create(input: CreateUserInput): Promise<StoredUser> {
    const user: StoredUser = {
      id: randomUUID(),
      email: input.email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      createdAt: new Date().toISOString(),
    };
    this.byId.set(user.id, user);
    this.idByEmail.set(this.normalizeEmail(input.email), user.id);
    return user;
  }

  async findByEmail(email: string): Promise<StoredUser | null> {
    const id = this.idByEmail.get(this.normalizeEmail(email));
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async findById(id: string): Promise<StoredUser | null> {
    return this.byId.get(id) ?? null;
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
