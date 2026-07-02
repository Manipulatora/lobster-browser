import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Profile } from '@lobster/shared-types';

import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import { BLOB_STORE, type BlobStore } from './blob/blob-store';
import type { CreateProfileDto } from './dto/create-profile.dto';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import { PROFILES_REPOSITORY, type ProfilesRepository } from './profiles.repository';

/** Direction of an encrypted-blob sync. */
export type SyncDirection = 'push' | 'pull';

/** Arguments for {@link ProfilesService.sync}, parsed from the validated request DTO. */
export interface SyncProfileInput {
  direction: SyncDirection;
  /** base64 CLIENT-encrypted blob to store. Required on push; ignored on pull. */
  payload?: string;
  /** Version the client believes is current; a mismatch on push is a conflict (409). */
  baseVersion?: number;
}

/**
 * Result of a profile sync.
 *
 * `version` is the current stored version (0 when a profile has never been synced). `blobRef` is
 * the S3-style object key / URI for the CLIENT-encrypted blob at that version (null when none
 * exists). On `pull`, `payload` carries the latest blob base64-encoded (null when never synced);
 * it is omitted on `push`. The server never sees plaintext — the desktop agent holds the AES key.
 */
export interface SyncResult {
  profileId: string;
  direction: SyncDirection;
  blobRef: string | null;
  version: number;
  /** base64 CLIENT-encrypted blob (pull only; null when never synced). */
  payload?: string | null;
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
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
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
   * Push (upload a new CLIENT-encrypted blob) or pull (fetch the latest). The desktop agent
   * encrypts/decrypts locally with its own AES key; the server only stores opaque bytes + a
   * per-profile version. Every sync is team-scoped: the profile must belong to the caller's team.
   *
   * Push is optimistic-concurrency-checked: when the caller supplies `baseVersion` it must equal
   * the currently-stored version, otherwise the write is rejected with a 409 (the caller must pull,
   * re-apply, and retry). Each successful push bumps the version by one.
   */
  async sync(
    userId: string,
    id: string,
    input: SyncProfileInput,
    teamId?: string,
  ): Promise<SyncResult> {
    const ownerTeamId = await this.resolveTeamId(userId, teamId);
    // Confirm the profile exists and belongs to the caller's team before touching the blob store.
    const profile = await this.profiles.findById(ownerTeamId, id);
    if (!profile) {
      throw new NotFoundException('profile not found');
    }
    const key = this.blobKey(ownerTeamId, id);
    return input.direction === 'pull'
      ? this.pull(id, ownerTeamId, key)
      : this.push(id, ownerTeamId, key, input);
  }

  /** Store a new encrypted blob, enforcing the optimistic-concurrency check when requested. */
  private async push(
    profileId: string,
    teamId: string,
    key: string,
    input: SyncProfileInput,
  ): Promise<SyncResult> {
    if (input.payload === undefined) {
      throw new BadRequestException('push requires a base64 payload');
    }
    if (input.baseVersion !== undefined) {
      const currentVersion = (await this.blobs.head(key))?.version ?? 0;
      if (input.baseVersion !== currentVersion) {
        throw new ConflictException('stale base version');
      }
    }
    // `payload` is validated as base64 at the DTO boundary; store the decoded bytes opaquely.
    const bytes = Buffer.from(input.payload, 'base64');
    const { version } = await this.blobs.put(key, bytes, { teamId, profileId });
    return {
      profileId,
      direction: 'push',
      blobRef: this.blobRef(teamId, profileId, version),
      version,
      syncedAt: new Date().toISOString(),
    };
  }

  /** Return the latest encrypted blob (base64), or a version-0/null result when never synced. */
  private async pull(profileId: string, teamId: string, key: string): Promise<SyncResult> {
    const latest = await this.blobs.getLatest(key);
    if (!latest) {
      return {
        profileId,
        direction: 'pull',
        blobRef: null,
        version: 0,
        payload: null,
        syncedAt: new Date().toISOString(),
      };
    }
    return {
      profileId,
      direction: 'pull',
      blobRef: this.blobRef(teamId, profileId, latest.version),
      version: latest.version,
      payload: latest.bytes.toString('base64'),
      syncedAt: latest.updatedAt,
    };
  }

  /** Logical blob-store key for a profile's encrypted-blob stream (the store owns versioning). */
  private blobKey(teamId: string, profileId: string): string {
    return `${teamId}/${profileId}`;
  }

  /** S3-style object URI for a specific stored version of a profile's encrypted blob. */
  private blobRef(teamId: string, profileId: string, version: number): string {
    return `s3://lobster-profiles/${teamId}/${profileId}/${version}.enc`;
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
