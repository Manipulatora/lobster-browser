import assert from 'node:assert/strict';
import test from 'node:test';

import { PrismaService } from '../prisma/prisma.service';
import { PrismaUsersRepository } from './prisma-users.repository';

interface PendingRow {
  email: string;
  passwordHash: string;
  fullName: string;
  company: string | null;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  createdAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  company: string | null;
  passwordHash: string;
  createdAt: Date;
  emailVerifiedAt: Date;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}

interface TeamRow {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: Date;
}

interface MembershipRow {
  teamId: string;
  userId: string;
  role: 'admin';
  createdAt: Date;
}

interface ValidPendingWhere {
  email: string;
  codeHash: string;
  expiresAt: { gt: Date };
  attempts: { lt: number };
}

interface FakeTransaction {
  pendingRegistration: {
    findFirst(input: { where: ValidPendingWhere }): Promise<PendingRow | null>;
    updateMany(input: {
      where: { email: string };
      data: { attempts: { increment: number } };
    }): Promise<{ count: number }>;
    deleteMany(input: { where: ValidPendingWhere }): Promise<{ count: number }>;
  };
  user: {
    findUnique(input: { where: { email: string } }): Promise<UserRow | null>;
    create(input: {
      data: {
        email: string;
        passwordHash: string;
        displayName: string;
        company: string | null;
        emailVerifiedAt: Date;
      };
    }): Promise<UserRow>;
  };
  team: {
    create(input: { data: { ownerUserId: string; name: string } }): Promise<TeamRow>;
  };
  membership: {
    create(input: {
      data: { teamId: string; userId: string; role: 'admin' };
    }): Promise<MembershipRow>;
  };
}

function cloneMap<T extends object>(source: Map<string, T>): Map<string, T> {
  return new Map([...source].map(([key, value]) => [key, { ...value }]));
}

function restoreMap<T>(target: Map<string, T>, snapshot: Map<string, T>): void {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}

function fixture(options: { failFirstMembershipWrite?: boolean } = {}) {
  const pending = new Map<string, PendingRow>();
  const users = new Map<string, UserRow>();
  const teams = new Map<string, TeamRow>();
  const memberships = new Map<string, MembershipRow>();
  let nextId = 1;
  let failMembershipWrite = options.failFirstMembershipWrite ?? false;

  const isLive = (row: PendingRow | undefined, where: ValidPendingWhere): row is PendingRow =>
    row !== undefined &&
    row.codeHash === where.codeHash &&
    row.expiresAt > where.expiresAt.gt &&
    row.attempts < where.attempts.lt;

  const tx: FakeTransaction = {
    pendingRegistration: {
      async findFirst({ where }) {
        const row = pending.get(where.email);
        return isLive(row, where) ? row : null;
      },
      async updateMany({ where, data }) {
        const row = pending.get(where.email);
        if (!row) return { count: 0 };
        row.attempts += data.attempts.increment;
        return { count: 1 };
      },
      async deleteMany({ where }) {
        const row = pending.get(where.email);
        if (!isLive(row, where)) return { count: 0 };
        pending.delete(where.email);
        return { count: 1 };
      },
    },
    user: {
      async findUnique({ where }) {
        return users.get(where.email) ?? null;
      },
      async create({ data }) {
        if (users.has(data.email)) {
          throw Object.assign(new Error('unique email'), { code: 'P2002' });
        }
        const row: UserRow = {
          id: `user-${nextId++}`,
          ...data,
          createdAt: data.emailVerifiedAt,
          failedLoginAttempts: 0,
          lockedUntil: null,
        };
        users.set(row.email, row);
        return row;
      },
    },
    team: {
      async create({ data }) {
        const row: TeamRow = {
          id: `team-${nextId++}`,
          ...data,
          createdAt: new Date(),
        };
        teams.set(row.id, row);
        return row;
      },
    },
    membership: {
      async create({ data }) {
        if (failMembershipWrite) {
          failMembershipWrite = false;
          throw new Error('injected membership write failure');
        }
        const row: MembershipRow = { ...data, createdAt: new Date() };
        memberships.set(`${row.teamId}:${row.userId}`, row);
        return row;
      },
    },
  };

  // A tiny transaction queue models the database's row-level serialization for simultaneous
  // correct-code claims, while the snapshots model rollback after any downstream write failure.
  let transactionTail = Promise.resolve();
  const runTransaction = async <T>(operation: (transaction: FakeTransaction) => Promise<T>) => {
    let release!: () => void;
    const predecessor = transactionTail;
    transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    const snapshots = {
      pending: cloneMap(pending),
      users: cloneMap(users),
      teams: cloneMap(teams),
      memberships: cloneMap(memberships),
    };
    try {
      return await operation(tx);
    } catch (error) {
      restoreMap(pending, snapshots.pending);
      restoreMap(users, snapshots.users);
      restoreMap(teams, snapshots.teams);
      restoreMap(memberships, snapshots.memberships);
      throw error;
    } finally {
      release();
    }
  };

  const prisma = {
    $transaction: runTransaction,
    user: {
      async findUnique({ where }: { where: { email: string } }) {
        return users.get(where.email) ?? null;
      },
    },
  } as unknown as PrismaService;

  return {
    repository: new PrismaUsersRepository(prisma),
    pending,
    users,
    teams,
    memberships,
    seedPending(email: string, codeHash: string): void {
      pending.set(email, {
        email,
        passwordHash: 'bcrypt-hash',
        fullName: 'Alice Example',
        company: 'Example Ltd',
        codeHash,
        expiresAt: new Date(Date.now() + 60_000),
        attempts: 0,
        createdAt: new Date(),
      });
    },
  };
}

