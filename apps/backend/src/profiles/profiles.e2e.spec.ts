import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import {
  decryptProfileBlob,
  encryptProfileBlob,
  generateProfileContentKey,
  isLBv1Envelope,
} from '@lobster/crypto';
import { ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { configureBodyLimit } from '../body-limit';
import { ProfilesModule } from './profiles.module';
import { DEFAULT_FREE_PROFILE_LIMIT } from './profiles.service';

/**
 * HTTP e2e for profiles: boots a real Nest app (controllers + JWT guard + validation pipe) and
 * drives it over HTTP with supertest. No database — DATABASE_URL is cleared so the in-memory
 * repositories are used. Each registered user gets a personal team automatically (auth), which
 * profiles are scoped to.
 */
let app: NestExpressApplication;

/** Register a fresh user and return their bearer token. */
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
      PrismaModule,
      AuthModule,
      ProfilesModule,
    ],
  }).compile();

  // Mirror the production bootstrap (main.ts): disable the built-in ~100kb body parser and apply
  // the raised limit, so large encrypted profile blobs on sync are exercised as they run in prod.
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureBodyLimit(app);
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
    .send({ name: 'Profile A', engine: 'lobium', os: 'windows' });
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
    .send({ name: 'Profile B', engine: 'lobium', os: 'macos' });
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
    .send({ name: 'A-only', engine: 'lobium', os: 'linux' });

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

test('update persists all editable non-secret desktop metadata', async () => {
  const token = await registerToken('profiles-update@example.com');
  const auth = { Authorization: `Bearer ${token}` };

  const create = await request(app.getHttpServer())
    .post('/profiles')
    .set(auth)
    .send({ name: 'Editable', engine: 'lobium', os: 'windows' });
  assert.equal(create.body.code, 0);
  const id: string = create.body.data.id;
  const originalSeed: string = create.body.data.fingerprintSeed;

  const overrides = { navigator: { hardwareConcurrency: 12 }, fonts: ['Arial', 'Helvetica'] };
  const extensions = [
    {
      source: 'chrome_web_store',
      enabled: true,
      id: 'abcdefghijklmnop',
      name: 'Example',
      url: 'https://chromewebstore.google.com/detail/example/abcdefghijklmnop',
    },
  ];
  const cookiesImport = {
    mode: 'merge',
    source: 'file',
    fileName: 'cookies.txt',
    parsedCount: 3,
    errors: [{ line: 2, message: 'invalid cookie domain' }],
  };
  const update = await request(app.getHttpServer())
    .patch(`/profiles/${id}`)
    .set(auth)
    .send({
      engine: 'lobium',
      os: 'macos',
      osVersion: 'macOS 14.6',
      fingerprintOverrides: overrides,
      proxyId: 'proxy-2',
      templateId: 'template-2',
      cookiesImport,
      extensions,
      tags: ['updated'],
      folder: 'Work',
      notes: 'safe notes',
    });
  assert.equal(update.status, 200);
  assert.equal(update.body.data.engine, 'lobium');
  assert.equal(update.body.data.os, 'macos');
  assert.equal(update.body.data.osVersion, 'macOS 14.6');
  assert.deepEqual(update.body.data.fingerprintOverrides, overrides);
  assert.equal(update.body.data.proxyId, 'proxy-2');
  assert.equal(update.body.data.templateId, 'template-2');
  assert.deepEqual(update.body.data.cookiesImport, cookiesImport);
  assert.deepEqual(update.body.data.extensions, extensions);
  assert.deepEqual(update.body.data.tags, ['updated']);
  assert.equal(update.body.data.folder, 'Work');
  assert.equal(update.body.data.notes, 'safe notes');
  // Identity is immutable via update: the seed is untouched.
  assert.equal(update.body.data.fingerprintSeed, originalSeed);

  // Re-read to prove the edits were persisted, not just echoed back.
  const getOne = await request(app.getHttpServer()).get(`/profiles/${id}`).set(auth);
  assert.equal(getOne.status, 200);
  assert.equal(getOne.body.data.engine, 'lobium');
  assert.equal(getOne.body.data.os, 'macos');
  assert.equal(getOne.body.data.osVersion, 'macOS 14.6');
  assert.deepEqual(getOne.body.data.fingerprintOverrides, overrides);
  assert.equal(getOne.body.data.proxyId, 'proxy-2');
  assert.equal(getOne.body.data.templateId, 'template-2');
  assert.deepEqual(getOne.body.data.cookiesImport, cookiesImport);
  assert.deepEqual(getOne.body.data.extensions, extensions);

  // fingerprintSeed is not a whitelisted update field, so attempting to change it is a 400.
  const seedChange = await request(app.getHttpServer())
    .patch(`/profiles/${id}`)
    .set(auth)
    .send({ fingerprintSeed: 'deadbeefdeadbeefdeadbeefdeadbeef' });
  assert.equal(seedChange.status, 400);
});

