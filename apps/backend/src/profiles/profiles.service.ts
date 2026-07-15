import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Profile, ProfileExport, ProfileExportBundle } from '@lobster/shared-types';

import { AuditService } from '../audit/audit.service';
import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import { BLOB_STORE, BlobVersionConflictError, type BlobStore } from './blob/blob-store';
import type { BulkCreateProfilesDto } from './dto/bulk-create-profiles.dto';
import type { CreateProfileDto } from './dto/create-profile.dto';
import type { ImportProfilesDto } from './dto/import-profiles.dto';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import { PROFILES_REPOSITORY, type ProfilesRepository } from './profiles.repository';
import { sanitizeCookieImportMetadata } from './sanitize-cookie-import';

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
/** Default free-tier profile limit (must match prisma Subscription.profileLimit default). */
export const DEFAULT_FREE_PROFILE_LIMIT = 5;

/**
 * BE-3: max CLIENT-encrypted blob size per push (bytes). 25 MiB covers a typical user-data
 * snapshot while rejecting runaway uploads. Override via `BLOB_MAX_BYTES`.
 */
export const DEFAULT_BLOB_MAX_BYTES = 25 * 1024 * 1024;

/**
 * BE-3: soft per-team total blob storage quota (bytes). Free tier default 250 MiB.
 * Override via `BLOB_TEAM_QUOTA_BYTES`. Enforced best-effort on push when the store reports size.
 */
