import { randomBytes } from 'node:crypto';

import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Profile } from '@lobster/shared-types';

import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import type { CreateProfileDto } from './dto/create-profile.dto';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import { PROFILES_REPOSITORY, type ProfilesRepository } from './profiles.repository';

/** Direction of an encrypted-blob sync. */
export type SyncDirection = 'push' | 'pull';

/** Result of a profile sync. On `pull` the client fetches the blob from `blobRef` (S3). */
export interface SyncResult {
  profileId: string;
  direction: SyncDirection;
  /** S3 object key / URI for the CLIENT-encrypted blob (server never sees plaintext). */
  blobRef: string;
  syncedAt: string;
}

/**
 * Default per-team profile limit for teams without a Subscription row (free tier). A team with a
 * Subscription uses its `profileLimit` instead (read via the repository).
 *
 * MUST match the free-tier default in prisma/schema.prisma (`Subscription.profileLimit @default(5)`)
 * so a team behaves identically before and after a Subscription row exists.
 */
export const DEFAULT_FREE_PROFILE_LIMIT = 5;

/**
 * Profile CRUD + encrypted-blob sync.
 *
 * Every operation is scoped to a team the caller belongs to: the team is resolved from the
 * caller's membership (their first team, or an explicit `teamId` they belong to). Storage is
 * abstracted behind `ProfilesRepository` (in-memory today, Prisma once Postgres is provisioned),
 * so this service runs and is tested without a database.
 */
@Injectable()
export class ProfilesService {
  constructor(
    @Inject(PROFILES_REPOSITORY) private readonly profiles: ProfilesRepository,
    @Inject(TEAMS_REPOSITORY) private readonly teams: TeamsRepository,
  ) {}

  async create(userId: string, dto: CreateProfileDto, teamId?: string): Promise<Profile> {
    const ownerTeamId = await this.resolveTeamId(userId, teamId);
    await this.assertUnderPlanLimit(ownerTeamId);

    // Every profile MUST get a unique seed — a shared/constant seed would give many profiles the
    // same fingerprint identity. Generate a fresh random 128-bit seed when the caller omits one.
    const fingerprintSeed = dto.fingerprintSeed ?? randomBytes(16).toString('hex');
    return this.profiles.create({
      ownerTeamId,
      name: dto.name,
      engine: dto.engine,
      os: dto.os,
      fingerprintSeed,
      fingerprintOverrides: dto.fingerprintOverrides,
      tags: dto.tags ?? [],
      folder: dto.folder,
      notes: dto.notes,
    });
  }

  async findAll(userId: string, teamId?: string): Promise<Profile[]> {
    const ownerTeamId = await this.resolveTeamId(userId, teamId);
    return this.profiles.findAllByTeam(ownerTeamId);
  }

  async findOne(userId: string, id: string, teamId?: string): Promise<Profile> {
    const ownerTeamId = await this.resolveTeamId(userId, teamId);
    const profile = await this.profiles.findById(ownerTeamId, id);
    if (!profile) {
      throw new NotFoundException('profile not found');
    }
    return profile;
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateProfileDto,
    teamId?: string,
  ): Promise<Profile> {
    const ownerTeamId = await this.resolveTeamId(userId, teamId);
    const updated = await this.profiles.update(ownerTeamId, id, dto);
    if (!updated) {
      throw new NotFoundException('profile not found');
    }
    return updated;
  }

  async remove(
    userId: string,
    id: string,
    teamId?: string,
  ): Promise<{ id: string; deleted: true }> {
    const ownerTeamId = await this.resolveTeamId(userId, teamId);
    const deleted = await this.profiles.remove(ownerTeamId, id);
    if (!deleted) {
      throw new NotFoundException('profile not found');
    }
    // TODO(Day 2): also delete the encrypted blob from S3.
    return { id, deleted: true };
  }

  /**
   * Push (upload new encrypted blob) or pull (get a reference to the latest blob).
   * The desktop agent encrypts/decrypts locally; the server only brokers the reference.
   *
   * STUB — see the blob-ref returned below. Day 2: on push accept a multipart/presigned upload
   * and store the returned object key on Profile.encryptedBlobRef; on pull return a presigned GET.
   */
  async sync(
    userId: string,
    id: string,
    direction: SyncDirection,
    teamId?: string,
  ): Promise<SyncResult> {
    const ownerTeamId = await this.resolveTeamId(userId, teamId);
    // Confirm the profile exists and belongs to the caller's team before handing back a blob ref.
    const profile = await this.profiles.findById(ownerTeamId, id);
    if (!profile) {
      throw new NotFoundException('profile not found');
    }
    return {
      profileId: id,
      direction,
      blobRef: `s3://lobster-profiles/${id}/latest.enc`,
      syncedAt: new Date().toISOString(),
    };
  }

  /**
   * Resolve the team to operate on. When `teamId` is given the caller must belong to it;
   * otherwise fall back to the caller's first team. Throws `ForbiddenException` when the caller
   * has no matching team (defence in depth — every user gets a personal team at register time).
   */
  private async resolveTeamId(userId: string, teamId?: string): Promise<string> {
    if (teamId) {
      const membership = await this.teams.getMembership(teamId, userId);
      if (!membership) {
        throw new ForbiddenException('you are not a member of the requested team');
      }
      return teamId;
    }
    const teams = await this.teams.findTeamsForUser(userId);
    const first = teams[0];
    if (!first) {
      throw new ForbiddenException('you do not belong to any team');
    }
    return first.id;
  }

  /**
   * Per-plan profile-limit gate. Reads the team's Subscription.profileLimit when present, else
   * applies the default free-tier limit; throws `ForbiddenException` when the team is at capacity.
   */
  private async assertUnderPlanLimit(teamId: string): Promise<void> {
    const limit = (await this.profiles.getProfileLimit(teamId)) ?? DEFAULT_FREE_PROFILE_LIMIT;
    const currentCount = (await this.profiles.findAllByTeam(teamId)).length;
    if (currentCount >= limit) {
      throw new ForbiddenException(
        `profile limit (${limit}) reached for this team; upgrade the plan to add more`,
      );
    }
  }
}
