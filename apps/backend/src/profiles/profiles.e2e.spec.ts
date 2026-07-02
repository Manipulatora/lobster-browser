import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ProfilesModule } from './profiles.module';
import { DEFAULT_FREE_PROFILE_LIMIT } from './profiles.service';

/**
 * HTTP e2e for profiles: boots a real Nest app (controllers + JWT guard + validation pipe) and
 * drives it over HTTP with supertest. No database — DATABASE_URL is cleared so the in-memory
 * repositories are used. Each registered user gets a personal team automatically (auth), which
 * profiles are scoped to.
 */
let app: INestApplication;

/** Register a fresh user and return their bearer token. */
async function registerToken(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: 'supersecret1' });
  assert.ok([200, 201].includes(res.status), `register status ${res.status}`);
  return res.body.data.token as string;
}

before(async () => {
  delete process.env.DATABASE_URL; // force the in-memory repositories
  process.env.NODE_ENV = 'test'; // allow the dev JWT secret outside production

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PrismaModule,
      AuthModule,
      ProfilesModule,
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

test('create -> list -> get -> update -> delete, all team-scoped with a unique seed', async () => {
  const token = await registerToken('profiles-crud@example.com');
  const auth = { Authorization: `Bearer ${token}` };

  // create (no seed provided → server generates a unique, non-constant one)
  const create = await request(app.getHttpServer())
    .post('/profiles')
    .set(auth)
    .send({ name: 'Profile A', engine: 'chromium', os: 'windows' });
  assert.ok([200, 201].includes(create.status), `create status ${create.status}`);
  assert.equal(create.body.code, 0);
  const profile = create.body.data;
  assert.equal(profile.name, 'Profile A');
  assert.ok(profile.ownerTeamId, 'profile must be scoped to a team');
  assert.match(profile.fingerprintSeed, /^[0-9a-f]{32}$/, 'seed must be a fresh 128-bit hex value');

  // a second profile must get a DIFFERENT seed (never a constant)
  const create2 = await request(app.getHttpServer())
    .post('/profiles')
    .set(auth)
    .send({ name: 'Profile B', engine: 'chromium', os: 'macos' });
  assert.equal(create2.body.code, 0);
  assert.notEqual(
    create2.body.data.fingerprintSeed,
    profile.fingerprintSeed,
    'each profile gets its own seed',
  );

  // list returns both, scoped to the caller's team
  const list = await request(app.getHttpServer()).get('/profiles').set(auth);
  assert.equal(list.status, 200);
  assert.equal(list.body.code, 0);
  assert.equal(list.body.data.length, 2);
  const ids: string[] = list.body.data.map((p: { id: string }) => p.id);
  assert.ok(ids.includes(profile.id));

  // get by id
  const getOne = await request(app.getHttpServer()).get(`/profiles/${profile.id}`).set(auth);
  assert.equal(getOne.status, 200);
  assert.equal(getOne.body.data.id, profile.id);

  // update
  const update = await request(app.getHttpServer())
    .patch(`/profiles/${profile.id}`)
    .set(auth)
    .send({ name: 'Profile A (renamed)', tags: ['ecom'] });
  assert.equal(update.status, 200);
  assert.equal(update.body.data.name, 'Profile A (renamed)');
  assert.deepEqual(update.body.data.tags, ['ecom']);

  // delete, then get -> 404
  const del = await request(app.getHttpServer()).delete(`/profiles/${profile.id}`).set(auth);
  assert.equal(del.status, 200);
  assert.equal(del.body.data.deleted, true);

  const missing = await request(app.getHttpServer()).get(`/profiles/${profile.id}`).set(auth);
  assert.equal(missing.status, 404);
});

test("profiles are isolated per team: one user never sees another user's profiles", async () => {
  const tokenA = await registerToken('isolation-a@example.com');
  const tokenB = await registerToken('isolation-b@example.com');

  await request(app.getHttpServer())
    .post('/profiles')
    .set({ Authorization: `Bearer ${tokenA}` })
    .send({ name: 'A-only', engine: 'chromium', os: 'linux' });

  const listB = await request(app.getHttpServer())
    .get('/profiles')
    .set({ Authorization: `Bearer ${tokenB}` });
  assert.equal(listB.status, 200);
  assert.equal(listB.body.data.length, 0, "user B must not see user A's profiles");
});

test('create accepts the lobium engine (no longer a contract-drift 400)', async () => {
  const token = await registerToken('profiles-lobium@example.com');
  const res = await request(app.getHttpServer())
    .post('/profiles')
    .set({ Authorization: `Bearer ${token}` })
    .send({ name: 'Lobium Profile', engine: 'lobium', os: 'linux' });
  assert.ok([200, 201].includes(res.status), `create status ${res.status}`);
  assert.equal(res.body.code, 0);
  assert.equal(res.body.data.engine, 'lobium');
});

test('update can edit engine, os, and fingerprintOverrides and they persist', async () => {
  const token = await registerToken('profiles-update@example.com');
  const auth = { Authorization: `Bearer ${token}` };

  const create = await request(app.getHttpServer())
    .post('/profiles')
    .set(auth)
    .send({ name: 'Editable', engine: 'chromium', os: 'windows' });
  assert.equal(create.body.code, 0);
  const id: string = create.body.data.id;
  const originalSeed: string = create.body.data.fingerprintSeed;

  const overrides = { navigator: { hardwareConcurrency: 12 }, fonts: ['Arial', 'Helvetica'] };
  const update = await request(app.getHttpServer())
    .patch(`/profiles/${id}`)
    .set(auth)
    .send({ engine: 'lobium', os: 'macos', fingerprintOverrides: overrides });
  assert.equal(update.status, 200);
  assert.equal(update.body.data.engine, 'lobium');
  assert.equal(update.body.data.os, 'macos');
  assert.deepEqual(update.body.data.fingerprintOverrides, overrides);
  // Identity is immutable via update: the seed is untouched.
  assert.equal(update.body.data.fingerprintSeed, originalSeed);

  // Re-read to prove the edits were persisted, not just echoed back.
  const getOne = await request(app.getHttpServer()).get(`/profiles/${id}`).set(auth);
  assert.equal(getOne.status, 200);
  assert.equal(getOne.body.data.engine, 'lobium');
  assert.equal(getOne.body.data.os, 'macos');
  assert.deepEqual(getOne.body.data.fingerprintOverrides, overrides);

  // fingerprintSeed is not a whitelisted update field, so attempting to change it is a 400.
  const seedChange = await request(app.getHttpServer())
    .patch(`/profiles/${id}`)
    .set(auth)
    .send({ fingerprintSeed: 'deadbeefdeadbeefdeadbeefdeadbeef' });
  assert.equal(seedChange.status, 400);
});

/** Create a profile and return its id. */
async function createProfile(auth: { Authorization: string }, name: string): Promise<string> {
  const create = await request(app.getHttpServer())
    .post('/profiles')
    .set(auth)
    .send({ name, engine: 'chromium', os: 'windows' });
  assert.ok([200, 201].includes(create.status), `create status ${create.status}`);
  return create.body.data.id as string;
}

/** Base64 of an opaque "ciphertext" — the server treats the bytes as opaque, so any base64 works. */
function encryptedBlob(text: string): string {
  return Buffer.from(text).toString('base64');
}

test('sync rejects an invalid direction with 400', async () => {
  const token = await registerToken('profiles-sync@example.com');
  const auth = { Authorization: `Bearer ${token}` };
  const id = await createProfile(auth, 'Syncable');

  const bad = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ direction: 'sideways' });
  assert.equal(bad.status, 400);

  // A non-base64 payload is rejected at the boundary too.
  const badPayload = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ direction: 'push', payload: 'not base64!!!' });
  assert.equal(badPayload.status, 400);
});