test('profile DTOs reject inline proxies, raw cookie text, and malformed extensions', async () => {
  const token = await registerToken('profiles-secret-validation@example.com');
  const auth = { Authorization: `Bearer ${token}` };

  const inlineProxy = await request(app.getHttpServer())
    .post('/profiles')
    .set(auth)
    .send({
      name: 'Unsafe proxy',
      engine: 'lobium',
      os: 'windows',
      proxy: {
        id: 'inline',
        type: 'http',
        host: 'proxy.example.com',
        port: 8080,
        username: 'user',
        password: 'secret',
      },
    });
  assert.equal(inlineProxy.status, 400);

  const rawCookies = await request(app.getHttpServer())
    .post('/profiles')
    .set(auth)
    .send({
      name: 'Unsafe cookies',
      engine: 'lobium',
      os: 'windows',
      cookiesImport: { mode: 'replace', source: 'plain_text', rawText: 'session=secret' },
    });
  assert.equal(rawCookies.status, 400);

  const malformedExtension = await request(app.getHttpServer())
    .post('/profiles')
    .set(auth)
    .send({
      name: 'Bad extension',
      engine: 'lobium',
      os: 'windows',
      extensions: [{ source: 'chrome_web_store', enabled: 'yes' }],
    });
  assert.equal(malformedExtension.status, 400);

  const androidProfile = await request(app.getHttpServer())
    .post('/profiles')
    .set(auth)
    .send({ name: 'Android mobile target', engine: 'lobium', os: 'android' });
  assert.equal(androidProfile.status, 201);
  assert.equal(androidProfile.body.data.os, 'android');

  const safe = await request(app.getHttpServer())
    .post('/profiles')
    .set(auth)
    .send({ name: 'Safe', engine: 'lobium', os: 'windows' });
  assert.ok([200, 201].includes(safe.status));

  const rawCookieUpdate = await request(app.getHttpServer())
    .patch(`/profiles/${safe.body.data.id}`)
    .set(auth)
    .send({ cookiesImport: { mode: 'merge', rawText: 'auth=secret' } });
  assert.equal(rawCookieUpdate.status, 400);

  const rawCookieImport = await request(app.getHttpServer())
    .post('/profiles/import')
    .set(auth)
    .send({
      version: 1,
      profiles: [
        {
          name: 'Unsafe import',
          engine: 'lobium',
          os: 'linux',
          fingerprintSeed: '0123456789abcdef0123456789abcdef',
          cookiesImport: { mode: 'replace', rawText: 'token=secret' },
          tags: [],
        },
      ],
    });
  assert.equal(rawCookieImport.status, 400);
});

/** Create a profile and return its id. */
async function createProfile(auth: { Authorization: string }, name: string): Promise<string> {
  const create = await request(app.getHttpServer())
    .post('/profiles')
    .set(auth)
    .send({ name, engine: 'lobium', os: 'windows' });
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

test('SEC-1: real LBv1 envelope syncs opaquely and decrypts only client-side', async () => {
  const token = await registerToken('profiles-lbv1@example.com');
  const auth = { Authorization: `Bearer ${token}` };
  const id = await createProfile(auth, 'LBv1 profile');

  const cookieDomain = 'accounts.example.com';
  const cookieValue = 'session-token-hunter2-secret';
  const key = generateProfileContentKey();
  const envelope = encryptProfileBlob(
    {
      v: 1,
      profileId: id,
      exportedAt: '2026-07-09T00:00:00.000Z',
      fingerprintSeed: '0123456789abcdef0123456789abcdef',
      cookies: [
        {
          name: 'session',
          value: cookieValue,
          domain: cookieDomain,
          path: '/',
          httpOnly: true,
          secure: true,
        },
      ],
    },
    { key },
  );
  assert.equal(isLBv1Envelope(envelope), true);
  // Wire bytes must not contain cleartext cookie/domain (SEC-1 acceptance).
  const wireLatin1 = envelope.toString('latin1');
  assert.equal(wireLatin1.includes(cookieValue), false);
  assert.equal(wireLatin1.includes(cookieDomain), false);

  const payload = envelope.toString('base64');
  const push = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ direction: 'push', payload });
  assert.ok([200, 201].includes(push.status), `push status ${push.status}`);
  assert.equal(push.body.data.version, 1);

  const pull = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ direction: 'pull' });
  assert.equal(pull.body.data.payload, payload);

  // Server response body must also stay free of cleartext secrets.
  const responseJson = JSON.stringify(pull.body);
  assert.equal(responseJson.includes(cookieValue), false);
  assert.equal(responseJson.includes(cookieDomain), false);

  const restored = decryptProfileBlob(Buffer.from(pull.body.data.payload, 'base64'), key);
  assert.equal(restored.profileId, id);
  assert.equal((restored.cookies as Array<{ value: string }>)[0]?.value, cookieValue);
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

