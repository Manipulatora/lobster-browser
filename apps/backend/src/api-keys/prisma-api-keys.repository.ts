import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { ApiKeyRecord, ApiKeysRepository, CreateApiKeyRecord } from './api-keys.repository';

/** The subset of a Prisma `api_keys` row this repository maps to an {@link ApiKeyRecord}. */
interface ApiKeyRow {
  id: string;
  prefix: string;
  hashedKey: string;
  name: string;
  teamId: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/**
 * Production `ApiKeysRepository` backed by Postgres via the shared {@link PrismaService}.
 *
 * The wiring module selects this as the active provider whenever `DATABASE_URL` is set; without
 * a DB (local dev / tests) the in-memory repository is used instead. Team-facing reads/writes are
 * scoped to `teamId`. The server persists only the display `prefix` + the `hashedKey` (sha256 of
 * the secret) — never the plaintext secret, which is shown to the caller exactly once at creation.
 */
@Injectable()
export class PrismaApiKeysRepository implements ApiKeysRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateApiKeyRecord): Promise<ApiKeyRecord> {
    const row = await this.prisma.apiKey.create({
      data: {
        prefix: input.prefix,
        hashedKey: input.hashedKey,
        name: input.name,
        teamId: input.teamId,
      },
    });
    return this.toRecord(row);
  }

  async findAllByTeam(teamId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: { teamId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toRecord(row));
  }

  async findById(teamId: string, id: string): Promise<ApiKeyRecord | null> {
    const row = await this.prisma.apiKey.findFirst({ where: { id, teamId } });
    return row ? this.toRecord(row) : null;
  }

  async remove(teamId: string, id: string): Promise<boolean> {
    const existing = await this.prisma.apiKey.findFirst({ where: { id, teamId } });
    if (!existing) {
      return false;
    }
    await this.prisma.apiKey.delete({ where: { id } });
    return true;
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const row = await this.prisma.apiKey.findFirst({ where: { hashedKey: hash } });
    return row ? this.toRecord(row) : null;
  }

  async touchLastUsed(id: string): Promise<void> {
    // Best-effort last-used stamp; scoped by id only (this is the authenticated key itself).
    // `updateMany` is a no-op (count: 0) rather than a throw when the key was concurrently revoked,
    // so a benign create/verify/revoke race can never surface as a 500 to the automation client.
    await this.prisma.apiKey.updateMany({ where: { id }, data: { lastUsedAt: new Date() } });
  }

  /**
   * Map a Prisma row to an internal {@link ApiKeyRecord}. The `hashedKey` is preserved here (the
   * record is server-internal); the SERVICE strips it before returning an {@link ApiKey} to a
   * client, so the hash never crosses the HTTP boundary.
   */
  private toRecord(row: ApiKeyRow): ApiKeyRecord {
    return {
      id: row.id,
      prefix: row.prefix,
      name: row.name,
      teamId: row.teamId,
      hashedKey: row.hashedKey,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : undefined,
    };
  }
}
