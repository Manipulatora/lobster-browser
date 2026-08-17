import 'reflect-metadata';
import assert from 'node:assert/strict';
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
