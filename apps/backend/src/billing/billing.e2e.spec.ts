import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { MailService } from '../mail/mail.service';
import { PrismaModule } from '../prisma/prisma.module';
import { createMailCapture, signUpOverHttp, type MailCapture } from '../testing/e2e-auth';
import { BillingModule } from './billing.module';

/**
 * HTTP e2e for the operator-driven renewal sweep and the overview payload.
 *
 * WHY THE SWEEP ROUTE NEEDS A TEST AT ALL. `RENEWAL_SWEEP_INTERVAL_MS=0` turns the in-process timer
 * off and points the deployment at an external cron — and for as long as no route existed to point
 * it at, that setting stopped all billing without erroring at anything. A route nobody can reach and
 * a route anybody can reach are both serious, so both halves are asserted here.
 */
let app: INestApplication;
let mailCapture: MailCapture;

const ADMIN_TOKEN = 'e2e-admin-token';

before(async () => {
  // Empty, not deleted: requiring @prisma/client auto-loads .env and dotenv never overwrites a var
  // that is already set, so an empty string survives and the in-memory repositories are used.
  process.env.DATABASE_URL = '';
  process.env.SMTP_HOST = '';
  process.env.NODE_ENV = 'test';
  process.env.BILLING_ADMIN_TOKEN = ADMIN_TOKEN;
  // No background timers during the suite: the sweep under test is the one this file triggers.
  process.env.RENEWAL_SWEEP_INTERVAL_MS = '0';
  process.env.DEPOSIT_RECONCILE_INTERVAL_MS = '0';

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      MailModule,
      PrismaModule,
      AuthModule,
      BillingModule,
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

test('the admin sweep runs with the configured token and reports what it did', async () => {
  const res = await request(app.getHttpServer())
    .post('/billing/admin/renewal-sweep')
    .set('X-Admin-Token', ADMIN_TOKEN);

  assert.equal(res.status, 200);
  assert.equal(res.body.code, 0);
  // Nothing is subscribed in this suite, so the interesting part is that a sweep ran and answered
  // with counts a cron can log rather than an empty 200.
  assert.deepEqual(res.body.data, { examined: 0, renewed: 0, lapsed: 0, skipped: 0 });
});

test('the sweep refuses a wrong token, and a missing one', async () => {
  const wrong = await request(app.getHttpServer())
    .post('/billing/admin/renewal-sweep')
    .set('X-Admin-Token', 'not-the-token');
  assert.equal(wrong.status, 401);

  const none = await request(app.getHttpServer()).post('/billing/admin/renewal-sweep');
  assert.equal(none.status, 401, 'a session on the site is not authority over every team at once');
});

test('the quote route answers over HTTP and refuses a tier nobody sells', async () => {
  // Over the wire because the confirmation dialog cannot open without it: a quote that exists only
  // in TypeScript is a modal with no figures in it, and the purchase behind it is unreachable.
  const { token } = await signUpOverHttp(app, mailCapture, 'billing-quote@gmail.com');
  const auth = `Bearer ${token}`;

  const res = await request(app.getHttpServer())
    .get('/billing/quote?tier=pro&period=yearly')
    .set('Authorization', auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.code, 0);
  assert.deepEqual(
    {
      kind: res.body.data.kind,
      allowed: res.body.data.allowed,
      priceCents: res.body.data.priceCents,
      dueCents: res.body.data.dueCents,
      shortfallCents: res.body.data.shortfallCents,
      currentTier: res.body.data.currentTier,
    },
    // An account with no Credit and no package: allowed to buy, unable to pay for it — two
    // different facts, and the dialog offers a top-up rather than an error on the second.
    {
      kind: 'new',
      allowed: true,
      priceCents: 96_000,
      dueCents: 96_000,
      shortfallCents: 96_000,
      currentTier: 'free',
    },
  );

  const bogus = await request(app.getHttpServer())
    .get('/billing/quote?tier=platinum')
    .set('Authorization', auth);
  assert.equal(bogus.status, 400, 'the quote validates exactly what the purchase does');

  const anonymous = await request(app.getHttpServer()).get('/billing/quote?tier=pro');
  assert.equal(anonymous.status, 401, 'a quote names a team’s balance');
});

test('the overview names the next billing date and the allowance actually in force', async () => {
  // Over the wire, because these two fields are what the dashboard and the desktop render: a
  // payload that carries them only in TypeScript is a panel with a blank date in it.
  const { token } = await signUpOverHttp(app, mailCapture, 'billing-overview@gmail.com');

  const res = await request(app.getHttpServer())
    .get('/billing/overview')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  const overview = res.body.data;
  assert.equal(overview.nextBillingAt, null, 'an account with no package owes nothing');
  assert.equal(overview.entitledProfileLimit, overview.freePlanProfileLimit);
});
