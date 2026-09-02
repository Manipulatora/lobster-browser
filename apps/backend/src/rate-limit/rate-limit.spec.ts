import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { Controller, Get, Module, Post } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';

import type { JwtPayload } from '../auth/auth.service';
import {
  MemoryRateLimitStore,
  RATE_LIMIT_DEFAULTS,
  RATE_LIMIT_ENV,
  classifyRoute,
  createRateLimitMiddleware,
  ipBucket,
  principalFromBearer,
  resolveRateLimitPolicies,
  type RateLimitClass,
  type RateLimitPolicies,
  type RateLimitStore,
} from './rate-limit';

/**
 * The classification table, as a table. Each row is a route the product actually serves (or a
 * spelling of one an attacker might try), and the budget it must land in. A route that moves
 * between classes is a product decision and has to be made here, visibly.
 */
const ROUTES: ReadonlyArray<[method: string, path: string, expected: RateLimitClass]> = [
  ['POST', '/auth/login', 'auth'],
  ['POST', '/auth/register', 'auth'],
  ['POST', '/auth/desktop/grant', 'auth'],
  ['POST', '/auth/desktop/exchange', 'auth'],
  ['POST', '/auth/verify-email', 'auth'],
  ['POST', '/auth/resend-verification/session', 'auth'],
  // Express routes case-insensitively and tolerates a trailing slash; the classifier must too, or
  // a flood picks whichever spelling lands in the laxest class.
  ['POST', '/AUTH/LOGIN', 'auth'],
  ['POST', '/auth/login/', 'auth'],
  ['POST', '/auth/%6Cogin', 'auth'],
  ['POST', '//auth//login', 'auth'],
  // The session check is signed-in traffic, not a guessing surface.
  ['GET', '/auth/me', 'general'],
  ['POST', '/auth/me', 'auth'],
  ['GET', '/profiles', 'sync'],
  ['POST', '/profiles', 'sync'],
  ['POST', '/profiles/bulk', 'sync'],
  ['GET', '/profiles/export', 'sync'],
  ['GET', '/profiles/p-1', 'sync'],
  ['POST', '/profiles/p-1/sync', 'sync'],
  ['GET', '/profiles/p-1/lease', 'leases'],
  ['POST', '/profiles/p-1/lease', 'leases'],
  ['POST', '/profiles/p-1/lease/refresh', 'leases'],
  ['DELETE', '/profiles/p-1/lease', 'leases'],
  ['GET', '/leases', 'leases'],
  ['POST', '/agent/llm/chat/completions', 'agent'],
  ['GET', '/agent/llm/models', 'agent'],
  ['GET', '/agent/llm/usage', 'agent'],
  // Minting an agent token needs a valid session, so it is not a guessing surface, and a run that
  // cannot mint cannot start — it belongs with the signed-in traffic.
  ['POST', '/agent/token', 'general'],
  ['GET', '/billing/overview', 'general'],
  ['POST', '/billing/webhook', 'general'],
  ['GET', '/teams', 'general'],
  ['GET', '/vault/key', 'general'],
  ['GET', '/automation/whoami', 'general'],
  ['GET', '/', 'general'],
  ['GET', '/nonexistent', 'general'],
  ['GET', '/health', 'exempt'],
  ['GET', '/health/ready', 'exempt'],
  ['GET', '/health/agent', 'exempt'],
  ['OPTIONS', '/profiles', 'exempt'],
  ['OPTIONS', '/auth/login', 'exempt'],
];

test('every route lands in the budget the product decided for it', () => {
  for (const [method, path, expected] of ROUTES) {
    assert.equal(classifyRoute(method, path), expected, `${method} ${path}`);
  }
});

