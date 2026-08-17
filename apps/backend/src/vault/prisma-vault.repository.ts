import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type {
  UpsertVaultEnrollment,
  VaultEnrollmentRecord,
  VaultRepository,
} from './vault.repository';

/** The Prisma row shape, kept local so the mapper is explicit about every field it reads. */
interface VaultRow {
  userId: string;
  passwordSalt: Buffer | Uint8Array;
  recoverySalt: Buffer | Uint8Array;
  wrappedByPassword: Buffer | Uint8Array;
  wrappedByRecovery: Buffer | Uint8Array;
  keyFingerprint: string;
  argonMemoryKiB: number;
  argonIterations: number;
  argonParallelism: number;
  enrolledAt: Date;
  recoveryCodeUsedAt: Date | null;
  rotatedAt: Date | null;
}

@Injectable()
export class PrismaVaultRepository implements VaultRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(userId: string): Promise<VaultEnrollmentRecord | null> {
    const row = await this.prisma.vaultEnrollment.findUnique({ where: { userId } });
    return row ? this.toRecord(row as VaultRow) : null;
  }

  async create(input: UpsertVaultEnrollment): Promise<VaultEnrollmentRecord> {
    const row = await this.prisma.vaultEnrollment.create({ data: this.toData(input) });
    return this.toRecord(row as VaultRow);
  }

  async rotate(input: UpsertVaultEnrollment): Promise<VaultEnrollmentRecord | null> {
    // `updateMany` rather than `update` so a missing enrollment returns null instead of throwing:
    // "you have not enrolled" is a 404 the caller renders, not an exception.
    const changed = await this.prisma.vaultEnrollment.updateMany({
      where: { userId: input.userId },
      data: { ...this.toData(input), rotatedAt: new Date() },
    });
    if (changed.count === 0) return null;
    return this.find(input.userId);
  }

  async markRecoveryCodeUsed(userId: string): Promise<void> {
    // Conditional on the column still being null, so the FIRST use is the one recorded. Re-stamping
    // on every later use would lose the fact that matters: when the code left its paper copy.
    await this.prisma.vaultEnrollment.updateMany({
      where: { userId, recoveryCodeUsedAt: null },
      data: { recoveryCodeUsedAt: new Date() },
    });
  }

  private toData(input: UpsertVaultEnrollment) {
    return {
      userId: input.userId,
      passwordSalt: Buffer.from(input.passwordSalt),
      recoverySalt: Buffer.from(input.recoverySalt),
      wrappedByPassword: Buffer.from(input.wrappedByPassword),
      wrappedByRecovery: Buffer.from(input.wrappedByRecovery),
      keyFingerprint: input.keyFingerprint,
      argonMemoryKiB: input.argon.memoryKiB,
      argonIterations: input.argon.iterations,
      argonParallelism: input.argon.parallelism,
    };
  }

  private toRecord(row: VaultRow): VaultEnrollmentRecord {
    return {
      userId: row.userId,
      passwordSalt: Buffer.from(row.passwordSalt),
      recoverySalt: Buffer.from(row.recoverySalt),
      wrappedByPassword: Buffer.from(row.wrappedByPassword),
      wrappedByRecovery: Buffer.from(row.wrappedByRecovery),
      keyFingerprint: row.keyFingerprint,
      argon: {
        memoryKiB: row.argonMemoryKiB,
        iterations: row.argonIterations,
        parallelism: row.argonParallelism,
      },
      enrolledAt: row.enrolledAt.toISOString(),
      ...(row.recoveryCodeUsedAt
        ? { recoveryCodeUsedAt: row.recoveryCodeUsedAt.toISOString() }
        : {}),
      ...(row.rotatedAt ? { rotatedAt: row.rotatedAt.toISOString() } : {}),
    };
  }
}
