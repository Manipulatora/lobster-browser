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

/**
 * HTTP e2e for teams: boots a real Nest app and drives it over HTTP with supertest. No database —
 * DATABASE_URL is cleared so the in-memory repositories are used. Covers team creation, invite,
 * role change, and admin-only / membership enforcement.
 */
let app: INestApplication;

async function registerToken(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: 'supersecret1' });
  assert.ok([200, 201].includes(res.status), `register status ${res.status}`);
  return res.body.data.token as string;
}

before(async () => {
  process.env.DATABASE_URL = ''; // force in-memory repos. NOT `delete`: requiring @prisma/client
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
  }).compile();

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
  const token = await registerToken('teamowner@example.com');
  const res = await request(app.getHttpServer())
    .get('/teams')
    .set({ Authorization: `Bearer ${token}` });
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 0);
  assert.equal(res.body.data.length, 1, 'a fresh user has exactly one personal team');
});

test('create team -> invite -> role change -> admin-only + membership enforcement', async () => {
  const adminToken = await registerToken('admin-flow@example.com');
  const memberToken = await registerToken('member-flow@example.com');
  const outsiderToken = await registerToken('outsider-flow@example.com');
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
    .send({ email: 'member-flow@example.com', role: 'member' });
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
    .send({ email: 'outsider-flow@example.com', role: 'member' });
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
    .send({ email: 'outsider-flow@example.com', role: 'member' });
  assert.ok([200, 201].includes(promotedInvite.status), `promoted invite ${promotedInvite.status}`);
});

test('unauthenticated create is 401', async () => {
  const res = await request(app.getHttpServer()).post('/teams').send({ name: 'nope' });
  assert.equal(res.status, 401);
});

test('BE-7: admin can remove a member; member can leave after promotion', async () => {
  const adminToken = await registerToken('admin-remove@example.com');
  const memberToken = await registerToken('member-remove@example.com');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const create = await request(app.getHttpServer())
    .post('/teams')
    .set(auth(adminToken))
    .send({ name: 'Removable Team' });
  const teamId: string = create.body.data.id;

  const invite = await request(app.getHttpServer())
    .post(`/teams/${teamId}/members`)
    .set(auth(adminToken))
    .send({ email: 'member-remove@example.com', role: 'member' });
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
    .send({ email: 'member-remove@example.com', role: 'member' });
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
