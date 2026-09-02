import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Profile } from '@lobster/shared-types';

import type { AuditRepository } from '../audit/audit.repository';
import { AuditService } from '../audit/audit.service';
import type { TeamsRepository } from '../teams/teams.repository';
import { InMemoryBlobStore } from './blob/in-memory-blob-store';
import { InMemoryProfilesRepository } from './in-memory-profiles.repository';
import type { ProfilesRepository } from './profiles.repository';
import {
  DEFAULT_BLOB_TEAM_QUOTA_BYTES,
  DEFAULT_FREE_PROFILE_LIMIT,
  ProfilesService,
  resolveBlobTeamQuotaBytes,
  type SyncProfileInput,
} from './profiles.service';

/** No S3_* configured — the blob refs the service builds then name the in-memory store. */
const config = { get: () => undefined } as unknown as ConfigService;

/**
 * Unit tests for ProfilesService.sync's optimistic-concurrency behaviour, wired against the real
 * InMemoryBlobStore plus minimal stubs for the other collaborators (team + profile resolution and
 * a no-op audit). Driving it in-process lets us interleave two pushes deterministically — HTTP e2e
 * can't guarantee interleaving because Nest may serialise the two request handlers.
 */
function makeService(
  cfg: ConfigService = config,
  entitledProfileLimit: number | null = null,
): {
  service: ProfilesService;
  blobs: InMemoryBlobStore;
} {
  const blobs = new InMemoryBlobStore();
  const teams = {
    getMembership: async () => ({ teamId: 'team-1', userId: 'user-1', role: 'admin' }),
  } as unknown as TeamsRepository;
  const profiles = {
    findById: async (teamId: string, id: string) =>
      ({ id, ownerTeamId: teamId, name: 'Racy' }) as unknown as Profile,
    getProfileLimit: async () => entitledProfileLimit,
  } as unknown as ProfilesRepository;
  const audit = { record: async () => {} } as unknown as AuditService;
  return { service: new ProfilesService(profiles, teams, blobs, audit, cfg), blobs };
}

