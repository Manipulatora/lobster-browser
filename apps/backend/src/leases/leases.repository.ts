/** A live claim on a profile. */
export interface ProfileLease {
  profileId: string;
  leaseId: string;
  userId: string;
  deviceId: string;
  deviceLabel: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface AcquireLeaseInput {
  profileId: string;
  userId: string;
  deviceId: string;
  deviceLabel: string;
  /** Absolute expiry. The holder refreshes before it passes. */
  expiresAt: Date;
  /** Fresh per-claim id, presented on refresh and release. */
  leaseId: string;
}

export interface LeasesRepository {
  /**
   * Take the lease, or report who already holds it.
   *
   * MUST be atomic: a read-then-write acquire lets two callers both believe they hold the profile,
   * which for an anti-detect product is simultaneously a corruption hazard and a detection event.
   * An EXPIRED lease may be taken over — that is how a crashed machine's claim heals itself.
   */
  acquire(input: AcquireLeaseInput, now: Date): Promise<
    { ok: true; lease: ProfileLease } | { ok: false; heldBy: ProfileLease }
  >;

  /** Extend a lease the caller still holds. False when it was taken over or released meanwhile. */
  refresh(profileId: string, leaseId: string, expiresAt: Date, now: Date): Promise<boolean>;

  /** Give the lease up. Only the holder may, so a stale client cannot release someone else's claim. */
  release(profileId: string, leaseId: string): Promise<boolean>;

  /** The current holder, or null when free. An expired lease reads as free. */
  current(profileId: string, now: Date): Promise<ProfileLease | null>;
}

export const LEASES_REPOSITORY = Symbol('LEASES_REPOSITORY');
