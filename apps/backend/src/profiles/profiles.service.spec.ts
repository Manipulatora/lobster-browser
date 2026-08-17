import assert from 'node:assert/strict';
import test from 'node:test';

import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Profile } from '@lobster/shared-types';

import type { AuditService } from '../audit/audit.service';
import type { TeamsRepository } from '../teams/teams.repository';
import { InMemoryBlobStore } from './blob/in-memory-blob-store';
import type { ProfilesRepository } from './profiles.repository';
import { ProfilesService, type SyncProfileInput } from './profiles.service';

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
    { direction: 'push', payload: Buffer.from('cipher').toString('base64') },
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
