import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { MissingProfileError } from './leases.repository';
import type { AcquireLeaseInput, LeasesRepository, ProfileLease } from './leases.repository';

interface LeaseRow {
  profileId: string;
  leaseId: string;
  userId: string;
  deviceId: string;
  deviceLabel: string;
  acquiredAt: Date;
  expiresAt: Date;
}

@Injectable()
export class PrismaLeasesRepository implements LeasesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async acquire(
    input: AcquireLeaseInput,
    now: Date,
  ): Promise<{ ok: true; lease: ProfileLease } | { ok: false; heldBy: ProfileLease }> {
    // First claim: the primary key decides. Two racing callers cannot both insert.
    try {
      const row = await this.prisma.profileLease.create({
        data: {
          profileId: input.profileId,
          leaseId: input.leaseId,
          userId: input.userId,
          deviceId: input.deviceId,
          deviceLabel: input.deviceLabel,
          expiresAt: input.expiresAt,
        },
      });
      return { ok: true, lease: this.toLease(row as LeaseRow) };
    } catch (err) {
      // ONLY a duplicate primary key (P2002) means "a row already exists", which is the case the
      // takeover below heals. `profileId` is also a foreign key, so a profile deleted between the
      // caller's visibility check and this insert fails with P2003 — and any other code is a real
      // database fault. Both used to fall through here and end as "vanished mid-acquire", a 500
      // that named neither cause.
      const code = (err as { code?: string }).code;
      if (code === 'P2003') throw new MissingProfileError(input.profileId);
      if (code !== 'P2002') throw err;

      // A row exists. Take it over ONLY if it has expired — conditional in the WHERE clause, so the
      // check and the write are one statement and two callers cannot both win a lapsed lease.
      const takenOver = await this.prisma.profileLease.updateMany({
        where: { profileId: input.profileId, expiresAt: { lte: now } },
        data: {
          leaseId: input.leaseId,
          userId: input.userId,
          deviceId: input.deviceId,
          deviceLabel: input.deviceLabel,
          acquiredAt: now,
          expiresAt: input.expiresAt,
        },
      });
      const row = await this.prisma.profileLease.findUnique({
        where: { profileId: input.profileId },
      });
      if (!row) throw new Error(`lease row for ${input.profileId} vanished mid-acquire`);
      if (takenOver.count === 1 && row.leaseId === input.leaseId) {
        return { ok: true, lease: this.toLease(row as LeaseRow) };
      }
      return { ok: false, heldBy: this.toLease(row as LeaseRow) };
    }
  }

  async refresh(profileId: string, leaseId: string, expiresAt: Date, now: Date): Promise<boolean> {
    // Scoped to the caller's own leaseId AND to it still being live: a client that was taken over
    // while paused must not be able to extend a claim it no longer holds.
    const updated = await this.prisma.profileLease.updateMany({
      where: { profileId, leaseId, expiresAt: { gt: now } },
      data: { expiresAt },
    });
    return updated.count === 1;
  }

  async release(profileId: string, leaseId: string): Promise<boolean> {
    const deleted = await this.prisma.profileLease.deleteMany({ where: { profileId, leaseId } });
    return deleted.count === 1;
  }

  async current(profileId: string, now: Date): Promise<ProfileLease | null> {
    const row = await this.prisma.profileLease.findUnique({ where: { profileId } });
    if (!row || row.expiresAt <= now) return null;
    return this.toLease(row as LeaseRow);
  }

  async purgeExpired(now: Date): Promise<void> {
    await this.prisma.profileLease.deleteMany({ where: { expiresAt: { lt: now } } });
  }

  private toLease(row: LeaseRow): ProfileLease {
    return {
      profileId: row.profileId,
      leaseId: row.leaseId,
      userId: row.userId,
      deviceId: row.deviceId,
      deviceLabel: row.deviceLabel,
      acquiredAt: row.acquiredAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
  }
}