export const DEFAULT_BLOB_TEAM_QUOTA_BYTES = 250 * 1024 * 1024;

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
    private readonly audit: AuditService,
  ) {}

  async create(userId: string, dto: CreateProfileDto, teamId?: string): Promise<Profile> {
    const ownerTeamId = await this.resolveTeamId(userId, teamId);
    await this.assertCanAddProfiles(ownerTeamId, 1);

    // Every profile MUST get a unique seed — a shared/constant seed would give many profiles the
    // same fingerprint identity. Generate a fresh random 128-bit seed when the caller omits one.
    const fingerprintSeed = dto.fingerprintSeed ?? randomBytes(16).toString('hex');
    const created = await this.profiles.create({
      ownerTeamId,
      name: dto.name,
      engine: dto.engine,
      os: dto.os,
      osVersion: dto.osVersion,
      fingerprintSeed,
      fingerprintOverrides: dto.fingerprintOverrides,
      proxyId: dto.proxyId,
      templateId: dto.templateId,
      cookiesImport: sanitizeCookieImportMetadata(dto.cookiesImport),
      extensions: dto.extensions,
      tags: dto.tags ?? [],
      folder: dto.folder,
      notes: dto.notes,
    });
    await this.audit.record({
      teamId: ownerTeamId,
      actorUserId: userId,
      action: 'profile.create',
      targetType: 'profile',
      targetId: created.id,
      metadata: { name: created.name, engine: created.engine, os: created.os },
    });
    return created;
  }

  /**
   * Create `count` profiles in one call, each with its OWN fresh unique seed (never a shared
   * identity). The whole batch is plan-limit-checked up front, so a batch that would exceed the
   * team's limit is rejected wholesale (no partial creation).
   */
  async bulkCreate(
    userId: string,
    dto: BulkCreateProfilesDto,
    teamId?: string,
  ): Promise<Profile[]> {
    const ownerTeamId = await this.resolveTeamId(userId, teamId);
    await this.assertCanAddProfiles(ownerTeamId, dto.count);

    const created: Profile[] = [];
    for (let i = 0; i < dto.count; i += 1) {
      created.push(
        await this.profiles.create({
          ownerTeamId,
          name: `${dto.namePrefix} ${i + 1}`,
          engine: dto.engine,
          os: dto.os,
          fingerprintSeed: randomBytes(16).toString('hex'),
          tags: dto.tags ?? [],
          folder: dto.folder,
        }),
      );
    }
    await this.audit.record({
      teamId: ownerTeamId,
      actorUserId: userId,
      action: 'profile.bulk_create',
      targetType: 'profile',
      metadata: { count: created.length, namePrefix: dto.namePrefix },
    });
    return created;
  }

  /**
   * Export every profile in the caller's team as a portable, SECRET-FREE bundle: only the
   * deterministic `fingerprintSeed` + non-secret metadata — never the encrypted blob or any ids.
   * This is the export/transfer wire format ({@link ProfileExportBundle}).
   */
  async exportAll(userId: string, teamId?: string): Promise<ProfileExportBundle> {
    const ownerTeamId = await this.resolveTeamId(userId, teamId);
    const profiles = await this.profiles.findAllByTeam(ownerTeamId);
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      profiles: profiles.map((p) => this.toExport(p)),
    };
  }

  /**
   * Import a bundle: re-create each exported profile under the caller's team, PRESERVING its
   * `fingerprintSeed` so the same coherent fingerprint identity transfers across teams/accounts.
   * The full batch is plan-limit-checked before anything is created.
   */
  async importBundle(userId: string, dto: ImportProfilesDto, teamId?: string): Promise<Profile[]> {
    const ownerTeamId = await this.resolveTeamId(userId, teamId);
    await this.assertCanAddProfiles(ownerTeamId, dto.profiles.length);

    const imported: Profile[] = [];
    for (const item of dto.profiles) {
      imported.push(
        await this.profiles.create({
          ownerTeamId,
          name: item.name,
          engine: item.engine,
          os: item.os,
          osVersion: item.osVersion,
          fingerprintSeed: item.fingerprintSeed,
          fingerprintOverrides: item.fingerprintOverrides,
          proxyId: item.proxyId,
          templateId: item.templateId,
          cookiesImport: sanitizeCookieImportMetadata(item.cookiesImport),
          extensions: item.extensions,
          tags: item.tags ?? [],
          folder: item.folder,
          notes: item.notes,
        }),
      );
    }
    await this.audit.record({
      teamId: ownerTeamId,
      actorUserId: userId,
      action: 'profile.import',
      targetType: 'profile',
      metadata: { count: imported.length },
    });
    return imported;
  }

  /** Project a stored profile down to the SECRET-FREE portable export shape. */
  private toExport(p: Profile): ProfileExport {
    return {
      name: p.name,
      engine: p.engine,
      os: p.os,
      ...(p.osVersion !== undefined ? { osVersion: p.osVersion } : {}),
      fingerprintSeed: p.fingerprintSeed,
      ...(p.fingerprintOverrides !== undefined
        ? { fingerprintOverrides: p.fingerprintOverrides }
        : {}),
      ...(p.proxyId !== undefined ? { proxyId: p.proxyId } : {}),
      ...(p.templateId !== undefined ? { templateId: p.templateId } : {}),
      ...(p.cookiesImport !== undefined
        ? { cookiesImport: sanitizeCookieImportMetadata(p.cookiesImport) }
        : {}),
      ...(p.extensions !== undefined ? { extensions: p.extensions } : {}),
      tags: p.tags,
      ...(p.folder !== undefined ? { folder: p.folder } : {}),
      ...(p.notes !== undefined ? { notes: p.notes } : {}),
    };
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
    await this.audit.record({
      teamId: ownerTeamId,
      actorUserId: userId,
      action: 'profile.update',
      targetType: 'profile',
      targetId: id,
      // Record WHICH fields changed, never their values (values can be large/derived config).
      metadata: { fields: Object.keys(dto) },
    });
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
    await this.audit.record({
      teamId: ownerTeamId,
      actorUserId: userId,
      action: 'profile.delete',
      targetType: 'profile',
      targetId: id,
    });
    // Delete the profile's encrypted blob versions so they are not orphaned in the object store.
    // Best-effort: the DB record is already gone (the source of truth), so a transient store error
    // must not fail the delete — it would only leave reclaimable bytes, never a dangling profile.
    try {
      await this.blobs.deleteAll(this.blobKey(ownerTeamId, id));
    } catch {
      /* orphaned bytes are reclaimable out-of-band; the profile is deleted regardless */
    }
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
    const result =
      input.direction === 'pull'
        ? await this.pull(id, ownerTeamId, key)
        : await this.push(id, ownerTeamId, key, input);
    // Record the mutation (push), not reads (pull), to keep the audit trail action-focused.
    if (result.direction === 'push') {
      await this.audit.record({
        teamId: ownerTeamId,
        actorUserId: userId,
        action: 'profile.sync',
        targetType: 'profile',
        targetId: id,
        metadata: { version: result.version },
      });
    }
    return result;
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
    // `payload` is validated as base64 at the DTO boundary; store the decoded bytes opaquely.
    const bytes = Buffer.from(input.payload, 'base64');
    // BE-3: reject oversized blobs before touching the store.
    const maxBytes = Number(process.env.BLOB_MAX_BYTES ?? DEFAULT_BLOB_MAX_BYTES);
    if (Number.isFinite(maxBytes) && maxBytes > 0 && bytes.length > maxBytes) {
      throw new PayloadTooLargeException(
        `encrypted blob exceeds max size (${bytes.length} > ${maxBytes} bytes)`,
      );
    }
    // Optimistic concurrency is enforced atomically inside the store (compare-and-set): passing
    // `baseVersion` as `expectedVersion` makes the version check and write one indivisible step,
    // so two concurrent pushes at the same base can't both succeed (one loses with a conflict).
    // Omitting baseVersion writes unconditionally, matching the previous behaviour.
    let version: number;
    try {
      ({ version } = await this.blobs.put(key, bytes, {
        teamId,
        profileId,
        expectedVersion: input.baseVersion,
      }));
    } catch (err) {
      if (err instanceof BlobVersionConflictError) {
        throw new ConflictException('stale base version');
      }
      throw err;
    }
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
   * Per-plan profile-limit gate for adding `count` profiles. Reads the team's
   * Subscription.profileLimit when present, else the default free-tier limit; throws
   * `ForbiddenException` when the batch would push the team over its limit (checked as a whole, so
   * bulk/import never partially create).
   */
  private async assertCanAddProfiles(teamId: string, count: number): Promise<void> {
    const limit = (await this.profiles.getProfileLimit(teamId)) ?? DEFAULT_FREE_PROFILE_LIMIT;
    const currentCount = (await this.profiles.findAllByTeam(teamId)).length;
    if (currentCount + count > limit) {
      throw new ForbiddenException(
        `profile limit (${limit}) reached for this team: ${currentCount} in use, cannot add ${count} more — upgrade the plan`,
      );
    }
  }
}
