import { Injectable } from '@nestjs/common';

import type {
  UpsertVaultEnrollment,
  VaultEnrollmentRecord,
  VaultRepository,
} from './vault.repository';

/**
 * Process-local enrollment store for tests and for booting without a database.
 *
 * Mirrors the Prisma implementation's REFUSALS, not just its happy path: `create` rejects a second
 * enrollment and `rotate` returns null for a missing one. A stub that quietly upserted would let a
 * test pass while the real backend threw — and the thing being guarded here is the only copy of a
 * user's key wraps.
 */
@Injectable()
export class InMemoryVaultRepository implements VaultRepository {
  private readonly rows = new Map<string, VaultEnrollmentRecord>();

  async find(userId: string): Promise<VaultEnrollmentRecord | null> {
    const row = this.rows.get(userId);
    return row ? this.clone(row) : null;
  }

  async create(input: UpsertVaultEnrollment): Promise<VaultEnrollmentRecord> {
    if (this.rows.has(input.userId)) {
      throw new Error(`vault enrollment already exists for ${input.userId}`);
    }
    const record: VaultEnrollmentRecord = {
      ...this.fromInput(input),
      enrolledAt: new Date().toISOString(),
    };
    this.rows.set(input.userId, record);
    return this.clone(record);
  }

  async rotate(input: UpsertVaultEnrollment): Promise<VaultEnrollmentRecord | null> {
    const existing = this.rows.get(input.userId);
    if (!existing) return null;
    const record: VaultEnrollmentRecord = {
      ...existing,
      ...this.fromInput(input),
      rotatedAt: new Date().toISOString(),
    };
    this.rows.set(input.userId, record);
    return this.clone(record);
  }

  async markRecoveryCodeUsed(userId: string): Promise<void> {
    const existing = this.rows.get(userId);
    if (!existing || existing.recoveryCodeUsedAt) return;
    this.rows.set(userId, { ...existing, recoveryCodeUsedAt: new Date().toISOString() });
  }

  private fromInput(input: UpsertVaultEnrollment) {
    return {
      userId: input.userId,
      passwordSalt: Buffer.from(input.passwordSalt),
      recoverySalt: Buffer.from(input.recoverySalt),
      wrappedByPassword: Buffer.from(input.wrappedByPassword),
      wrappedByRecovery: Buffer.from(input.wrappedByRecovery),
      keyFingerprint: input.keyFingerprint,
      argon: { ...input.argon },
    };
  }

  /** Copied out so a caller mutating a returned Buffer cannot corrupt the stored wraps. */
  private clone(row: VaultEnrollmentRecord): VaultEnrollmentRecord {
    return {
      ...row,
      passwordSalt: Buffer.from(row.passwordSalt),
      recoverySalt: Buffer.from(row.recoverySalt),
      wrappedByPassword: Buffer.from(row.wrappedByPassword),
      wrappedByRecovery: Buffer.from(row.wrappedByRecovery),
      argon: { ...row.argon },
    };
  }
}
