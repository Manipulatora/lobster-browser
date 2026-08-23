import assert from 'node:assert/strict';
import test from 'node:test';

import { ForbiddenException } from '@nestjs/common';

import { TeamsService } from './teams.service';
import { InMemoryTeamsRepository } from './in-memory-teams.repository';
import { InMemoryUsersRepository } from '../auth/in-memory-users.repository';

/**
 * Unit tests for TeamsService against the in-memory repos — no Nest app boot and no database.
 * Focused on the last-admin safety guard in {@link TeamsService.setRole}.
 */
function makeService(): { service: TeamsService; teams: InMemoryTeamsRepository } {
  const teams = new InMemoryTeamsRepository();
  const users = new InMemoryUsersRepository((ownerUserId, name) =>
    teams.prepareTeamWithOwner(ownerUserId, name),
  );
  return { service: new TeamsService(teams, users), teams };
}

test('createTeam returns only after the owner admin membership is visible', async () => {
  const { service, teams } = makeService();

  const team = await service.createTeam('owner-1', 'Atomic Team');

  assert.equal((await teams.getMembership(team.id, 'owner-1'))?.role, 'admin');
});

test('setRole refuses to demote the last admin of a team', async () => {
  const { service, teams } = makeService();
  const adminId = 'admin-1';
  const team = await teams.createTeam(adminId, 'Solo Team');

  await assert.rejects(
    () => service.setRole(team.id, adminId, adminId, 'member'),
    ForbiddenException,
  );

  // The demotion was rejected, so the sole admin is still an admin.
  const membership = await teams.getMembership(team.id, adminId);
  assert.equal(membership?.role, 'admin', 'the last admin must remain an admin');
});

test('setRole CAN demote an admin when another admin remains', async () => {
  const { service, teams } = makeService();
  const adminA = 'admin-a';
  const adminB = 'admin-b';
  const team = await teams.createTeam(adminA, 'Team');
  await teams.addMember(team.id, adminB, 'admin');

  // adminA (still an admin) demotes adminB — the team keeps at least one admin, so this is allowed.
  const result = await service.setRole(team.id, adminA, adminB, 'member');
  assert.equal(result.role, 'member');

  const stillAdmin = await teams.getMembership(team.id, adminA);
  assert.equal(stillAdmin?.role, 'admin', 'the remaining admin is untouched');
});

async function twoAdminTeam(): Promise<{
  service: TeamsService;
  teams: InMemoryTeamsRepository;
  teamId: string;
  adminA: string;
  adminB: string;
}> {
  const { service, teams } = makeService();
  const adminA = 'admin-a';
  const adminB = 'admin-b';
  const team = await teams.createTeam(adminA, 'Concurrent Team');
  await teams.addMember(team.id, adminB, 'admin');
  return { service, teams, teamId: team.id, adminA, adminB };
}

function assertExactlyOneSucceeded(results: PromiseSettledResult<unknown>[]): void {
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
    'exactly one competing admin-decreasing mutation may succeed',
  );
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof ForbiddenException);
}

async function assertOneAdminRemains(
  teams: InMemoryTeamsRepository,
  teamId: string,
): Promise<void> {
  const members = await teams.listMembers(teamId);
  assert.equal(
    members.filter((member) => member.role === 'admin').length,
    1,
    'the team must retain one admin after the race',
  );
}

test('concurrent cross-demotions cannot race a two-admin team down to zero admins', async () => {
  const { service, teams, teamId, adminA, adminB } = await twoAdminTeam();

  const results = await Promise.allSettled([
    service.setRole(teamId, adminA, adminB, 'member'),
    service.setRole(teamId, adminB, adminA, 'member'),
  ]);

  assertExactlyOneSucceeded(results);
  await assertOneAdminRemains(teams, teamId);
});

test('concurrent cross-removals cannot race a two-admin team down to zero admins', async () => {
  const { service, teams, teamId, adminA, adminB } = await twoAdminTeam();

  const results = await Promise.allSettled([
    service.removeMember(teamId, adminA, adminB),
    service.removeMember(teamId, adminB, adminA),
  ]);

  assertExactlyOneSucceeded(results);
  await assertOneAdminRemains(teams, teamId);
});

test('concurrent leaves cannot race a two-admin team down to zero admins', async () => {
  const { service, teams, teamId, adminA, adminB } = await twoAdminTeam();

  const results = await Promise.allSettled([
    service.leaveTeam(teamId, adminA),
    service.leaveTeam(teamId, adminB),
  ]);

  assertExactlyOneSucceeded(results);
  await assertOneAdminRemains(teams, teamId);
});
