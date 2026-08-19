import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { planAllowsAgent, type PlanTier } from '@lobster/shared-types';

import { AuthService, type JwtPayload } from '../auth/auth.service';
import { BILLING_REPOSITORY, type BillingRepository } from '../billing/billing.repository';
import { planRequired } from './agent-refusal';

/** Who is spending, and on whose wallet. Every metered decision downstream reads this and nothing else. */
export interface AgentPrincipal {
  userId: string;
  teamId: string;
  tier: PlanTier;
  /** The browser profile the run drives, for attributing the usage row. Client-supplied, advisory. */
  profileId?: string;
  /** The Lobee run this call belongs to, so a whole run can be totalled. */
  sessionId?: string;
}

export interface AgentRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Populated by {@link AgentAuthGuard} once the agent token is verified and the plan checked. */
  agent?: AgentPrincipal;
}

/** Bounded so a hostile client cannot use an attribution header as a free write channel. */
const MAX_ATTRIBUTION_LENGTH = 128;

/**
 * Guards the managed agent-LLM proxy: identity first, entitlement second.
 *
 * WHAT REPLACED WHAT. This endpoint used to accept one static `AGENT_PROXY_TOKEN` shared by every
 * installation. That token said nothing about who was calling, which made the two things this
 * endpoint most needs to know — which team's wallet to charge, and whether that team bought a
 * package that includes the agent — literally unanswerable, and made a single leaked string a
 * licence to spend the operator's model balance without limit. It is gone. A caller now presents a
 * short-lived `agent`-audience JWT carrying its own user and team (see `POST /agent/token`).
 *
 * THE PLAN IS CHECKED HERE AND NOT ONLY AT MINT TIME. A token outlives the state it was minted
 * under: a team that downgrades, cancels or lapses mid-run would otherwise keep spending until the
 * token expired. Re-reading the subscription per call is a cheap indexed lookup and is the only
 * point at which "Plus and up" is actually true.
 */
@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
    @Inject(BILLING_REPOSITORY) private readonly billing: BillingRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AgentRequest>();
    const token = bearerToken(request);
    if (!token) throw new UnauthorizedException('missing agent token');

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token, { secret: this.auth.jwtSecret });
    } catch {
      throw new UnauthorizedException('invalid or expired agent token');
    }
    // A session token must not reach the metered path. It carries no team, so honouring it would
    // mean picking a wallet on the caller's behalf on an endpoint that spends money.
    if (payload.aud !== 'agent' || !payload.teamId) {
      throw new UnauthorizedException('this endpoint requires an agent token');
    }

    const tier = await this.resolveTier(payload.teamId);
    if (!planAllowsAgent(tier)) throw planRequired(tier);

    request.agent = {
      userId: payload.sub,
      teamId: payload.teamId,
      tier,
      profileId: attribution(request, 'x-lobster-profile-id'),
      sessionId: attribution(request, 'x-lobster-session-id'),
    };
    return true;
  }

  /**
   * A team with no subscription row, or one that is not currently active, is on `free`. A lapsed
   * package is not a reduced package — an expired Plus buys no agent time.
   */
  private async resolveTier(teamId: string): Promise<PlanTier> {
    const subscription = await this.billing.getSubscription(teamId);
    if (!subscription || subscription.status !== 'active') return 'free';
    return subscription.tier;
  }
}

function bearerToken(request: AgentRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

/** Attribution only: these name a profile or a run for the usage row, never a wallet. */
function attribution(request: AgentRequest, header: string): string | undefined {
  const value = request.headers[header];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ATTRIBUTION_LENGTH) return undefined;
  return trimmed;
}