test('registration graph failure rolls every row back and leaves the code retryable', async () => {
  const f = fixture({ failFirstMembershipWrite: true });
  f.seedPending('alice@gmail.com', 'correct-hash');

  await assert.rejects(
    () => f.repository.completePendingRegistration('alice@gmail.com', 'correct-hash', new Date()),
    /injected membership write failure/,
  );

  assert.equal(f.pending.size, 1, 'the pending-code claim must roll back');
  assert.equal(f.users.size, 0);
  assert.equal(f.teams.size, 0);
  assert.equal(f.memberships.size, 0);

  const retried = await f.repository.completePendingRegistration(
    'alice@gmail.com',
    'correct-hash',
    new Date(),
  );
  assert.equal(retried.outcome, 'created');
  assert.equal(f.pending.size, 0);
  assert.equal(f.users.size, 1);
  assert.equal(f.teams.size, 1);
  assert.equal(f.memberships.size, 1);
});

test('simultaneous correct-code claims create one and only one complete account graph', async () => {
  const f = fixture();
  f.seedPending('alice@gmail.com', 'correct-hash');

  const results = await Promise.all([
    f.repository.completePendingRegistration('alice@gmail.com', 'correct-hash', new Date()),
    f.repository.completePendingRegistration('alice@gmail.com', 'correct-hash', new Date()),
  ]);

  assert.deepEqual(results.map((result) => result.outcome).sort(), ['created', 'invalid']);
  assert.equal(f.users.size, 1);
  assert.equal(f.teams.size, 1);
  assert.equal(f.memberships.size, 1);
});

test('an email conflict rolls the pending-code claim back instead of consuming it', async () => {
  const f = fixture();
  f.seedPending('alice@gmail.com', 'correct-hash');
  f.users.set('alice@gmail.com', {
    id: 'existing-user',
    email: 'alice@gmail.com',
    displayName: 'Existing',
    company: null,
    passwordHash: 'existing-hash',
    createdAt: new Date(),
    emailVerifiedAt: new Date(),
    failedLoginAttempts: 0,
    lockedUntil: null,
  });

  const result = await f.repository.completePendingRegistration(
    'alice@gmail.com',
    'correct-hash',
    new Date(),
  );

  assert.equal(result.outcome, 'email_conflict');
  assert.equal(f.pending.size, 1);
  assert.equal(f.users.size, 1);
  assert.equal(f.teams.size, 0);
  assert.equal(f.memberships.size, 0);
});
