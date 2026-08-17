import { Injectable } from '@nestjs/common';

import type { VaultRepository } from './vault.repository';

/** Process-local key store for tests and for booting without a database. */
@Injectable()
export class InMemoryVaultRepository implements VaultRepository {
  private readonly keys = new Map<string, Buffer>();

  async find(userId: string): Promise<Buffer | null> {
    const key = this.keys.get(userId);
    return key ? Buffer.from(key) : null;
  }

  async findOrCreate(userId: string, generate: () => Buffer): Promise<Buffer> {
    const existing = this.keys.get(userId);
    if (existing) return Buffer.from(existing);
    const created = generate();
    this.keys.set(userId, created);
    return Buffer.from(created);
  }
}
