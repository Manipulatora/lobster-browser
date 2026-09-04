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
  sessionVersion: number;
}

interface ResetRow {
  userId: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  createdAt: Date;
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

/** What every claim of a live pending code is predicated on. */
interface ValidPendingWhere {
  email: string;
  codeHash: string;
  expiresAt: { gt: Date };
  attempts: { lt: number };
}

/** What `claimPendingRegistration` clears a dead row with — and nothing else. */
interface ExpiredPendingWhere {
  email: string;
  expiresAt: { lte: Date };
}

interface ValidResetWhere {
  userId: string;
  codeHash: string;
  expiresAt: { gt: Date };
  attempts: { lt: number };
}

/** The subset of `Prisma.UserUpdateInput` the repository writes through `user.update`. */
interface UserUpdate {
  passwordHash?: string;
  sessionVersion?: { increment: number };
  failedLoginAttempts?: number | { increment: number };
  lockedUntil?: Date | null;
}

interface PendingDelegate {
  findFirst(input: { where: ValidPendingWhere }): Promise<PendingRow | null>;
  updateMany(input: {
    where: { email: string };
    data: { attempts: { increment: number } };
  }): Promise<{ count: number }>;
  deleteMany(input: { where: ValidPendingWhere | ExpiredPendingWhere }): Promise<{ count: number }>;
  createMany(input: {
    data: Array<Omit<PendingRow, 'attempts' | 'createdAt'>>;
    skipDuplicates: boolean;
  }): Promise<{ count: number }>;
}

interface UserDelegate {
  findUnique(input: { where: { email?: string; id?: string } }): Promise<UserRow | null>;
  create(input: {
    data: {
      email: string;
      passwordHash: string;
      displayName: string;
      company: string | null;
      emailVerifiedAt: Date;
    };
  }): Promise<UserRow>;
  update(input: { where: { id: string }; data: UserUpdate }): Promise<UserRow>;
}

interface ResetDelegate {
  deleteMany(input: { where: ValidResetWhere }): Promise<{ count: number }>;
  updateMany(input: {
    where: { userId: string };
    data: { attempts: { increment: number } };
  }): Promise<{ count: number }>;
}

interface FakeTransaction {
  pendingRegistration: PendingDelegate;
  passwordReset: ResetDelegate;
  user: UserDelegate;
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
  const resets = new Map<string, ResetRow>();
  const teams = new Map<string, TeamRow>();
  const memberships = new Map<string, MembershipRow>();
  let nextId = 1;
  let failMembershipWrite = options.failFirstMembershipWrite ?? false;

  const isLive = (row: PendingRow | undefined, where: ValidPendingWhere): row is PendingRow =>
    row !== undefined &&
    row.codeHash === where.codeHash &&
    row.expiresAt > where.expiresAt.gt &&
    row.attempts < where.attempts.lt;

  const userById = (id: string): UserRow | undefined =>
    [...users.values()].find((row) => row.id === id);

  const pendingDelegate: PendingDelegate = {
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
      // Two predicates reach this delegate: the live-code claim, and the dead-row clearing that
      // precedes a fresh claim. Each removes exactly what it names and nothing else.
      const matches =
        'codeHash' in where
          ? isLive(row, where)
          : row !== undefined && row.expiresAt <= where.expiresAt.lte;
      if (!matches) return { count: 0 };
      pending.delete(where.email);
      return { count: 1 };
    },
    async createMany({ data, skipDuplicates }) {
      let count = 0;
      for (const row of data) {
        if (pending.has(row.email)) {
          if (!skipDuplicates) throw Object.assign(new Error('unique email'), { code: 'P2002' });
          continue;
        }
        pending.set(row.email, { ...row, attempts: 0, createdAt: new Date() });
        count += 1;
      }
      return { count };
    },
  };

