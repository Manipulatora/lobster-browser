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
import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import { BillingModule } from './billing.module';
import { BILLING_REPOSITORY, type BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';

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
  assert.deepEqual(res.body.data, {
    examined: 0,
    renewed: 0,
    lapsed: 0,
    skipped: 0,
    expired: 0,
  });
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
  // The deposit floor rides along so the amount field can refuse a too-small entry while it is
  // being typed, naming the server's own figure instead of a hard-coded copy of it.
  assert.equal(overview.minDepositCents, 500);
});

/**
 * Seed a deposit row through the repository, not the HTTP route: creating one over the wire needs
 * live processor credentials (the unconfigured provider answers 503 by design), and what these
 * tests exercise is what cancel and expiry do to a row that already exists.
 */
function seedDeposit(
  repo: BillingRepository,
  teamId: string,
  suffix: string,
): ReturnType<BillingRepository['createDeposit']> {
  return repo.createDeposit({
    teamId,
    provider: 'nowpayments',
    providerPaymentId: `nowpayments:e2e-${suffix}`,
    amountCents: 1000,
    chain: 'Solana',
    asset: 'USDT',
    address: `addr-${suffix}`,
    amountCrypto: '10',
  });
}

test('a deposit below the minimum is refused at the door, naming the floor', async () => {
  const { token } = await signUpOverHttp(app, mailCapture, 'billing-deposit-floor@gmail.com');
  const auth = `Bearer ${token}`;

  // The defect as shipped: a typed "0.001" reached the API as `amountCents: 0`, passed the DTO
  // (bare @IsInt) and died at the service's range check as an unexplained 400. Both the zero and
  // an honest-but-small amount must now be refused by the DTO itself — asserted through the
  // wording, because the two layers phrase the refusal differently ("at least" here, "between"
  // in the service) and the message naming the floor is the fix.
  for (const amountCents of [0, 100]) {
    const res = await request(app.getHttpServer())
      .post('/billing/deposits')
      .set('Authorization', auth)
      .send({ amountCents, currencyCode: 'usdtsol' });
    assert.equal(res.status, 400, `amountCents=${amountCents} must be refused`);
    assert.match(
      JSON.stringify(res.body),
      /at least 5 Credit/,
      'the refusal comes from the DTO and names the floor',
    );
  }
});

test('cancel closes a pending deposit, and refuses to touch a credited one', async () => {
  const { token, userId } = await signUpOverHttp(
    app,
    mailCapture,
    'billing-deposit-cancel@gmail.com',
  );
  const auth = `Bearer ${token}`;
  const teams = app.get<TeamsRepository>(TEAMS_REPOSITORY);
  const [team] = await teams.findTeamsForUser(userId);
  const repo = app.get<BillingRepository>(BILLING_REPOSITORY);

  const open = await seedDeposit(repo, team.id, 'cancel-open');

  const canceled = await request(app.getHttpServer())
    .post(`/billing/deposits/${open.id}/cancel`)
    .set('Authorization', auth);
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.code, 0);
  assert.equal(canceled.body.data.canceled, true);

  const listed = await request(app.getHttpServer())
    .get('/billing/deposits')
    .set('Authorization', auth);
  const row = listed.body.data.find((d: { id: string }) => d.id === open.id);
  assert.equal(
    row.status,
    'expired',
    'cancel is a fact the server records — the fix for the payment that kept coming back',
  );

  // A credited deposit is money already on the books; cancel must answer, not rewrite history.
  const paid = await seedDeposit(repo, team.id, 'cancel-paid');
  await repo.creditDeposit('nowpayments:e2e-cancel-paid', { creditedCents: 1000 });

  const refused = await request(app.getHttpServer())
    .post(`/billing/deposits/${paid.id}/cancel`)
    .set('Authorization', auth);
  assert.equal(refused.status, 200, 'a no-op is an answer, not an error');
  assert.equal(refused.body.data.canceled, false);

  const after = await request(app.getHttpServer())
    .get('/billing/overview')
    .set('Authorization', auth);
  assert.equal(after.body.data.balanceCents, 1000, 'the credited money is untouched');
  const listedAfter = await request(app.getHttpServer())
    .get('/billing/deposits')
    .set('Authorization', auth);
  assert.equal(
    listedAfter.body.data.find((d: { id: string }) => d.id === paid.id).status,
    'confirmed',
    'a settled deposit keeps its status through a stray cancel',
  );
});

test('the stale-deposit sweep expires only pending, uncredited rows past the cutoff', async () => {
  const { userId } = await signUpOverHttp(app, mailCapture, 'billing-deposit-expiry@gmail.com');
  const teams = app.get<TeamsRepository>(TEAMS_REPOSITORY);
  const [team] = await teams.findTeamsForUser(userId);
  const repo = app.get<BillingRepository>(BILLING_REPOSITORY);
  const billing = app.get(BillingService);

  const abandoned = await seedDeposit(repo, team.id, 'expiry-abandoned');
  const credited = await seedDeposit(repo, team.id, 'expiry-credited');
  const confirming = await seedDeposit(repo, team.id, 'expiry-confirming');
  await repo.creditDeposit('nowpayments:e2e-expiry-credited', { creditedCents: 1000 });
  await repo.updateDepositStatus('nowpayments:e2e-expiry-confirming', 'confirming', {});

  // Every row is seconds old, so against the real clock the 7-day cutoff spares them all — a
  // fresh address must never be expired out from under someone still copying it into a wallet.
  assert.equal(await billing.expireStaleDeposits(), 0);

  // Eight days on, the cutoff is past every row, and exactly ONE goes: `confirming` has funds
  // visibly in flight (reconciliation's business, not housekeeping's) and the credited one is
  // money already minted. The count of 1 leans on this suite leaving no other pending rows —
  // the cancel test above flips both of its own to terminal states.
  const eightDaysOn = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  assert.equal(await billing.expireStaleDeposits(eightDaysOn), 1);

  const statuses = new Map((await repo.listDeposits(team.id, 10)).map((d) => [d.id, d.status]));
  assert.equal(statuses.get(abandoned.id), 'expired');
  assert.equal(statuses.get(credited.id), 'confirmed');
  assert.equal(statuses.get(confirming.id), 'confirming');
});
