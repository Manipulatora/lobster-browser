import assert from 'node:assert/strict';
import test from 'node:test';

import { ForbiddenException } from '@nestjs/common';
import type { Team } from '@lobster/shared-types';

import { InMemoryTeamsRepository } from './in-memory-teams.repository';
import { defaultTeamOf, resolveTeamId } from './resolve-team-id';

/** A cap high enough to be out of the way; the cap has its own tests. */
const UNCAPPED = 100;

/**
 * The invitation scenario from the 2026-09-02 audit, in miniature. Ivy's team is OLDER than Bob's
 * personal team, and the desktop sends no teamId on any call. The old rule — the oldest team the
 * caller belongs to — pointed every one of Bob's teamId-less calls at Ivy's team the moment he
 * accepted her invitation: his profile list, his pushes, his agent token.
 */
test('an omitted teamId resolves to the team the caller OWNS, not the oldest team they belong to', async () => {
  const teams = new InMemoryTeamsRepository();
  const ivys = await teams.createTeam('ivy', "Ivy's Team", UNCAPPED);
  const bobs = await teams.createTeam('bob', "Bob's Team", UNCAPPED);
  await teams.addMember(ivys.id, 'bob', 'member');

  assert.equal(await resolveTeamId(teams, 'bob'), bobs.id);
  // Ivy's team is still reachable exactly as before — by naming it.
  assert.equal(await resolveTeamId(teams, 'bob', ivys.id), ivys.id);
  // And Ivy's own default is untouched by having invited someone.
  assert.equal(await resolveTeamId(teams, 'ivy'), ivys.id);
});

test('an explicit teamId is honoured only with a membership', async () => {
  const teams = new InMemoryTeamsRepository();
  const ivys = await teams.createTeam('ivy', "Ivy's Team", UNCAPPED);
  await teams.createTeam('bob', "Bob's Team", UNCAPPED);

  await assert.rejects(() => resolveTeamId(teams, 'bob', ivys.id), ForbiddenException);
});

test('a caller with no team at all is refused rather than given somebody else’s', async () => {
  const teams = new InMemoryTeamsRepository();
  await teams.createTeam('ivy', "Ivy's Team", UNCAPPED);

  await assert.rejects(() => resolveTeamId(teams, 'nobody'), ForbiddenException);
});

test('among several owned teams the oldest — the personal team — is the default, whatever the input order', () => {
  const teams: Team[] = [
    {
      id: 'invited-older',
      name: 'Theirs',
      ownerUserId: 'them',
      createdAt: '2026-07-01T00:00:00.000Z',
    },
    {
      id: 'second-owned',
      name: 'Second',
      ownerUserId: 'me',
      createdAt: '2026-09-01T00:00:00.000Z',
    },
    { id: 'personal', name: 'Mine', ownerUserId: 'me', createdAt: '2026-08-01T00:00:00.000Z' },
  ];

  assert.equal(defaultTeamOf('me', teams)?.id, 'personal');
  assert.equal(defaultTeamOf('me', [...teams].reverse())?.id, 'personal');
});

test('an account that owns nothing falls back to its oldest membership instead of being locked out', () => {
  const teams: Team[] = [
    { id: 'newer', name: 'Newer', ownerUserId: 'them', createdAt: '2026-08-01T00:00:00.000Z' },
    { id: 'older', name: 'Older', ownerUserId: 'them', createdAt: '2026-07-01T00:00:00.000Z' },
  ];

  assert.equal(defaultTeamOf('me', teams)?.id, 'older');
  assert.equal(defaultTeamOf('me', []), undefined);
});
