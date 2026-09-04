import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { AuthModule } from '../auth/auth.module';
import { TeamsModule } from './teams.module';
import { DEFAULT_TEAMS_PER_ACCOUNT_LIMIT } from './teams.service';
import { createMailCapture, signUpOverHttp, type MailCapture } from '../testing/e2e-auth';
import { MailService } from '../mail/mail.service';

/**
 * HTTP e2e for teams: boots a real Nest app and drives it over HTTP with supertest. No database —
 * DATABASE_URL is cleared so the in-memory repositories are used. Covers team creation, invite,
 * role change, and admin-only / membership enforcement.
 */
let app: INestApplication;
/** Reads back the verification code, which sign-up now requires. See testing/e2e-auth.ts. */
let mailCapture: MailCapture;

async function registerToken(email: string): Promise<string> {
  // Sign-up is two steps now: register emails a code and creates nothing; verify creates the
  // account and returns the session. See testing/e2e-auth.ts.
  return (await signUpOverHttp(app, mailCapture, email)).token;
}

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
      TeamsModule,
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

test('register auto-creates a personal team visible via GET /teams', async () => {
  const token = await registerToken('teamowner@gmail.com');
  const res = await request(app.getHttpServer())
    .get('/teams')
    .set({ Authorization: `Bearer ${token}` });
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 0);
  assert.equal(res.body.data.length, 1, 'a fresh user has exactly one personal team');
});

test('create team -> invite -> role change -> admin-only + membership enforcement', async () => {
  const adminToken = await registerToken('admin-flow@gmail.com');
  const memberToken = await registerToken('member-flow@gmail.com');
  const outsiderToken = await registerToken('outsider-flow@gmail.com');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  // admin creates a shared team (they become its admin)
  const create = await request(app.getHttpServer())
    .post('/teams')
    .set(auth(adminToken))
    .send({ name: 'Shared Team' });
  assert.ok([200, 201].includes(create.status), `create status ${create.status}`);
  assert.equal(create.body.code, 0);
  const teamId: string = create.body.data.id;

  // admin invites the member (as a plain member)
  const invite = await request(app.getHttpServer())
    .post(`/teams/${teamId}/members`)
    .set(auth(adminToken))
    .send({ email: 'member-flow@gmail.com', role: 'member' });
  assert.ok([200, 201].includes(invite.status), `invite status ${invite.status}`);
  assert.equal(invite.body.data.role, 'member');

  // members list now has both, and a member may read it
  const members = await request(app.getHttpServer())
    .get(`/teams/${teamId}/members`)
    .set(auth(memberToken));
  assert.equal(members.status, 200);
  assert.equal(members.body.data.length, 2);

  // an outsider cannot read the members list -> 403
  const outsiderList = await request(app.getHttpServer())
    .get(`/teams/${teamId}/members`)
    .set(auth(outsiderToken));
  assert.equal(outsiderList.status, 403);

  // a plain member cannot invite -> 403 (admin-only)
  const memberInvite = await request(app.getHttpServer())
    .post(`/teams/${teamId}/members`)
    .set(auth(memberToken))
    .send({ email: 'outsider-flow@gmail.com', role: 'member' });
  assert.equal(memberInvite.status, 403);

  // admin promotes the member to admin
  const memberId: string = invite.body.data.userId;
  const promote = await request(app.getHttpServer())
    .patch(`/teams/${teamId}/members/${memberId}/role`)
    .set(auth(adminToken))
    .send({ role: 'admin' });
  assert.equal(promote.status, 200);
  assert.equal(promote.body.data.role, 'admin');

  // now the promoted member CAN invite
  const promotedInvite = await request(app.getHttpServer())
    .post(`/teams/${teamId}/members`)
    .set(auth(memberToken))
    .send({ email: 'outsider-flow@gmail.com', role: 'member' });
  assert.ok([200, 201].includes(promotedInvite.status), `promoted invite ${promotedInvite.status}`);
});

test('unauthenticated create is 401', async () => {
  const res = await request(app.getHttpServer()).post('/teams').send({ name: 'nope' });
  assert.equal(res.status, 401);
});

test('an account may own at most the configured number of teams, its personal team included', async () => {
  const token = await registerToken('team-cap@gmail.com');
  const inviterToken = await registerToken('team-cap-inviter@gmail.com');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  // The personal team is one; the rest of the cap is available over the API…
  for (let i = 1; i < DEFAULT_TEAMS_PER_ACCOUNT_LIMIT; i += 1) {
    const res = await request(app.getHttpServer())
      .post('/teams')
      .set(auth(token))
      .send({ name: `Owned ${i}` });
    assert.ok([200, 201].includes(res.status), `create ${i} status ${res.status}`);
  }
  // …and the one past it is refused. Before the cap this loop ran for as long as curl did.
  const overflow = await request(app.getHttpServer())
    .post('/teams')
    .set(auth(token))
    .send({ name: 'One too many' });
  assert.equal(overflow.status, 403);

  // An invitation is not something the invitee created, so it neither counts nor is refused.
  const theirs = await request(app.getHttpServer())
    .post('/teams')
    .set(auth(inviterToken))
    .send({ name: 'Theirs' });
  const invite = await request(app.getHttpServer())
    .post(`/teams/${theirs.body.data.id}/members`)
    .set(auth(inviterToken))
    .send({ email: 'team-cap@gmail.com', role: 'member' });
  assert.ok([200, 201].includes(invite.status), `invite status ${invite.status}`);

  const list = await request(app.getHttpServer()).get('/teams').set(auth(token));
  assert.equal(list.body.data.length, DEFAULT_TEAMS_PER_ACCOUNT_LIMIT + 1);
});

test('BE-7: admin can remove a member; member can leave after promotion', async () => {
  const adminToken = await registerToken('admin-remove@gmail.com');
  const memberToken = await registerToken('member-remove@gmail.com');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const create = await request(app.getHttpServer())
    .post('/teams')
    .set(auth(adminToken))
    .send({ name: 'Removable Team' });
  const teamId: string = create.body.data.id;

  const invite = await request(app.getHttpServer())
    .post(`/teams/${teamId}/members`)
    .set(auth(adminToken))
    .send({ email: 'member-remove@gmail.com', role: 'member' });
  assert.ok([200, 201].includes(invite.status));
  const memberId: string = invite.body.data.userId;

  const remove = await request(app.getHttpServer())
    .delete(`/teams/${teamId}/members/${memberId}`)
    .set(auth(adminToken));
  assert.equal(remove.status, 200);
  assert.equal(remove.body.data.removed, true);

  // Re-invite, promote to admin, then leave as that admin (another admin remains).
  const invite2 = await request(app.getHttpServer())
    .post(`/teams/${teamId}/members`)
    .set(auth(adminToken))
    .send({ email: 'member-remove@gmail.com', role: 'member' });
  const memberId2: string = invite2.body.data.userId;
  await request(app.getHttpServer())
    .patch(`/teams/${teamId}/members/${memberId2}/role`)
    .set(auth(adminToken))
    .send({ role: 'admin' });

  const leave = await request(app.getHttpServer())
    .post(`/teams/${teamId}/leave`)
    .set(auth(memberToken));
  assert.ok([200, 201].includes(leave.status), `leave status ${leave.status}`);
  assert.equal(leave.body.data.left, true);
});
