import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  entitledProfileLimit,
  type BrowserExtensionRef,
  type EngineKind,
  type FingerprintOverrides,
  type Profile,
  type ProfileOsTarget,
} from '@lobster/shared-types';

import { PrismaService } from '../prisma/prisma.service';
import {
  ProfileLimitExceededError,
  type CreateProfileRecord,
  type ProfilesRepository,
  type RemoveProfileAsAdminResult,
  type SafeCookieImportMetadata,
  type UpdateProfileRecord,
} from './profiles.repository';
import { sanitizeCookieImportMetadata } from './sanitize-cookie-import';

/**
 * Non-secret, non-indexed profile fields packed into the Prisma `Profile.metadata` JSON column
 * (the DB indexes only id / name / ownerTeamId / fingerprintSeed — see schema.prisma).
 */
interface ProfileMetadata {
  engine: EngineKind;
  os: ProfileOsTarget;
  osVersion?: string;
  fingerprintOverrides?: FingerprintOverrides;
  proxyId?: string;
  templateId?: string;
  cookiesImport?: SafeCookieImportMetadata;
  extensions?: BrowserExtensionRef[];
  tags: string[];
  folder?: string;
  notes?: string;
}

/** The subset of a Prisma `profiles` row this repository maps to a `Profile`. */
interface ProfileRow {
  id: string;
  name: string;
  fingerprintSeed: string;
  metadata: Prisma.JsonValue;
  ownerTeamId: string;
  createdAt: Date;
  updatedAt: Date;
}

const SERIALIZABLE_ATTEMPTS = 5;

/**
 * Production `ProfilesRepository` backed by Postgres via the shared {@link PrismaService}.
 *
 * The wiring module selects this as the active provider whenever `DATABASE_URL` is set; without
 * a DB (local dev / tests) the in-memory repository is used instead. Every query is scoped to
 * `ownerTeamId`. The server persists only metadata + the deterministic seed + the encrypted-blob
 * reference — never plaintext profile contents.
 */
@Injectable()
export class PrismaProfilesRepository implements ProfilesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createManyWithinLimit(inputs: readonly CreateProfileRecord[]): Promise<Profile[]> {
    if (inputs.length === 0) return [];

    const ownerTeamId = inputs[0]!.ownerTeamId;
    if (inputs.some((input) => input.ownerTeamId !== ownerTeamId)) {
      throw new Error('profile creation batch must belong to one team');
    }

