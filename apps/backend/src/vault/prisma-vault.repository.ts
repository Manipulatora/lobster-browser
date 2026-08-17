import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { VaultRepository } from './vault.repository';

@Injectable()
export class PrismaVaultRepository implements VaultRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(userId: string): Promise<Buffer | null> {
    const row = await this.prisma.vaultKey.findUnique({ where: { userId } });
    return row ? Buffer.from(row.dataKey) : null;
  }

  async findOrCreate(userId: string, generate: () => Buffer): Promise<Buffer> {
    const existing = await this.find(userId);
    if (existing) return existing;

    // Two clients signing in at once must not end up with different keys — the second would seal
    // snapshots the first cannot read. `create` + catch-on-conflict makes the database's primary key
    // the arbiter, so exactly one generated key can ever win.
    try {
      const row = await this.prisma.vaultKey.create({
        data: { userId, dataKey: generate() },
      });
      return Buffer.from(row.dataKey);
    } catch {
      const winner = await this.find(userId);
      if (!winner) throw new Error(`could not create or read a vault key for ${userId}`);
      return winner;
    }
  }
}
