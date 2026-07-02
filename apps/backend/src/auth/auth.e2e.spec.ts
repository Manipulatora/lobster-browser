import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from './auth.module';

/**
 * HTTP e2e for auth: boots a real Nest app (controllers + guard + validation pipe) and drives it
 * over HTTP with supertest. No database — DATABASE_URL is cleared so the in-memory repo is used.
 */
let app: INestApplication;

before(async () => {
  delete process.env.DATABASE_URL; // force the in-memory users repository
  process.env.NODE_ENV = 'test'; // allow the dev JWT secret outside production

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PrismaModule,
      AuthModule,
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

test('register -> login -> /auth/me happy path (with {code,data,msg} envelope)', async () => {
  const email = 'e2e@example.com';
  const password = 'supersecret1';

  const reg = await request(app.getHttpServer()).post('/auth/register').send({ email, password });
  assert.ok([200, 201].includes(reg.status), `register status ${reg.status}`);
  assert.equal(reg.body.code, 0);
  assert.ok(reg.body.data.token, 'register returns a token');
  assert.equal(reg.body.data.user.email, email);
  assert.equal(reg.body.data.user.passwordHash, undefined, 'password hash must never leak');

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

test('/auth/me without a token is 401', async () => {
  const res = await request(app.getHttpServer()).get('/auth/me');
  assert.equal(res.status, 401);
});

test('login with the wrong password is 401', async () => {
  const email = 'e2e-wrong@example.com';
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: 'correct-horse1' });

  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: 'totallywrong9' });
  assert.equal(res.status, 401);
});
