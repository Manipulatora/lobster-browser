import assert from 'node:assert/strict';
import test from 'node:test';

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Profile } from '@lobster/shared-types';

import type { AuditRepository } from '../audit/audit.repository';
import { AuditService } from '../audit/audit.service';
import type { TeamsRepository } from '../teams/teams.repository';
import { InMemoryBlobStore } from './blob/in-memory-blob-store';
import { InMemoryProfilesRepository } from './in-memory-profiles.repository';
import type { ProfilesRepository } from './profiles.repository';
import {
  DEFAULT_FREE_PROFILE_LIMIT,
  ProfilesService,
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
function makeService(cfg: ConfigService = config): {
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
  } as unknown as ProfilesRepository;
  const audit = { record: async () => {} } as unknown as AuditService;
  return { service: new ProfilesService(profiles, teams, blobs, audit, cfg), blobs };
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
