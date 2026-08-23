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
import type { CreateProfileRecord } from './profiles.repository';
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
  readonly adminUserIds = new Set(['user-1']);
  private nextId = 1;
  createCalls = 0;
  failOnCreateCall: number | null = null;
  lockCalls = 0;
  readonly transactionIsolationLevels: Prisma.TransactionIsolationLevel[] = [];

  readonly profile = {
    create: async ({ data }: { data: Record<string, unknown> }): Promise<FakeRow> => {
      this.createCalls += 1;
      if (this.createCalls === this.failOnCreateCall) {
        throw new Error('injected profile insert failure');
      }
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
    count: async ({ where }: { where: Record<string, unknown> }): Promise<number> =>
      this.match(where).length,
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
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }> => {
      const relation = where.ownerTeam as
        | {
            is?: {
              memberships?: { some?: { userId?: string; role?: 'admin' | 'member' } };
            };
          }
        | undefined;
      const requiredMembership = relation?.is?.memberships?.some;
      if (
        requiredMembership?.role !== 'admin' ||
        !requiredMembership.userId ||
        !this.adminUserIds.has(requiredMembership.userId)
      ) {
        return { count: 0 };
      }

      const matched = this.match(where);
      for (const row of matched) Object.assign(row, data, { updatedAt: new Date() });
      return { count: matched.length };
    },
  };

  readonly membership = {
    findUnique: async ({
      where,
    }: {
      where: { userId_teamId: { userId: string; teamId: string } };
    }): Promise<{ role: 'admin' | 'member' } | null> => {
      const { userId, teamId } = where.userId_teamId;
      if (teamId !== 'team-1') return null;
      return { role: this.adminUserIds.has(userId) ? 'admin' : 'member' };
    },
  };

  readonly subscription = {
    // No subscription rows: the service falls back to the default free-tier limit.
    findUnique: async (): Promise<null> => null,
  };

  async $queryRaw<T>(_query: TemplateStringsArray, ..._values: readonly unknown[]): Promise<T> {
    this.lockCalls += 1;
    return [{ id: 'team-1' }] as T;
  }

  async $transaction<T>(
    callback: (transaction: this) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T> {
    if (options?.isolationLevel) this.transactionIsolationLevels.push(options.isolationLevel);
    const rowsBefore = this.rows.map((row) => ({ ...row }));
    const nextIdBefore = this.nextId;
    try {
      return await callback(this);
    } catch (error) {
      this.rows.splice(0, this.rows.length, ...rowsBefore);
      this.nextId = nextIdBefore;
      throw error;
    }
  }

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
  return (
    await repository.createManyWithinLimit([
      {
        ownerTeamId: 'team-1',
        name,
        engine: 'lobium',
        os: 'windows',
        fingerprintSeed: '0123456789abcdef0123456789abcdef',
        tags: [],
      },
    ])
  )[0]!;
}

function createRecord(name: string, seed: string): CreateProfileRecord {
  return {
    ownerTeamId: 'team-1',
    name,
    engine: 'lobium',
    os: 'windows',
    fingerprintSeed: seed,
    tags: [],
  };
}

test('a failed batch insert rolls back every row and can be retried without duplicates', async () => {
  const { repository, prisma } = makeRepository();
  const records = [
    createRecord('First', '11111111111111111111111111111111'),
    createRecord('Second', '22222222222222222222222222222222'),
  ];

  prisma.failOnCreateCall = 2;
  await assert.rejects(
    () => repository.createManyWithinLimit(records),
    /injected profile insert failure/,
  );
  assert.equal(prisma.rows.length, 0, 'the first insert must roll back with the second');
  assert.equal(prisma.lockCalls, 1, 'the transaction must lock the owning team row');

  prisma.failOnCreateCall = null;
  const retried = await repository.createManyWithinLimit(records);
  assert.deepEqual(
    retried.map((profile) => profile.name),
    ['First', 'Second'],
    'the batch preserves request order',
  );
  assert.equal(prisma.rows.length, 2);
  assert.equal(new Set(prisma.rows.map((row) => row.id)).size, 2);
  assert.equal(new Set(prisma.rows.map((row) => row.name)).size, 2);
});

test('admin removal writes a deletedAt tombstone and every read filters it out', async () => {
  const { repository, prisma } = makeRepository();
  const kept = await createProfile(repository, 'Kept');
  const deleted = await createProfile(repository, 'Deleted');

  assert.equal((await repository.removeAsAdmin('team-1', deleted.id, 'user-1')).outcome, 'removed');

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
  assert.equal(
    (await repository.removeAsAdmin('team-1', deleted.id, 'user-1')).outcome,
    'not_found',
  );
});

test('the tombstone UPDATE itself requires a current admin membership', async () => {
  const { repository, prisma } = makeRepository();
  const profile = await createProfile(repository, 'Protected');

  const result = await repository.removeAsAdmin('team-1', profile.id, 'plain-member');

  assert.equal(result.outcome, 'forbidden');
  assert.equal(prisma.rows.find((row) => row.id === profile.id)?.deletedAt, null);
  assert.equal(prisma.transactionIsolationLevels.at(-1), 'Serializable');
});

test('a tombstoned profile does not consume the team profile allowance', async () => {
  const { repository } = makeRepository();
  const teams = {
    findTeamsForUser: async () => [{ id: 'team-1' }],
    getMembership: async () => ({ teamId: 'team-1', userId: 'user-1', role: 'admin' }),
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
