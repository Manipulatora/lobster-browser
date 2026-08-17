import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  deriveRecoveryKey,
  deriveUserMasterKey,
  generatePasswordSalt,
  generateRecoveryCode,
  generateSymmetricKey,
  keyFingerprint,
  unwrapKey,
  wrapKey,
} from '@lobster/crypto';

import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { VaultModule } from './vault.module';

/**
 * HTTP e2e for the vault: boots a real Nest app and drives `/vault` over supertest with no database.
 *
 * The point of these tests is the REFUSALS. The happy path is a blob store; what makes this safe to
 * ship is that it declines to overwrite existing wraps, declines a rotation that would orphan
 * snapshots, and declines the shapes that quietly reduce two recovery paths to one.
 */
let app: INestApplication;

/** Reduced Argon2id cost — still above the server's accepted floor, but fast enough for a test. */
const ARGON = { memoryKiB: 8 * 1024, iterations: 2, parallelism: 1 };

interface Enrollment {
  passwordSalt: string;
  recoverySalt: string;
  wrappedByPassword: string;
  wrappedByRecovery: string;
  keyFingerprint: string;
  argon: typeof ARGON;
}

/** Everything a client does locally before it ever talks to the server. */
async function buildEnrollment(
  password: string,
  code: string,
  teamDataKey = generateSymmetricKey(),
): Promise<Enrollment> {
  const passwordSalt = generatePasswordSalt();
  const recoverySalt = generatePasswordSalt();
  const passwordKey = await deriveUserMasterKey(password, passwordSalt, ARGON);
  const recoveryKey = await deriveRecoveryKey(code, recoverySalt, ARGON);
  return {
    passwordSalt: passwordSalt.toString('base64'),
    recoverySalt: recoverySalt.toString('base64'),
    wrappedByPassword: wrapKey(teamDataKey, passwordKey).toString('base64'),
    wrappedByRecovery: wrapKey(teamDataKey, recoveryKey).toString('base64'),
    keyFingerprint: keyFingerprint(teamDataKey),
    argon: ARGON,
  };
}

async function register(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: 'supersecret1' });
  assert.ok([200, 201].includes(res.status), `register status ${res.status}`);
  return res.body.data.token as string;
}

before(async () => {
  process.env.DATABASE_URL = ''; // force in-memory repos — see the note in audit.e2e.spec.ts
  process.env.NODE_ENV = 'test';

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      MailModule,
      PrismaModule,
      AuthModule,
      AuditModule,
      VaultModule,
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

test('an unenrolled account reads back null, so a client knows to offer setup', async () => {
  const token = await register('vault-fresh@example.com');
  const res = await request(app.getHttpServer())
    .get('/vault')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 0);
  assert.equal(res.body.data, null);
});

test('the round trip a new machine actually performs: enroll here, unlock there', async () => {
  const token = await register('vault-roundtrip@example.com');
  const password = 'correct horse battery staple';
  const code = generateRecoveryCode();
  const teamDataKey = generateSymmetricKey();
  const body = await buildEnrollment(password, code, teamDataKey);

  const enrolled = await request(app.getHttpServer())
    .post('/vault/enroll')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));

  // A DIFFERENT machine: it has the password and nothing else. It fetches the blobs and derives.
  const fetched = await request(app.getHttpServer())
    .get('/vault')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(fetched.status, 200);
  const view = fetched.body.data;

  // The cost is echoed back, which is what lets parameters be raised later without stranding anyone.
  assert.deepEqual(view.argon, ARGON);

  const passwordKey = await deriveUserMasterKey(
    password,
    Buffer.from(view.passwordSalt, 'base64'),
    view.argon,
  );
  const recovered = unwrapKey(Buffer.from(view.wrappedByPassword, 'base64'), passwordKey);
  assert.deepEqual(recovered, teamDataKey, 'the password path recovers the exact key');

  // ...and so does the recovery code, which is the whole reason it exists.
  const recoveryKey = await deriveRecoveryKey(
    code,
    Buffer.from(view.recoverySalt, 'base64'),
    view.argon,
  );
  assert.deepEqual(
    unwrapKey(Buffer.from(view.wrappedByRecovery, 'base64'), recoveryKey),
    teamDataKey,
    'the recovery path recovers the exact same key',
  );

  // A wrong password fails closed rather than yielding a plausible-looking wrong key.
  const wrongKey = await deriveUserMasterKey(
    'not the password',
    Buffer.from(view.passwordSalt, 'base64'),
    view.argon,
  );
  assert.throws(() => unwrapKey(Buffer.from(view.wrappedByPassword, 'base64'), wrongKey));
});

