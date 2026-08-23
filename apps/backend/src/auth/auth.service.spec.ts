import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
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
import { LOGIN_ATTEMPTS_BEFORE_BACKOFF, LOGIN_BACKOFF_MAX_MS } from './users.repository';
import { InMemoryTeamsRepository } from '../teams/in-memory-teams.repository';

/**
 * Addresses must be at an accepted provider now, so the fixtures are @gmail.com rather than
 * @example.com. That is not incidental tidying: with @example.com every one of these tests would
 * fail at the provider check before reaching what it means to assert.
 */
const EMAIL = 'alice@gmail.com';
const PASSWORD = 'password123';
const NAME = 'Alice Example';

/** Captures the code that was mailed, which is the only place a test can legitimately read it. */
interface MailSpy extends MailService {
  lastCode(): string;
  codes: string[];
}

function stubMail(): MailSpy {
  const codes: string[] = [];
  return {
    codes,
    lastCode: () => codes[codes.length - 1] ?? '',
    isConfigured: () => true,
    send: async () => true,
    sendVerification: async (_to: string, code: string) => {
      codes.push(code);
      return true;
    },
    sendDepositReceipt: async () => true,
  } as unknown as MailSpy;
}

function makeService(options: { failFirstTeamCommit?: boolean } = {}): {
  service: AuthService;
  jwt: JwtService;
  teams: InMemoryTeamsRepository;
  users: InMemoryUsersRepository;
  mail: MailSpy;
  preparedOwnerIds: string[];
} {
  const teams = new InMemoryTeamsRepository();
  const preparedOwnerIds: string[] = [];
  let failTeamCommit = options.failFirstTeamCommit ?? false;
  const users = new InMemoryUsersRepository((ownerUserId, name) => {
    preparedOwnerIds.push(ownerUserId);
    const plan = teams.prepareTeamWithOwner(ownerUserId, name);
    return {
      commit: () => {
        plan.commit();
        if (failTeamCommit) {
          failTeamCommit = false;
          throw new Error('injected personal-team write failure');
        }
      },
      rollback: () => plan.rollback(),
    };
  });
  const jwt = new JwtService({ secret: DEV_JWT_SECRET });
  const config = { get: () => undefined } as unknown as ConfigService;
  const mail = stubMail();
  return {
    service: new AuthService(users, jwt, config, mail),
    jwt,
    teams,
    users,
    mail,
    preparedOwnerIds,
  };
}

/** Register + verify, the whole happy path, for tests that need an existing account. */
async function signUp(
  s: ReturnType<typeof makeService>,
  email = EMAIL,
  password = PASSWORD,
): Promise<{ id: string; token: string }> {
  await s.service.register({ email, password, fullName: NAME });
  const result = await s.service.completeRegistration(email, s.mail.lastCode());
  return { id: result.user.id, token: result.token };
}

// --- No account until the code -----------------------------------------------

test('register creates NO user and NO team, and returns no token', async () => {
  // The invariant the whole pending-registration design exists for. Registration used to create
  // the account, the team and a session up front; abandoning the form then left all three behind.
  const { service, users, teams } = makeService();

  const result = await service.register({ email: EMAIL, password: PASSWORD, fullName: NAME });

  assert.equal(result.pending, true);
  assert.equal(result.email, EMAIL);
  assert.equal((result as { token?: string }).token, undefined, 'no session may be issued here');
  assert.equal(await users.findByEmail(EMAIL), null, 'no account may exist yet');
  assert.equal((await teams.findTeamsForUser('any')).length, 0, 'no team may exist yet');
});

test('an abandoned sign-up leaves nothing behind', async () => {
  const { service, users } = makeService();
  await service.register({ email: EMAIL, password: PASSWORD, fullName: NAME });

  // The user closes the dialog and never returns.
  assert.equal(await users.findByEmail(EMAIL), null);
  // ...and the address is still free for its real owner.
  await service.register({ email: EMAIL, password: 'another-password', fullName: 'Someone Else' });
  assert.equal(await users.findByEmail(EMAIL), null);
});