test('a >100kb encrypted blob syncs (push) successfully (body limit raised above the ~100kb default)', async () => {
  const token = await registerToken('profiles-largeblob@example.com');
  const auth = { Authorization: `Bearer ${token}` };
  const id = await createProfile(auth, 'Large blob');

  // 300kB of raw bytes → ~400kB of base64, comfortably past Express's ~100kb default which would
  // otherwise reject a realistic encrypted profile blob with 413.
  const payload = Buffer.alloc(300 * 1024, 0xab).toString('base64');
  assert.ok(payload.length > 100 * 1024, 'payload must exceed the ~100kb default body limit');

  const push = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ direction: 'push', payload });
  assert.ok([200, 201].includes(push.status), `push status ${push.status}`);
  assert.equal(push.body.data.version, 1);

  // Round-trips byte-for-byte, proving the whole large body was accepted and stored.
  const pull = await request(app.getHttpServer())
    .post(`/profiles/${id}/sync`)
    .set(auth)
    .send({ direction: 'pull' });
  assert.equal(pull.body.data.payload, payload);
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
      .send({ name: `Limit ${i}`, engine: 'lobium', os: 'windows' });
    assert.ok([200, 201].includes(res.status), `create ${i} status ${res.status}`);
  }

  const overflow = await request(app.getHttpServer())
    .post('/profiles')
    .set(auth)
    .send({ name: 'one too many', engine: 'lobium', os: 'windows' });
  assert.equal(overflow.status, 403);
});

test('unauthenticated create is 401', async () => {
  const res = await request(app.getHttpServer())
    .post('/profiles')
    .send({ name: 'nope', engine: 'lobium', os: 'windows' });
  assert.equal(res.status, 401);
});

test('bulk create makes N profiles each with a unique seed, batch-checked against the plan limit', async () => {
  const token = await registerToken('profiles-bulk@example.com');
  const auth = { Authorization: `Bearer ${token}` };

  const bulk = await request(app.getHttpServer())
    .post('/profiles/bulk')
    .set(auth)
    .send({ count: 3, namePrefix: 'Batch', engine: 'lobium', os: 'windows', tags: ['ecom'] });
  assert.ok([200, 201].includes(bulk.status), `bulk status ${bulk.status}`);
  assert.equal(bulk.body.code, 0);
  assert.equal(bulk.body.data.length, 3);
  assert.equal(
    new Set(bulk.body.data.map((p: { fingerprintSeed: string }) => p.fingerprintSeed)).size,
    3,
  );
  assert.equal(bulk.body.data[0].name, 'Batch 1');
  assert.deepEqual(bulk.body.data[2].tags, ['ecom']);

  // A batch that would exceed the free limit (5) is rejected wholesale (3 exist, +3 > 5).
  const overflow = await request(app.getHttpServer())
    .post('/profiles/bulk')
    .set(auth)
    .send({ count: 3, namePrefix: 'Over', engine: 'lobium', os: 'windows' });
  assert.equal(overflow.status, 403);
  const list = await request(app.getHttpServer()).get('/profiles').set(auth);
  assert.equal(list.body.data.length, 3, 'nothing partial was created on the rejected batch');
});

