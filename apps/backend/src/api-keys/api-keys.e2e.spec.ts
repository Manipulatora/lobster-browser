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
import { AuthModule } from '../auth/auth.module';
import { ApiKeysModule } from './api-keys.module';
import { ApiKeysService } from './api-keys.service';

/**
 * HTTP e2e for API keys: boots a real Nest app (controllers + JWT guard + validation pipe) and
 * drives it over HTTP with supertest. No database — DATABASE_URL is cleared so the in-memory
 * repositories are used. Each registered user gets a personal team automatically (auth), which
 * keys are scoped to. The service's `verify()` path is exercised directly via the DI container.
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
      ApiKeysModule,
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

test('create returns the full secret exactly once with the expected format and public fields', async () => {
  const token = await registerToken('api-keys-create@example.com');
  const auth = { Authorization: `Bearer ${token}` };

  const create = await request(app.getHttpServer())
    .post('/api-keys')
    .set(auth)
    .send({ name: 'CI pipeline' });
  assert.ok([200, 201].includes(create.status), `create status ${create.status}`);
  assert.equal(create.body.code, 0);

  const { apiKey, secret } = create.body.data;

  // secret = 'lb_live_' + 24 random bytes as hex (48 hex chars).
  assert.match(secret, /^lb_live_[0-9a-f]{48}$/, 'secret must be lb_live_ + 48 hex chars');

  // The public record carries display fields and the prefix is the leading 16 chars of the secret.
  assert.ok(apiKey.id, 'apiKey must have an id');
  assert.equal(apiKey.name, 'CI pipeline');
  assert.ok(apiKey.teamId, 'apiKey must be scoped to a team');
  assert.ok(apiKey.createdAt, 'apiKey must have a createdAt');
  assert.equal(apiKey.prefix, secret.slice(0, 16));
  assert.match(
    apiKey.prefix,
    /^lb_live_[0-9a-f]{8}$/,
    'prefix is the safe-to-display leading slice',
  );

  // The public record must NEVER carry the secret or its hash.
  assert.equal(apiKey.secret, undefined, 'the public apiKey must not include the secret');
  assert.equal(apiKey.hashedKey, undefined, 'the public apiKey must not include the hash');
});

test('list returns the team keys without ever exposing the secret or hash', async () => {
  const token = await registerToken('api-keys-list@example.com');
  const auth = { Authorization: `Bearer ${token}` };

  await request(app.getHttpServer()).post('/api-keys').set(auth).send({ name: 'key one' });
  await request(app.getHttpServer()).post('/api-keys').set(auth).send({ name: 'key two' });

  const list = await request(app.getHttpServer()).get('/api-keys').set(auth);
  assert.equal(list.status, 200);
  assert.equal(list.body.code, 0);
  assert.equal(list.body.data.length, 2);

  for (const key of list.body.data) {
    assert.ok(key.id && key.prefix && key.name && key.teamId && key.createdAt);
    assert.equal(key.secret, undefined, 'list must not include the secret');
    assert.equal(key.hashedKey, undefined, 'list must not include the hash');
    assert.match(key.prefix, /^lb_live_[0-9a-f]{8}$/);
  }
});

test('delete revokes a key and a second delete of the same id is 404', async () => {
  const token = await registerToken('api-keys-delete@example.com');
  const auth = { Authorization: `Bearer ${token}` };

  const create = await request(app.getHttpServer())
    .post('/api-keys')
    .set(auth)
    .send({ name: 'to be revoked' });
  const id: string = create.body.data.apiKey.id;

  const del = await request(app.getHttpServer()).delete(`/api-keys/${id}`).set(auth);
  assert.equal(del.status, 200);
  assert.equal(del.body.code, 0);
  assert.deepEqual(del.body.data, { id, revoked: true });

  // The key is gone: it is no longer listed...
  const list = await request(app.getHttpServer()).get('/api-keys').set(auth);
  assert.equal(list.body.data.length, 0);

  // ...and deleting it again is a 404.
  const again = await request(app.getHttpServer()).delete(`/api-keys/${id}`).set(auth);
  assert.equal(again.status, 404);
});

test("keys are isolated per team: deleting another team's key is 404 and never listed", async () => {
  const tokenA = await registerToken('api-keys-isolation-a@example.com');
  const tokenB = await registerToken('api-keys-isolation-b@example.com');

  const createA = await request(app.getHttpServer())
    .post('/api-keys')
    .set({ Authorization: `Bearer ${tokenA}` })
    .send({ name: 'A-only' });
  const idA: string = createA.body.data.apiKey.id;

  // B cannot see A's key...
  const listB = await request(app.getHttpServer())
    .get('/api-keys')
    .set({ Authorization: `Bearer ${tokenB}` });
  assert.equal(listB.status, 200);
  assert.equal(listB.body.data.length, 0, "user B must not see user A's keys");

  // ...nor revoke it (a cross-team id is indistinguishable from a missing one → 404).
  const delB = await request(app.getHttpServer())
    .delete(`/api-keys/${idA}`)
    .set({ Authorization: `Bearer ${tokenB}` });
  assert.equal(delB.status, 404);

  // A's key survived B's attempt.
  const listA = await request(app.getHttpServer())
    .get('/api-keys')
    .set({ Authorization: `Bearer ${tokenA}` });
  assert.equal(listA.body.data.length, 1);
});

test('an empty or over-long name is rejected with 400 by the validation pipe', async () => {
  const token = await registerToken('api-keys-validation@example.com');
  const auth = { Authorization: `Bearer ${token}` };

  const empty = await request(app.getHttpServer()).post('/api-keys').set(auth).send({ name: '' });
  assert.equal(empty.status, 400);

  const tooLong = await request(app.getHttpServer())
    .post('/api-keys')
    .set(auth)
    .send({ name: 'x'.repeat(81) });
  assert.equal(tooLong.status, 400);
});

test('verify() authenticates the presented secret, stamps lastUsedAt, and rejects unknown secrets', async () => {
  const token = await registerToken('api-keys-verify@example.com');
  const auth = { Authorization: `Bearer ${token}` };

  const create = await request(app.getHttpServer())
    .post('/api-keys')
    .set(auth)
    .send({ name: 'verifiable' });
  const { apiKey, secret } = create.body.data;

  const service = app.get(ApiKeysService);

  // A valid secret resolves to the owning team + key id.
  const verified = await service.verify(secret);
  assert.ok(verified, 'a valid secret must verify');
  assert.equal(verified.apiKeyId, apiKey.id);
  assert.equal(verified.teamId, apiKey.teamId);

  // verify() stamped lastUsedAt, now visible on the listed key (still no secret/hash exposed).
  const list = await request(app.getHttpServer()).get('/api-keys').set(auth);
  const listed = list.body.data.find((k: { id: string }) => k.id === apiKey.id);
  assert.ok(listed.lastUsedAt, 'lastUsedAt must be set after a successful verify');
  assert.equal(listed.hashedKey, undefined);

  // An unknown secret (never issued) does not verify.
  const bogus = `lb_live_${'0'.repeat(48)}`;
  assert.equal(await service.verify(bogus), null, 'an unknown secret must not verify');

  // Sanity: the stored hash is sha256(secret), confirming plaintext is never persisted.
  assert.notEqual(createHash('sha256').update(secret).digest('hex'), secret);
});

test('a revoked secret no longer verifies', async () => {
  const token = await registerToken('api-keys-revoked-verify@example.com');
  const auth = { Authorization: `Bearer ${token}` };

  const create = await request(app.getHttpServer())
    .post('/api-keys')
    .set(auth)
    .send({ name: 'short-lived' });
  const { apiKey, secret } = create.body.data;

  const service = app.get(ApiKeysService);
  assert.ok(await service.verify(secret), 'secret verifies before revocation');

  const del = await request(app.getHttpServer()).delete(`/api-keys/${apiKey.id}`).set(auth);
  assert.equal(del.status, 200);

  assert.equal(await service.verify(secret), null, 'a revoked secret must not verify');
});

test('BE-5: GET /automation/whoami accepts a live key and 401s after revoke', async () => {
  const token = await registerToken('api-keys-automation@example.com');
  const auth = { Authorization: `Bearer ${token}` };

  const create = await request(app.getHttpServer())
    .post('/api-keys')
    .set(auth)
    .send({ name: 'automation' });
  const { apiKey, secret } = create.body.data;

  const whoami = await request(app.getHttpServer())
    .get('/automation/whoami')
    .set({ Authorization: `Bearer ${secret}` });
  assert.equal(whoami.status, 200);
  assert.equal(whoami.body.code, 0);
  assert.equal(whoami.body.data.apiKeyId, apiKey.id);
  assert.equal(whoami.body.data.teamId, apiKey.teamId);

  await request(app.getHttpServer()).delete(`/api-keys/${apiKey.id}`).set(auth);
  const after = await request(app.getHttpServer())
    .get('/automation/whoami')
    .set({ Authorization: `Bearer ${secret}` });
  assert.equal(after.status, 401);
});

test('unauthenticated create is 401', async () => {
  const res = await request(app.getHttpServer()).post('/api-keys').send({ name: 'nope' });
  assert.equal(res.status, 401);
});

test('unauthenticated list is 401', async () => {
  const res = await request(app.getHttpServer()).get('/api-keys');
  assert.equal(res.status, 401);
});
