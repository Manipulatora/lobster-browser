import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { PrismaApiKeysRepository } from '../api-keys/prisma-api-keys.repository';
import { PrismaAuditRepository } from '../audit/prisma-audit.repository';
import { PrismaProfilesRepository } from '../profiles/prisma-profiles.repository';
import {
  ProfileLimitExceededError,
  type CreateProfileRecord,
} from '../profiles/profiles.repository';
import { PrismaTeamsRepository } from '../teams/prisma-teams.repository';
import { PrismaUsersRepository } from '../auth/prisma-users.repository';
import { PrismaService } from './prisma.service';

/**
 * Postgres/Prisma integration proof (roadmap BE-2). OPT-IN: it runs only when `DATABASE_URL`
 * points at a reachable Postgres, and is SKIPPED cleanly otherwise so the default `npm test`
 * gate stays green with no database. To run it for real:
 *
 *   docker run -d --name lobster-pg -e POSTGRES_PASSWORD=lobster -e POSTGRES_DB=lobster \
 *     -p 5432:5432 postgres:16
 *   DATABASE_URL=postgresql://postgres:lobster@localhost:5432/lobster npm test
 *   # (or `npm run test:integration` to run just this file; see README "Postgres integration")
 *
 * It first applies the committed migrations (`prisma migrate deploy`) and then drives every
 * Prisma-backed repository through the same behavioural assertions the in-memory suites rely on,
 * proving the schema + migrations + repository mapping actually work against a real Postgres.
 * All rows are created under one throwaway user/team and removed afterwards (cascade), so the
 * test is re-runnable against a persistent database.
 */

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl
  ? false
  : 'DATABASE_URL not set — skipping Postgres/Prisma integration (see README to run it)';

/** apps/backend, resolved from the compiled location `dist/prisma/…spec.js`. */
const backendRoot = path.resolve(__dirname, '..', '..');

/** Apply the committed migrations with the Prisma CLI (resolved locally — no PATH dependency). */
function migrateDeploy(): void {
  const prismaCli = require.resolve('prisma');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: backendRoot,
    env: process.env,
    stdio: 'pipe',
  });
}

