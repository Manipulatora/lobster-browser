import { Injectable } from '@nestjs/common';

import type { AcquireLeaseInput, LeasesRepository, ProfileLease } from './leases.repository';

/**
 * Process-local leases for tests and for booting without a database.
 *
 * Mirrors the Prisma implementation's ATOMICITY, not just its happy path: every method's read and
 * write run with no `await` between them, so on the single-threaded event loop two racing acquires
 * cannot both win. A stub that awaited mid-check would pass tests the real backend would fail.
 */
@Injectable()
export class InMemoryLeasesRepository implements LeasesRepository {
  private readonly rows = new Map<string, ProfileLease>();

  async acquire(
    input: AcquireLeaseInput,
    now: Date,
  ): Promise<{ ok: true; lease: ProfileLease } | { ok: false; heldBy: ProfileLease }> {
    const existing = this.rows.get(input.profileId);
    if (existing && new Date(existing.expiresAt) > now) {
      return { ok: false, heldBy: { ...existing } };
    }
    const lease: ProfileLease = {
      profileId: input.profileId,
      leaseId: input.leaseId,
      userId: input.userId,
      deviceId: input.deviceId,
      deviceLabel: input.deviceLabel,
      acquiredAt: now.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    };
    this.rows.set(input.profileId, lease);
    return { ok: true, lease: { ...lease } };
  }

  async refresh(profileId: string, leaseId: string, expiresAt: Date, now: Date): Promise<boolean> {
    const existing = this.rows.get(profileId);
    if (!existing || existing.leaseId !== leaseId || new Date(existing.expiresAt) <= now) {
      return false;
    }
    this.rows.set(profileId, { ...existing, expiresAt: expiresAt.toISOString() });
    return true;
  }

  async release(profileId: string, leaseId: string): Promise<boolean> {
    const existing = this.rows.get(profileId);
    if (!existing || existing.leaseId !== leaseId) return false;
    this.rows.delete(profileId);
    return true;
  }

  async current(profileId: string, now: Date): Promise<ProfileLease | null> {
    const existing = this.rows.get(profileId);
    if (!existing || new Date(existing.expiresAt) <= now) return null;
    return { ...existing };
  }

  async purgeExpired(now: Date): Promise<void> {
    for (const [profileId, lease] of this.rows) {
      if (new Date(lease.expiresAt) <= now) this.rows.delete(profileId);
    }
  }
}
