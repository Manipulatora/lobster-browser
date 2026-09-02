import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { FREE_PLAN_PROFILE_LIMIT, type Profile } from '@lobster/shared-types';

import {
  ProfileLimitExceededError,
  type CreateProfileRecord,
  type ProfilesRepository,
  type RemoveProfileAsAdminResult,
  type UpdateProfileRecord,
} from './profiles.repository';
import { sanitizeCookieImportMetadata } from './sanitize-cookie-import';

/**
 * In-memory `ProfilesRepository` backed by a Map. The active implementation until a Postgres
 * instance is provisioned — it lets profiles run (and be tested) with no DB. State lives for the
 * lifetime of the process only; it is intentionally NOT durable.
 *
 * There is no in-memory subscription store, so creation and {@link getProfileLimit} use the
 * default free-tier entitlement. The allowance is still counted per BILLING ACCOUNT — every team
 * with the same owner shares it — through the `billingAccountOf` probe the module wires to the
 * in-memory teams repository.
 */
@Injectable()
export class InMemoryProfilesRepository implements ProfilesRepository {
  private readonly byId = new Map<string, Profile>();

  constructor(
    private readonly isTeamAdmin: (teamId: string, userId: string) => boolean = () => false,
    /**
     * The owner a team's profiles count against. A team the probe does not know is its own
     * account, so a repository built without a team store (unit tests) still meters per team.
     */
    private readonly billingAccountOf: (teamId: string) => string | undefined = () => undefined,
  ) {}

  async createManyWithinLimit(inputs: readonly CreateProfileRecord[]): Promise<Profile[]> {
    if (inputs.length === 0) return [];

    const ownerTeamId = inputs[0]!.ownerTeamId;
    if (inputs.some((input) => input.ownerTeamId !== ownerTeamId)) {
      throw new Error('profile creation batch must belong to one team');
    }
    // No await between this count and the writes below: the check and the insert are one turn.
    const account = this.accountOf(ownerTeamId);
    const currentCount = [...this.byId.values()].filter(
      (profile) =>
        profile.ownerTeamId !== undefined && this.accountOf(profile.ownerTeamId) === account,
    ).length;
    if (currentCount + inputs.length > FREE_PLAN_PROFILE_LIMIT) {
      throw new ProfileLimitExceededError(FREE_PLAN_PROFILE_LIMIT, currentCount, inputs.length);
    }

    // Stage every row before mutating the Map. A bad record (or any future mapping failure) throws
    // with zero writes, matching the Prisma transaction's rollback guarantee.
    const now = new Date().toISOString();
    const reservedIds = new Set(this.byId.keys());
    const staged = inputs.map((input): Profile => {
      let id: string;
      do {
        id = randomUUID();
      } while (reservedIds.has(id));
      reservedIds.add(id);
      return {
        id,
        name: input.name,
        engine: input.engine,
        os: input.os,
        osVersion: input.osVersion,
        fingerprintSeed: input.fingerprintSeed,
        fingerprintOverrides: input.fingerprintOverrides,
        proxyId: input.proxyId,
        templateId: input.templateId,
        cookiesImport: sanitizeCookieImportMetadata(input.cookiesImport),
        extensions: input.extensions,
        tags: input.tags,
        folder: input.folder,
        notes: input.notes,
        status: 'idle',
        ownerTeamId: input.ownerTeamId,
        createdAt: now,
        updatedAt: now,
      };
    });
    for (const profile of staged) this.byId.set(profile.id, profile);
    return staged;
  }

  async findById(teamId: string, id: string): Promise<Profile | null> {
    const profile = this.byId.get(id);
    return profile && profile.ownerTeamId === teamId ? profile : null;
  }

  async findAllByTeam(teamId: string): Promise<Profile[]> {
    return [...this.byId.values()].filter((p) => p.ownerTeamId === teamId);
  }

  async update(teamId: string, id: string, patch: UpdateProfileRecord): Promise<Profile | null> {
    const existing = this.byId.get(id);
    if (!existing || existing.ownerTeamId !== teamId) {
      return null;
    }
    const updated: Profile = {
      ...existing,
      name: patch.name ?? existing.name,
      engine: patch.engine ?? existing.engine,
      os: patch.os ?? existing.os,
      osVersion: patch.osVersion ?? existing.osVersion,
      fingerprintOverrides: patch.fingerprintOverrides ?? existing.fingerprintOverrides,
      proxyId: patch.proxyId ?? existing.proxyId,
      templateId: patch.templateId ?? existing.templateId,
      cookiesImport:
        patch.cookiesImport !== undefined
          ? sanitizeCookieImportMetadata(patch.cookiesImport)
          : existing.cookiesImport,
      extensions: patch.extensions ?? existing.extensions,
      tags: patch.tags ?? existing.tags,
      folder: patch.folder ?? existing.folder,
      notes: patch.notes ?? existing.notes,
      updatedAt: new Date().toISOString(),
    };
    this.byId.set(id, updated);
    return updated;
  }

  async removeAsAdmin(
    teamId: string,
    id: string,
    actorUserId: string,
  ): Promise<RemoveProfileAsAdminResult> {
    // No await before the delete: role check + profile scope check + mutation are one JS turn.
    if (!this.isTeamAdmin(teamId, actorUserId)) return { outcome: 'forbidden' };
    const existing = this.byId.get(id);
    if (!existing || existing.ownerTeamId !== teamId) {
      return { outcome: 'not_found' };
    }
    this.byId.delete(id);
    return { outcome: 'removed' };
  }

  async getProfileLimit(_teamId: string): Promise<number | null> {
    // No subscription store in memory — the service applies the default free-tier limit.
    return null;
  }

  private accountOf(teamId: string): string {
    return this.billingAccountOf(teamId) ?? teamId;
  }
}
