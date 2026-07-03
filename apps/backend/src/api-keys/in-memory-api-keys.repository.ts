import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { ApiKeyRecord, ApiKeysRepository, CreateApiKeyRecord } from './api-keys.repository';

/**
 * In-memory `ApiKeysRepository` backed by a Map. The active implementation until a Postgres
 * instance is provisioned — it lets API-key management run (and be tested) with no DB. State lives
 * for the lifetime of the process only; it is intentionally NOT durable.
 *
 * Records keep the `hashedKey` so {@link findByHash} can authenticate a presented secret; the
 * service strips it before returning anything to a client.
 */
@Injectable()
export class InMemoryApiKeysRepository implements ApiKeysRepository {
  private readonly byId = new Map<string, ApiKeyRecord>();

  async create(input: CreateApiKeyRecord): Promise<ApiKeyRecord> {
    const record: ApiKeyRecord = {
      id: randomUUID(),
      prefix: input.prefix,
      name: input.name,
      teamId: input.teamId,
      hashedKey: input.hashedKey,
      createdAt: new Date().toISOString(),
      // lastUsedAt is left undefined until the key is first used to authenticate.
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findAllByTeam(teamId: string): Promise<ApiKeyRecord[]> {
    return [...this.byId.values()].filter((key) => key.teamId === teamId);
  }

  async findById(teamId: string, id: string): Promise<ApiKeyRecord | null> {
    const key = this.byId.get(id);
    return key && key.teamId === teamId ? key : null;
  }

  async remove(teamId: string, id: string): Promise<boolean> {
    const key = this.byId.get(id);
    if (!key || key.teamId !== teamId) {
      return false;
    }
    this.byId.delete(id);
    return true;
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    // Linear scan is fine for the in-memory store; Prisma indexes/queries by hash directly.
    return [...this.byId.values()].find((key) => key.hashedKey === hash) ?? null;
  }

  async touchLastUsed(id: string): Promise<void> {
    const key = this.byId.get(id);
    if (!key) {
      return;
    }
    this.byId.set(id, { ...key, lastUsedAt: new Date().toISOString() });
  }
}