    return this.prisma.$transaction(
      async (tx) => {
        // PostgreSQL READ COMMITTED takes a fresh snapshot for each statement. Locking the stable
        // owning-team row first makes every capacity-bearing create for that team queue here; the
        // next transaction's count therefore sees all profiles committed by its predecessor.
        const lockedTeam = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "teams" WHERE "id" = ${ownerTeamId} FOR UPDATE
        `;
        if (lockedTeam.length !== 1) {
          throw new Error('profile owner team does not exist');
        }

        const subscription = await tx.subscription.findUnique({ where: { teamId: ownerTeamId } });
        const limit = entitledProfileLimit(
          subscription
            ? {
                status: subscription.status,
                profileLimit: subscription.profileLimit,
                currentPeriodEnd: subscription.currentPeriodEnd?.toISOString(),
              }
            : null,
        );
        const currentCount = await tx.profile.count({
          where: { ownerTeamId, deletedAt: null },
        });
        if (currentCount + inputs.length > limit) {
          throw new ProfileLimitExceededError(limit, currentCount, inputs.length);
        }

        // Sequential creates preserve the API's requested order. They are still one database
        // transaction: any row failure aborts every earlier insert in this batch.
        const created: Profile[] = [];
        for (const input of inputs) {
          const row = await tx.profile.create({ data: this.createData(input) });
          created.push(this.toProfile(row));
        }
        return created;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 5_000,
        timeout: 20_000,
      },
    );
  }

  async findById(teamId: string, id: string): Promise<Profile | null> {
    const row = await this.prisma.profile.findFirst({ where: this.liveScope(teamId, id) });
    return row ? this.toProfile(row) : null;
  }

  async findAllByTeam(teamId: string): Promise<Profile[]> {
    const rows = await this.prisma.profile.findMany({
      where: this.liveScope(teamId),
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toProfile(row));
  }

  async update(teamId: string, id: string, patch: UpdateProfileRecord): Promise<Profile | null> {
    const existing = await this.prisma.profile.findFirst({ where: this.liveScope(teamId, id) });
    if (!existing) {
      return null;
    }
    const metadata = this.readMetadata(existing.metadata);
    if (patch.engine !== undefined) {
      metadata.engine = patch.engine;
    }
    if (patch.os !== undefined) {
      metadata.os = patch.os;
    }
    if (patch.osVersion !== undefined) {
      metadata.osVersion = patch.osVersion;
    }
    if (patch.fingerprintOverrides !== undefined) {
      metadata.fingerprintOverrides = patch.fingerprintOverrides;
    }
    if (patch.proxyId !== undefined) {
      metadata.proxyId = patch.proxyId;
    }
    if (patch.templateId !== undefined) {
      metadata.templateId = patch.templateId;
    }
    if (patch.cookiesImport !== undefined) {
      metadata.cookiesImport = sanitizeCookieImportMetadata(patch.cookiesImport);
    }
    if (patch.extensions !== undefined) {
      metadata.extensions = patch.extensions;
    }
    if (patch.tags !== undefined) {
      metadata.tags = patch.tags;
    }
    if (patch.folder !== undefined) {
      metadata.folder = patch.folder;
    }
    if (patch.notes !== undefined) {
      metadata.notes = patch.notes;
    }
    const row = await this.prisma.profile.update({
      where: { id },
      data: {
        name: patch.name ?? existing.name,
        metadata: metadata as unknown as Prisma.InputJsonValue,
      },
    });
    return this.toProfile(row);
  }

  /**
   * Soft-delete: stamp a tombstone instead of removing the row. A hard DELETE leaves an offline
   * machine no way to learn the profile is gone (on its next sync a missing row reads as "never
   * synced from here", so it re-uploads and resurrects it). The row stays invisible to every read
   * because they all go through {@link liveScope}, so a tombstone never shows up in a list and
   * never counts toward the team's profile limit. Re-deleting an already-tombstoned profile
   * returns `not_found`, exactly as a second hard delete did.
   */
  async removeAsAdmin(
    teamId: string,
    id: string,
    actorUserId: string,
  ): Promise<RemoveProfileAsAdminResult> {
    return this.runSerializable(async (tx) => {
      // The membership predicate is part of the UPDATE. A service-level role read followed by this
      // write would let a concurrent demotion race through a destructive tombstone/blob purge.
      const deleted = await tx.profile.updateMany({
        where: {
          ...this.liveScope(teamId, id),
          ownerTeam: {
            is: { memberships: { some: { userId: actorUserId, role: 'admin' } } },
          },
        },
        data: { deletedAt: new Date() },
      });
      if (deleted.count === 1) return { outcome: 'removed' };

      // Classification happens only after the guarded write failed. It cannot authorize a mutation,
      // and checking the actor first avoids revealing profile existence to a non-admin member.
      const actor = await tx.membership.findUnique({
        where: { userId_teamId: { userId: actorUserId, teamId } },
      });
      if (actor?.role !== 'admin') return { outcome: 'forbidden' };

      const existing = await tx.profile.findFirst({
        where: this.liveScope(teamId, id),
        select: { id: true },
      });
      if (!existing) return { outcome: 'not_found' };

      // A live row plus an admin should have matched the guarded UPDATE. Refuse rather than report a
      // successful delete when the database did not perform one.
      throw new Error('guarded profile tombstone matched no row despite live profile and admin');
    });
  }

  /**
   * The allowance the team is ENTITLED to, not the one on the row.
   *
   * `profileLimit` records what was bought and stays put when the package lapses or its period
   * simply runs out with auto-renew off. Returning it unconditionally would let a team turn
   * auto-renew off and keep a Max allowance indefinitely, for free — and would disagree with the
   * desktop, which shows the free cap for a lapsed package. `entitledProfileLimit` is the single
   * rule both answer to.
   */
  async getProfileLimit(teamId: string): Promise<number | null> {
    const subscription = await this.prisma.subscription.findUnique({ where: { teamId } });
    if (!subscription) return null;
    return entitledProfileLimit({
      status: subscription.status,
      profileLimit: subscription.profileLimit,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString(),
    });
  }

  /**
   * Team scope for every read. `deletedAt: null` is NOT optional on any of them: a tombstone that
   * still matched a read would come back from the list API and, worse, keep counting against the
   * plan's profile limit forever — a deleted profile permanently consuming the allowance.
   */
  private liveScope(teamId: string, id?: string): Prisma.ProfileWhereInput {
    return { ...(id !== undefined ? { id } : {}), ownerTeamId: teamId, deletedAt: null };
  }

  /** Keep guarded-write classification on one snapshot and retry PostgreSQL SSI conflicts. */
  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= SERIALIZABLE_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const serializationConflict =
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === 'P2034';
        if (!serializationConflict || attempt === SERIALIZABLE_ATTEMPTS) throw error;
      }
    }
    throw new Error('unreachable: serializable profile tombstone exhausted without throwing');
  }

  private createData(input: CreateProfileRecord): Prisma.ProfileUncheckedCreateInput {
    const metadata: ProfileMetadata = {
      engine: input.engine,
      os: input.os,
      osVersion: input.osVersion,
      fingerprintOverrides: input.fingerprintOverrides,
      proxyId: input.proxyId,
      templateId: input.templateId,
      cookiesImport: sanitizeCookieImportMetadata(input.cookiesImport),
      extensions: input.extensions,
      tags: input.tags,
      folder: input.folder,
      notes: input.notes,
    };
    return {
      name: input.name,
      fingerprintSeed: input.fingerprintSeed,
      ownerTeamId: input.ownerTeamId,
      metadata: metadata as unknown as Prisma.InputJsonValue,
    };
  }

  private readMetadata(value: Prisma.JsonValue): ProfileMetadata {
    const metadata = (value ?? {}) as unknown as Partial<ProfileMetadata>;
    return {
      engine: metadata.engine ?? 'lobium',
      os: metadata.os ?? 'windows',
      osVersion: metadata.osVersion,
      fingerprintOverrides: metadata.fingerprintOverrides,
      proxyId: metadata.proxyId,
      templateId: metadata.templateId,
      cookiesImport: sanitizeCookieImportMetadata(metadata.cookiesImport),
      extensions: metadata.extensions,
      tags: metadata.tags ?? [],
      folder: metadata.folder,
      notes: metadata.notes,
    };
  }

  private toProfile(row: ProfileRow): Profile {
    const metadata = this.readMetadata(row.metadata);
    return {
      id: row.id,
      name: row.name,
      engine: metadata.engine,
      os: metadata.os,
      osVersion: metadata.osVersion,
      fingerprintSeed: row.fingerprintSeed,
      fingerprintOverrides: metadata.fingerprintOverrides,
      proxyId: metadata.proxyId,
      templateId: metadata.templateId,
      cookiesImport: metadata.cookiesImport,
      extensions: metadata.extensions,
      tags: metadata.tags,
      folder: metadata.folder,
      notes: metadata.notes,
      // Status is runtime-only (not persisted); a freshly-loaded profile is idle.
      status: 'idle',
      ownerTeamId: row.ownerTeamId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
