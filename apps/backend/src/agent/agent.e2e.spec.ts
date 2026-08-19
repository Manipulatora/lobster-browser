import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { PlanTier, Subscription } from '@lobster/shared-types';

import { AuthService } from '../auth/auth.service';
import { BILLING_REPOSITORY, type BillingRepository } from '../billing/billing.repository';
import { ApiExceptionFilter } from '../common/api-exception.filter';
import { MailModule } from '../mail/mail.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AgentModule } from './agent.module';

/**
 * HTTP e2e for the agent proxy, and specifically for the shape a refusal arrives in.
 *
 * The global `ApiExceptionFilter` is installed here exactly as `main.ts` installs it, because that
 * is the thing being tested: it flattens every exception to `{ code, data, msg }`, which would
 * reduce a plan refusal to a sentence the panel cannot render an upsell from. Asserting the typed
 * fields through a real HTTP round-trip is the only way to know the controller-scoped filter still
 * wins.
 */
let app: INestApplication;
/** Flipped per test to stand the team on a different package. */
let tier: PlanTier | null = null;
let realFetch: typeof globalThis.fetch;

/** The one model these tests ask for, served from a stubbed catalog so no call leaves the machine. */
const MODEL = 'anthropic/claude-sonnet-5';

before(async () => {
  process.env.DATABASE_URL = '';
  process.env.BLOB_STORE_PATH = '';
  process.env.S3_BUCKET = '';
  process.env.SMTP_HOST = '';
  process.env.NODE_ENV = 'test'; // allow the dev JWT secret outside production
  process.env.OPENROUTER_API_KEY = 'e2e-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes('/models')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: MODEL,
              name: 'Sonnet',
              supported_parameters: ['max_tokens', 'tools', 'tool_choice'],
              architecture: { output_modalities: ['text'] },
            },
          ],
        }),
        { status: 200 },
      );
    }
    throw new Error('a refused call must never reach the provider');
  }) as typeof fetch;

  const billing = {
    getSubscription: async (teamId: string): Promise<Subscription | null> =>
      tier === null
        ? null
        : { teamId, tier, profileLimit: 10, priceCents: 0, status: 'active', autoRenew: false },
    getBalanceCents: async (): Promise<number> => 0,
    getAgentAccruedMicros: async (): Promise<number> => 0,
  } as unknown as BillingRepository;

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      MailModule,
      PrismaModule,
      AgentModule,
    ],
  })
    .overrideProvider(BILLING_REPOSITORY)
    .useValue(billing)
    .compile();

  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
});

after(async () => {
  globalThis.fetch = realFetch;
  await app?.close();
});

/** Signed with whatever secret the booted app resolved, so the test cannot pass for the wrong reason. */
function agentToken(): string {
  return new JwtService({ secret: app.get(AuthService).jwtSecret }).sign({
    sub: 'user-1',
    email: 'user@example.com',
    aud: 'agent',
    teamId: 'team-1',
  });
}

test('a Light team gets a typed upsell over the wire, not a flattened message', async () => {
  tier = 'light';
  const response = await request(app.getHttpServer())
    .post('/agent/llm/chat/completions')
    .set('authorization', `Bearer ${agentToken()}`)
    .send({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(response.status, 403);
  assert.equal(response.body.reason, 'plan_required');
  assert.equal(response.body.currentTier, 'light');
  assert.deepEqual(response.body.requiredTiers, ['plus', 'pro', 'max']);
  assert.equal(response.body.minimumTier, 'plus');
  // The envelope would have swallowed all of the above.
  assert.equal(response.body.code, undefined);
});

test('a Free team is refused the same way', async () => {
  tier = null;
  const response = await request(app.getHttpServer())
    .post('/agent/llm/chat/completions')
    .set('authorization', `Bearer ${agentToken()}`)
    .send({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(response.status, 403);
  assert.equal(response.body.currentTier, 'free');
});

test('the old shared proxy token is not a way in', async () => {
  tier = 'max';
  process.env.AGENT_PROXY_TOKEN = 'the-token-every-installation-used-to-share';
  const response = await request(app.getHttpServer())
    .post('/agent/llm/chat/completions')
    .set('authorization', 'Bearer the-token-every-installation-used-to-share')
    .send({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
  delete process.env.AGENT_PROXY_TOKEN;

  assert.equal(response.status, 401);
});

test('an admitted team reaches spending, and is stopped there when Credit is exhausted', async () => {
  tier = 'plus';
  const response = await request(app.getHttpServer())
    .post('/agent/llm/chat/completions')
    .set('authorization', `Bearer ${agentToken()}`)
    .send({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] });

  // 402 and not 403: the plan was fine, the wallet was not — a top-up, not an upgrade.
  assert.equal(response.status, 402);
  assert.equal(response.body.reason, 'insufficient_credit');
  assert.equal(response.body.balanceCents, 0);
  assert.ok(response.body.requiredCents > 0);
});
