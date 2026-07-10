import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { EngineKind, FingerprintOverrides, Profile, ProfileOsTarget } from '@lobster/shared-types';

import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateProfileRecord,
  ProfilesRepository,
  UpdateProfileRecord,
} from './profiles.repository';

/**
 * Non-secret, non-indexed profile fields packed into the Prisma `Profile.metadata` JSON column
 * (the DB indexes only id / name / ownerTeamId / fingerprintSeed — see schema.prisma).
 */
interface ProfileMetadata {
  engine: EngineKind;
  os: ProfileOsTarget;
  fingerprintOverrides?: FingerprintOverrides;
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

  async create(input: CreateProfileRecord): Promise<Profile> {
    const metadata: ProfileMetadata = {
      engine: input.engine,
      os: input.os,
      fingerprintOverrides: input.fingerprintOverrides,
      tags: input.tags,
      folder: input.folder,
      notes: input.notes,
    };
    const row = await this.prisma.profile.create({
      data: {
        name: input.name,
        fingerprintSeed: input.fingerprintSeed,
        ownerTeamId: input.ownerTeamId,
        metadata: metadata as unknown as Prisma.InputJsonValue,
      },
    });
    return this.toProfile(row);
  }

  async findById(teamId: string, id: string): Promise<Profile | null> {
    const row = await this.prisma.profile.findFirst({ where: { id, ownerTeamId: teamId } });
    return row ? this.toProfile(row) : null;
  }

  async findAllByTeam(teamId: string): Promise<Profile[]> {
    const rows = await this.prisma.profile.findMany({
      where: { ownerTeamId: teamId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toProfile(row));
  }

  async update(teamId: string, id: string, patch: UpdateProfileRecord): Promise<Profile | null> {
    const existing = await this.prisma.profile.findFirst({ where: { id, ownerTeamId: teamId } });
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
    if (patch.fingerprintOverrides !== undefined) {
      metadata.fingerprintOverrides = patch.fingerprintOverrides;
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

  async remove(teamId: string, id: string): Promise<boolean> {
    const existing = await this.prisma.profile.findFirst({ where: { id, ownerTeamId: teamId } });
    if (!existing) {
      return false;
    }
    // TODO(Day 2): also delete the encrypted blob from S3 (Profile.encryptedBlobRef).
    await this.prisma.profile.delete({ where: { id } });
    return true;
  }

  async getProfileLimit(teamId: string): Promise<number | null> {
    const subscription = await this.prisma.subscription.findUnique({ where: { teamId } });
    return subscription ? subscription.profileLimit : null;
  }

  private readMetadata(value: Prisma.JsonValue): ProfileMetadata {
    const metadata = (value ?? {}) as unknown as Partial<ProfileMetadata>;
    return {
      engine: metadata.engine ?? 'lobium',
      os: metadata.os ?? 'windows',
      fingerprintOverrides: metadata.fingerprintOverrides,
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
      fingerprintSeed: row.fingerprintSeed,
      fingerprintOverrides: metadata.fingerprintOverrides,
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