  const userDelegate: UserDelegate = {
    async findUnique({ where }) {
      if (where.email !== undefined) return users.get(where.email) ?? null;
      return (where.id !== undefined && userById(where.id)) || null;
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
        sessionVersion: 0,
      };
      users.set(row.email, row);
      return row;
    },
    async update({ where, data }) {
      const row = userById(where.id);
      if (!row) throw Object.assign(new Error('record not found'), { code: 'P2025' });
      if (data.passwordHash !== undefined) row.passwordHash = data.passwordHash;
      if (data.sessionVersion) row.sessionVersion += data.sessionVersion.increment;
      if (typeof data.failedLoginAttempts === 'number') {
        row.failedLoginAttempts = data.failedLoginAttempts;
      } else if (data.failedLoginAttempts) {
        row.failedLoginAttempts += data.failedLoginAttempts.increment;
      }
      if ('lockedUntil' in data) row.lockedUntil = data.lockedUntil ?? null;
      return row;
    },
  };

  const resetDelegate: ResetDelegate = {
    async deleteMany({ where }) {
      const row = resets.get(where.userId);
      const live =
        row !== undefined &&
        row.codeHash === where.codeHash &&
        row.expiresAt > where.expiresAt.gt &&
        row.attempts < where.attempts.lt;
      if (!live) return { count: 0 };
      resets.delete(where.userId);
      return { count: 1 };
    },
    async updateMany({ where, data }) {
      const row = resets.get(where.userId);
      if (!row) return { count: 0 };
      row.attempts += data.attempts.increment;
      return { count: 1 };
    },
  };

  const tx: FakeTransaction = {
    pendingRegistration: pendingDelegate,
    passwordReset: resetDelegate,
    user: userDelegate,
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
      resets: cloneMap(resets),
      teams: cloneMap(teams),
      memberships: cloneMap(memberships),
    };
    try {
      return await operation(tx);
    } catch (error) {
      restoreMap(pending, snapshots.pending);
      restoreMap(users, snapshots.users);
      restoreMap(resets, snapshots.resets);
      restoreMap(teams, snapshots.teams);
      restoreMap(memberships, snapshots.memberships);
      throw error;
    } finally {
      release();
    }
  };

  const prisma = {
    $transaction: runTransaction,
    pendingRegistration: pendingDelegate,
    passwordReset: resetDelegate,
    user: userDelegate,
  } as unknown as PrismaService;

  return {
    repository: new PrismaUsersRepository(prisma),
    pending,
    users,
    resets,
    teams,
    memberships,
    seedPending(email: string, codeHash: string, expiresAt = new Date(Date.now() + 60_000)): void {
      pending.set(email, {
        email,
        passwordHash: 'bcrypt-hash',
        fullName: 'Alice Example',
        company: 'Example Ltd',
        codeHash,
        expiresAt,
        attempts: 0,
        createdAt: new Date(),
      });
    },
    seedUser(email: string, overrides: Partial<UserRow> = {}): UserRow {
      const row: UserRow = {
        id: `user-${nextId++}`,
        email,
        displayName: 'Existing',
        company: null,
        passwordHash: 'existing-hash',
        createdAt: new Date(),
        emailVerifiedAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
        sessionVersion: 0,
        ...overrides,
      };
      users.set(email, row);
      return row;
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
  f.seedUser('alice@gmail.com');

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

test('a live pending sign-up is not replaced by a later claim; an expired one is', async () => {
  const f = fixture();
  const now = new Date();
  f.seedPending('alice@gmail.com', 'first-code', new Date(now.getTime() + 60_000));

  const contested = await f.repository.claimPendingRegistration(
    {
      email: 'alice@gmail.com',
      passwordHash: 'second-password-hash',
      fullName: 'Second',
      codeHash: 'second-code',
      expiresAt: new Date(now.getTime() + 60_000),
    },
    now,
  );
  assert.equal(contested, false);
  const untouched = f.pending.get('alice@gmail.com');
  assert.equal(untouched?.codeHash, 'first-code', 'the live row keeps its code');
  assert.equal(untouched?.passwordHash, 'bcrypt-hash', '...and, above all, its password');

  // Past the first row's window it is nobody's, and the next claim takes the address outright.
  const later = new Date(now.getTime() + 120_000);
  const reclaimed = await f.repository.claimPendingRegistration(
    {
      email: 'alice@gmail.com',
      passwordHash: 'third-password-hash',
      fullName: 'Third',
      codeHash: 'third-code',
      expiresAt: new Date(later.getTime() + 60_000),
    },
    later,
  );
  assert.equal(reclaimed, true);
  const replaced = f.pending.get('alice@gmail.com');
  assert.equal(replaced?.codeHash, 'third-code');
  assert.equal(replaced?.passwordHash, 'third-password-hash');
  assert.equal(replaced?.attempts, 0, 'a fresh claim starts with a fresh attempt budget');
});

test('a reset code is consumed and the password changed in one transaction; a miss burns an attempt', async () => {
  const f = fixture();
  const now = new Date();
  const user = f.seedUser('alice@gmail.com', {
    passwordHash: 'old-hash',
    sessionVersion: 3,
    failedLoginAttempts: 2,
    lockedUntil: new Date(now.getTime() + 60_000),
  });
  f.resets.set(user.id, {
    userId: user.id,
    codeHash: 'reset-hash',
    expiresAt: new Date(now.getTime() + 60_000),
    attempts: 0,
    createdAt: now,
  });

  assert.equal(
    await f.repository.resetPasswordWithCode(user.id, 'wrong-hash', 'new-hash', now),
    null,
  );
  assert.equal(f.resets.get(user.id)?.attempts, 1, 'a miss counts against the outstanding code');
  assert.equal(f.users.get('alice@gmail.com')?.passwordHash, 'old-hash', 'a miss changes nothing');

  const updated = await f.repository.resetPasswordWithCode(user.id, 'reset-hash', 'new-hash', now);
  assert.equal(updated?.passwordHash, 'new-hash');
  assert.equal(updated?.sessionVersion, 4, 'a reset revokes every session');
  assert.equal(
    updated?.failedLoginAttempts,
    0,
    'the backoff was defending a password that is gone',
  );
  assert.equal(updated?.lockedUntil, undefined);
  assert.equal(f.resets.size, 0, 'the code is gone: single-use');
  assert.equal(
    await f.repository.resetPasswordWithCode(user.id, 'reset-hash', 'newer-hash', now),
    null,
    'a replay finds nothing to consume',
  );
});

test('revoking sessions moves the version, and an account that is gone answers null', async () => {
  const f = fixture();
  const user = f.seedUser('alice@gmail.com', { sessionVersion: 7 });

  assert.equal((await f.repository.revokeSessions(user.id))?.sessionVersion, 8);
  assert.equal((await f.repository.changePassword(user.id, 'new-hash'))?.sessionVersion, 9);
  assert.equal(await f.repository.revokeSessions('no-such-user'), null);
  assert.equal(await f.repository.changePassword('no-such-user', 'new-hash'), null);
});
