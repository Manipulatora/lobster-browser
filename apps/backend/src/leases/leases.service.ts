import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  LEASES_REPOSITORY,
  type LeasesRepository,
  type ProfileLease,
} from './leases.repository';

/**
 * How long a claim survives without a refresh.
 *
 * Short enough that a crashed machine frees its profile in a couple of minutes rather than needing an
 * operator, long enough to ride out a network blip or a laptop suspend without dropping a claim the
 * browser is still using. The holder refreshes at roughly a third of this.
 */
export const LEASE_TTL_MS = 150_000;

@Injectable()
export class LeasesService {
  constructor(@Inject(LEASES_REPOSITORY) private readonly repo: LeasesRepository) {}

  /**
   * Claim a profile for this device, or refuse and name the holder.
   *
   * The refusal is the feature. One profile is one browser identity, and running it from two machines
   * means the same account arriving from two IPs — the exact signal the product exists to avoid.
   */
  async acquire(
    profileId: string,
    userId: string,
    deviceId: string,
    deviceLabel: string,
  ): Promise<ProfileLease> {
    const now = new Date();
    const result = await this.repo.acquire(
      {
        profileId,
        userId,
        deviceId,
        deviceLabel,
        leaseId: randomUUID(),
        expiresAt: new Date(now.getTime() + LEASE_TTL_MS),
      },
      now,
    );
    if (result.ok) return result.lease;

    // Phrased for the person reading it, the way Octo phrases it: the remedy is to close it where it
    // is open, not to retry harder.
    const secondsLeft = Math.max(
      0,
      Math.ceil((new Date(result.heldBy.expiresAt).getTime() - now.getTime()) / 1000),
    );
    throw new ConflictException(
      `This profile is open on ${result.heldBy.deviceLabel}. Close it there first. ` +
        `If that device is offline, the profile frees itself in about ${secondsLeft}s.`,
    );
  }

  /** Extend a claim while the browser is still running. */
  async refresh(profileId: string, leaseId: string): Promise<ProfileLease> {
    const now = new Date();
    const ok = await this.repo.refresh(
      profileId,
      leaseId,
      new Date(now.getTime() + LEASE_TTL_MS),
      now,
    );
    if (!ok) {
      // Taken over or released. The caller must stop rather than keep browsing, since another machine
      // may already be running this identity.
      throw new ConflictException(
        'this lease is no longer held — the profile was taken over or released, so stop using it',
      );
    }
    const lease = await this.repo.current(profileId, now);
    if (!lease) throw new NotFoundException('lease vanished after a successful refresh');
    return lease;
  }

  async release(profileId: string, leaseId: string): Promise<void> {
    // Not an error when it is already gone: a client releasing after being taken over is doing the
    // right thing, and failing it would only encourage clients to skip the release.
    await this.repo.release(profileId, leaseId);
  }

  /** Who holds it, or null when free. An expired lease reads as free. */
  async current(profileId: string): Promise<ProfileLease | null> {
    return this.repo.current(profileId, new Date());
  }
}
