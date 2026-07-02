import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { CreateUserInput, StoredUser, UsersRepository } from './users.repository';

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

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}