function configOf(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function pushOf(marker: string, baseVersion = 0): SyncProfileInput {
  return { direction: 'push', payload: Buffer.from(marker).toString('base64'), baseVersion };
}

function makeProfileCreationService(): {
  service: ProfilesService;
  repository: InMemoryProfilesRepository;
  auditActions: string[];
} {
  const repository = new InMemoryProfilesRepository();
  const teams = {
    getMembership: async () => ({ teamId: 'team-1', userId: 'user-1', role: 'admin' }),
  } as unknown as TeamsRepository;
  const auditActions: string[] = [];
  const audit = {
    record: async (input: { action: string }) => {
      auditActions.push(input.action);
    },
  } as unknown as AuditService;
  return {
    service: new ProfilesService(repository, teams, new InMemoryBlobStore(), audit, config),
    repository,
    auditActions,
  };
}

test('two creates racing for the final plan slot produce one profile and one 403', async () => {
  const { service, repository, auditActions } = makeProfileCreationService();
  for (let index = 0; index < DEFAULT_FREE_PROFILE_LIMIT - 1; index += 1) {
    await service.create(
      'user-1',
      { name: `Existing ${index}`, engine: 'lobium', os: 'windows' },
      'team-1',
    );
  }
  const auditCountBeforeRace = auditActions.length;

  const results = await Promise.allSettled([
    service.create('user-1', { name: 'Racer A', engine: 'lobium', os: 'windows' }, 'team-1'),
    service.create('user-1', { name: 'Racer B', engine: 'lobium', os: 'windows' }, 'team-1'),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    results.filter(
      (result) => result.status === 'rejected' && result.reason instanceof ForbiddenException,
    ).length,
    1,
  );
  const stored = await repository.findAllByTeam('team-1');
  assert.equal(stored.length, DEFAULT_FREE_PROFILE_LIMIT);
  assert.equal(stored.filter((profile) => /^Racer [AB]$/.test(profile.name)).length, 1);
  assert.deepEqual(auditActions.slice(auditCountBeforeRace), ['profile.create']);
});

test('capacity-rejected bulk and import batches write no profiles or audits', async () => {
  const { service, repository, auditActions } = makeProfileCreationService();
  for (let index = 0; index < DEFAULT_FREE_PROFILE_LIMIT - 1; index += 1) {
    await service.create(
      'user-1',
      { name: `Existing ${index}`, engine: 'lobium', os: 'windows' },
      'team-1',
    );
  }
  const auditCountBeforeFailures = auditActions.length;

  await assert.rejects(
    () =>
      service.bulkCreate(
        'user-1',
        { count: 2, namePrefix: 'Bulk', engine: 'lobium', os: 'windows' },
        'team-1',
      ),
    ForbiddenException,
  );
  await assert.rejects(
    () =>
      service.importBundle(
        'user-1',
        {
          version: 1,
          profiles: [
            {
              name: 'Imported A',
              engine: 'lobium',
              os: 'windows',
              fingerprintSeed: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
            {
              name: 'Imported B',
              engine: 'lobium',
              os: 'windows',
              fingerprintSeed: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
          ],
        },
        'team-1',
      ),
    ForbiddenException,
  );

  const stored = await repository.findAllByTeam('team-1');
  assert.equal(stored.length, DEFAULT_FREE_PROFILE_LIMIT - 1);
  assert.equal(
    stored.some((profile) => /^(Bulk|Imported)/.test(profile.name)),
    false,
  );
  assert.deepEqual(auditActions.slice(auditCountBeforeFailures), []);
});

test('a failed best-effort audit write cannot turn a committed bulk create into an API failure', async () => {
  const repository = new InMemoryProfilesRepository();
  const teams = {
    getMembership: async () => ({ teamId: 'team-1', userId: 'user-1', role: 'admin' }),
  } as unknown as TeamsRepository;
  const audit = new AuditService(
    {
      record: async () => {
        throw new Error('audit store unavailable');
      },
      listByTeam: async () => [],
    } as unknown as AuditRepository,
    teams,
  );
  const service = new ProfilesService(repository, teams, new InMemoryBlobStore(), audit, config);

  const created = await service.bulkCreate(
    'user-1',
    { count: 2, namePrefix: 'Committed', engine: 'lobium', os: 'windows' },
    'team-1',
  );

  assert.equal(created.length, 2);
  assert.equal((await repository.findAllByTeam('team-1')).length, 2);
});

test('the profile allowance belongs to the billing account: a second owned team shares it', async () => {
  // Both teams are owned by user-1, which is what the in-memory probe reports; the teams stub
  // admits the caller to either.
  const repository = new InMemoryProfilesRepository(
    () => true,
    (teamId) => (teamId === 'team-1' || teamId === 'team-2' ? 'user-1' : undefined),
  );
  const teams = {
    getMembership: async (teamId: string) => ({ teamId, userId: 'user-1', role: 'admin' }),
  } as unknown as TeamsRepository;
  const audit = { record: async () => {} } as unknown as AuditService;
  const service = new ProfilesService(repository, teams, new InMemoryBlobStore(), audit, config);

  for (let index = 0; index < DEFAULT_FREE_PROFILE_LIMIT; index += 1) {
    await service.create(
      'user-1',
      { name: `Own ${index}`, engine: 'lobium', os: 'windows' },
      'team-1',
    );
  }

  // Before this rule, `POST /teams` + `?teamId=<new>` was another three free profiles.
  await assert.rejects(
    () => service.create('user-1', { name: 'Overflow', engine: 'lobium', os: 'windows' }, 'team-2'),
    (err: unknown) => {
      assert.ok(err instanceof ForbiddenException);
      assert.match(err.message, /reached for this account/);
      return true;
    },
  );
  assert.equal((await repository.findAllByTeam('team-2')).length, 0);
});

test('a push the team has no storage quota left for is a 507 whose message says what to do', async () => {
  // 16 bytes on the free allowance, so two 10-byte snapshots from two profiles cannot both fit.
  const { service, blobs } = makeService(configOf({ BLOB_TEAM_QUOTA_BYTES: '16' }));
  await service.sync('user-1', 'p1', pushOf('0123456789'), 'team-1');

  await assert.rejects(
    () => service.sync('user-1', 'p2', pushOf('abcdefghij'), 'team-1'),
    (err: unknown) => {
      assert.ok(err instanceof HttpException);
      assert.equal(err.getStatus(), 507);
      assert.match(err.message, /storage quota exceeded/);
      assert.match(err.message, /delete unused profiles or upgrade the plan/);
      // The launcher prints the first 200 characters of the envelope; the message must fit.
      assert.ok(err.message.length <= 170, `message too long for the launcher: ${err.message}`);
      return true;
    },
  );
  assert.equal(await blobs.head('team-1/p2'), null, 'the refused push stored nothing');

  // Replacing p1's own snapshot is measured net, so the same profile keeps syncing.
  const replaced = await service.sync('user-1', 'p1', pushOf('9876543210', 1), 'team-1');
  assert.equal(replaced.version, 2);
});

test('the storage quota scales with the account’s entitled profile count, and 0 disables it', async () => {
  // Entitled to twice the free profile count → twice the quota: both 10-byte snapshots fit in 32.
  const scaled = makeService(
    configOf({ BLOB_TEAM_QUOTA_BYTES: '16' }),
    DEFAULT_FREE_PROFILE_LIMIT * 2,
  );
  await scaled.service.sync('user-1', 'p1', pushOf('0123456789'), 'team-1');
  await scaled.service.sync('user-1', 'p2', pushOf('abcdefghij'), 'team-1');

  const disabled = makeService(configOf({ BLOB_TEAM_QUOTA_BYTES: '0' }));
  await disabled.service.sync('user-1', 'p1', pushOf('0123456789'), 'team-1');
  await disabled.service.sync('user-1', 'p2', pushOf('abcdefghij'), 'team-1');

  // A typo is the default figure, never "no quota".
  assert.equal(resolveBlobTeamQuotaBytes('plenty'), DEFAULT_BLOB_TEAM_QUOTA_BYTES);
  assert.equal(resolveBlobTeamQuotaBytes(undefined), DEFAULT_BLOB_TEAM_QUOTA_BYTES);
  assert.equal(resolveBlobTeamQuotaBytes('0'), undefined);
  assert.equal(resolveBlobTeamQuotaBytes('1024'), 1024);
});

test('two interleaved pushes at the same baseVersion resolve to exactly one success and one 409 (atomic compare-and-set)', async () => {
  const { service, blobs } = makeService();
  const push = (marker: string): SyncProfileInput => ({
    direction: 'push',
    payload: Buffer.from(marker).toString('base64'),
    baseVersion: 0,
  });

  // Fire both pushes without awaiting between them so they interleave at every await boundary. A
  // non-atomic head()-then-put() check lets BOTH read version 0 and then write (both succeed, one
  // silently clobbering the other); the atomic compare-and-set guarantees exactly one winner.
  const results = await Promise.allSettled([
    service.sync('user-1', 'p1', push('racer-a'), 'team-1'),
    service.sync('user-1', 'p1', push('racer-b'), 'team-1'),
  ]);

  const winners = results.filter((r) => r.status === 'fulfilled');
  const conflicts = results.filter(
    (r) => r.status === 'rejected' && r.reason instanceof ConflictException,
  );
  assert.equal(winners.length, 1, 'exactly one racing push must succeed');
  assert.equal(conflicts.length, 1, 'exactly one racing push must lose with a 409 conflict');

  // The store settled at version 1 — the single winner's write, never clobbered to 2.
  const latest = await blobs.getLatest('team-1/p1');
  assert.equal(latest?.version, 1);
});

test('a direct push without baseVersion is a 400 and cannot mutate the blob store', async () => {
  const { service, blobs } = makeService();

  await assert.rejects(
    () =>
      service.sync(
        'user-1',
        'p1',
        {
          direction: 'push',
          payload: Buffer.from('must-not-write').toString('base64'),
        } as unknown as SyncProfileInput,
        'team-1',
      ),
    BadRequestException,
  );
  assert.equal(await blobs.getLatest('team-1/p1'), null);
});

test('blobRef names the bucket and key prefix the store actually writes under', async () => {
  // Only the ref DERIVATION is under test (the in-memory store still holds the bytes here). The
  // ref used to be a hardcoded `s3://lobster-profiles/…` that ignored both settings, so every ref
  // handed to a client or written to the audit log pointed at an object key that need not exist.
  const { service } = makeService({
    get: (key: string) =>
      ({ S3_BUCKET: 'lobster-blobs', S3_KEY_PREFIX: 'profiles' })[key as string],
  } as unknown as ConfigService);

  const result = await service.sync(
    'user-1',
    'p1',
    { direction: 'push', payload: Buffer.from('cipher').toString('base64'), baseVersion: 0 },
    'team-1',
  );
  assert.equal(result.blobRef, 's3://lobster-blobs/profiles/team-1/p1/1.enc');
});

test('export projects only secret-free metadata and sanitizes legacy cookie rawText', async () => {
  const storedProfile = {
    id: 'profile-1',
    ownerTeamId: 'team-1',
    name: 'Portable',
    engine: 'lobium',
    os: 'windows',
    osVersion: 'Windows 11 23H2',
    fingerprintSeed: '0123456789abcdef0123456789abcdef',
    fingerprintOverrides: { navigator: { hardwareConcurrency: 8 } },
    proxy: {
      id: 'inline-proxy',
      type: 'http',
      host: 'proxy.example.com',
      port: 8080,
      username: 'private-user',
      password: 'private-password',
    },
    proxyId: 'proxy-reference',
    templateId: 'template-reference',
    cookiesImport: {
      mode: 'replace',
      source: 'plain_text',
      rawText: 'session=private-cookie',
      parsedCount: 1,
    },
    extensions: [{ source: 'chrome_web_store', enabled: true, id: 'extension-id' }],
    tags: ['portable'],
    folder: 'Work',
    notes: 'safe note',
    status: 'idle',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  } satisfies Profile;
  const profiles = {
    findAllByTeam: async () => [storedProfile],
  } as unknown as ProfilesRepository;
  const teams = {
    getMembership: async () => ({ teamId: 'team-1', userId: 'user-1', role: 'admin' }),
  } as unknown as TeamsRepository;
  const audit = { record: async () => {} } as unknown as AuditService;
  const service = new ProfilesService(profiles, teams, new InMemoryBlobStore(), audit, config);

  const bundle = await service.exportAll('user-1', 'team-1');
  const exported = bundle.profiles[0]!;
  const exportedCookies = (
    exported as typeof exported & {
      cookiesImport?: { mode: string; source?: string; parsedCount?: number; rawText?: string };
    }
  ).cookiesImport;

  assert.equal(exported.proxyId, 'proxy-reference');
  assert.equal(exported.templateId, 'template-reference');
  assert.equal(exportedCookies?.rawText, undefined);
  assert.deepEqual(exportedCookies, {
    mode: 'replace',
    source: 'plain_text',
    parsedCount: 1,
  });
  assert.equal('proxy' in exported, false);
  assert.equal(JSON.stringify(bundle).includes('private-password'), false);
  assert.equal(JSON.stringify(bundle).includes('private-cookie'), false);
});

test('the profile list carries the account blob version, so a launcher can skip pulls', async () => {
  const repository = new InMemoryProfilesRepository();
  const blobs = new InMemoryBlobStore();
  const teams = {
    getMembership: async () => ({ teamId: 'team-1', userId: 'user-1', role: 'admin' }),
  } as unknown as TeamsRepository;
  const audit = { record: async () => {} } as unknown as AuditService;
  const service = new ProfilesService(repository, teams, blobs, audit, config);
  const synced = await service.create(
    'user-1',
    { name: 'synced', engine: 'lobium', os: 'windows' },
    'team-1',
  );
  const fresh = await service.create(
    'user-1',
    { name: 'fresh', engine: 'lobium', os: 'windows' },
    'team-1',
  );
  await blobs.put(`team-1/${synced.id}`, Buffer.from('v1'), {
    teamId: 'team-1',
    profileId: synced.id,
  });
  await blobs.put(`team-1/${synced.id}`, Buffer.from('v2'), {
    teamId: 'team-1',
    profileId: synced.id,
    expectedVersion: 1,
  });
  const listed = await service.findAll('user-1', 'team-1');
  const byId = new Map(listed.map((p) => [p.id, p.syncVersion]));
  assert.equal(byId.get(synced.id), 2, 'the latest version, not the count of writes');
  assert.equal(byId.get(fresh.id), 0, 'never synced reads as 0, not undefined');
});
