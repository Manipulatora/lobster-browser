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
  const users = new InMemoryUsersRepository();
  return { service: new TeamsService(teams, users), teams };
}

test('setRole refuses to demote the last admin of a team', async () => {
  const { service, teams } = makeService();
  const adminId = 'admin-1';
  const team = await teams.createTeam(adminId, 'Solo Team');
  await teams.addMember(team.id, adminId, 'admin');

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
  await teams.addMember(team.id, adminA, 'admin');
  await teams.addMember(team.id, adminB, 'admin');

  // adminA (still an admin) demotes adminB — the team keeps at least one admin, so this is allowed.
  const result = await service.setRole(team.id, adminA, adminB, 'member');
  assert.equal(result.role, 'member');

  const stillAdmin = await teams.getMembership(team.id, adminA);
  assert.equal(stillAdmin?.role, 'admin', 'the remaining admin is untouched');
});
