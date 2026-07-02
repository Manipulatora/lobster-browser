import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { CreateUserInput, StoredUser, UsersRepository } from './users.repository';

/** The subset of a Prisma `users` row this repository maps to a `StoredUser`. */
interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  passwordHash: string | null;
  createdAt: Date;
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
    };
  }
}
