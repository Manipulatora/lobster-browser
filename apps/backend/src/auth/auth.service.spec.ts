import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { ConflictException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

// The service calls `bcrypt.compare` through a star-import namespace whose bindings are getter-only,
// which node:test's `mock.method` cannot replace. Grab the underlying (Node-cached) CommonJS module
// object instead — the service's namespace delegates to it, so a spy here is observed by the service.
const bcryptModule = require('bcryptjs') as typeof import('bcryptjs');

import type { MailService } from '../mail/mail.service';
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
  users: InMemoryUsersRepository;
} {
  const users = new InMemoryUsersRepository();
  const teams = new InMemoryTeamsRepository();
  const jwt = new JwtService({ secret: DEV_JWT_SECRET });
  const config = { get: () => undefined } as unknown as ConfigService;
  return { service: new AuthService(users, teams, jwt, config, stubMail()), jwt, teams, users };
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


/** Mail is best-effort in production; in tests it must never be a dependency of the assertions. */
function stubMail(): MailService {
  return {
    isConfigured: () => false,
    send: async () => false,
    sendVerification: async () => false,
    sendDepositReceipt: async () => false,
  } as unknown as MailService;
}

test('registration issues a single-use 6-digit code that verifies exactly once', async () => {
  const { service, users } = makeService();
  await service.register({ email: 'v@example.com', password: 'Str0ng-Passw0rd!' } as never);
  const stored = await users.findByEmail('v@example.com');
  assert.ok(stored, 'user exists');
  assert.equal(stored.emailVerifiedAt, undefined, 'a new account starts unverified');

  const code = await service.issueVerification(stored.id, stored.email);
  assert.match(code, /^\d{6}$/, 'the emailed secret is six digits');

  const verified = await service.verifyEmail(stored.id, code);
  assert.ok(verified.emailVerifiedAt, 'verification stamps the instant');

  // Replay must fail: the code is single-use.
  await assert.rejects(() => service.verifyEmail(stored.id, code), /incorrect or has expired/);
});

test('a wrong code is refused and cannot be distinguished from a used one', async () => {
  const { service, users } = makeService();
  await service.register({ email: 'w@example.com', password: 'Str0ng-Passw0rd!' } as never);
  const user = await users.findByEmail('w@example.com');
  assert.ok(user);
  await assert.rejects(() => service.verifyEmail(user.id, '000000'), /incorrect or has expired/);
});

test('a code issued to one user cannot verify another', async () => {
  // Six digits collide across accounts, so this is the case a global lookup by hash would get
  // wrong: Bob's code must not verify Alice, no matter that the digits match a live row.
  const { service, users } = makeService();
  await service.register({ email: 'alice@example.com', password: 'Str0ng-Passw0rd!' } as never);
  await service.register({ email: 'bob@example.com', password: 'Str0ng-Passw0rd!' } as never);
  const alice = await users.findByEmail('alice@example.com');
  const bob = await users.findByEmail('bob@example.com');
  assert.ok(alice && bob);

  const bobsCode = await service.issueVerification(bob.id, bob.email);
  await assert.rejects(() => service.verifyEmail(alice.id, bobsCode), /incorrect or has expired/);

  const stillUnverified = await users.findById(alice.id);
  assert.equal(stillUnverified?.emailVerifiedAt, undefined, 'Alice is still unproven');
});

test('the code dies after too many wrong guesses', async () => {
  // Without this cap a 1-in-a-million secret is grindable inside its own lifetime.
  const { service, users } = makeService();
  await service.register({ email: 'brute@example.com', password: 'Str0ng-Passw0rd!' } as never);
  const user = await users.findByEmail('brute@example.com');
  assert.ok(user);
  const code = await service.issueVerification(user.id, user.email);

  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => service.verifyEmail(user.id, 'zzzzzz'), /incorrect or has expired/);
  }
  // The real code is now worthless too — the attempts were spent against it.
  await assert.rejects(() => service.verifyEmail(user.id, code), /incorrect or has expired/);
});

test('re-sending supersedes the previous code', async () => {
  const { service, users } = makeService();
  await service.register({ email: 'again@example.com', password: 'Str0ng-Passw0rd!' } as never);
  const user = await users.findByEmail('again@example.com');
  assert.ok(user);

  const first = await service.issueVerification(user.id, user.email);
  const second = await service.issueVerification(user.id, user.email);
  assert.notEqual(first, second, 'a fresh code is minted');

  await assert.rejects(() => service.verifyEmail(user.id, first), /incorrect or has expired/);
  const verified = await service.verifyEmail(user.id, second);
  assert.ok(verified.emailVerifiedAt);
});

test('resend never reveals whether an address exists', async () => {
  const { service } = makeService();
  // Neither call may throw or behave observably differently.
  await service.resendVerification('nobody@example.com');
  await service.register({ email: 'real@example.com', password: 'Str0ng-Passw0rd!' } as never);
  await service.resendVerification('real@example.com');
});
