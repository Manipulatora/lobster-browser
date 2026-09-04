import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { after, before } from 'node:test';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { AuthModule } from './auth.module';
import { createMailCapture, signUpOverHttp, type MailCapture } from '../testing/e2e-auth';
import { MailService } from '../mail/mail.service';

/**
 * HTTP e2e for auth: boots a real Nest app (controllers + guard + validation pipe) and drives it
 * over HTTP with supertest. No database — DATABASE_URL is cleared so the in-memory repo is used.
 */
let app: INestApplication;
/** Reads back the verification code, which sign-up now requires. See testing/e2e-auth.ts. */
let mailCapture: MailCapture;

before(async () => {
  process.env.DATABASE_URL = '';
  // Same leak, same fix: requiring @prisma/client auto-loads .env, which in a real
  // deployment sets BLOB_STORE_PATH — and the blob store would then be the PRODUCTION
  // directory, so running the suite wrote real files into it. Emptied, not deleted, for
  // the reason above.
  process.env.BLOB_STORE_PATH = '';
  process.env.S3_BUCKET = '';
  // ...and the mailer, for the same reason. Registering a user sends a verification email,
  // so with the real SMTP settings leaking in from .env every test run posted real mail to
  // fake addresses from the production mailbox — enough of it to trip the provider's rate
  // limit. Unconfigured, MailService logs instead of sending.
  process.env.SMTP_HOST = ''; // force in-memory repos. NOT `delete`: requiring @prisma/client
  // auto-loads .env and re-injects DATABASE_URL, so a deleted var comes back and the suite
  // silently runs against whatever database .env points at. dotenv never overwrites a var that
  // is already set, so an empty string (falsy) survives and PrismaService picks in-memory.
  process.env.NODE_ENV = 'test'; // allow the dev JWT secret outside production

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      MailModule,
      PrismaModule,
      AuthModule,
    ],
  })
    .overrideProvider(MailService)
    .useValue((mailCapture = createMailCapture()))
    .compile();

  app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
});

after(async () => {
  await app?.close();
});

test('register -> verify -> login -> /auth/me happy path (with {code,data,msg} envelope)', async () => {
  const email = 'e2e@gmail.com';
  const password = 'supersecret1';

  // STEP 1 — register. Creates nothing and issues no session; it only emails a code.
  const reg = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password, fullName: 'E2E User', company: 'Example Ltd' });
  assert.ok([200, 201].includes(reg.status), `register status ${reg.status}`);
  assert.equal(reg.body.code, 0);
  assert.equal(reg.body.data.pending, true, 'register acknowledges a pending sign-up');
  assert.equal(reg.body.data.token, undefined, 'register must NOT return a session');

  // The account does not exist yet, so signing in must fail exactly like an unknown address.
  const early = await request(app.getHttpServer()).post('/auth/login').send({ email, password });
  assert.equal(early.status, 401, 'a pending sign-up must not be loggable-into');

  // STEP 2 — verify. This is what creates the account and returns the session.
  const verify = await request(app.getHttpServer())
    .post('/auth/verify-email')
    .send({ email, code: mailCapture.lastCode() });
  assert.ok([200, 201].includes(verify.status), `verify status ${verify.status}`);
  assert.equal(verify.body.code, 0);
  assert.ok(verify.body.data.token, 'verify returns a token');
  assert.equal(verify.body.data.user.email, email);
  assert.equal(verify.body.data.user.displayName, 'E2E User');
  assert.equal(verify.body.data.user.company, 'Example Ltd');
  assert.equal(verify.body.data.user.passwordHash, undefined, 'password hash must never leak');

  const login = await request(app.getHttpServer()).post('/auth/login').send({ email, password });
  assert.ok([200, 201].includes(login.status), `login status ${login.status}`);
  assert.equal(login.body.code, 0);
  const token: string = login.body.data.token;
  assert.ok(token);

  const me = await request(app.getHttpServer())
    .get('/auth/me')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.code, 0);
  assert.equal(me.body.data.email, email);
});

test('a sign-up abandoned before the code creates no account', async () => {
  const email = 'e2e-abandoned@gmail.com';
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: 'supersecret1', fullName: 'Ghost' });

  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: 'supersecret1' });
  assert.equal(login.status, 401, 'no account may exist for an unverified sign-up');
});

test('sign-up is refused for providers outside Gmail and Outlook', async () => {
  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email: 'someone@yahoo.com', password: 'supersecret1', fullName: 'Nope' });
  assert.equal(res.status, 400);
});

test('register requires a full name', async () => {
  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email: 'e2e-noname@gmail.com', password: 'supersecret1' });
  assert.equal(res.status, 400);
});

test('/auth/me without a token is 401', async () => {
  const res = await request(app.getHttpServer()).get('/auth/me');
  assert.equal(res.status, 401);
});

