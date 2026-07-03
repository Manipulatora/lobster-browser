import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { ConflictException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

// The service calls `bcrypt.compare` through a star-import namespace whose bindings are getter-only,
// which node:test's `mock.method` cannot replace. Grab the underlying (Node-cached) CommonJS module
// object instead — the service's namespace delegates to it, so a spy here is observed by the service.
const bcryptModule = require('bcryptjs') as typeof import('bcryptjs');

import { AuthService, type JwtPayload } from './auth.service';
import { DEV_JWT_SECRET } from './jwt-secret';
import { InMemoryUsersRepository } from './in-memory-users.repository';
import { InMemoryTeamsRepository } from '../teams/in-memory-teams.repository';

/**
 * Unit tests for AuthService against the in-memory repos + a real JwtService — no Nest app
 * boot and no database. A stub ConfigService returns undefined so the service falls back to
 * DEV_JWT_SECRET, which the JwtService below is configured with, so tokens round-trip.
 */
function makeService(): {
  service: AuthService;
  jwt: JwtService;
  teams: InMemoryTeamsRepository;
} {
  const users = new InMemoryUsersRepository();
  const teams = new InMemoryTeamsRepository();
  const jwt = new JwtService({ secret: DEV_JWT_SECRET });
  const config = { get: () => undefined } as unknown as ConfigService;
  return { service: new AuthService(users, teams, jwt, config), jwt, teams };
}

test('register hashes the password, stores the user, and returns a token', async () => {
  const { service } = makeService();

  const result = await service.register({ email: 'alice@example.com', password: 'password123' });

  assert.equal(result.user.email, 'alice@example.com');
  assert.ok(result.token.length > 0, 'expected a non-empty token');
  // The public user must never carry the password hash.
  assert.equal((result.user as { passwordHash?: string }).passwordHash, undefined);
});

test('register auto-creates a personal team with the new user as admin', async () => {
  const { service, teams } = makeService();

  const result = await service.register({ email: 'owner@example.com', password: 'password123' });

  const userTeams = await teams.findTeamsForUser(result.user.id);
  assert.equal(userTeams.length, 1, 'expected exactly one auto-created personal team');
  const team = userTeams[0];
  assert.ok(team, 'expected a personal team');
  assert.equal(team.ownerUserId, result.user.id);

  const membership = await teams.getMembership(team.id, result.user.id);
  assert.equal(membership?.role, 'admin', 'the new user must be an admin of their personal team');
});

test('email is normalized: register mixed-case, then login lower-case succeeds', async () => {
  const { service } = makeService();

  const registered = await service.register({
    email: 'Alice@Example.com',
    password: 'password123',
  });
  // The canonical (trimmed + lower-cased) email is what gets stored/returned.
  assert.equal(registered.user.email, 'alice@example.com');

  // Logging in with a different case must resolve to the same account (identical across backends).
  const result = await service.login({ email: 'alice@example.com', password: 'password123' });
  assert.equal(result.user.id, registered.user.id);
});

test('register rejects a duplicate email', async () => {
  const { service } = makeService();
  await service.register({ email: 'dup@example.com', password: 'password123' });

  await assert.rejects(
    () => service.register({ email: 'dup@example.com', password: 'password123' }),
    ConflictException,
  );
});

test('login with the correct password returns a token decoding to the user id', async () => {
  const { service, jwt } = makeService();
  const registered = await service.register({ email: 'bob@example.com', password: 'password123' });

  const result = await service.login({ email: 'bob@example.com', password: 'password123' });

  const payload = jwt.verify<JwtPayload>(result.token, { secret: DEV_JWT_SECRET });
  assert.equal(payload.sub, registered.user.id);
  assert.equal(payload.email, 'bob@example.com');
});

test('login with a wrong password throws UnauthorizedException', async () => {
  const { service } = makeService();
  await service.register({ email: 'carol@example.com', password: 'password123' });

  await assert.rejects(
    () => service.login({ email: 'carol@example.com', password: 'wrong-password' }),
    UnauthorizedException,
  );
});

test('login with an unknown email throws UnauthorizedException', async () => {
  const { service } = makeService();

  await assert.rejects(
    () => service.login({ email: 'nobody@example.com', password: 'password123' }),
    UnauthorizedException,
  );
});

test('login with an unknown email still runs bcrypt.compare (no user-enumeration timing oracle)', async () => {
  const { service } = makeService();
  // Spy on the same bcryptjs module the service calls, preserving the real implementation so the
  // constant-time dummy compare still runs (and still fails to match) as in production.
  const compareSpy = mock.method(bcryptModule, 'compare');
  try {
    await assert.rejects(
      () => service.login({ email: 'ghost@example.com', password: 'password123' }),
      UnauthorizedException,
    );
    // Before the fix the missing-user branch short-circuited and skipped compare entirely (0 calls),
    // which is exactly the timing oracle; the fix must compare against a dummy hash instead.
    assert.equal(
      compareSpy.mock.callCount(),
      1,
      'a bcrypt.compare must run even when the email is unknown',
    );
  } finally {
    compareSpy.mock.restore();
  }
});