test('budgets come from the environment, clamped, with the old single knob feeding general only', () => {
  const defaults = resolveRateLimitPolicies({});
  for (const cls of ['auth', 'sync', 'leases', 'agent', 'general'] as const) {
    assert.equal(defaults[cls].limit, RATE_LIMIT_DEFAULTS[cls].limit);
    assert.equal(defaults[cls].key, RATE_LIMIT_DEFAULTS[cls].key);
    assert.equal(defaults[cls].windowMs, 60_000);
  }
  // The credential surface is the strict one and the only per-address one.
  assert.equal(defaults.auth.key, 'ip');
  assert.ok(defaults.auth.limit < defaults.sync.limit);
  assert.ok(defaults.sync.limit < defaults.agent.limit);

  const tuned = resolveRateLimitPolicies({
    RATE_LIMIT_WINDOW_MS: '30000',
    RATE_LIMIT_AUTH_MAX: '5',
    RATE_LIMIT_AGENT_MAX: '2000',
    RATE_LIMIT_MAX: '77',
  });
  assert.equal(tuned.auth.limit, 5);
  assert.equal(tuned.agent.limit, 2000);
  assert.equal(tuned.general.limit, 77, 'RATE_LIMIT_MAX keeps meaning the catch-all budget');
  assert.equal(tuned.sync.limit, RATE_LIMIT_DEFAULTS.sync.limit, 'it does not leak into sync');
  assert.equal(tuned.auth.windowMs, 30_000);

  const explicitWins = resolveRateLimitPolicies({
    RATE_LIMIT_MAX: '77',
    RATE_LIMIT_GENERAL_MAX: '9',
  });
  assert.equal(explicitWins.general.limit, 9);

  // A typo degrades to the default, never to no limit.
  const garbage = resolveRateLimitPolicies({
    RATE_LIMIT_AUTH_MAX: 'lots',
    RATE_LIMIT_SYNC_MAX: '0',
    RATE_LIMIT_WINDOW_MS: '-5',
  });
  assert.equal(garbage.auth.limit, RATE_LIMIT_DEFAULTS.auth.limit);
  assert.equal(garbage.sync.limit, 1, 'zero clamps to the floor of one, not to unlimited');
  assert.equal(garbage.auth.windowMs, 1_000);
});

test('the memory store counts within a fixed window and forgets it afterwards', async () => {
  const store = new MemoryRateLimitStore();
  const t0 = 1_000_000;
  assert.deepEqual(await store.hit('k', 1000, t0), { count: 1, resetAt: t0 + 1000 });
  assert.deepEqual(await store.hit('k', 1000, t0 + 500), { count: 2, resetAt: t0 + 1000 });
  assert.deepEqual(await store.hit('other', 1000, t0 + 500), { count: 1, resetAt: t0 + 1500 });
  // The window ends; the next hit opens a new one.
  assert.deepEqual(await store.hit('k', 1000, t0 + 1000), { count: 1, resetAt: t0 + 2000 });
  assert.equal(store.size, 2);
  // Expired windows are swept on a later hit, so an address seen once does not live forever.
  await store.hit('late', 1000, t0 + 120_000);
  assert.equal(store.size, 1);
});