test('push then pull round-trips the exact encrypted payload (server stores opaque bytes)', async () => {
  const token = await registerToken('profiles-roundtrip@example.com');
  const auth = { Authorization: `Bearer ${token}` };
  const id = await createProfile(auth, 'Roundtrip');

  const payload = encryptedBlob('cipher-v1-🔒-опаковый-blob');

  // Omitting direction falls back to the 'push' default.
  const push = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ payload });
  assert.ok([200, 201].includes(push.status), `push status ${push.status}`);
  assert.equal(push.body.code, 0);
  assert.equal(push.body.data.direction, 'push');
  assert.equal(push.body.data.version, 1);
  // The blobRef is an S3-style, team-scoped key ending in <version>.enc (never a plaintext leak).
  assert.match(push.body.data.blobRef, /^s3:\/\/lobster-profiles\/.+\/.+\/1\.enc$/);
  // A push does not echo the payload back.
  assert.ok(push.body.data.payload === undefined || push.body.data.payload === null);

  const pull = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ direction: 'pull' });
  assert.ok([200, 201].includes(pull.status), `pull status ${pull.status}`);
  assert.equal(pull.body.data.direction, 'pull');
  assert.equal(pull.body.data.version, 1);
  // The pulled payload is byte-for-byte what was pushed.
  assert.equal(pull.body.data.payload, payload);
  assert.equal(
    Buffer.from(pull.body.data.payload, 'base64').toString(),
    'cipher-v1-🔒-опаковый-blob',
  );
});