test('the emailed code creates the account, the personal team, and a session', async () => {
  const { service, users, teams, mail } = makeService();
  await service.register({
    email: EMAIL,
    password: PASSWORD,
    fullName: NAME,
    company: 'Example Ltd',
  });

  assert.match(mail.lastCode(), /^\d{6}$/, 'the emailed secret is six digits');

  const result = await service.completeRegistration(EMAIL, mail.lastCode());

  assert.equal(result.user.email, EMAIL);
  assert.equal(result.user.displayName, NAME);
  assert.equal(result.user.company, 'Example Ltd');
  assert.ok(result.token.length > 0, 'expected a non-empty token');
  // The public user must never carry the password hash.
  assert.equal((result.user as { passwordHash?: string }).passwordHash, undefined);

  const stored = await users.findByEmail(EMAIL);
  assert.ok(stored?.emailVerifiedAt, 'the account is verified the instant it exists');

  const userTeams = await teams.findTeamsForUser(result.user.id);
  assert.equal(userTeams.length, 1, 'expected exactly one auto-created personal team');
  assert.equal(userTeams[0]?.ownerUserId, result.user.id);
  assert.equal(userTeams[0]?.name, `${NAME}'s Team`);
  const membership = await teams.getMembership(userTeams[0]!.id, result.user.id);
  assert.equal(membership?.role, 'admin');
});

test('a personal-team failure rolls back the user and preserves the pending code for retry', async () => {
  const s = makeService({ failFirstTeamCommit: true });
  await s.service.register({ email: EMAIL, password: PASSWORD, fullName: NAME });
  const code = s.mail.lastCode();

  await assert.rejects(
    () => s.service.completeRegistration(EMAIL, code),
    /injected personal-team write failure/,
  );

  assert.equal(await s.users.findByEmail(EMAIL), null, 'the user write must roll back');
  assert.ok(
    await s.users.findPendingRegistration(EMAIL),
    'a failed graph write must not consume the valid code',
  );
  assert.equal(
    (await s.teams.findTeamsForUser(s.preparedOwnerIds[0]!)).length,
    0,
    'the staged team and membership must roll back too',
  );

  const retried = await s.service.completeRegistration(EMAIL, code);
  assert.equal(retried.user.email, EMAIL);
  assert.equal((await s.teams.findTeamsForUser(retried.user.id)).length, 1);
});

test('the password set at registration is the one that works at login', async () => {
  // The hash is computed at register and carried through the pending row; a bug there would only
  // surface as "correct password rejected" after sign-up.
  const s = makeService();
  await signUp(s);

  const result = await s.service.login({ email: EMAIL, password: PASSWORD });
  assert.equal(result.user.email, EMAIL);
});

// --- Code handling -------------------------------------------------------------

test('a wrong code is refused and still creates nothing', async () => {
  const { service, users } = makeService();
  await service.register({ email: EMAIL, password: PASSWORD, fullName: NAME });

  await assert.rejects(
    () => service.completeRegistration(EMAIL, '000000'),
    /incorrect or has expired/,
  );
  assert.equal(await users.findByEmail(EMAIL), null, 'a failed code must not create an account');
});

test('a code is single-use', async () => {
  const { service, mail } = makeService();
  await service.register({ email: EMAIL, password: PASSWORD, fullName: NAME });
  const code = mail.lastCode();

  await service.completeRegistration(EMAIL, code);
  // Replaying it must not produce a second account or a second session.
  await assert.rejects(() => service.completeRegistration(EMAIL, code), /incorrect or has expired/);
});