test('Postgres/Prisma integration: migrate deploy + repository behaviour', { skip }, async (t) => {
  migrateDeploy();

  const prisma = new PrismaService();
  await prisma.$connect();

  const users = new PrismaUsersRepository(prisma);
  const teams = new PrismaTeamsRepository(prisma);
  const profiles = new PrismaProfilesRepository(prisma);
  const apiKeys = new PrismaApiKeysRepository(prisma);
  const audit = new PrismaAuditRepository(prisma);

  // Unique per run so the suite is re-runnable against a persistent database.
  const runId = randomUUID().slice(0, 8);
  let userId = '';
  let teamId = '';

  try {
    await t.test('users: create → findByEmail → findById round-trip', async () => {
      const email = `it-${runId}@example.com`;
      const created = await users.create({
        email,
        passwordHash: 'bcrypt$fake-hash',
        displayName: 'Integration',
      });
      userId = created.id;
      assert.equal(created.email, email);

      const byEmail = await users.findByEmail(email);
      assert.equal(byEmail?.id, created.id);
      assert.equal(byEmail?.passwordHash, 'bcrypt$fake-hash');

      const byId = await users.findById(created.id);
      assert.equal(byId?.email, created.email);
      assert.equal(await users.findByEmail(`missing-${runId}@example.com`), null);

      // The conflict is discovered after the conditional pending-row claim. It must escape the
      // transaction callback so PostgreSQL restores that claim instead of consuming a valid code.
      await users.upsertPendingRegistration({
        email,
        passwordHash: 'unused-conflict-hash',
        fullName: 'Conflict',
        codeHash: 'conflict-code-hash',
        expiresAt: new Date(Date.now() + 60_000),
      });
      const conflict = await users.completePendingRegistration(
        email,
        'conflict-code-hash',
        new Date(),
      );
      assert.equal(conflict.outcome, 'email_conflict');
      assert.ok(
        await users.findPendingRegistration(email),
        'the valid pending row was rolled back',
      );
      await prisma.pendingRegistration.delete({ where: { email } });
    });

    await t.test('registration completion creates one complete personal-team graph', async () => {
      const email = `registration-${runId}@example.com`;
      let registeredUserId = '';
      try {
        await users.upsertPendingRegistration({
          email,
          passwordHash: 'bcrypt$registration-hash',
          fullName: 'Registration Integration',
          company: 'Lobster',
          codeHash: 'registration-code-hash',
          expiresAt: new Date(Date.now() + 60_000),
        });

        const completed = await users.completePendingRegistration(
          email,
          'registration-code-hash',
          new Date(),
        );
        assert.equal(completed.outcome, 'created');
        if (completed.outcome !== 'created')
          throw new Error('registration did not create its user');
        registeredUserId = completed.user.id;

        const personalTeams = await teams.findTeamsForUser(registeredUserId);
        assert.equal(personalTeams.length, 1);
        assert.equal(personalTeams[0]?.name, "Registration Integration's Team");
        assert.equal(
          (await teams.getMembership(personalTeams[0]!.id, registeredUserId))?.role,
          'admin',
        );
        assert.equal(await users.findPendingRegistration(email), null);
      } finally {
        await prisma.pendingRegistration.deleteMany({ where: { email } });
        if (registeredUserId) {
          await prisma.team.deleteMany({ where: { ownerUserId: registeredUserId } });
          await prisma.user.delete({ where: { id: registeredUserId } });
        }
      }
    });

    await t.test(
      'users: a live sign-up is not reclaimed; sessions and resets round-trip',
      async () => {
        const email = `claim-${runId}@example.com`;
        const now = new Date();
        const later = new Date(now.getTime() + 60_000);
        const attempt = (passwordHash: string, codeHash: string, expiresAt: Date) => ({
          email,
          passwordHash,
          fullName: 'Claimant',
          codeHash,
          expiresAt,
        });
        try {
          assert.equal(
            await users.claimPendingRegistration(attempt('first', 'first-code', later), now),
            true,
          );
          // ON CONFLICT DO NOTHING on the email primary key: a live row belongs to whoever wrote it.
          assert.equal(
            await users.claimPendingRegistration(attempt('second', 'second-code', later), now),
            false,
          );
          assert.equal((await users.findPendingRegistration(email))?.passwordHash, 'first');
          // Past the first row's window it is nobody's, and the next claim takes the address.
          assert.equal(
            await users.claimPendingRegistration(
              attempt('third', 'third-code', new Date(later.getTime() + 60_000)),
              later,
            ),
            true,
          );
          assert.equal((await users.findPendingRegistration(email))?.passwordHash, 'third');
        } finally {
          await prisma.pendingRegistration.deleteMany({ where: { email } });
        }

        const before = (await users.findById(userId))?.sessionVersion ?? 0;
        assert.equal((await users.revokeSessions(userId))?.sessionVersion, before + 1);

        await users.createPasswordReset(userId, 'reset-code-hash', later);
        assert.equal(await users.resetPasswordWithCode(userId, 'wrong-hash', 'unused', now), null);
        const reset = await users.resetPasswordWithCode(
          userId,
          'reset-code-hash',
          'bcrypt$reset-hash',
          now,
        );
        assert.equal(reset?.passwordHash, 'bcrypt$reset-hash');
        assert.equal(reset?.sessionVersion, before + 2, 'a reset revokes every session');
        assert.equal(
          await users.resetPasswordWithCode(userId, 'reset-code-hash', 'unused', now),
          null,
          'a reset code is single-use',
        );
      },
    );

    await t.test('teams: create, membership add/get/list, setRole, findTeamsForUser', async () => {
      const team = await teams.createTeam(userId, `IT Team ${runId}`);
      teamId = team.id;
      assert.equal(team.ownerUserId, userId);

      const membership = await teams.getMembership(teamId, userId);
      assert.equal(membership?.role, 'admin');

      const lastAdminDemotion = await teams.setRoleAsAdmin(teamId, userId, userId, 'member');
      assert.equal(lastAdminDemotion.outcome, 'last_admin');

      const members = await teams.listMembers(teamId);
      assert.equal(members.length, 1);

      const forUser = await teams.findTeamsForUser(userId);
      assert.ok(
        forUser.some((tm) => tm.id === teamId),
        'membership resolves the team',
      );
      assert.equal(await teams.getMembership(teamId, `no-such-user-${runId}`), null);
    });

    await t.test('profiles: CRUD is team-scoped and metadata round-trips', async () => {
      const created = (
        await profiles.createManyWithinLimit([
          {
            ownerTeamId: teamId,
            name: 'IT Profile',
            engine: 'lobium',
            os: 'linux',
            osVersion: 'Ubuntu 24.04',
            fingerprintSeed: `seed-${runId}`,
            fingerprintOverrides: { navigator: { hardwareConcurrency: 8 } },
            proxyId: `proxy-${runId}`,
            templateId: `template-${runId}`,
            cookiesImport: {
              mode: 'merge',
              source: 'file',
              fileName: 'cookies.txt',
              parsedCount: 2,
            },
            extensions: [
              {
                source: 'chrome_web_store',
                enabled: true,
                id: 'abcdefghijklmnop',
                name: 'Example',
              },
            ],
            tags: ['it', 'prisma'],
            folder: 'integration',
            notes: 'created by the BE-2 integration test',
          },
        ])
      )[0]!;
      assert.equal(created.fingerprintSeed, `seed-${runId}`);
      assert.equal(created.osVersion, 'Ubuntu 24.04');
      assert.equal(created.proxyId, `proxy-${runId}`);
      assert.equal(created.templateId, `template-${runId}`);
      assert.deepEqual(created.cookiesImport, {
        mode: 'merge',
        source: 'file',
        fileName: 'cookies.txt',
        parsedCount: 2,
      });
      assert.deepEqual(created.extensions, [
        {
          source: 'chrome_web_store',
          enabled: true,
          id: 'abcdefghijklmnop',
          name: 'Example',
        },
      ]);
      assert.deepEqual(created.tags, ['it', 'prisma']);

      const fetched = await profiles.findById(teamId, created.id);
      assert.equal(fetched?.name, 'IT Profile');
      assert.equal(fetched?.os, 'linux');
      // Team scoping: the same id under a different team resolves to nothing.
      assert.equal(await profiles.findById(`not-${teamId}`, created.id), null);

      const updated = await profiles.update(teamId, created.id, {
        name: 'IT Profile v2',
        osVersion: 'Ubuntu 24.10',
        proxyId: `proxy-updated-${runId}`,
        templateId: `template-updated-${runId}`,
        cookiesImport: { mode: 'empty', parsedCount: 0 },
        extensions: [{ source: 'unpacked', enabled: false, name: 'Local extension' }],
        notes: 'updated',
      });
      assert.equal(updated?.name, 'IT Profile v2');
      assert.equal(updated?.notes, 'updated');
      assert.equal(updated?.osVersion, 'Ubuntu 24.10');
      assert.equal(updated?.proxyId, `proxy-updated-${runId}`);
      assert.equal(updated?.templateId, `template-updated-${runId}`);
      assert.deepEqual(updated?.cookiesImport, { mode: 'empty', parsedCount: 0 });
      assert.deepEqual(updated?.extensions, [
        { source: 'unpacked', enabled: false, name: 'Local extension' },
      ]);
      // Untouched metadata fields survive a partial update.
      assert.deepEqual(updated?.tags, ['it', 'prisma']);
      assert.deepEqual(updated?.fingerprintOverrides, {
        navigator: { hardwareConcurrency: 8 },
      });
      // The seed — the profile's identity — is immutable through update.
      assert.equal(updated?.fingerprintSeed, `seed-${runId}`);

      const all = await profiles.findAllByTeam(teamId);
      assert.equal(all.length, 1);

      assert.equal((await profiles.removeAsAdmin(teamId, created.id, userId)).outcome, 'removed');
      assert.equal((await profiles.removeAsAdmin(teamId, created.id, userId)).outcome, 'not_found');
      assert.equal((await profiles.findAllByTeam(teamId)).length, 0);
    });

    await t.test(
      'profiles: getProfileLimit reads the team subscription (null without one)',
      async () => {
        assert.equal(await profiles.getProfileLimit(teamId), null);
        await prisma.subscription.create({
          data: { teamId, tier: 'pro', profileLimit: 25, status: 'active' },
        });
        assert.equal(await profiles.getProfileLimit(teamId), 25);
      },
    );

    await t.test('profiles: concurrent creates cannot exceed the final plan slot', async () => {
      await prisma.profile.deleteMany({ where: { ownerTeamId: teamId } });
      await prisma.subscription.update({
        where: { teamId },
        data: { profileLimit: 2 },
      });
      const record = (name: string, seed: string): CreateProfileRecord => ({
        ownerTeamId: teamId,
        name,
        engine: 'lobium',
        os: 'windows',
        fingerprintSeed: seed,
        tags: [],
      });

      try {
        await profiles.createManyWithinLimit([
          record('Capacity baseline', '11111111111111111111111111111111'),
        ]);
        const results = await Promise.allSettled([
          profiles.createManyWithinLimit([
            record('Capacity racer A', '22222222222222222222222222222222'),
          ]),
          profiles.createManyWithinLimit([
            record('Capacity racer B', '33333333333333333333333333333333'),
          ]),
        ]);

        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        assert.equal(
          results.filter(
            (result) =>
              result.status === 'rejected' && result.reason instanceof ProfileLimitExceededError,
          ).length,
          1,
        );
        assert.equal(
          await prisma.profile.count({ where: { ownerTeamId: teamId, deletedAt: null } }),
          2,
        );
      } finally {
        await prisma.profile.deleteMany({ where: { ownerTeamId: teamId } });
        await prisma.subscription.update({
          where: { teamId },
          data: { profileLimit: 25 },
        });
      }
    });

    await t.test('api keys: create, findByHash, touchLastUsed, team-scoped remove', async () => {
      const created = await apiKeys.create({
        teamId,
        name: 'IT key',
        prefix: 'lb_test_it01',
        hashedKey: `sha256-${runId}`,
      });
      assert.equal(created.lastUsedAt, undefined);

      const byHash = await apiKeys.findByHash(`sha256-${runId}`);
      assert.equal(byHash?.id, created.id);
      assert.equal(await apiKeys.findByHash('sha256-of-nothing'), null);

      await apiKeys.touchLastUsed(created.id);
      const touched = await apiKeys.findById(teamId, created.id);
      assert.ok(touched?.lastUsedAt, 'lastUsedAt is stamped after touchLastUsed');

      // Team scoping: another team can neither see nor revoke the key.
      assert.equal(await apiKeys.findById(`not-${teamId}`, created.id), null);
      assert.equal(await apiKeys.remove(`not-${teamId}`, created.id), false);
      assert.equal(await apiKeys.remove(teamId, created.id), true);
      assert.equal((await apiKeys.findAllByTeam(teamId)).length, 0);
    });

    await t.test('audit: append-only record + newest-first keyset pagination', async () => {
      const recorded = [];
      for (let i = 1; i <= 3; i += 1) {
        recorded.push(
          await audit.record({
            teamId,
            actorUserId: userId,
            action: `it.event_${i}`,
            targetType: 'integration',
            metadata: { i },
          }),
        );
      }

      const page1 = await audit.listByTeam(teamId, { limit: 2 });
      assert.equal(page1.length, 2);
      const cursor = page1[1]!;
      const page2 = await audit.listByTeam(teamId, {
        limit: 2,
        before: { createdAt: cursor.createdAt, id: cursor.id },
      });
      assert.equal(page2.length, 1);

      // Keyset pagination covers all entries exactly once — no skips, no duplicates
      // (even when rows share a createdAt millisecond, thanks to the (createdAt, id) cursor).
      const paged = [...page1, ...page2].map((e) => e.id).sort();
      assert.deepEqual(paged, recorded.map((e) => e.id).sort());
    });
  } finally {
    // Team delete cascades memberships / profiles / api keys / audit logs / subscription.
    if (teamId) {
      await prisma.team.delete({ where: { id: teamId } }).catch(() => {});
    }
    if (userId) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
});
