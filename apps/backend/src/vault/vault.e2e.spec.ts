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
import { VaultModule } from './vault.module';

/**
 * The account key, end to end. One route, no setup step: signing in is all a user needs to reach
 * their profiles from a new machine.
 */
let app: INestApplication;

async function register(email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: 'supersecret1' });
  assert.ok([200, 201].includes(res.status), `register status ${res.status}`);
  return res.body.data.token as string;
}

before(async () => {
  process.env.DATABASE_URL = ''; // force in-memory repos — see the note in audit.e2e.spec.ts
  process.env.BLOB_STORE_PATH = '';
  process.env.S3_BUCKET = '';
  // ...and the mailer, for the same reason. Registering a user sends a verification email,
  // so with the real SMTP settings leaking in from .env every test run posted real mail to
  // fake addresses from the production mailbox — enough of it to trip the provider's rate
  // limit. Unconfigured, MailService logs instead of sending.
  process.env.SMTP_HOST = '';
  process.env.NODE_ENV = 'test';

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      MailModule,
      PrismaModule,
      AuthModule,
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

test('a signed-in user gets a key with no setup step, and the same one every time', async () => {
  const token = await register('key-basic@example.com');

  const first = await request(app.getHttpServer())
    .get('/vault/key')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(first.status, 200);
  assert.equal(first.body.code, 0);

  const key = Buffer.from(first.body.data.dataKey, 'base64');
  assert.equal(key.length, 32, 'a 32-byte key');

  // Stable across calls: a second key would leave the first machine's snapshots unreadable.
  const second = await request(app.getHttpServer())
    .get('/vault/key')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(second.body.data.dataKey, first.body.data.dataKey);
});

test('two machines signing in at once end up with the same key', async () => {
  const token = await register('key-race@example.com');

  // Two callers, issued before either has been answered. Different keys here would mean snapshots
  // sealed by one machine could not be opened by the other. Kept to two connections: supertest binds
  // an ephemeral server per request and a larger fan-out resets connections, which would make this
  // test flaky for a reason that has nothing to do with what it checks.
  const answers = await Promise.all([
    request(app.getHttpServer()).get('/vault/key').set('Authorization', `Bearer ${token}`),
    request(app.getHttpServer()).get('/vault/key').set('Authorization', `Bearer ${token}`),
  ]);
  for (const res of answers) assert.equal(res.status, 200);
  const keys = new Set(answers.map((r) => r.body.data.dataKey));
  assert.equal(keys.size, 1, 'every caller must receive the identical key');
});

test('each account gets its own key', async () => {
  const alice = await register('key-alice@example.com');
  const bob = await register('key-bob@example.com');

  const [a, b] = await Promise.all([
    request(app.getHttpServer()).get('/vault/key').set('Authorization', `Bearer ${alice}`),
    request(app.getHttpServer()).get('/vault/key').set('Authorization', `Bearer ${bob}`),
  ]);
  assert.notEqual(a.body.data.dataKey, b.body.data.dataKey);
});

test('the key requires a token, and there is no route that names a user', async () => {
  const anonymous = await request(app.getHttpServer()).get('/vault/key');
  assert.equal(anonymous.status, 401);

  // The route is scoped to the caller's token; there is no `:userId` shape to attack.
  const token = await register('key-scope@example.com');
  const mine = await request(app.getHttpServer())
    .get('/vault/key')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(mine.status, 200);
});