test('export is secret-free; import transfers profiles (preserving seed identity) to another team', async () => {
  const tokenA = await registerToken('export-a@example.com');
  const authA = { Authorization: `Bearer ${tokenA}` };
  const tokenB = await registerToken('import-b@example.com');
  const authB = { Authorization: `Bearer ${tokenB}` };

  const alphaMetadata = {
    osVersion: 'macOS 14.6',
    fingerprintOverrides: {
      navigator: { hardwareConcurrency: 10 },
      fonts: ['Arial', 'Helvetica'],
    },
    proxyId: 'proxy-alpha',
    templateId: 'template-alpha',
    cookiesImport: {
      mode: 'merge',
      source: 'file',
      fileName: 'cookies.txt',
      parsedCount: 2,
      errors: [{ line: 4, message: 'expired cookie' }],
    },
    extensions: [
      {
        source: 'chrome_web_store',
        enabled: true,
        id: 'abcdefghijklmnop',
        name: 'Example',
        url: 'https://chromewebstore.google.com/detail/example/abcdefghijklmnop',
      },
      { source: 'unpacked', enabled: false, name: 'Local helper' },
    ],
    tags: ['t'],
    folder: 'Transfers',
    notes: 'n',
  };
  const p1 = await request(app.getHttpServer())
    .post('/profiles')
    .set(authA)
    .send({ name: 'Alpha', engine: 'lobium', os: 'macos', ...alphaMetadata });
  assert.ok([200, 201].includes(p1.status), `Alpha create status ${p1.status}`);
  await request(app.getHttpServer())
    .post('/profiles')
    .set(authA)
    .send({ name: 'Beta', engine: 'lobium', os: 'linux' });
  // Sync a secret blob into Alpha to prove export never carries it.
  await request(app.getHttpServer())
    .post(`/profiles/${p1.body.data.id}/sync`)
    .set(authA)
    .send({ payload: Buffer.from('SECRET').toString('base64') });

  const exp = await request(app.getHttpServer()).get('/profiles/export').set(authA);
  assert.equal(exp.status, 200);
  assert.equal(exp.body.data.version, 1);
  assert.equal(exp.body.data.profiles.length, 2);
  for (const p of exp.body.data.profiles) {
    assert.equal(p.id, undefined, 'export carries no server id');
    assert.equal(p.ownerTeamId, undefined, 'export carries no team id');
    assert.equal(p.status, undefined, 'export carries no runtime status');
    assert.equal(p.proxy, undefined, 'export carries no inline proxy');
    assert.equal(p.cookiesImport?.rawText, undefined, 'export carries no raw cookie text');
  }
  assert.ok(
    !JSON.stringify(exp.body.data).includes('U0VDUkVU'),
    'export must not carry the encrypted blob',
  );
  const alpha = exp.body.data.profiles.find((p: { name: string }) => p.name === 'Alpha');
  assert.equal(alpha.engine, 'lobium');
  for (const [key, value] of Object.entries(alphaMetadata)) {
    assert.deepEqual(alpha[key], value, `export round-trips Alpha ${key}`);
  }

  // B imports A's bundle; seeds (identity) transfer and B owns the copies.
  const imp = await request(app.getHttpServer())
    .post('/profiles/import')
    .set(authB)
    .send(exp.body.data);
  assert.ok([200, 201].includes(imp.status), `import status ${imp.status}`);
  assert.equal(imp.body.data.length, 2);
  const bAlpha = imp.body.data.find((p: { name: string }) => p.name === 'Alpha');
  assert.equal(bAlpha.fingerprintSeed, alpha.fingerprintSeed, 'seed identity transfers');
  assert.ok(bAlpha.ownerTeamId, "imported under B's team");
  for (const [key, value] of Object.entries(alphaMetadata)) {
    assert.deepEqual(bAlpha[key], value, `import round-trips Alpha ${key}`);
  }

  const listB = await request(app.getHttpServer()).get('/profiles').set(authB);
  assert.equal(listB.body.data.length, 2, 'B sees exactly the imported profiles (isolation holds)');
});

test('profile actions are recorded to the team audit log (newest first, with metadata)', async () => {
  const token = await registerToken('audit-integration@example.com');
  const auth = { Authorization: `Bearer ${token}` };

  const create = await request(app.getHttpServer())
    .post('/profiles')
    .set(auth)
    .send({ name: 'Audited', engine: 'lobium', os: 'windows' });
  assert.equal(create.body.code, 0);
  await request(app.getHttpServer())
    .post('/profiles/bulk')
    .set(auth)
    .send({ count: 2, namePrefix: 'B', engine: 'lobium', os: 'windows' });

  // AuditController (GET /audit) is mounted transitively via ProfilesModule -> AuditModule.
  const audit = await request(app.getHttpServer()).get('/audit').set(auth);
  assert.equal(audit.status, 200);
  assert.equal(audit.body.code, 0);
  const actions: string[] = audit.body.data.map((e: { action: string }) => e.action);
  assert.ok(actions.includes('profile.create'), 'profile.create audited');
  assert.ok(actions.includes('profile.bulk_create'), 'profile.bulk_create audited');
  // Newest-first: the later bulk_create precedes the earlier create.
  assert.ok(
    actions.indexOf('profile.bulk_create') < actions.indexOf('profile.create'),
    'audit feed is newest-first',
  );
  const createEntry = audit.body.data.find(
    (e: { action: string }) => e.action === 'profile.create',
  );
  assert.equal(createEntry.targetType, 'profile');
  assert.equal(createEntry.metadata.name, 'Audited');
});
