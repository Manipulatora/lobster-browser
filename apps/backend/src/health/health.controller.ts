import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Public } from '../auth/public.decorator';
import { ok, type ApiResponse } from '../common/api-response';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Liveness + readiness probes.
 *
 * - `GET /health` — always 200 when the process is up (load balancer liveness).
 * - `GET /health/ready` — 503 in production (or when `HEALTH_REQUIRE_DB=1`) if Postgres
 *   is configured but unreachable; 200 otherwise (SEC-6 readiness).
 * - `GET /health/agent` — always 200; whether the managed Lobee agent has an operator credential.
 */
// Public by design: load balancers and uptime checks have no session, and a health probe that
// requires one measures the auth layer, not the service.
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  check(): ApiResponse<{ status: 'ok' }> {
    return ok({ status: 'ok' });
  }

  /**
   * Readiness.
   *
   * THE PASS/FAIL CONTRACT IS POSTGRES AND NOTHING ELSE, and it has to stay that way: the unit's
   * `ExecStartPost` polls this route and fails the whole service if it never answers 200, so
   * anything allowed to flip it to 503 also gains the power to block a deploy. `agentCredential`
   * therefore rides along as a REPORTED field and never as a verdict — a backend with no OpenRouter
   * key is a working backend that cannot serve one feature, not a broken one, and taking sign-in,
   * profile sync and billing down over it would be a far worse outage than the one it describes.
   */
  @Get('ready')
  async ready(): Promise<
    ApiResponse<{
      status: 'ready';
      database: 'up' | 'skipped';
      agentCredential: AgentCredentialState;
    }>
  > {
    const requireDb =
      this.config.get<string>('NODE_ENV') === 'production' ||
      this.config.get<string>('HEALTH_REQUIRE_DB') === '1';
    const databaseUrl = this.config.get<string>('DATABASE_URL');
    const agentCredential = this.agentCredential();

    if (!requireDb || !databaseUrl) {
      return ok({ status: 'ready', database: 'skipped', agentCredential });
    }

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return ok({ status: 'ready', database: 'up', agentCredential });
    } catch {
      throw new ServiceUnavailableException('database unavailable');
    }
  }

  /**
   * Why the managed agent can or cannot run, on a route of its own.
   *
   * ALWAYS 200. This answers "what state is it in", and a probe that fails is a probe an operator
   * has to interpret before they can read the answer — the point of this route is that the answer
   * is legible without one. Following the docs used to leave a backend with no `OPENROUTER_API_KEY`
   * at all (`.env.example` did not list it), which started clean, passed the readiness probe, and
   * failed at the first user request; this is where that gap is now visible before a customer finds
   * it.
   *
   * The variable is NAMED here even though `/health` is reachable through the public vhost: a
   * variable name is not a secret, its VALUE never appears in any response, and an operator who
   * cannot see which knob is missing cannot turn it. What is NOT reported is whether the key still
   * WORKS — that would mean spending a provider round-trip on every uptime poll. A key that is
   * present but revoked shows up as `agent/llm OPERATOR_FAULT` in the journal instead.
   */
  @Get('agent')
  agent(): ApiResponse<{
    status: 'ok' | 'disabled';
    component: 'agent-openrouter-credential';
    credential: AgentCredentialState;
    variable: 'OPENROUTER_API_KEY';
    detail: string;
  }> {
    const credential = this.agentCredential();
    return ok({
      status: credential === 'configured' ? 'ok' : 'disabled',
      component: 'agent-openrouter-credential',
      credential,
      variable: 'OPENROUTER_API_KEY',
      detail:
        credential === 'configured'
          ? 'An operator OpenRouter credential is configured. This does not prove the provider still accepts it.'
          : 'No operator OpenRouter credential is configured: managed Lobee calls answer 503 and the model roster is empty. Everything else on this backend is unaffected.',
    });
  }

  /** Present or absent. Never the value, and never a call to the provider to find out if it works. */
  private agentCredential(): AgentCredentialState {
    return this.config.get<string>('OPENROUTER_API_KEY')?.trim() ? 'configured' : 'missing';
  }
}

/**
 * The agent's operator credential, as the health surface reports it.
 *
 * A separate word from the readiness verdict on purpose — see {@link HealthController.ready} for why
 * `missing` must never make the probe fail.
 */
export type AgentCredentialState = 'configured' | 'missing';
