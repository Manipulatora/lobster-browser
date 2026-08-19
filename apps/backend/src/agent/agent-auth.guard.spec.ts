import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { PlanTier, Subscription, SubscriptionStatus } from '@lobster/shared-types';

import type { AuthService } from '../auth/auth.service';
import type { BillingRepository } from '../billing/billing.repository';
import { AgentAuthGuard, type AgentRequest } from './agent-auth.guard';
import { AgentRefusalException } from './agent-refusal';

const SECRET = 'agent-guard-test-secret';

function subscription(tier: PlanTier, status: SubscriptionStatus = 'active'): Subscription {
  return { teamId: 'team-1', tier, profileLimit: 10, priceCents: 0, status, autoRenew: false };
}

function createGuard(tier: PlanTier | null, status: SubscriptionStatus = 'active'): AgentAuthGuard {
  const jwt = new JwtService({ secret: SECRET });
  const auth = { jwtSecret: SECRET } as unknown as AuthService;
  const billing = {
    getSubscription: async (): Promise<Subscription | null> =>
      tier === null ? null : subscription(tier, status),
  } as unknown as BillingRepository;
  return new AgentAuthGuard(jwt, auth, billing);
}

function contextFor(headers: Record<string, string>): {
  context: ExecutionContext;
  request: AgentRequest;
} {
  const request: AgentRequest = { headers };
  return {
    context: {
      switchToHttp: () => ({ getRequest: <T>(): T => request as unknown as T }),
    } as unknown as ExecutionContext,
    request,
  };
}

function agentToken(claims: Record<string, unknown> = {}): string {
  return new JwtService({ secret: SECRET }).sign({
    sub: 'user-1',
    email: 'user@example.com',
    aud: 'agent',
    teamId: 'team-1',
    ...claims,
  });
}

for (const tier of ['plus', 'pro', 'max'] as const) {
  test(`a ${tier} team may run the agent`, async () => {
    const guard = createGuard(tier);
    const { context, request } = contextFor({ authorization: `Bearer ${agentToken()}` });
    assert.equal(await guard.canActivate(context), true);
    assert.deepEqual(request.agent, {
      userId: 'user-1',
      teamId: 'team-1',
      tier,
      profileId: undefined,
      sessionId: undefined,
    });
  });
}

for (const tier of ['free', 'light'] as const) {
  test(`a ${tier} team is refused with a named upsell, not a generic error`, async () => {
    const guard = createGuard(tier === 'free' ? null : tier);
    const { context } = contextFor({ authorization: `Bearer ${agentToken()}` });
    await assert.rejects(guard.canActivate(context), (error: unknown) => {
      assert.ok(error instanceof AgentRefusalException);
      assert.equal(error.getStatus(), 403);
      assert.equal(error.body.reason, 'plan_required');
      // The panel renders the upgrade button from these, not from the sentence.
      assert.equal(error.body.currentTier, tier);
      assert.deepEqual(error.body.requiredTiers, ['plus', 'pro', 'max']);
      assert.equal(error.body.minimumTier, 'plus');
      return true;
    });
  });
}

test('Light is refused even though it is a paid package', async () => {
  // Deliberate, and it matches what the pricing page sells: agent time is metered spend, and the
  // entry package is not priced to carry it.
  const guard = createGuard('light');
  const { context } = contextFor({ authorization: `Bearer ${agentToken()}` });
  await assert.rejects(guard.canActivate(context), AgentRefusalException);
});

test('a lapsed package buys no agent time', async () => {
  const guard = createGuard('pro', 'past_due');
  const { context } = contextFor({ authorization: `Bearer ${agentToken()}` });
  await assert.rejects(guard.canActivate(context), (error: unknown) => {
    assert.ok(error instanceof AgentRefusalException);
    assert.equal(error.body.currentTier, 'free');
    return true;
  });
});

test('an ordinary session token is not an agent token', async () => {
  const guard = createGuard('max');
  const session = new JwtService({ secret: SECRET }).sign({
    sub: 'user-1',
    email: 'user@example.com',
    aud: 'desktop',
  });
  const { context } = contextFor({ authorization: `Bearer ${session}` });
  // It carries no team, so honouring it would mean choosing a wallet on the caller's behalf.
  await assert.rejects(guard.canActivate(context), UnauthorizedException);
});

test('an agent token missing its team is refused', async () => {
  const guard = createGuard('max');
  const token = new JwtService({ secret: SECRET }).sign({
    sub: 'user-1',
    email: 'user@example.com',
    aud: 'agent',
  });
  const { context } = contextFor({ authorization: `Bearer ${token}` });
  await assert.rejects(guard.canActivate(context), UnauthorizedException);
});

test('a token signed with another secret is refused', async () => {
  const guard = createGuard('max');
  const forged = new JwtService({ secret: 'not-the-secret' }).sign({
    sub: 'user-1',
    email: 'user@example.com',
    aud: 'agent',
    teamId: 'team-1',
  });
  const { context } = contextFor({ authorization: `Bearer ${forged}` });
  await assert.rejects(guard.canActivate(context), UnauthorizedException);
});

test('an expired agent token is refused', async () => {
  const guard = createGuard('max');
  const expired = new JwtService({ secret: SECRET }).sign(
    { sub: 'user-1', email: 'user@example.com', aud: 'agent', teamId: 'team-1' },
    { expiresIn: -10 },
  );
  const { context } = contextFor({ authorization: `Bearer ${expired}` });
  await assert.rejects(guard.canActivate(context), UnauthorizedException);
});

test('a missing bearer header is refused', async () => {
  const guard = createGuard('max');
  const { context } = contextFor({});
  await assert.rejects(guard.canActivate(context), UnauthorizedException);
});

test('attribution headers name a profile and a run, never a wallet', async () => {
  const guard = createGuard('plus');
  const { context, request } = contextFor({
    authorization: `Bearer ${agentToken()}`,
    'x-lobster-profile-id': 'profile-9',
    'x-lobster-session-id': 'session-4',
  });
  await guard.canActivate(context);
  assert.equal(request.agent?.profileId, 'profile-9');
  assert.equal(request.agent?.sessionId, 'session-4');
  // The team still comes from the signed claims, not from anything the client sent.
  assert.equal(request.agent?.teamId, 'team-1');
});

test('an oversized attribution header is dropped rather than stored', async () => {
  const guard = createGuard('plus');
  const { context, request } = contextFor({
    authorization: `Bearer ${agentToken()}`,
    'x-lobster-profile-id': 'p'.repeat(500),
  });
  await guard.canActivate(context);
  assert.equal(request.agent?.profileId, undefined);
});

test('the team is taken from the token, never from a header the caller controls', async () => {
  const guard = createGuard('plus');
  const { context, request } = contextFor({
    authorization: `Bearer ${agentToken({ teamId: 'team-1' })}`,
    'x-team-id': 'someone-elses-team',
  });
  await guard.canActivate(context);
  assert.equal(request.agent?.teamId, 'team-1');
});
