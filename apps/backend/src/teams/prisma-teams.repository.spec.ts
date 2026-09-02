import assert from 'node:assert/strict';
import test from 'node:test';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { PrismaTeamsRepository } from './prisma-teams.repository';
import { OwnedTeamLimitExceededError } from './teams.repository';

/** A cap high enough to be out of the way in fixtures that are about something else. */
const UNCAPPED = 100;

interface FakeMembershipRow {
  userId: string;
  teamId: string;
  role: 'admin' | 'member';
  createdAt: Date;
}

interface FakeTransaction {
  membership: {
    findUnique(input: {
      where: { userId_teamId: { userId: string; teamId: string } };
    }): Promise<FakeMembershipRow | null>;
    count(input: { where: { teamId: string; role: 'admin' } }): Promise<number>;
    update(input: {
      where: { userId_teamId: { userId: string; teamId: string } };
      data: { role: 'admin' | 'member' };
    }): Promise<FakeMembershipRow>;
    delete(input: {
      where: { userId_teamId: { userId: string; teamId: string } };
    }): Promise<FakeMembershipRow>;
  };
}

interface FakeCreateTransaction {
  $queryRaw<T>(query: TemplateStringsArray, ...values: readonly unknown[]): Promise<T>;
  team: {
    count(input: { where: { ownerUserId: string } }): Promise<number>;
    create(input: { data: { ownerUserId: string; name: string } }): Promise<{
      id: string;
      ownerUserId: string;
      name: string;
      createdAt: Date;
    }>;
  };
  membership: {
    create(input: {
      data: { teamId: string; userId: string; role: 'admin' };
    }): Promise<FakeMembershipRow>;
  };
}

function repositoryFixture(conflictsBeforeSuccess = 0): {
  repository: PrismaTeamsRepository;
  attempts: () => number;
  isolationLevels: Prisma.TransactionIsolationLevel[];
  rows: Map<string, FakeMembershipRow>;
  writes: () => number;
} {
  const teamId = 'team-1';
  const rows = new Map<string, FakeMembershipRow>([
    ['admin-a', { userId: 'admin-a', teamId, role: 'admin', createdAt: new Date(0) }],
    ['admin-b', { userId: 'admin-b', teamId, role: 'admin', createdAt: new Date(0) }],
  ]);
  let attempts = 0;
  let writes = 0;
  const isolationLevels: Prisma.TransactionIsolationLevel[] = [];

  const tx: FakeTransaction = {
    membership: {
      async findUnique(input) {
        return rows.get(input.where.userId_teamId.userId) ?? null;
      },
      async count(input) {
        return [...rows.values()].filter(
          (row) => row.teamId === input.where.teamId && row.role === input.where.role,
        ).length;
      },
      async update(input) {
        const userId = input.where.userId_teamId.userId;
        const existing = rows.get(userId);
        if (!existing) throw new Error('missing fake membership');
        const updated = { ...existing, role: input.data.role };
        rows.set(userId, updated);
        writes += 1;
        return updated;
      },
      async delete(input) {
        const userId = input.where.userId_teamId.userId;
        const existing = rows.get(userId);
        if (!existing) throw new Error('missing fake membership');
        rows.delete(userId);
        writes += 1;
        return existing;
      },
    },
  };

  const prisma = {
    async $transaction<T>(
      operation: (transaction: FakeTransaction) => Promise<T>,
      options: { isolationLevel: Prisma.TransactionIsolationLevel },
    ): Promise<T> {
      attempts += 1;
      isolationLevels.push(options.isolationLevel);
      if (attempts <= conflictsBeforeSuccess) {
        throw Object.assign(new Error('serialization conflict'), { code: 'P2034' });
      }
      return operation(tx);
    },
  } as unknown as PrismaService;

  return {
    repository: new PrismaTeamsRepository(prisma),
    attempts: () => attempts,
    isolationLevels,
    rows,
    writes: () => writes,
  };
}

