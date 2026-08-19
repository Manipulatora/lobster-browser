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
import { LeasesModule } from './leases.module';
import { LEASES_REPOSITORY, type LeasesRepository } from './leases.repository';
import { createMailCapture, signUpOverHttp, type MailCapture } from '../testing/e2e-auth';
import { MailService } from '../mail/mail.service';

/**
 * The lease, end to end. Every test here is about a REFUSAL: one profile is one browser identity, and
 * two machines running it means the same account arriving from two IPs.
 */
let app: INestApplication;
/** Reads back the verification code, which sign-up now requires. See testing/e2e-auth.ts. */
let mailCapture: MailCapture;
let repo: LeasesRepository;

async function register(email: string): Promise<string> {
  // Sign-up is two steps now: register emails a code and creates nothing; verify creates the
  // account and returns the session. See testing/e2e-auth.ts.
  return (await signUpOverHttp(app, mailCapture, email)).token;
}

/**
 * A session plus one profile of its own.
 *
 * The lease routes are scoped to a profile the caller can actually see, so these tests need a REAL
 * profile id rather than an invented string — an invented one is now (correctly) a 404.
 */
async function userWithProfile(email: string): Promise<{ token: string; profileId: string }> {
  const token = await register(email);
  const created = await request(app.getHttpServer())
    .post('/profiles')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Leased profile', engine: 'lobium', os: 'windows' });
  assert.ok([200, 201].includes(created.status), `profile create status ${created.status}`);
  return { token, profileId: created.body.data.id };
}

before(async () => {
  process.env.DATABASE_URL = ''; // force in-memory repos — see the note in audit.e2e.spec.ts
  process.env.BLOB_STORE_PATH = '';
  process.env.S3_BUCKET = '';
  process.env.SMTP_HOST = ''; // never send real mail from a test run
  process.env.NODE_ENV = 'test';

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      MailModule,
      PrismaModule,
      AuthModule,
      LeasesModule,
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
  repo = app.get<LeasesRepository>(LEASES_REPOSITORY, { strict: false });
});

after(async () => {
  await app?.close();
});