test('the response never contains the key, only material useless without a secret', async () => {
  const token = await register('vault-nokey@example.com');
  const teamDataKey = generateSymmetricKey();
  const body = await buildEnrollment('pw-one', generateRecoveryCode(), teamDataKey);
  await request(app.getHttpServer())
    .post('/vault/enroll')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .expect(201);

  const res = await request(app.getHttpServer())
    .get('/vault')
    .set('Authorization', `Bearer ${token}`);
  const wire = JSON.stringify(res.body);
  assert.ok(
    !wire.includes(teamDataKey.toString('base64')),
    'the plaintext key must never appear on the wire',
  );
  assert.ok(!wire.includes(teamDataKey.toString('hex')));
});

test('enrolling twice is refused, because overwriting destroys the only wraps of the live key', async () => {
  const token = await register('vault-twice@example.com');
  const first = await buildEnrollment('pw-one', generateRecoveryCode());
  await request(app.getHttpServer())
    .post('/vault/enroll')
    .set('Authorization', `Bearer ${token}`)
    .send(first)
    .expect(201);

  // A second enrollment carries a DIFFERENT key. Accepting it would strand every snapshot sealed
  // under the first one, with no way back.
  const second = await buildEnrollment('pw-two', generateRecoveryCode());
  const res = await request(app.getHttpServer())
    .post('/vault/enroll')
    .set('Authorization', `Bearer ${token}`)
    .send(second);
  assert.equal(res.status, 409);
  assert.match(res.body.msg ?? res.body.message, /already has vault key material/);

  // ...and the original wraps are untouched.
  const after = await request(app.getHttpServer())
    .get('/vault')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(after.body.data.wrappedByPassword, first.wrappedByPassword);
});

test('rotation re-wraps the same key, and refuses a different one', async () => {
  const token = await register('vault-rotate@example.com');
  const teamDataKey = generateSymmetricKey();
  await request(app.getHttpServer())
    .post('/vault/enroll')
    .set('Authorization', `Bearer ${token}`)
    .send(await buildEnrollment('old-password', generateRecoveryCode(), teamDataKey))
    .expect(201);

  // A password change: same key, new wraps.
  const newCode = generateRecoveryCode();
  const rotated = await buildEnrollment('new-password', newCode, teamDataKey);
  const ok = await request(app.getHttpServer())
    .post('/vault/rotate')
    .set('Authorization', `Bearer ${token}`)
    .send(rotated);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.data.rotatedAt, 'a rotation is stamped');

  // The new password opens it, and the key is still the one snapshots were sealed under.
  const view = (await request(app.getHttpServer()).get('/vault').set('Authorization', `Bearer ${token}`))
    .body.data;
  const key = await deriveUserMasterKey(
    'new-password',
    Buffer.from(view.passwordSalt, 'base64'),
    view.argon,
  );
  assert.deepEqual(unwrapKey(Buffer.from(view.wrappedByPassword, 'base64'), key), teamDataKey);

  // Rotating in a DIFFERENT key is refused — that is the orphan-every-snapshot mistake.
  const differentKey = await buildEnrollment('new-password', newCode, generateSymmetricKey());
  const refused = await request(app.getHttpServer())
    .post('/vault/rotate')
    .set('Authorization', `Bearer ${token}`)
    .send(differentKey);
  assert.equal(refused.status, 400);
  assert.match(refused.body.msg ?? refused.body.message, /not the key currently enrolled/);
});

test('rotating without enrolling is a 404, not a silent create', async () => {
  const token = await register('vault-norotate@example.com');
  const res = await request(app.getHttpServer())
    .post('/vault/rotate')
    .set('Authorization', `Bearer ${token}`)
    .send(await buildEnrollment('pw', generateRecoveryCode()));
  assert.equal(res.status, 404);
});

