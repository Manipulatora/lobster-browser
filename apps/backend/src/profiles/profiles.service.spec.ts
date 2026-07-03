import assert from 'node:assert/strict';
import test from 'node:test';

import { ConflictException } from '@nestjs/common';
import type { Profile } from '@lobster/shared-types';

import type { AuditService } from '../audit/audit.service';
import type { TeamsRepository } from '../teams/teams.repository';
import { InMemoryBlobStore } from './blob/in-memory-blob-store';
import type { ProfilesRepository } from './profiles.repository';
import { ProfilesService, type SyncProfileInput } from './profiles.service';

/**
 * Unit tests for ProfilesService.sync's optimistic-concurrency behaviour, wired against the real
 * InMemoryBlobStore plus minimal stubs for the other collaborators (team + profile resolution and
 * a no-op audit). Driving it in-process lets us interleave two pushes deterministically — HTTP e2e
 * can't guarantee interleaving because Nest may serialise the two request handlers.
 */
function makeService(): { service: ProfilesService; blobs: InMemoryBlobStore } {
  const blobs = new InMemoryBlobStore();
  const teams = {
    getMembership: async () => ({ teamId: 'team-1', userId: 'user-1', role: 'admin' }),
  } as unknown as TeamsRepository;
  const profiles = {
    findById: async (teamId: string, id: string) =>
      ({ id, ownerTeamId: teamId, name: 'Racy' }) as unknown as Profile,
  } as unknown as ProfilesRepository;
  const audit = { record: async () => {} } as unknown as AuditService;
  return { service: new ProfilesService(profiles, teams, blobs, audit), blobs };
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