function atomicCreateFixture(options: { failFirstMembershipWrite?: boolean } = {}): {
  repository: PrismaTeamsRepository;
  teams: Map<string, { id: string; ownerUserId: string; name: string; createdAt: Date }>;
  memberships: Map<string, FakeMembershipRow>;
  /** The raw SQL of every row lock the repository took, in order. */
  locks: string[];
} {
  const teams = new Map<
    string,
    { id: string; ownerUserId: string; name: string; createdAt: Date }
  >();
  const memberships = new Map<string, FakeMembershipRow>();
  const locks: string[] = [];
  let failMembershipWrite = options.failFirstMembershipWrite ?? true;
  let nextTeamId = 1;

  const tx: FakeCreateTransaction = {
    async $queryRaw<T>(query: TemplateStringsArray, ...values: readonly unknown[]): Promise<T> {
      locks.push(query.join('?'));
      return [{ id: values[0] }] as T;
    },
    team: {
      async count({ where }) {
        return [...teams.values()].filter((row) => row.ownerUserId === where.ownerUserId).length;
      },
      async create({ data }) {
        const row = { id: `team-created-${nextTeamId++}`, ...data, createdAt: new Date(0) };
        teams.set(row.id, row);
        return row;
      },
    },
    membership: {
      async create({ data }) {
        if (failMembershipWrite) {
          failMembershipWrite = false;
          throw new Error('injected owner-membership failure');
        }
        const row: FakeMembershipRow = { ...data, createdAt: new Date(0) };
        memberships.set(`${row.teamId}:${row.userId}`, row);
        return row;
      },
    },
  };

  const prisma = {
    async $transaction<T>(
      operation: (transaction: FakeCreateTransaction) => Promise<T>,
    ): Promise<T> {
      const teamSnapshot = new Map(teams);
      const membershipSnapshot = new Map(memberships);
      try {
        return await operation(tx);
      } catch (error) {
        teams.clear();
        memberships.clear();
        for (const [key, value] of teamSnapshot) teams.set(key, value);
        for (const [key, value] of membershipSnapshot) memberships.set(key, value);
        throw error;
      }
    },
  } as unknown as PrismaService;

  return { repository: new PrismaTeamsRepository(prisma), teams, memberships, locks };
}

test('team creation rolls back when its owner membership cannot be written', async () => {
  const fixture = atomicCreateFixture();

  await assert.rejects(
    () => fixture.repository.createTeam('owner-1', 'Atomic Team', UNCAPPED),
    /injected owner-membership failure/,
  );
  assert.equal(fixture.teams.size, 0);
  assert.equal(fixture.memberships.size, 0);

  const team = await fixture.repository.createTeam('owner-1', 'Atomic Team', UNCAPPED);
  assert.equal(team.ownerUserId, 'owner-1');
  assert.equal(fixture.teams.size, 1);
  assert.equal(fixture.memberships.get(`${team.id}:owner-1`)?.role, 'admin');
});

test('team creation locks the owner row and refuses the create once the owner holds the cap', async () => {
  const fixture = atomicCreateFixture({ failFirstMembershipWrite: false });

  await fixture.repository.createTeam('owner-1', 'One', 2);
  await fixture.repository.createTeam('owner-1', 'Two', 2);
  await assert.rejects(
    () => fixture.repository.createTeam('owner-1', 'Three', 2),
    (err: unknown) => {
      assert.ok(err instanceof OwnedTeamLimitExceededError);
      assert.equal(err.limit, 2);
      assert.equal(err.ownedCount, 2);
      return true;
    },
  );
  assert.equal(fixture.teams.size, 2, 'the refused create wrote nothing');

  // Every attempt queued on the OWNER's user row before counting: that lock is what turns the
  // count into an invariant under READ COMMITTED, and it must be the account, not a team.
  assert.equal(fixture.locks.length, 3);
  for (const sql of fixture.locks) assert.match(sql, /"users"[\s\S]*FOR UPDATE/);

  // Another owner's count is their own.
  await fixture.repository.createTeam('owner-2', 'Theirs', 2);
  assert.equal(fixture.teams.size, 3);
});

test('admin-decreasing writes use SERIALIZABLE isolation and retry P2034 conflicts', async () => {
  const fixture = repositoryFixture(2);

  const result = await fixture.repository.setRoleAsAdmin('team-1', 'admin-a', 'admin-b', 'member');

  assert.equal(result.outcome, 'updated');
  assert.equal(fixture.attempts(), 3);
  assert.deepEqual(fixture.isolationLevels, [
    Prisma.TransactionIsolationLevel.Serializable,
    Prisma.TransactionIsolationLevel.Serializable,
    Prisma.TransactionIsolationLevel.Serializable,
  ]);
  assert.equal(fixture.rows.get('admin-b')?.role, 'member');
});

test('the SERIALIZABLE mutation refuses the last-admin write before touching the row', async () => {
  const fixture = repositoryFixture();
  fixture.rows.delete('admin-b');

  const result = await fixture.repository.removeMemberAsAdmin('team-1', 'admin-a', 'admin-a');

  assert.equal(result.outcome, 'last_admin');
  assert.equal(fixture.writes(), 0);
  assert.equal(fixture.rows.get('admin-a')?.role, 'admin');
  assert.deepEqual(fixture.isolationLevels, [Prisma.TransactionIsolationLevel.Serializable]);
});