test('the shapes that quietly reduce two recovery paths to one are refused', async () => {
  const token = await register('vault-shapes@example.com');
  const good = await buildEnrollment('pw', generateRecoveryCode());

  // One salt for both: the two wrapping keys become related, and a password change silently
  // invalidates the recovery code.
  const sharedSalt = await request(app.getHttpServer())
    .post('/vault/enroll')
    .set('Authorization', `Bearer ${token}`)
    .send({ ...good, recoverySalt: good.passwordSalt });
  assert.equal(sharedSalt.status, 400);
  assert.match(sharedSalt.body.msg ?? sharedSalt.body.message, /must differ/);

  // The same wrap sent twice: one recovery path pretending to be two.
  const sameWrap = await request(app.getHttpServer())
    .post('/vault/enroll')
    .set('Authorization', `Bearer ${token}`)
    .send({ ...good, wrappedByRecovery: good.wrappedByPassword });
  assert.equal(sameWrap.status, 400);
  assert.match(sameWrap.body.msg ?? sameWrap.body.message, /identical/);

  // A trivial Argon2id cost: the password wrap would be cheap to attack offline, and the server is
  // the only place that can refuse it.
  const weak = await request(app.getHttpServer())
    .post('/vault/enroll')
    .set('Authorization', `Bearer ${token}`)
    .send({ ...good, argon: { memoryKiB: 64, iterations: 1, parallelism: 1 } });
  assert.equal(weak.status, 400);
  assert.match(weak.body.msg ?? weak.body.message, /argon cost is below the minimum/);

  // Nothing above should have enrolled anything.
  const still = await request(app.getHttpServer()).get('/vault').set('Authorization', `Bearer ${token}`);
  assert.equal(still.body.data, null);
});

test('recovery-code use is recorded once, and is advisory only', async () => {
  const token = await register('vault-recovered@example.com');
  await request(app.getHttpServer())
    .post('/vault/enroll')
    .set('Authorization', `Bearer ${token}`)
    .send(await buildEnrollment('pw', generateRecoveryCode()))
    .expect(201);

  await request(app.getHttpServer())
    .post('/vault/recovery-code-used')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);

  const first = (await request(app.getHttpServer()).get('/vault').set('Authorization', `Bearer ${token}`))
    .body.data.recoveryCodeUsedAt;
  assert.ok(first, 'the first use is stamped');

  // A second report does not move the timestamp: what matters is when the code left its paper copy.
  await request(app.getHttpServer())
    .post('/vault/recovery-code-used')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  const second = (await request(app.getHttpServer()).get('/vault').set('Authorization', `Bearer ${token}`))
    .body.data.recoveryCodeUsedAt;
  assert.equal(second, first);
});

test('every route requires a token, and none takes a user id', async () => {
  for (const [method, path] of [
    ['get', '/vault'],
    ['post', '/vault/enroll'],
    ['post', '/vault/rotate'],
    ['post', '/vault/recovery-code-used'],
  ] as const) {
    const res = await request(app.getHttpServer())[method](path).send({});
    assert.equal(res.status, 401, `${method.toUpperCase()} ${path} must require auth`);
  }

  // Two enrolled users cannot reach each other's material: the routes are scoped to the token and
  // there is no `:userId` shape to attack.
  const alice = await register('vault-alice@example.com');
  const bob = await register('vault-bob@example.com');
  const aliceBody = await buildEnrollment('alice-pw', generateRecoveryCode());
  const bobBody = await buildEnrollment('bob-pw', generateRecoveryCode());
  await request(app.getHttpServer())
    .post('/vault/enroll')
    .set('Authorization', `Bearer ${alice}`)
    .send(aliceBody)
    .expect(201);
  await request(app.getHttpServer())
    .post('/vault/enroll')
    .set('Authorization', `Bearer ${bob}`)
    .send(bobBody)
    .expect(201);

  const bobsView = await request(app.getHttpServer()).get('/vault').set('Authorization', `Bearer ${bob}`);
  assert.equal(bobsView.body.data.wrappedByPassword, bobBody.wrappedByPassword);
  assert.notEqual(bobsView.body.data.wrappedByPassword, aliceBody.wrappedByPassword);
});
