import { Injectable } from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'node:crypto';

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
   * Atomically claim an unredeemed, unexpired grant by its code hash and launcher proof.
   *
   * State and PKCE challenge must be verified before the claiming write, never in checks after it.
   * Otherwise a process that intercepts the loopback redirect can submit a wrong verifier first and
   * consume the code, turning PKCE's theft protection into a reliable denial of service against the
   * launcher.
   *
   * @returns the grant if this call claimed it; null if it does not exist, the launcher proof does
   *          not match, it has expired, or it was already redeemed.
   */
  redeem(
    codeHash: string,
    state: string,
    codeChallenge: string,
    now: Date,
  ): Promise<StoredGrant | null>;

  /** Drop expired rows. Housekeeping only — expiry is already enforced in `redeem`. */
  purgeExpired(now: Date): Promise<void>;
}

export const DESKTOP_AUTH_REPOSITORY = Symbol('DesktopAuthRepository');

/**
 * Compare one attacker-supplied OAuth proof with the stored value without a value-dependent string
 * comparison. `timingSafeEqual` requires equal-size buffers, so a wrong-size input is compared
 * against a same-size dummy before the separately recorded length result is folded in. This keeps
 * both the state and PKCE paths on the native constant-time primitive even for malformed lengths.
 *
 * This protects the comparison itself; as Node documents, it cannot make the surrounding request
 * handling constant-time.
 */
export function constantTimeEquals(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  const sameLength = suppliedBytes.length === expectedBytes.length;
  const comparable = sameLength ? suppliedBytes : Buffer.alloc(expectedBytes.length);
  const sameBytes = timingSafeEqual(comparable, expectedBytes);
  return sameLength && sameBytes;
}

@Injectable()
export class PrismaDesktopAuthRepository implements DesktopAuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(grant: Omit<StoredGrant, 'id' | 'redeemedAt'>): Promise<void> {
    await this.prisma.desktopAuthGrant.create({ data: grant });
  }

  async redeem(
    codeHash: string,
    state: string,
    codeChallenge: string,
    now: Date,
  ): Promise<StoredGrant | null> {
    return this.prisma.$transaction(async (tx) => {
      // Fetch by the random 256-bit code hash, then verify both launcher proofs in this process.
      // Putting state/challenge directly in the SQL equality predicate delegates their comparison
      // to a value-dependent database string comparator and reintroduces the timing oracle that
      // `constantTimeEquals` exists to close.
      const grant = (await tx.desktopAuthGrant.findUnique({
        where: { codeHash },
      })) as StoredGrant | null;
      if (!grant) return null;
      const stateMatches = constantTimeEquals(state, grant.state);
      const challengeMatches = constantTimeEquals(codeChallenge, grant.codeChallenge);
      if (!stateMatches || !challengeMatches) return null;

      // Proof checking precedes this await, but the claim itself remains atomic: any number of
      // valid concurrent exchanges may read the row and only one can change redeemedAt from null.
      // Expiry stays in this write predicate so crossing the deadline between read and claim fails.
      const claimed = await tx.desktopAuthGrant.updateMany({
        where: { id: grant.id, redeemedAt: null, expiresAt: { gt: now } },
        data: { redeemedAt: now },
      });
      if (claimed.count === 0) return null;
      return { ...grant, redeemedAt: now };
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

  async redeem(
    codeHash: string,
    state: string,
    codeChallenge: string,
    now: Date,
  ): Promise<StoredGrant | null> {
    const grant = this.grants.get(codeHash);
    if (!grant) return null;
    if (grant.redeemedAt) return null;
    if (grant.expiresAt <= now) return null;
    // Compute BOTH proofs before branching: short-circuiting the second comparison would disclose
    // whether the state alone matched. These random launcher proofs are intentionally never compared
    // with JavaScript's value-dependent string equality.
    const stateMatches = constantTimeEquals(state, grant.state);
    const challengeMatches = constantTimeEquals(codeChallenge, grant.codeChallenge);
    if (!stateMatches || !challengeMatches) return null;
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