test('login with the wrong password is 401', async () => {
  const email = 'e2e-wrong@gmail.com';
  // A REAL account is needed here, so this goes through both steps. Registering alone would leave
  // nothing to log into, and the test would pass for the wrong reason.
  await signUpOverHttp(app, mailCapture, email, 'correct-horse1');

  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: 'totallywrong9' });
  assert.equal(res.status, 401);
});

// --- A pending sign-up belongs to whoever started it ------------------------------

test("a second registration for an address mid-sign-up cannot replace the first one's credentials", async () => {
  const email = 'e2e-contested@gmail.com';
  const ownerPassword = 'owner-password1';
  const impostorPassword = 'impostor-password1';

  const first = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: ownerPassword, fullName: 'Rightful Owner' });
  assert.ok([200, 201].includes(first.status), `register status ${first.status}`);
  const ownerCode = mailCapture.lastCode();

  // Inside the window, someone else registers the same address with their own password.
  const noticesBefore = mailCapture.alreadyPendingNotices.length;
  const second = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: impostorPassword, fullName: 'Impostor' });
  // The same acknowledgement as a fresh sign-up: a refusal would say which addresses are
  // mid-registration.
  assert.ok([200, 201].includes(second.status), `register status ${second.status}`);
  assert.equal(second.body.data.pending, true);
  // No new code — the row, and the password in it, are the first registrant's — and the mailbox
  // owner is told a sign-up is already in progress.
  assert.equal(mailCapture.lastCode(), ownerCode, 'no second code may be mailed');
  assert.equal(mailCapture.alreadyPendingNotices.length, noticesBefore + 1);
  assert.equal(mailCapture.alreadyPendingNotices.at(-1), email);

  // The owner enters the only code they were sent and gets an account with THEIR password.
  const verify = await request(app.getHttpServer())
    .post('/auth/verify-email')
    .send({ email, code: ownerCode });
  assert.ok([200, 201].includes(verify.status), `verify status ${verify.status}`);
  assert.equal(verify.body.data.user.displayName, 'Rightful Owner');

  const impostor = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: impostorPassword });
  assert.equal(impostor.status, 401, 'the second registrant must not be able to sign in');
  const owner = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: ownerPassword });
  assert.equal(owner.status, 200);
});

test('re-registering with the same password is a re-send: a fresh code, the old one dead', async () => {
  const email = 'e2e-retry@gmail.com';
  const password = 'same-password1';
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password, fullName: 'First Try' });
  const first = mailCapture.lastCode();

  // A closed tab, a mail that never came: the same person submits the form again, name corrected.
  const again = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password, fullName: 'Second Try' });
  assert.ok([200, 201].includes(again.status), `register status ${again.status}`);
  const second = mailCapture.lastCode();
  assert.notEqual(second, first, 'a retry with the pending password gets a new code');

  const stale = await request(app.getHttpServer())
    .post('/auth/verify-email')
    .send({ email, code: first });
  assert.equal(stale.status, 400, 'the superseded code must be dead');
  const verify = await request(app.getHttpServer())
    .post('/auth/verify-email')
    .send({ email, code: second });
  assert.ok([200, 201].includes(verify.status), `verify status ${verify.status}`);
  assert.equal(verify.body.data.user.displayName, 'Second Try', "the retry's details are kept");
});

// --- Sessions and revocation ----------------------------------------------------

/** GET /auth/me with a token: the one call that says whether a session is alive. */
async function whoami(token: string): Promise<number> {
  const me = await request(app.getHttpServer())
    .get('/auth/me')
    .set('Authorization', `Bearer ${token}`);
  return me.status;
}

/**
 * The loopback handoff end to end, returning the launcher's token — so a revocation can be proven
 * against the year-long desktop token and not only the week-long web one.
 */
async function desktopSignIn(webToken: string): Promise<string> {
  const state = 'state-for-one-launcher-instance';
  const codeVerifier = 'v'.repeat(43);
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const grant = await request(app.getHttpServer())
    .post('/auth/desktop/grant')
    .set('Authorization', `Bearer ${webToken}`)
    .send({ state, codeChallenge, port: 43125 });
  assert.equal(grant.status, 200, `grant status ${grant.status}: ${JSON.stringify(grant.body)}`);
  const code = new URL(grant.body.data.redirectUrl).searchParams.get('code');
  assert.ok(code, 'the redirect carries the one-time code');

  const exchange = await request(app.getHttpServer())
    .post('/auth/desktop/exchange')
    .send({ code, state, codeVerifier });
  assert.equal(
    exchange.status,
    200,
    `exchange status ${exchange.status}: ${JSON.stringify(exchange.body)}`,
  );
  return exchange.body.data.token as string;
}

