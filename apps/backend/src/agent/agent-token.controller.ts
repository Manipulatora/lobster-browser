import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { planAllowsAgent, type PlanTier } from '@lobster/shared-types';

import { AuthService } from '../auth/auth.service';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { BILLING_REPOSITORY, type BillingRepository } from '../billing/billing.repository';
import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import { ok, type ApiResponse } from '../common/api-response';
import { AgentRefusalFilter, planRequired } from './agent-refusal';

export class AgentTokenDto {
  /** Which team to spend for. Omitted by the desktop, which has exactly one. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  teamId?: string;
}

/** What the desktop gets back: the scoped token, the team it spends for, and when to renew. */
export interface AgentTokenResponse {
  token: string;
  teamId: string;
  tier: PlanTier;
  expiresInSeconds: number;
}

/**
 * Exchange a desktop session for a short-lived, team-scoped agent token.
 *
 * WHY AN EXCHANGE RATHER THAN SHIPPING A CREDENTIAL. The alternative — a long-lived secret baked
 * into the installer — is the same shared-token mistake this replaces, just distributed more
 * widely: it identifies nobody, expires never, and one copy pulled off one machine spends the
 * operator's model balance for everyone. Here the desktop already holds a session it earned
 * through the loopback handoff, and trades it for a credential that is narrow (agent audience
 * only), attributable (one user, one team) and short-lived, so a leaked copy is worth minutes.
 *
 * The plan is checked HERE as well as on every call, so the panel can render its upsell before a
 * run starts rather than at the first model call — the refusal body is the same either way.
 */
@Controller('agent')
@UseFilters(AgentRefusalFilter)
export class AgentTokenController {
  constructor(
    private readonly auth: AuthService,
    @Inject(TEAMS_REPOSITORY) private readonly teams: TeamsRepository,
    @Inject(BILLING_REPOSITORY) private readonly billing: BillingRepository,
  ) {}

  @Post('token')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, EmailVerifiedGuard)
  async issue(
    @Req() request: AuthenticatedRequest,
    @Body() dto: AgentTokenDto,
  ): Promise<ApiResponse<AgentTokenResponse>> {
    const user = request.user;
    if (!user) throw new UnauthorizedException();

    const teamId = await this.resolveTeamId(user.id, dto.teamId);
    const subscription = await this.billing.getSubscription(teamId);
    const tier: PlanTier =
      subscription && subscription.status === 'active' ? subscription.tier : 'free';
    if (!planAllowsAgent(tier)) throw planRequired(tier);

    const { token, expiresInSeconds } = this.auth.issueAgentToken({
      userId: user.id,
      email: user.email,
      teamId,
    });
    return ok({ token, teamId, tier, expiresInSeconds });
  }

  /**
   * Mirrors BillingService: an explicit team is honoured only after membership is verified, and
   * otherwise the caller's own team is used. A team id taken on trust here would bake someone
   * else's wallet into a spending credential.
   */
  private async resolveTeamId(userId: string, requested?: string): Promise<string> {
    if (requested) {
      const membership = await this.teams.getMembership(requested, userId);
      if (!membership) throw new ForbiddenException('you are not a member of the requested team');
      return requested;
    }
    const teams = await this.teams.findTeamsForUser(userId);
    const first = teams[0];
    if (!first) throw new ForbiddenException('you do not belong to any team');
    return first.id;
  }
}