test('concurrent submissions of one code create exactly one complete account graph', async () => {
  const s = makeService();
  await s.service.register({ email: EMAIL, password: PASSWORD, fullName: NAME });
  const code = s.mail.lastCode();

  const results = await Promise.allSettled([
    s.service.completeRegistration(EMAIL, code),
    s.service.completeRegistration(EMAIL, code),
  ]);
  const successes = results.filter(
    (
      result,
    ): result is PromiseFulfilledResult<Awaited<ReturnType<AuthService['completeRegistration']>>> =>
      result.status === 'fulfilled',
  );

  assert.equal(successes.length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const user = successes[0]!.value.user;
  assert.equal((await s.teams.findTeamsForUser(user.id)).length, 1);
  assert.equal(
    (await s.teams.listMembers((await s.teams.findTeamsForUser(user.id))[0]!.id)).length,
    1,
  );
});

test('the code dies after too many wrong guesses', async () => {
  // Without this cap a 1-in-a-million secret is grindable inside its own lifetime, against an
  // endpoint that must be public because there is no session yet to authenticate.
  const { service, mail } = makeService();
  await service.register({ email: EMAIL, password: PASSWORD, fullName: NAME });
  const code = mail.lastCode();

  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      () => service.completeRegistration(EMAIL, 'zzzzzz'),
      /incorrect or has expired/,
    );
  }
  // The real code is now worthless too — the attempts were spent against it.
  await assert.rejects(() => service.completeRegistration(EMAIL, code), /incorrect or has expired/);
});

test('re-sending supersedes the previous code and restores the attempt budget', async () => {
  const { service, mail } = makeService();
  await service.register({ email: EMAIL, password: PASSWORD, fullName: NAME });
  const first = mail.lastCode();

  await service.resendRegistrationCode(EMAIL);
  const second = mail.lastCode();
  assert.notEqual(first, second, 'a re-send must issue a new code');

  // The old one is dead...
  await assert.rejects(
    () => service.completeRegistration(EMAIL, first),
    /incorrect or has expired/,
  );
  // ...and the new one works. (Reaching here also proves the failed attempt above did not consume
  // the new code's budget — the cap belongs to the code, not to the address.)
  const result = await service.completeRegistration(EMAIL, second);
  assert.equal(result.user.email, EMAIL);
});

test('re-sending for an address with no sign-up in flight is a silent no-op', async () => {
  // It must not reveal whether an address is mid-registration.
  const { service, mail } = makeService();
  await service.resendRegistrationCode('nobody@gmail.com');
  assert.equal(mail.codes.length, 0);
});

// --- Provider restriction ------------------------------------------------------

test('sign-up is refused for providers outside Gmail and Outlook', async () => {
  const { service, users } = makeService();

  for (const email of ['someone@example.com', 'someone@yahoo.com', 'me@my-company.co.uk']) {
    await assert.rejects(
      () => service.register({ email, password: PASSWORD, fullName: NAME }),
      BadRequestException,
      `expected ${email} to be refused`,
    );
    assert.equal(await users.findByEmail(email), null);
  }
});

test('both Google and Microsoft aliases are accepted', async () => {
  // An "Outlook account" is just as often a hotmail or live address; rejecting those would read as
  // a bug to the person holding one.
  for (const email of [
    'a@gmail.com',
    'b@googlemail.com',
    'c@outlook.com',
    'd@hotmail.com',
    'e@live.com',
    'f@msn.com',
  ]) {
    const s = makeService();
    const result = await s.service.register({ email, password: PASSWORD, fullName: NAME });
    assert.equal(result.pending, true, `expected ${email} to be accepted`);
  }
});

// --- Existing-account rules ----------------------------------------------------

test('register rejects an address that already has an account', async () => {
  const s = makeService();
  await signUp(s);

  await assert.rejects(
    () => s.service.register({ email: EMAIL, password: PASSWORD, fullName: NAME }),
    ConflictException,
  );
});

test('email is normalized: register mixed-case, then login lower-case succeeds', async () => {
  const s = makeService();
  await s.service.register({ email: 'Alice@Gmail.com', password: PASSWORD, fullName: NAME });
  const registered = await s.service.completeRegistration('Alice@Gmail.com', s.mail.lastCode());

  // The canonical (trimmed + lower-cased) email is what gets stored/returned.
  assert.equal(registered.user.email, EMAIL);

  // Logging in with a different case must resolve to the same account.
  const result = await s.service.login({ email: EMAIL, password: PASSWORD });
  assert.equal(result.user.id, registered.user.id);
});

// --- Login ----------------------------------------------------------------------

