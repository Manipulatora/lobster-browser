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
import { ConfigService } from '@nestjs/config';
import { FREE_PLAN_PROFILE_LIMIT } from '@lobster/shared-types';
import type { Profile, ProfileExport, ProfileExportBundle } from '@lobster/shared-types';

import { AuditService } from '../audit/audit.service';
import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import { resolveTeamId } from '../teams/resolve-team-id';
import { BLOB_STORE, BlobVersionConflictError, type BlobStore } from './blob/blob-store';
import { blobObjectKey, normalizeKeyPrefix } from './blob/s3-blob-store';
import type { BulkCreateProfilesDto } from './dto/bulk-create-profiles.dto';
import type { CreateProfileDto } from './dto/create-profile.dto';
import type { ImportProfilesDto } from './dto/import-profiles.dto';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import {
  PROFILES_REPOSITORY,
  ProfileLimitExceededError,
  type CreateProfileRecord,
  type ProfilesRepository,
} from './profiles.repository';
import { sanitizeCookieImportMetadata } from './sanitize-cookie-import';

/** Direction of an encrypted-blob sync. */
export type SyncDirection = 'push' | 'pull';

/** Arguments for {@link ProfilesService.sync}, parsed from the validated request DTO. */
export type SyncProfileInput =
  | {
      direction: 'push';
      /** base64 CLIENT-encrypted blob to store. */
      payload?: string;
      /** Version the client believes is current (`0` before its first push). */
      baseVersion: number;
    }
  | {
      direction: 'pull';
      /** Ignored on pull. */
      payload?: string;
      /** Ignored on pull; accepted for forward-compatible clients. */
      baseVersion?: number;
    };

/**
 * Result of a profile sync.
 *
 * `version` is the current stored version (0 when a profile has never been synced). `blobRef` is
 * the object URI for the CLIENT-encrypted blob at that version, in the bucket the active store
 * writes to (null when none exists). On `pull`, `payload` carries the latest blob base64-encoded (null when never synced);
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
 * Per-team profile limit for teams without a Subscription row — i.e. before any package is bought.
 * A team with a Subscription uses its own `profileLimit` instead (read via the repository).
 *
 * RE-EXPORTED, NOT REDEFINED. This used to be a local `5` with a comment asking whoever edited it
 * to remember to also edit `Subscription.profileLimit @default(...)` in schema.prisma. Two
 * constants and a comment is not a single source of truth: the value now lives once, in
 * `PLAN_CATALOG`'s neighbour `FREE_PLAN_PROFILE_LIMIT`, which the schema default is aligned to.
 */
