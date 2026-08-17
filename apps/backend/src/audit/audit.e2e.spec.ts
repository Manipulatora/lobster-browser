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
import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import { AuditModule } from './audit.module';
import { AuditService, encodeAuditCursor } from './audit.service';

/**
 * HTTP e2e for the audit log: boots a real Nest app (controller + JWT guard + validation pipe)
 * and drives it over HTTP with supertest. No database — DATABASE_URL is cleared so the in-memory
 * repositories are used. Entries are appended internally via `AuditService.record` (there is no
 * write endpoint), then read back over `GET /audit`. Each registered user gets a personal team
 * automatically (auth), which the audit feed is scoped to.
 */
let app: INestApplication;
let auditService: AuditService;
let teams: TeamsRepository;

interface RegisteredUser {
  token: string;
  userId: string;
  teamId: string;
}

/** Register a fresh user and return their bearer token, user id, and personal team id. */
async function register(email: string): Promise<RegisteredUser> {
  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: 'supersecret1' });
  assert.ok([200, 201].includes(res.status), `register status ${res.status}`);
  const userId = res.body.data.user.id as string;
  const [team] = await teams.findTeamsForUser(userId);
  assert.ok(team, 'a freshly-registered user should have a personal team');
  return { token: res.body.data.token as string, userId, teamId: team.id };
}

/** Small delay so successive audit writes get strictly-increasing (distinct) createdAt values. */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
      AuditModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();

  // The audit service (to append entries the way other modules will) and the teams repository
  // (to discover a registered user's personal team) are resolved from the running app.
  auditService = app.get(AuditService, { strict: false });
  teams = app.get<TeamsRepository>(TEAMS_REPOSITORY, { strict: false });
});

after(async () => {
  await app?.close();
});

test('an entry recorded via the service is returned by GET /audit, newest first', async () => {
  const user = await register('audit-basic@example.com');
  const auth = { Authorization: `Bearer ${user.token}` };

  await auditService.record({
    teamId: user.teamId,
    actorUserId: user.userId,
    action: 'profile.created',
    targetType: 'profile',
    targetId: 'profile-1',
    metadata: { name: 'Profile A' },
  });
  await delay(3); // guarantee a distinct createdAt for a deterministic newest-first order
  await auditService.record({
    teamId: user.teamId,
    actorUserId: user.userId,
    action: 'profile.deleted',
    targetType: 'profile',
    targetId: 'profile-1',
  });

  const res = await request(app.getHttpServer()).get('/audit').set(auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 0);
  assert.equal(res.body.data.length, 2);

  // Newest first: the delete (recorded second) precedes the create.
  assert.equal(res.body.data[0].action, 'profile.deleted');
  assert.equal(res.body.data[1].action, 'profile.created');

  // The recorded fields round-trip, scoped to the caller's team.
  const created = res.body.data[1];
  assert.equal(created.teamId, user.teamId);
  assert.equal(created.actorUserId, user.userId);
  assert.equal(created.targetType, 'profile');
  assert.equal(created.targetId, 'profile-1');
  assert.deepEqual(created.metadata, { name: 'Profile A' });
  assert.ok(created.id, 'each entry gets an id');
  assert.ok(created.createdAt, 'each entry gets a createdAt');
});

test("audit entries are team-scoped: one team never sees another team's history", async () => {
  const a = await register('audit-iso-a@example.com');
  const b = await register('audit-iso-b@example.com');

  await auditService.record({
    teamId: a.teamId,
    actorUserId: a.userId,
    action: 'team-a.only',
    targetType: 'thing',
  });

  const listB = await request(app.getHttpServer())
    .get('/audit')
    .set({ Authorization: `Bearer ${b.token}` });
  assert.equal(listB.status, 200);
  assert.equal(listB.body.data.length, 0, "team B must not see team A's audit entries");
});

test('GET /audit honors limit and the before cursor (newest first, cursor-paginated)', async () => {
  const user = await register('audit-page@example.com');
  const auth = { Authorization: `Bearer ${user.token}` };

  // Five entries with distinct, increasing timestamps → deterministic newest-first ordering.
  for (let i = 0; i < 5; i += 1) {
    await auditService.record({
      teamId: user.teamId,
      actorUserId: user.userId,
      action: `event.${i}`,
      targetType: 'seq',
      targetId: String(i),
    });
    await delay(3);
  }

  // `limit` caps the page size; results come back newest first.
  const firstPage = await request(app.getHttpServer()).get('/audit?limit=2').set(auth);
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.data.length, 2);
  assert.equal(firstPage.body.data[0].action, 'event.4');
  assert.equal(firstPage.body.data[1].action, 'event.3');

  // `before` is an exclusive keyset cursor: passing the last row's cursor returns strictly-older rows.
  const cursor = encodeAuditCursor(firstPage.body.data[1]);
  const secondPage = await request(app.getHttpServer())
    .get(`/audit?limit=2&before=${encodeURIComponent(cursor)}`)
    .set(auth);
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.body.data.length, 2);
  assert.equal(secondPage.body.data[0].action, 'event.2');
  assert.equal(secondPage.body.data[1].action, 'event.1');
});

test('cursor pagination is lossless across same-millisecond entries (keyset tiebreak)', async () => {
  const user = await register('audit-tie@example.com');
  const auth = { Authorization: `Bearer ${user.token}` };

  // A burst with NO delay: many entries share a createdAt millisecond. A timestamp-only cursor
  // would silently drop the boundary siblings; the (createdAt, id) keyset must return them all.
  const N = 12;
  for (let i = 0; i < N; i += 1) {
    await auditService.record({
      teamId: user.teamId,
      actorUserId: user.userId,
      action: `burst.${i}`,
      targetType: 'burst',
      targetId: String(i),
    });
  }

  // Page through the ENTIRE feed with the keyset cursor; every entry must appear exactly once.
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const url = cursor ? `/audit?limit=5&before=${encodeURIComponent(cursor)}` : '/audit?limit=5';
    const page = await request(app.getHttpServer()).get(url).set(auth);
    assert.equal(page.status, 200);
    if (page.body.data.length === 0) break;
    for (const row of page.body.data) seen.add(row.action);
    cursor = encodeAuditCursor(page.body.data[page.body.data.length - 1]);
  }
  assert.equal(
    seen.size,
    N,
    `expected all ${N} entries across pages, got ${seen.size} (same-ms drop?)`,
  );
});

test('a malformed before cursor is a 400 (not a 500 or a silent wrong page)', async () => {
  const user = await register('audit-badcursor@example.com');
  const res = await request(app.getHttpServer())
    .get('/audit?before=not-a-valid-cursor')
    .set({ Authorization: `Bearer ${user.token}` });
  assert.equal(res.status, 400);
});

test('AuditService.record is fail-safe: it never throws and returns void', async () => {
  const user = await register('audit-failsafe@example.com');
  // A well-formed record resolves to undefined (void) rather than throwing or returning a row.
  const result = await auditService.record({
    teamId: user.teamId,
    action: 'noop.event',
    targetType: 'noop',
  });
  assert.equal(result, undefined);
});

test('unauthenticated GET /audit is 401', async () => {
  const res = await request(app.getHttpServer()).get('/audit');
  assert.equal(res.status, 401);
});