test('login with the correct password returns a token decoding to the user id', async () => {
  const s = makeService();
  const registered = await signUp(s);

  const result = await s.service.login({ email: EMAIL, password: PASSWORD });

  const payload = s.jwt.verify<JwtPayload>(result.token, { secret: DEV_JWT_SECRET });
  assert.equal(payload.sub, registered.id);
  assert.equal(payload.email, EMAIL);
});

test('login with a wrong password throws UnauthorizedException', async () => {
  const s = makeService();
  await signUp(s);

  await assert.rejects(
    () => s.service.login({ email: EMAIL, password: 'wrong-password' }),
    UnauthorizedException,
  );
});

test('a run of wrong passwords backs the account off, and the right one clears it', async () => {
  const s = makeService();
  const registered = await signUp(s);

  for (let i = 0; i < LOGIN_ATTEMPTS_BEFORE_BACKOFF; i += 1) {
    await assert.rejects(() => s.service.login({ email: EMAIL, password: 'wrong' }));
  }
  // Still free at the threshold: someone who mistypes a handful of times is not a spray.
  assert.equal((await s.users.findById(registered.id))?.lockedUntil, undefined);

  await assert.rejects(() => s.service.login({ email: EMAIL, password: 'wrong' }));
  const lockedUntil = (await s.users.findById(registered.id))?.lockedUntil;
  assert.ok(lockedUntil && new Date(lockedUntil) > new Date(), 'the account is now backing off');

  // The CORRECT password is refused too while the window is open — otherwise the delay bounds
  // nothing, because a guesser only ever needs the attempt that happens to be right.
  await assert.rejects(
    () => s.service.login({ email: EMAIL, password: PASSWORD }),
    UnauthorizedException,
  );

  // Same generic sentence as a wrong password: "too many attempts" would say which addresses have
  // accounts.
  await assert.rejects(
    () => s.service.login({ email: EMAIL, password: 'wrong' }),
    (err: unknown) =>
      err instanceof UnauthorizedException &&
      JSON.stringify(err.getResponse()).includes('invalid email or password'),
  );

  // Once the window passes, the real password works again and the streak is forgotten.
  await s.users.registerFailedLogin(registered.id, new Date(Date.now() - LOGIN_BACKOFF_MAX_MS));
  const cleared = await s.service.login({ email: EMAIL, password: PASSWORD });
  assert.equal(cleared.user.id, registered.id);
  const after = await s.users.findById(registered.id);
  assert.equal(after?.failedLoginAttempts, 0);
  assert.equal(after?.lockedUntil, undefined);
});

test('login with an unknown email throws UnauthorizedException', async () => {
  const { service } = makeService();

  await assert.rejects(
    () => service.login({ email: 'nobody@gmail.com', password: PASSWORD }),
    UnauthorizedException,
  );
});

test('a pending sign-up cannot be logged into', async () => {
  // There is no account yet, so this must fail exactly like an unknown address — including not
  // revealing that a sign-up is in flight for it.
  const { service } = makeService();
  await service.register({ email: EMAIL, password: PASSWORD, fullName: NAME });

  await assert.rejects(
    () => service.login({ email: EMAIL, password: PASSWORD }),
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
      () => service.login({ email: 'ghost@gmail.com', password: PASSWORD }),
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

// --- Desktop token lifetime ------------------------------------------------------

test('a desktop token outlives a web token', async () => {
  // Re-authenticating the launcher costs a whole browser round-trip, so its token is deliberately
  // long-lived. If these ever match, the launcher has quietly gone back to weekly re-login.
  const s = makeService();
  const { id } = await signUp(s);

  const web = s.jwt.decode(s.service.issueTokenFor(id, EMAIL)) as { exp: number };
  const desktop = s.jwt.decode(s.service.issueTokenFor(id, EMAIL, 'desktop')) as { exp: number };

  assert.ok(desktop.exp > web.exp, 'the desktop token must expire later than the web token');
  const days = (desktop.exp - Math.floor(Date.now() / 1000)) / 86400;
  assert.ok(days > 300, `expected a long-lived desktop token, got ~${Math.round(days)} days`);
});