export const DEFAULT_FREE_PROFILE_LIMIT = FREE_PLAN_PROFILE_LIMIT;

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
  /** Bucket the active blob store writes to, or '' when the in-memory store is bound. */
  private readonly blobBucket: string;
  private readonly blobStorePath: string;
  /** Key namespace inside that bucket (`S3_KEY_PREFIX`), normalised exactly as the store does. */
  private readonly blobKeyPrefix: string;

  constructor(
    @Inject(PROFILES_REPOSITORY) private readonly profiles: ProfilesRepository,
    @Inject(TEAMS_REPOSITORY) private readonly teams: TeamsRepository,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.blobBucket = config.get<string>('S3_BUCKET') ?? '';
    this.blobStorePath = config.get<string>('BLOB_STORE_PATH') ?? '';
    this.blobKeyPrefix = normalizeKeyPrefix(config.get<string>('S3_KEY_PREFIX'));
  }

  async create(userId: string, dto: CreateProfileDto, teamId?: string): Promise<Profile> {
    const ownerTeamId = await resolveTeamId(this.teams, userId, teamId);

    // Every profile MUST get a unique seed — a shared/constant seed would give many profiles the
    // same fingerprint identity. Generate a fresh random 128-bit seed when the caller omits one.
    const fingerprintSeed = dto.fingerprintSeed ?? randomBytes(16).toString('hex');
    const created = (
      await this.createManyWithinLimit([
        {
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
        },
      ])
    )[0]!;
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
   * identity). The whole profile-row batch is plan-limit-checked and committed transactionally, so
   * a rejection or insert failure creates nothing. The one audit record is attempted after commit
   * through AuditService's fail-safe API; an audit-store failure cannot change the successful API
   * result.
   */
  async bulkCreate(
    userId: string,
    dto: BulkCreateProfilesDto,
    teamId?: string,
  ): Promise<Profile[]> {
    const ownerTeamId = await resolveTeamId(this.teams, userId, teamId);
    const records: CreateProfileRecord[] = Array.from({ length: dto.count }, (_, index) => ({
      ownerTeamId,
      name: `${dto.namePrefix} ${index + 1}`,
      engine: dto.engine,
      os: dto.os,
      fingerprintSeed: randomBytes(16).toString('hex'),
      tags: dto.tags ?? [],
      folder: dto.folder,
    }));
    const created = await this.createManyWithinLimit(records);
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
    const ownerTeamId = await resolveTeamId(this.teams, userId, teamId);
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
   * The profile rows commit as one transaction before the fail-safe audit attempt.
   */
  async importBundle(userId: string, dto: ImportProfilesDto, teamId?: string): Promise<Profile[]> {
    const ownerTeamId = await resolveTeamId(this.teams, userId, teamId);
    const records: CreateProfileRecord[] = dto.profiles.map((item) => ({
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
    }));
    const imported = await this.createManyWithinLimit(records);
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
    const ownerTeamId = await resolveTeamId(this.teams, userId, teamId);
    return this.profiles.findAllByTeam(ownerTeamId);
  }

  async findOne(userId: string, id: string, teamId?: string): Promise<Profile> {
    const ownerTeamId = await resolveTeamId(this.teams, userId, teamId);
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
    const ownerTeamId = await resolveTeamId(this.teams, userId, teamId);
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
    const ownerTeamId = await resolveTeamId(this.teams, userId, teamId);
    const result = await this.profiles.removeAsAdmin(ownerTeamId, id, userId);
    if (result.outcome === 'forbidden') {
      throw new ForbiddenException('this action requires the admin role');
    }
    if (result.outcome === 'not_found') {
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
    // Best-effort: the row is already a tombstone (deletedAt set) and no longer served, so a
    // transient store error
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
   * Every push is optimistic-concurrency-checked: `baseVersion` must equal the currently-stored
   * version, otherwise the write is rejected with a 409 (the caller must pull, re-apply, and retry).
   * The first push uses version 0. Each successful push bumps the version by one.
   */
  async sync(
    userId: string,
    id: string,
    input: SyncProfileInput,
    teamId?: string,
  ): Promise<SyncResult> {
    const ownerTeamId = await resolveTeamId(this.teams, userId, teamId);
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

  /** Store a new encrypted blob under its mandatory optimistic-concurrency precondition. */
  private async push(
    profileId: string,
    teamId: string,
    key: string,
    input: Extract<SyncProfileInput, { direction: 'push' }>,
  ): Promise<SyncResult> {
    if (input.payload === undefined) {
      throw new BadRequestException('push requires a base64 payload');
    }
    if (
      input.baseVersion === undefined ||
      !Number.isInteger(input.baseVersion) ||
      input.baseVersion < 0
    ) {
      throw new BadRequestException('push requires a non-negative integer baseVersion');
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

  /**
   * Object URI for a specific stored version of a profile's encrypted blob.
   *
   * Derived from the bucket and key prefix the ACTIVE store writes under, not a literal: this used
   * to return `s3://lobster-profiles/…` unconditionally, so every ref handed to a client and
   * written to the audit log named a bucket that may not exist, dropped `S3_KEY_PREFIX`, and
   * claimed S3 durability even when the in-memory store was bound. Support and recovery tooling
   * can only follow a ref that matches the real object key, so the scheme names the store that
   * actually holds the bytes: `s3://` for a bucket, `file://` for the server's own disk, and
   * `memory://` only when the bytes really are in a process-local Map that a restart will empty.
   */
  private blobRef(teamId: string, profileId: string, version: number): string {
    const objectKey = blobObjectKey(this.blobKeyPrefix, this.blobKey(teamId, profileId), version);
    if (this.blobBucket) return `s3://${this.blobBucket}/${objectKey}`;
    // The filesystem store lays each version out as `<root>/<key>/vNNNNNNNNNN.blob`, so the ref is
    // the path an operator can actually `ls` — not the S3-shaped `<key>/<n>.enc` key.
    if (this.blobStorePath) {
      return `file://${this.blobStorePath}/${this.blobKey(teamId, profileId)}/v${String(version).padStart(10, '0')}.blob`;
    }
    return `memory://${objectKey}`;
  }

  /** Translate the repository's atomic capacity rejection to the API's established 403. */
  private async createManyWithinLimit(inputs: readonly CreateProfileRecord[]): Promise<Profile[]> {
    try {
      return await this.profiles.createManyWithinLimit(inputs);
    } catch (error) {
      if (error instanceof ProfileLimitExceededError) {
        throw new ForbiddenException(
          `profile limit (${error.limit}) reached for this team: ${error.currentCount} in use, cannot add ${error.requestedCount} more — upgrade the plan`,
        );
      }
      throw error;
    }
  }
}