test('an address is bucketed as its host, and IPv6 as its /64', () => {
  assert.equal(ipBucket('203.0.113.9'), '203.0.113.9');
  assert.equal(ipBucket('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(ipBucket('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2');
  // Two addresses in one /64 are one client; a different /64 is a different one.
  assert.equal(ipBucket('2001:0db8:0001:0002::9'), ipBucket('2001:db8:1:2:ffff::1'));
  assert.notEqual(ipBucket('2001:db8:1:2::1'), ipBucket('2001:db8:1:3::1'));
  assert.equal(ipBucket('fe80::1%eth0'), 'fe80:0:0:0');
  assert.equal(ipBucket(undefined), 'unknown');
});

test('the principal is the verified token, never the decoded one', () => {
  const verify = (token: string): JwtPayload => {
    if (token === 'session') return { sub: 'user-1', email: 'a@b' };
    if (token === 'agent') return { sub: 'user-1', email: 'a@b', aud: 'agent', teamId: 'team-9' };
    if (token === 'agent-no-team') return { sub: 'user-1', email: 'a@b', aud: 'agent' };
    throw new Error('bad signature');
  };
  const principalOf = principalFromBearer(verify);
  const withHeader = (authorization?: string): Request =>
    ({ headers: authorization ? { authorization } : {} }) as unknown as Request;

  assert.equal(principalOf(withHeader()), undefined);
  assert.equal(principalOf(withHeader('Basic session')), undefined);
  assert.equal(principalOf(withHeader('Bearer session')), 'user:user-1');
  assert.equal(principalOf(withHeader('Bearer agent')), 'team:team-9');
  assert.equal(principalOf(withHeader('Bearer agent-no-team')), undefined);
  // A token that does not verify is anonymous traffic, whatever its claims say.
  assert.equal(principalOf(withHeader('Bearer forged')), undefined);
});

/** What the middleware did with one request: passed it on, or answered it. */
interface Outcome {
  next: boolean;
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
}

/** Drive the middleware with a fake request and wait for it to decide. */
function dispatch(
  middleware: ReturnType<typeof createRateLimitMiddleware>,
  args: { method?: string; path: string; ip?: string; authorization?: string },
): Promise<Outcome> {
  const req = {
    method: args.method ?? 'GET',
    path: args.path,
    ip: args.ip ?? '10.0.0.1',
    headers: args.authorization ? { authorization: args.authorization } : {},
    socket: { remoteAddress: args.ip ?? '10.0.0.1' },
  } as unknown as Request;
  return new Promise((done) => {
    const outcome: Outcome = { next: false, headers: {} };
    const res = {
      setHeader: (name: string, value: string) => {
        outcome.headers[name.toLowerCase()] = value;
      },
      status: (code: number) => {
        outcome.status = code;
        return res;
      },
      json: (body: unknown) => {
        outcome.body = body;
        done(outcome);
        return res;
      },
    };
    middleware(req, res as unknown as Parameters<typeof middleware>[1], () => {
      outcome.next = true;
      done(outcome);
    });
  });
}

function tinyPolicies(): RateLimitPolicies {
  const base = resolveRateLimitPolicies({});
  return {
    auth: { ...base.auth, limit: 2 },
    sync: { ...base.sync, limit: 2 },
    leases: { ...base.leases, limit: 2 },
    agent: { ...base.agent, limit: 2 },
    general: { ...base.general, limit: 2 },
  };
}

/** Session tokens are `user:<sub>`, agent tokens `team:<team>`; anything else is anonymous. */
const principalOf = principalFromBearer((token: string): JwtPayload => {
  const [kind, id] = token.split('/');
  if (kind === 'user') return { sub: id, email: 'x@y' };
  if (kind === 'team') return { sub: 'someone', email: 'x@y', aud: 'agent', teamId: id };
  throw new Error('unverifiable');
});

test('classes are separate budgets and a principal is separate from its neighbours', async () => {
  const middleware = createRateLimitMiddleware({
    policies: tinyPolicies(),
    store: new MemoryRateLimitStore(),
    principalOf,
  });
  const alice = { path: '/profiles', authorization: 'Bearer user/alice' };
  assert.equal((await dispatch(middleware, alice)).next, true);
  assert.equal((await dispatch(middleware, alice)).next, true);
  const refused = await dispatch(middleware, alice);
  assert.equal(refused.next, false);
  assert.equal(refused.status, 429);

  // Alice's spent sync budget touches neither her lease refreshes nor her agent steps …
  assert.equal((await dispatch(middleware, { ...alice, path: '/leases' })).next, true);
  assert.equal(
    (await dispatch(middleware, { path: '/agent/llm/models', authorization: 'Bearer team/t1' }))
      .next,
    true,
  );
  // … nor Bob behind the same address, nor an anonymous caller from that address.
  assert.equal(
    (await dispatch(middleware, { path: '/profiles', authorization: 'Bearer user/bob' })).next,
    true,
  );
  assert.equal((await dispatch(middleware, { path: '/profiles' })).next, true);
});

test('the auth class is spent per address even when a token is presented', async () => {
  const middleware = createRateLimitMiddleware({
    policies: tinyPolicies(),
    store: new MemoryRateLimitStore(),
    principalOf,
  });
  const login = { method: 'POST', path: '/auth/login', ip: '198.51.100.7' };
  assert.equal(
    (await dispatch(middleware, { ...login, authorization: 'Bearer user/a' })).next,
    true,
  );
  assert.equal(
    (await dispatch(middleware, { ...login, authorization: 'Bearer user/b' })).next,
    true,
  );
  // A third attempt from the address is refused no matter whose token rides along.
  assert.equal(
    (await dispatch(middleware, { ...login, authorization: 'Bearer user/c' })).status,
    429,
  );
  // Another address is untouched.
  assert.equal((await dispatch(middleware, { ...login, ip: '198.51.100.8' })).next, true);
});

test('a refusal is the API envelope with the headers a client needs to back off', async () => {
  const t0 = 5_000_000;
  const middleware = createRateLimitMiddleware({
    policies: tinyPolicies(),
    store: new MemoryRateLimitStore(),
    principalOf,
    now: () => t0,
  });
  const call = { path: '/teams', authorization: 'Bearer user/alice' };
  const first = await dispatch(middleware, call);
  assert.equal(first.headers['ratelimit-limit'], '2');
  assert.equal(first.headers['ratelimit-remaining'], '1');
  assert.equal(first.headers['ratelimit-reset'], '60');
  await dispatch(middleware, call);
  const refused = await dispatch(middleware, call);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers['ratelimit-remaining'], '0');
  assert.equal(refused.headers['retry-after'], '60');
  // `{ code, data, msg }` like every other answer — the previous limiter's plain-text body was the
  // one response in the product a client could not parse.
  assert.deepEqual(refused.body, {
    code: 1,
    data: null,
    msg: 'too many requests: the general limit of 2 per 60s is spent; retry in 60s',
  });
});

test('health is never counted, and a failing store admits rather than refuses', async () => {
  const warnings: string[] = [];
  let hits = 0;
  const broken: RateLimitStore = {
    hit: async () => {
      hits += 1;
      throw new Error('redis down');
    },
  };
  const middleware = createRateLimitMiddleware({
    policies: tinyPolicies(),
    store: broken,
    principalOf,
    logger: { warn: (message: string) => void warnings.push(message) },
  });
  assert.equal((await dispatch(middleware, { path: '/health/ready' })).next, true);
  assert.equal(hits, 0, 'an exempt route must not even touch the store');

  for (let i = 0; i < 5; i += 1) {
    assert.equal((await dispatch(middleware, { path: '/teams' })).next, true);
  }
  assert.equal(hits, 5);
  assert.equal(warnings.length, 1, 'the fault is reported once, not once per request');
  assert.match(warnings[0], /redis down/);
});

test('every budget an operator can turn is documented in the example env', async () => {
  const example = await readFile(resolve(process.cwd(), '.env.example'), 'utf8');
  for (const variable of [...Object.values(RATE_LIMIT_ENV), 'RATE_LIMIT_WINDOW_MS']) {
    assert.ok(
      example.includes(variable),
      `${variable} changes the API's behaviour and must be documented`,
    );
  }
});

/**
 * Over real HTTP, wired the way `main.ts` wires it: the middleware in front of Nest, the principal
 * taken from a token the real JwtService verifies. This is what proves a forged token cannot spend
 * someone else's budget, which the fake above only asserts by construction.
 */
const SECRET = 'rate-limit-spec-secret';

@Controller()
class ProbeController {
  @Post('auth/login')
  login(): { ok: true } {
    return { ok: true };
  }

  @Get('profiles')
  profiles(): { ok: true } {
    return { ok: true };
  }

  @Get('agent/llm/models')
  models(): { ok: true } {
    return { ok: true };
  }

  @Get('health')
  health(): { ok: true } {
    return { ok: true };
  }
}

@Module({ imports: [JwtModule.register({ secret: SECRET })], controllers: [ProbeController] })
class ProbeModule {}

let app: NestExpressApplication;
let jwt: JwtService;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  jwt = app.get(JwtService);
  app.use(
    createRateLimitMiddleware({
      policies: resolveRateLimitPolicies({
        RATE_LIMIT_AUTH_MAX: '2',
        RATE_LIMIT_SYNC_MAX: '2',
        RATE_LIMIT_AGENT_MAX: '2',
      }),
      store: new MemoryRateLimitStore(),
      principalOf: principalFromBearer((token) =>
        jwt.verify<JwtPayload>(token, { secret: SECRET }),
      ),
    }),
  );
  await app.init();
});

