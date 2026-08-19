import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { PROFILES_REPOSITORY, type ProfilesRepository } from '../profiles/profiles.repository';
import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import {
  LEASES_REPOSITORY,
  MissingProfileError,
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
  constructor(
    @Inject(LEASES_REPOSITORY) private readonly repo: LeasesRepository,
    @Inject(PROFILES_REPOSITORY) private readonly profiles: ProfilesRepository,
    @Inject(TEAMS_REPOSITORY) private readonly teams: TeamsRepository,
  ) {}

  /**
   * Claim a profile for this device, or refuse and name the holder.
   *
   * The refusal is the feature. One profile is one browser identity, and running it from two machines
   * means the same account arriving from two IPs — the exact signal the product exists to avoid.
   */
  async acquire(
    userId: string,
    profileId: string,
    deviceId: string,
    deviceLabel: string,
  ): Promise<ProfileLease> {
    await this.assertVisible(userId, profileId);

    const now = new Date();
    const result = await this.claim(
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
  async refresh(userId: string, profileId: string, leaseId: string): Promise<ProfileLease> {
    await this.assertVisible(userId, profileId);

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

  async release(userId: string, profileId: string, leaseId: string): Promise<void> {
    await this.assertVisible(userId, profileId);
    // Not an error when it is already gone: a client releasing after being taken over is doing the
    // right thing, and failing it would only encourage clients to skip the release.
    await this.repo.release(profileId, leaseId);
  }

  /** Who holds it, or null when free. An expired lease reads as free. */
  async current(userId: string, profileId: string): Promise<ProfileLease | null> {
    await this.assertVisible(userId, profileId);
    return this.repo.current(profileId, new Date());
  }

  /**
   * The profile id is the only thing identifying the resource on these routes, so without this the
   * lease is an IDOR: a read names the user and device currently running someone else's identity,
   * and a write takes that identity over and keeps re-taking it, which blocks the owner's launch
   * for as long as the attacker refreshes.
   *
   * A profile the caller cannot see and a profile that does not exist answer the SAME 404 — a
   * distinct 403 would confirm that the id is real and belongs to somebody.
   *
   * Membership is checked across EVERY team the caller belongs to rather than through the
   * first-team resolution the other services use, because a lease route carries no `teamId` and a
   * member of two teams still has to be able to launch a profile from the second one.
   */
  private async assertVisible(userId: string, profileId: string): Promise<void> {
    const teams = await this.teams.findTeamsForUser(userId);
    for (const team of teams) {
      if (await this.profiles.findById(team.id, profileId)) return;
    }
    throw new NotFoundException('profile not found');
  }

  /** `repo.acquire`, with a profile deleted mid-call reported as the 404 it is. */
  private async claim(
    input: Parameters<LeasesRepository['acquire']>[0],
    now: Date,
  ): Promise<Awaited<ReturnType<LeasesRepository['acquire']>>> {
    try {
      return await this.repo.acquire(input, now);
    } catch (err) {
      if (err instanceof MissingProfileError) throw new NotFoundException('profile not found');
      throw err;
    }
  }
}
