import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { PlanTier, Subscription, Team, User } from '@lobster/shared-types';

import { AGENT_TOKEN_TTL_SECONDS, type AuthService, type JwtPayload } from '../auth/auth.service';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import type { BillingRepository } from '../billing/billing.repository';
import type { TeamsRepository } from '../teams/teams.repository';
import { AgentRefusalException } from './agent-refusal';
import { AgentTokenController } from './agent-token.controller';

const SECRET = 'agent-token-test-secret';
const USER: User = {
  id: 'user-1',
  email: 'user@example.com',
  emailVerified: true,
} as unknown as User;

function team(id: string): Team {
  return { id, name: 'Team', ownerUserId: 'user-1', createdAt: new Date().toISOString() };
}

function createController(args: {
  tier: PlanTier | null;
  teams?: string[];
  memberOf?: string[];
}): AgentTokenController {
  const jwt = new JwtService({ secret: SECRET });
  const auth = {
    issueAgentToken: (input: { userId: string; email: string; teamId: string }) => ({
      token: jwt.sign({
        sub: input.userId,
        email: input.email,
        aud: 'agent',
        teamId: input.teamId,
      }),
      teamId: input.teamId,
      expiresInSeconds: AGENT_TOKEN_TTL_SECONDS,
    }),
  } as unknown as AuthService;
  const teams = {
    findTeamsForUser: async (): Promise<Team[]> => (args.teams ?? ['team-1']).map(team),
    getMembership: async (teamId: string) =>
      (args.memberOf ?? ['team-1']).includes(teamId) ? { teamId, userId: 'user-1' } : null,
  } as unknown as TeamsRepository;
  const billing = {
    getSubscription: async (teamId: string): Promise<Subscription | null> =>
      args.tier === null
        ? null
        : {
            teamId,
            tier: args.tier,
            profileLimit: 10,
            priceCents: 0,
            status: 'active',
            autoRenew: false,
          },
  } as unknown as BillingRepository;
  return new AgentTokenController(auth, teams, billing);
}

function request(): AuthenticatedRequest {
  return { headers: {}, user: USER };
}

test('a signed-in Plus user exchanges a session for a short-lived, team-scoped token', async () => {
  const controller = createController({ tier: 'plus' });
  const response = await controller.issue(request(), {});
  assert.equal(response.code, 0);
  assert.equal(response.data?.teamId, 'team-1');
  assert.equal(response.data?.tier, 'plus');
  assert.equal(response.data?.expiresInSeconds, AGENT_TOKEN_TTL_SECONDS);
  // Minutes, not days: this credential buys model time and travels to a sidecar process.
  assert.ok(AGENT_TOKEN_TTL_SECONDS <= 60 * 60);

  const claims = new JwtService({ secret: SECRET }).verify<JwtPayload>(response.data!.token);
  assert.equal(claims.aud, 'agent');
  assert.equal(claims.sub, 'user-1');
  assert.equal(claims.teamId, 'team-1');
});

test('a Free team is refused at the exchange, so the panel can upsell before a run starts', async () => {
  const controller = createController({ tier: null });
  await assert.rejects(controller.issue(request(), {}), (error: unknown) => {
    assert.ok(error instanceof AgentRefusalException);
    assert.equal(error.getStatus(), 403);
    assert.equal(error.body.currentTier, 'free');
    assert.equal(error.body.minimumTier, 'plus');
    return true;
  });
});

test('a Light team is refused at the exchange', async () => {
  const controller = createController({ tier: 'light' });
  await assert.rejects(controller.issue(request(), {}), AgentRefusalException);
});

test('a requested team the caller does not belong to is refused, not billed', async () => {
  const controller = createController({ tier: 'max', memberOf: ['team-1'] });
  await assert.rejects(
    controller.issue(request(), { teamId: 'someone-elses-team' }),
    ForbiddenException,
  );
});

test('a user with no team gets no spending credential', async () => {
  const controller = createController({ tier: 'max', teams: [] });
  await assert.rejects(controller.issue(request(), {}), ForbiddenException);
});
