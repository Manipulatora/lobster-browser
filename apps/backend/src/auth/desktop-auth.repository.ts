import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { PrismaService } from '../prisma/prisma.service';

/** A pending desktop authorisation code. */
export interface StoredGrant {
  id: string;
  codeHash: string;
  state: string;
  codeChallenge: string;
  userId: string;
  expiresAt: Date;
  redeemedAt: Date | null;
}

/**
 * Persistence for the desktop loopback handoff.
 *
 * `redeem` is deliberately a single call rather than find-then-mark: the code is single-use, and
 * checking `redeemedAt` in JavaScript before writing it leaves a window in which two concurrent
 * exchanges both observe null and both receive a session. Implementations must claim the row
 * atomically.
 */
export interface DesktopAuthRepository {
  create(grant: Omit<StoredGrant, 'id' | 'redeemedAt'>): Promise<void>;

  /**
   * Atomically claim an unredeemed, unexpired grant by its code hash.
   *
   * @returns the grant if this call claimed it; null if it does not exist, has expired, or was
   *          already redeemed.
   */
  redeem(codeHash: string, now: Date): Promise<StoredGrant | null>;

  /** Drop expired rows. Housekeeping only — expiry is already enforced in `redeem`. */
  purgeExpired(now: Date): Promise<void>;
}

export const DESKTOP_AUTH_REPOSITORY = Symbol('DesktopAuthRepository');

@Injectable()
export class PrismaDesktopAuthRepository implements DesktopAuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(grant: Omit<StoredGrant, 'id' | 'redeemedAt'>): Promise<void> {
    await this.prisma.desktopAuthGrant.create({ data: grant });
  }

  async redeem(codeHash: string, now: Date): Promise<StoredGrant | null> {
    return this.prisma.$transaction(async (tx) => {
      // The predicate does the enforcing, not a prior read: `redeemedAt: null` means exactly one
      // of any number of concurrent exchanges can match, and `expiresAt: { gt: now }` means an
      // expired code cannot be claimed even if it is still in the table.
      const claimed = await tx.desktopAuthGrant.updateMany({
        where: { codeHash, redeemedAt: null, expiresAt: { gt: now } },
        data: { redeemedAt: now },
      });
      if (claimed.count === 0) return null;
      return (await tx.desktopAuthGrant.findUnique({ where: { codeHash } })) as StoredGrant | null;
    });
  }

  async purgeExpired(now: Date): Promise<void> {
    await this.prisma.desktopAuthGrant.deleteMany({ where: { expiresAt: { lt: now } } });
  }
}

/** In-memory grants, for running without Postgres. */
@Injectable()
export class InMemoryDesktopAuthRepository implements DesktopAuthRepository {
  private readonly grants = new Map<string, StoredGrant>();

  async create(grant: Omit<StoredGrant, 'id' | 'redeemedAt'>): Promise<void> {
    this.grants.set(grant.codeHash, { ...grant, id: randomUUID(), redeemedAt: null });
  }

  async redeem(codeHash: string, now: Date): Promise<StoredGrant | null> {
    const grant = this.grants.get(codeHash);
    if (!grant) return null;
    if (grant.redeemedAt) return null;
    if (grant.expiresAt <= now) return null;
    // Single-threaded and no await between the checks and this write, so the claim is atomic —
    // the same contract the Prisma implementation enforces with a predicate.
    grant.redeemedAt = now;
    return grant;
  }

  async purgeExpired(now: Date): Promise<void> {
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt < now) this.grants.delete(key);
    }
  }
}