test('version increments across pushes and pull returns the latest', async () => {
  const token = await registerToken('profiles-versioning@example.com');
  const auth = { Authorization: `Bearer ${token}` };
  const id = await createProfile(auth, 'Versioned');

  const first = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ direction: 'push', payload: encryptedBlob('v1') });
  assert.equal(first.body.data.version, 1);

  const second = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ direction: 'push', payload: encryptedBlob('v2') });
  assert.equal(second.body.data.version, 2);
  assert.match(second.body.data.blobRef, /\/2\.enc$/);

  const pull = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ direction: 'pull' });
  assert.equal(pull.body.data.version, 2);
  assert.equal(Buffer.from(pull.body.data.payload, 'base64').toString(), 'v2');
});

test('a push with a stale baseVersion is rejected with 409 Conflict', async () => {
  const token = await registerToken('profiles-conflict@example.com');
  const auth = { Authorization: `Bearer ${token}` };
  const id = await createProfile(auth, 'Conflicting');

  // First push from a fresh profile: baseVersion 0 matches the stored version (0).
  const push = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ direction: 'push', payload: encryptedBlob('base'), baseVersion: 0 });
  assert.equal(push.body.data.version, 1);

  // A second push claiming baseVersion 0 is stale (stored version is now 1) → 409.
  const stale = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ direction: 'push', payload: encryptedBlob('racy'), baseVersion: 0 });
  assert.equal(stale.status, 409);

  // The store was not mutated by the rejected write: it is still version 1.
  const pull = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ direction: 'pull' });
  assert.equal(pull.body.data.version, 1);
  assert.equal(Buffer.from(pull.body.data.payload, 'base64').toString(), 'base');

  // Supplying the correct baseVersion (1) lets the client win the retry.
  const retry = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ direction: 'push', payload: encryptedBlob('racy'), baseVersion: 1 });
  assert.equal(retry.body.data.version, 2);
});

test('pull on a never-synced profile returns version 0 and a null payload', async () => {
  const token = await registerToken('profiles-empty-pull@example.com');
  const auth = { Authorization: `Bearer ${token}` };
  const id = await createProfile(auth, 'Never synced');

  const pull = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ direction: 'pull' });
  assert.ok([200, 201].includes(pull.status), `pull status ${pull.status}`);
  assert.equal(pull.body.data.version, 0);
  assert.equal(pull.body.data.payload, null);
  assert.equal(pull.body.data.blobRef, null);
});

test('unauthenticated sync is 401', async () => {
  const res = await request(app.getHttpServer())
    .post('/profiles/some-id/sync')
    .send({ direction: 'pull' });
  assert.equal(res.status, 401);
});

test('free-tier profile limit matches the schema default (5) and is enforced', async () => {
  // Cross-checks the ProfilesService default against prisma/schema.prisma's Subscription default.
  assert.equal(DEFAULT_FREE_PROFILE_LIMIT, 5);

  const token = await registerToken('profiles-limit@example.com');
  const auth = { Authorization: `Bearer ${token}` };

  for (let i = 0; i < DEFAULT_FREE_PROFILE_LIMIT; i += 1) {
    const res = await request(app.getHttpServer())
      .post('/profiles')
      .set(auth)
      .send({ name: `Limit ${i}`, engine: 'chromium', os: 'windows' });
    assert.ok([200, 201].includes(res.status), `create ${i} status ${res.status}`);
  }

  const overflow = await request(app.getHttpServer())
    .post('/profiles')
    .set(auth)
    .send({ name: 'one too many', engine: 'chromium', os: 'windows' });
  assert.equal(overflow.status, 403);
});

test('unauthenticated create is 401', async () => {
  const res = await request(app.getHttpServer())
    .post('/profiles')
    .send({ name: 'nope', engine: 'chromium', os: 'windows' });
  assert.equal(res.status, 401);
});