test('logout-all invalidates every token issued before it, web and desktop alike', async () => {
  const email = 'e2e-logout-all@gmail.com';
  const password = 'supersecret1';
  const { token: first } = await signUpOverHttp(app, mailCapture, email, password);
  const login = await request(app.getHttpServer()).post('/auth/login').send({ email, password });
  const second: string = login.body.data.token;
  const desktop = await desktopSignIn(first);

  for (const token of [first, second, desktop]) {
    assert.equal(await whoami(token), 200, 'every session works before the revocation');
  }

  const logout = await request(app.getHttpServer())
    .post('/auth/logout-all')
    .set('Authorization', `Bearer ${first}`);
  assert.equal(
    logout.status,
    200,
    `logout status ${logout.status}: ${JSON.stringify(logout.body)}`,
  );
  assert.equal(logout.body.data.revoked, true);

  for (const token of [first, second, desktop]) {
    assert.equal(await whoami(token), 401, 'no token minted before the revocation may still work');
  }

  // Signing in again is what re-establishes a session.
  const again = await request(app.getHttpServer()).post('/auth/login').send({ email, password });
  assert.equal(again.status, 200);
  assert.equal(await whoami(again.body.data.token), 200);
});

test('changing the password ends the old sessions and retires the old password', async () => {
  const email = 'e2e-change-password@gmail.com';
  const oldPassword = 'old-password1';
  const newPassword = 'new-password1';
  const { token: old } = await signUpOverHttp(app, mailCapture, email, oldPassword);

  // A wrong current password changes nothing — and is a 400, not a 401, because the web client
  // treats a 401 as "signed out" and a typo here must not end the session.
  const typo = await request(app.getHttpServer())
    .post('/auth/password')
    .set('Authorization', `Bearer ${old}`)
    .send({ currentPassword: 'not-it-at-all', newPassword });
  assert.equal(typo.status, 400);
  assert.equal(await whoami(old), 200, 'a failed attempt must leave the session alone');

  const change = await request(app.getHttpServer())
    .post('/auth/password')
    .set('Authorization', `Bearer ${old}`)
    .send({ currentPassword: oldPassword, newPassword });
  assert.equal(
    change.status,
    200,
    `change status ${change.status}: ${JSON.stringify(change.body)}`,
  );
  const fresh: string = change.body.data.token;
  assert.ok(fresh && fresh !== old, 'the response carries a replacement token');

  assert.equal(await whoami(old), 401, 'the token from before the change is dead');
  assert.equal(await whoami(fresh), 200, 'the replacement token keeps this screen signed in');

  const stale = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: oldPassword });
  assert.equal(stale.status, 401, 'the old password is retired');
  const current = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: newPassword });
  assert.equal(current.status, 200);
});

test('a forgotten password is reset with the mailed code, and every session dies with it', async () => {
  const email = 'e2e-reset@gmail.com';
  const forgotten = 'forgotten-password1';
  const chosen = 'reset-password1';
  const { token: old } = await signUpOverHttp(app, mailCapture, email, forgotten);
  const codesBefore = mailCapture.codes.length;

  // An address with no account gets the same answer and no mail: this endpoint must not say
  // which addresses have accounts.
  const unknown = await request(app.getHttpServer())
    .post('/auth/password/forgot')
    .send({ email: 'e2e-nobody@gmail.com' });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.data.sent, true);
  assert.equal(mailCapture.codes.length, codesBefore, 'no code is mailed for an unknown address');

  const forgot = await request(app.getHttpServer()).post('/auth/password/forgot').send({ email });
  assert.equal(forgot.status, 200);
  assert.equal(forgot.body.data.sent, true);
  assert.equal(mailCapture.codes.length, codesBefore + 1, 'a real account gets exactly one code');
  const code = mailCapture.lastCode();

  const wrong = await request(app.getHttpServer())
    .post('/auth/password/reset')
    .send({ email, code: code === '000000' ? '000001' : '000000', newPassword: chosen });
  assert.equal(wrong.status, 400);
  const untouched = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: forgotten });
  assert.equal(untouched.status, 200, 'a wrong code must change nothing');

  const reset = await request(app.getHttpServer())
    .post('/auth/password/reset')
    .send({ email, code, newPassword: chosen });
  assert.equal(reset.status, 200, `reset status ${reset.status}: ${JSON.stringify(reset.body)}`);
  assert.ok(reset.body.data.token, 'a reset signs the person in, as a proven sign-up does');
  assert.equal(await whoami(reset.body.data.token), 200);

  assert.equal(await whoami(old), 401, 'whoever held the old password has lost their sessions');
  const retired = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: forgotten });
  assert.equal(retired.status, 401);
  const works = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: chosen });
  assert.equal(works.status, 200);

  const replay = await request(app.getHttpServer())
    .post('/auth/password/reset')
    .send({ email, code, newPassword: 'another-password1' });
  assert.equal(replay.status, 400, 'a reset code is single-use');
});