after(async () => {
  await app?.close();
});

test('over HTTP: sign-in is throttled per address and answers in the envelope', async () => {
  const server = app.getHttpServer();
  assert.equal((await request(server).post('/auth/login')).status, 201);
  assert.equal((await request(server).post('/auth/login')).status, 201);
  const refused = await request(server).post('/auth/login');
  assert.equal(refused.status, 429);
  assert.equal(refused.body.code, 1);
  assert.match(refused.body.msg, /auth limit of 2/);
  assert.ok(Number(refused.headers['retry-after']) >= 1);
  // Health keeps answering while the address is throttled.
  assert.equal((await request(server).get('/health')).status, 200);
});

test('over HTTP: a team spends its own agent budget and a forged token cannot spend it', async () => {
  const server = app.getHttpServer();
  const genuine = jwt.sign(
    { sub: 'user-1', email: 'u@example.com', aud: 'agent', teamId: 'team-A' },
    { secret: SECRET },
  );
  const forged = jwt.sign(
    { sub: 'user-1', email: 'u@example.com', aud: 'agent', teamId: 'team-A' },
    { secret: 'not-the-secret' },
  );
  // Two forged requests naming team-A: verification fails, so they are the caller's own
  // per-address traffic and leave team-A's budget untouched.
  for (let i = 0; i < 2; i += 1) {
    const res = await request(server)
      .get('/agent/llm/models')
      .set('authorization', `Bearer ${forged}`);
    assert.equal(res.headers['ratelimit-remaining'], String(1 - i));
  }
  const first = await request(server)
    .get('/agent/llm/models')
    .set('authorization', `Bearer ${genuine}`);
  assert.equal(first.status, 200);
  assert.equal(first.headers['ratelimit-remaining'], '1', 'team-A starts with a full budget');
  await request(server).get('/agent/llm/models').set('authorization', `Bearer ${genuine}`);
  const refused = await request(server)
    .get('/agent/llm/models')
    .set('authorization', `Bearer ${genuine}`);
  assert.equal(refused.status, 429);
  assert.match(refused.body.msg, /agent limit of 2/);
});

test('over HTTP: two users behind one address sync from separate budgets', async () => {
  const server = app.getHttpServer();
  const token = (sub: string): string =>
    jwt.sign({ sub, email: `${sub}@example.com` }, { secret: SECRET });
  for (let i = 0; i < 2; i += 1) {
    assert.equal(
      (
        await request(server)
          .get('/profiles')
          .set('authorization', `Bearer ${token('alice')}`)
      ).status,
      200,
    );
  }
  assert.equal(
    (
      await request(server)
        .get('/profiles')
        .set('authorization', `Bearer ${token('alice')}`)
    ).status,
    429,
  );
  assert.equal(
    (
      await request(server)
        .get('/profiles')
        .set('authorization', `Bearer ${token('bob')}`)
    ).status,
    200,
  );
});
