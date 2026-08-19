import { createHash, randomBytes } from 'node:crypto';

import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiKey } from '@lobster/shared-types';

import { AuditService } from '../audit/audit.service';
import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import {
  API_KEYS_REPOSITORY,
  type ApiKeyRecord,
  type ApiKeysRepository,
} from './api-keys.repository';
import type { CreateApiKeyDto } from './dto/create-api-key.dto';

/** Human-visible, non-secret prefix on every key — signals a live (non-test) automation credential. */
const SECRET_PREFIX = 'lb_live_';

/** Bytes of entropy in the random tail of a secret (24 bytes → 48 hex chars). */
const SECRET_ENTROPY_BYTES = 24;

/** Length of the display prefix persisted/shown for a key, e.g. "lb_live_ab12cd34" (8 + 8 chars). */
const DISPLAY_PREFIX_LENGTH = 16;

/**
 * Result of creating a key. The plaintext `secret` is returned EXACTLY ONCE, here — the server
 * only ever stores its sha256 hash, so there is no way to reveal it again. `apiKey` is the public
 * record (prefix/name/teamId/createdAt) shown thereafter.
 */
export interface CreatedApiKey {
  apiKey: ApiKey;
  secret: string;
}

/** The team + key identity resolved from a presented secret by {@link ApiKeysService.verify}. */
export interface VerifiedApiKey {
  teamId: string;
  apiKeyId: string;
}

/**
 * API-key management + secret verification.
 *
 * Team-facing operations (create/list/revoke) are scoped to a team the caller belongs to: the
 * team is resolved from the caller's membership (their first team, or an explicit `teamId` they
 * belong to). Storage is abstracted behind `ApiKeysRepository` (in-memory today, Prisma once
 * Postgres is provisioned), so this service runs and is tested without a database.
 *
 * SECURITY: a key's plaintext secret exists only transiently at creation time — the server stores
 * `sha256(secret)` and returns the secret to the caller exactly once. Every public record handed
 * back to a client is passed through {@link toApiKey}, which strips the internal `hashedKey`.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(API_KEYS_REPOSITORY) private readonly apiKeys: ApiKeysRepository,
    @Inject(TEAMS_REPOSITORY) private readonly teams: TeamsRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Mint a new key for the caller's team. Generates a random secret, derives its display prefix
   * and sha256 hash, persists ONLY the prefix + hash, and returns the plaintext secret exactly
   * once. The secret is unrecoverable afterwards — the caller must store it now or discard it.
   */
  async create(userId: string, dto: CreateApiKeyDto, teamId?: string): Promise<CreatedApiKey> {
    const ownerTeamId = await this.resolveAdminTeamId(userId, teamId);

    // secret = 'lb_live_' + 24 random bytes as hex; the prefix is the safe-to-display leading slice.
    const secret = `${SECRET_PREFIX}${randomBytes(SECRET_ENTROPY_BYTES).toString('hex')}`;
    const prefix = secret.slice(0, DISPLAY_PREFIX_LENGTH);
    const hashedKey = this.hashSecret(secret);

    const record = await this.apiKeys.create({
      teamId: ownerTeamId,
      name: dto.name,
      prefix,
      hashedKey,
    });
    await this.audit.record({
      teamId: ownerTeamId,
      actorUserId: userId,
      action: 'apikey.create',
      targetType: 'apiKey',
      targetId: record.id,
      // Only the non-secret display fields — never the secret or its hash.
      metadata: { name: record.name, prefix: record.prefix },
    });
    return { apiKey: this.toApiKey(record), secret };
  }

  /** List the caller's team's keys — display fields only (never the secret or its hash). */
  async findAll(userId: string, teamId?: string): Promise<ApiKey[]> {
    const ownerTeamId = await this.resolveTeamId(userId, teamId);
    const records = await this.apiKeys.findAllByTeam(ownerTeamId);
    return records.map((record) => this.toApiKey(record));
  }

  /**
   * Revoke (permanently delete) a key owned by the caller's team. A key that does not exist — or
   * that belongs to another team — is indistinguishable to the caller: both yield a 404 (so a key
   * id can't be probed for existence across teams).
   */
  async remove(
    userId: string,
    id: string,
    teamId?: string,
  ): Promise<{ id: string; revoked: true }> {
    const ownerTeamId = await this.resolveAdminTeamId(userId, teamId);
    const removed = await this.apiKeys.remove(ownerTeamId, id);
    if (!removed) {
      throw new NotFoundException('api key not found');
    }
    await this.audit.record({
      teamId: ownerTeamId,
      actorUserId: userId,
      action: 'apikey.revoke',
      targetType: 'apiKey',
      targetId: id,
    });
    return { id, revoked: true };
  }

  /**
   * Authenticate a presented secret. Hashes it and looks up the owning key by that hash across all
   * teams; on a match, stamps `lastUsedAt` and returns the owning `{ teamId, apiKeyId }`. Returns
   * null when no key matches (an unknown/revoked secret). This is the entry point a future
   * automation-API guard uses to authorise programmatic requests.
   */
  async verify(secret: string): Promise<VerifiedApiKey | null> {
    const record = await this.apiKeys.findByHash(this.hashSecret(secret));
    if (!record) {
      return null;
    }
    await this.apiKeys.touchLastUsed(record.id);
    return { teamId: record.teamId, apiKeyId: record.id };
  }

  /** sha256(secret) as hex — the only representation of a secret the server ever stores/compares. */
  private hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  /**
   * Project an internal {@link ApiKeyRecord} to the public {@link ApiKey} by dropping `hashedKey`.
   * EVERY client-facing record must go through here so the hash never leaks in a response body.
   */
  private toApiKey(record: ApiKeyRecord): ApiKey {
    const { hashedKey: _hashedKey, ...apiKey } = record;
    return apiKey;
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
   * Resolve the team for an operation that MINTS OR DESTROYS a live credential.
   *
   * A key authenticates as the whole team, outlives the session that made it and cannot be
   * recovered once shown, so creating one is the same class of act as inviting a member or changing
   * a role — all of which require the admin role. Listing stays open to any member: display fields
   * carry no secret, and a member has to be able to see which keys exist on their own team.
   */
  private async resolveAdminTeamId(userId: string, teamId?: string): Promise<string> {
    const ownerTeamId = await this.resolveTeamId(userId, teamId);
    const membership = await this.teams.getMembership(ownerTeamId, userId);
    if (membership?.role !== 'admin') {
      throw new ForbiddenException('this action requires the admin role');
    }
    return ownerTeamId;
  }
}
