import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { Profile } from '@lobster/shared-types';

import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TeamsRepository } from '../teams/teams.repository';
import { InMemoryBlobStore } from './blob/in-memory-blob-store';
import { PrismaProfilesRepository } from './prisma-profiles.repository';
import { DEFAULT_FREE_PROFILE_LIMIT, ProfilesService } from './profiles.service';

/** The `profiles` columns this repository reads/writes, as the fake client stores them. */
interface FakeRow {
  id: string;
  name: string;
  fingerprintSeed: string;
  metadata: Prisma.JsonValue;
  ownerTeamId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Fake Prisma client over an array of rows. It deliberately applies ONLY the filters the repository
 * actually passes: a `where` with no `deletedAt` matches tombstoned rows too, exactly as Postgres
 * would. That is what makes these tests catch a forgotten `deletedAt: null` — the soft delete is
 * worse than a hard delete if any read still sees the tombstone (a deleted profile would keep
 * consuming the team's profile allowance forever).
 */
class FakePrisma {
  readonly rows: FakeRow[] = [];
  private nextId = 1;

  readonly profile = {
    create: async ({ data }: { data: Record<string, unknown> }): Promise<FakeRow> => {
      const now = new Date();
      const row: FakeRow = {
        id: `p${this.nextId++}`,
        name: data.name as string,
        fingerprintSeed: data.fingerprintSeed as string,
        metadata: data.metadata as Prisma.JsonValue,
        ownerTeamId: data.ownerTeamId as string,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.rows.push(row);
      return row;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }): Promise<FakeRow | null> =>
      this.match(where)[0] ?? null,
    findMany: async ({ where }: { where: Record<string, unknown> }): Promise<FakeRow[]> =>
      this.match(where),
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<FakeRow> => {
      const row = this.rows.find((r) => r.id === where.id);
      assert.ok(row, `update targeted a missing row ${where.id}`);
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
  };

  readonly subscription = {
    // No subscription rows: the service falls back to the default free-tier limit.
    findUnique: async (): Promise<null> => null,
  };

  private match(where: Record<string, unknown>): FakeRow[] {
    return this.rows.filter(
      (row) =>
        (where.id === undefined || row.id === where.id) &&
        (where.ownerTeamId === undefined || row.ownerTeamId === where.ownerTeamId) &&
        (where.deletedAt === undefined || (where.deletedAt === null && row.deletedAt === null)),
    );
  }
}

function makeRepository(): { repository: PrismaProfilesRepository; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  return {
    repository: new PrismaProfilesRepository(prisma as unknown as PrismaService),
    prisma,
  };
}

async function createProfile(
  repository: PrismaProfilesRepository,
  name: string,
): Promise<{ id: string }> {
  return repository.create({
    ownerTeamId: 'team-1',
    name,
    engine: 'lobium',
    os: 'windows',
    fingerprintSeed: '0123456789abcdef0123456789abcdef',
    tags: [],
  });
}

test('remove writes a deletedAt tombstone and every read filters it out', async () => {
  const { repository, prisma } = makeRepository();
  const kept = await createProfile(repository, 'Kept');
  const deleted = await createProfile(repository, 'Deleted');

  assert.equal(await repository.remove('team-1', deleted.id), true);

  // The row survives — that tombstone is the only way an offline machine can learn of the delete.
  const row = prisma.rows.find((r) => r.id === deleted.id);
  assert.ok(row, 'the row must NOT be hard-deleted');
  assert.ok(row.deletedAt instanceof Date, 'deletedAt must be stamped');

  // …and is invisible to every read.
  assert.equal(await repository.findById('team-1', deleted.id), null);
  const live = await repository.findAllByTeam('team-1');
  assert.deepEqual(
    live.map((p) => p.id),
    [kept.id],
  );
  assert.equal(await repository.update('team-1', deleted.id, { name: 'Resurrected' }), null);
  // A second delete finds nothing live, exactly as a second hard delete did.
  assert.equal(await repository.remove('team-1', deleted.id), false);
});

test('a tombstoned profile does not consume the team profile allowance', async () => {
  const { repository } = makeRepository();
  const teams = {
    findTeamsForUser: async () => [{ id: 'team-1' }],
  } as unknown as TeamsRepository;
  const audit = { record: async () => {} } as unknown as AuditService;
  const config = { get: () => undefined } as unknown as ConfigService;
  const service = new ProfilesService(repository, teams, new InMemoryBlobStore(), audit, config);

  // Fill the free allowance exactly.
  const created: Profile[] = [];
  for (let i = 0; i < DEFAULT_FREE_PROFILE_LIMIT; i += 1) {
    created.push(
      await service.create('user-1', { name: `P${i}`, engine: 'lobium', os: 'windows' }),
    );
  }
  await assert.rejects(
    () => service.create('user-1', { name: 'over', engine: 'lobium', os: 'windows' }),
    /profile limit/,
    'the limit itself must still bite',
  );

  // Deleting one must free a slot. With a tombstone still counted, the allowance would be gone for
  // good and the user could never create a profile again.
  await service.remove('user-1', created[0]!.id);
  const replacement = await service.create('user-1', {
    name: 'replacement',
    engine: 'lobium',
    os: 'windows',
  });
  assert.ok(replacement.id, 'a deleted profile must give its slot back');
});
