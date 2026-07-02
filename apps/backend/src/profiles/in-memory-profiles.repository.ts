import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Profile } from '@lobster/shared-types';

import type {
  CreateProfileRecord,
  ProfilesRepository,
  UpdateProfileRecord,
} from './profiles.repository';

/**
 * In-memory `ProfilesRepository` backed by a Map. The active implementation until a Postgres
 * instance is provisioned — it lets profiles run (and be tested) with no DB. State lives for the
 * lifetime of the process only; it is intentionally NOT durable.
 *
 * There is no in-memory subscription store, so {@link getProfileLimit} returns null and the
 * service falls back to the default free-tier limit.
 */
@Injectable()
export class InMemoryProfilesRepository implements ProfilesRepository {
  private readonly byId = new Map<string, Profile>();

  async create(input: CreateProfileRecord): Promise<Profile> {
    const now = new Date().toISOString();
    const profile: Profile = {
      id: randomUUID(),
      name: input.name,
      engine: input.engine,
      os: input.os,
      fingerprintSeed: input.fingerprintSeed,
      fingerprintOverrides: input.fingerprintOverrides,
      tags: input.tags,
      folder: input.folder,
      notes: input.notes,
      status: 'idle',
      ownerTeamId: input.ownerTeamId,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(profile.id, profile);
    return profile;
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
      fingerprintOverrides: patch.fingerprintOverrides ?? existing.fingerprintOverrides,
      tags: patch.tags ?? existing.tags,
      folder: patch.folder ?? existing.folder,
      notes: patch.notes ?? existing.notes,
      updatedAt: new Date().toISOString(),
    };
    this.byId.set(id, updated);
    return updated;
  }

  async remove(teamId: string, id: string): Promise<boolean> {
    const existing = this.byId.get(id);
    if (!existing || existing.ownerTeamId !== teamId) {
      return false;
    }
    this.byId.delete(id);
    return true;
  }

  async getProfileLimit(_teamId: string): Promise<number | null> {
    // No subscription store in memory — the service applies the default free-tier limit.
    return null;
  }
}