test('a free profile reads as free, and claiming it names the holder', async () => {
  const { token, profileId } = await userWithProfile('lease-free@gmail.com');

  const before = await request(app.getHttpServer())
    .get(`/profiles/${profileId}/lease`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(before.body.data, null, 'a profile nobody holds is free');

  const claimed = await request(app.getHttpServer())
    .post(`/profiles/${profileId}/lease`)
    .set('Authorization', `Bearer ${token}`)
    .send({ deviceId: 'dev-1', deviceLabel: "Ivy's laptop" });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.data.deviceLabel, "Ivy's laptop");
  assert.ok(claimed.body.data.leaseId, 'a claim id is issued');

  const after = await request(app.getHttpServer())
    .get(`/profiles/${profileId}/lease`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(after.body.data.deviceId, 'dev-1');
});

test('a second machine is refused and told where the profile is open', async () => {
  const { token, profileId } = await userWithProfile('lease-second@gmail.com');
  await request(app.getHttpServer())
    .post(`/profiles/${profileId}/lease`)
    .set('Authorization', `Bearer ${token}`)
    .send({ deviceId: 'dev-a', deviceLabel: 'Desktop' })
    .expect(200);

  const second = await request(app.getHttpServer())
    .post(`/profiles/${profileId}/lease`)
    .set('Authorization', `Bearer ${token}`)
    .send({ deviceId: 'dev-b', deviceLabel: 'Laptop' });
  assert.equal(second.status, 409);
  const message = second.body.msg ?? second.body.message;
  // The message has to name the machine and the remedy — "409" tells a user nothing, and the
  // intuitive reaction (retry) is exactly wrong.
  assert.match(message, /open on Desktop/);
  assert.match(message, /Close it there first/);
  assert.match(message, /frees itself in about \d+s/);
});

test('two machines racing for the same profile: exactly one wins', async () => {
  const { token, profileId } = await userWithProfile('lease-race@gmail.com');

  const [a, b] = await Promise.all([
    request(app.getHttpServer())
      .post(`/profiles/${profileId}/lease`)
      .set('Authorization', `Bearer ${token}`)
      .send({ deviceId: 'dev-a', deviceLabel: 'A' }),
    request(app.getHttpServer())
      .post(`/profiles/${profileId}/lease`)
      .set('Authorization', `Bearer ${token}`)
      .send({ deviceId: 'dev-b', deviceLabel: 'B' }),
  ]);

  const won = [a, b].filter((r) => r.status === 200);
  const lost = [a, b].filter((r) => r.status === 409);
  assert.equal(won.length, 1, 'exactly one machine may hold a profile');
  assert.equal(lost.length, 1, 'the other must be refused, never queued');
});

test('a crashed machine frees its profile without an operator', async () => {
  // The lease expires; nobody releases it, because the machine holding it is gone. This is where
  // Octo requires a manual force-stop and we do not.
  const now = new Date();
  const dead = await repo.acquire(
    {
      profileId: 'prf-crashed',
      userId: 'u1',
      deviceId: 'dev-dead',
      deviceLabel: 'Crashed box',
      leaseId: 'lease-dead',
      expiresAt: new Date(now.getTime() + 1000),
    },
    now,
  );
  assert.ok(dead.ok);

  const later = new Date(now.getTime() + 60_000);
  assert.equal(await repo.current('prf-crashed', later), null, 'an expired claim reads as free');

  const takeover = await repo.acquire(
    {
      profileId: 'prf-crashed',
      userId: 'u2',
      deviceId: 'dev-live',
      deviceLabel: 'Working box',
      leaseId: 'lease-live',
      expiresAt: new Date(later.getTime() + 150_000),
    },
    later,
  );
  assert.ok(takeover.ok, 'a lapsed lease can be taken over');
  assert.equal(takeover.ok && takeover.lease.deviceLabel, 'Working box');
});

test('a taken-over machine cannot extend or release the claim it lost', async () => {
  const now = new Date();
  await repo.acquire(
    {
      profileId: 'prf-stale',
      userId: 'u1',
      deviceId: 'dev-old',
      deviceLabel: 'Old',
      leaseId: 'lease-old',
      expiresAt: new Date(now.getTime() + 1000),
    },
    now,
  );
  const later = new Date(now.getTime() + 60_000);
  await repo.acquire(
    {
      profileId: 'prf-stale',
      userId: 'u2',
      deviceId: 'dev-new',
      deviceLabel: 'New',
      leaseId: 'lease-new',
      expiresAt: new Date(later.getTime() + 150_000),
    },
    later,
  );

  // The old machine wakes up. It must NOT be able to extend a claim it no longer holds, or two
  // machines would believe they own the identity.
  assert.equal(
    await repo.refresh('prf-stale', 'lease-old', new Date(later.getTime() + 150_000), later),
    false,
  );
  // ...nor release the new holder's claim.
  assert.equal(await repo.release('prf-stale', 'lease-old'), false);
  const held = await repo.current('prf-stale', later);
  assert.equal(held?.deviceLabel, 'New', "the new holder's claim is untouched");
});

test('releasing frees the profile for the next machine', async () => {
  const { token, profileId } = await userWithProfile('lease-release@gmail.com');
  const claimed = await request(app.getHttpServer())
    .post(`/profiles/${profileId}/lease`)
    .set('Authorization', `Bearer ${token}`)
    .send({ deviceId: 'dev-a', deviceLabel: 'A' })
    .expect(200);

  await request(app.getHttpServer())
    .delete(`/profiles/${profileId}/lease`)
    .set('Authorization', `Bearer ${token}`)
    .send({ leaseId: claimed.body.data.leaseId })
    .expect(200);

  await request(app.getHttpServer())
    .post(`/profiles/${profileId}/lease`)
    .set('Authorization', `Bearer ${token}`)
    .send({ deviceId: 'dev-b', deviceLabel: 'B' })
    .expect(200);
});

test("another team's profile is invisible, not merely unwritable", async () => {
  const owner = await userWithProfile('lease-owner@gmail.com');
  const stranger = await register('lease-stranger@gmail.com');
  const strangerAuth = { Authorization: `Bearer ${stranger}` };

  await request(app.getHttpServer())
    .post(`/profiles/${owner.profileId}/lease`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ deviceId: 'dev-owner', deviceLabel: "Owner's laptop" })
    .expect(200);

  // Reading it would disclose which user and device is running that identity right now, and
  // claiming it would take the profile away from its owner for as long as the thief refreshes.
  // A 404 rather than a 403, so the id cannot be probed for existence either.
  const read = await request(app.getHttpServer())
    .get(`/profiles/${owner.profileId}/lease`)
    .set(strangerAuth);
  assert.equal(read.status, 404);
  assert.ok(!JSON.stringify(read.body).includes('dev-owner'), 'no holder is disclosed');

  const steal = await request(app.getHttpServer())
    .post(`/profiles/${owner.profileId}/lease`)
    .set(strangerAuth)
    .send({ deviceId: 'dev-thief', deviceLabel: 'Thief' });
  assert.equal(steal.status, 404);

  const held = await request(app.getHttpServer())
    .get(`/profiles/${owner.profileId}/lease`)
    .set('Authorization', `Bearer ${owner.token}`);
  assert.equal(held.body.data.deviceId, 'dev-owner', "the owner's claim is untouched");
});

test('a profile that does not exist has no lease to read or take', async () => {
  const token = await register('lease-missing@gmail.com');
  const auth = { Authorization: `Bearer ${token}` };

  await request(app.getHttpServer()).get('/profiles/no-such-profile/lease').set(auth).expect(404);
  await request(app.getHttpServer())
    .post('/profiles/no-such-profile/lease')
    .set(auth)
    .send({ deviceId: 'dev-a' })
    .expect(404);
});

test('every lease route requires a token', async () => {
  for (const [method, path] of [
    ['get', '/profiles/x/lease'],
    ['post', '/profiles/x/lease'],
    ['post', '/profiles/x/lease/refresh'],
    ['delete', '/profiles/x/lease'],
  ] as const) {
    const res = await request(app.getHttpServer())[method](path).send({});
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} must require auth`);
  }
});
