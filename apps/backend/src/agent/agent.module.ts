import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { AgentAuthGuard } from './agent-auth.guard';
import { AgentLlmController } from './agent-llm.controller';
import { AgentLlmService } from './agent-llm.service';
import { AgentTokenController } from './agent-token.controller';

/**
 * Managed agent-LLM feature — the server-side OpenRouter broker for managed (non-BYOK) agent runs.
 *
 * Imports AuthModule for the JWT machinery behind both the session guard on the token exchange and
 * the agent-token guard on the proxy, and BillingModule for `AgentSpendService` and the
 * subscription read the entitlement check depends on. Agent spend deliberately has no wallet
 * mechanism of its own: there is exactly one place in the product where Credit moves.
 */
@Module({
  imports: [AuthModule, BillingModule],
  controllers: [AgentTokenController, AgentLlmController],
  providers: [AgentLlmService, AgentAuthGuard],
})
export class AgentModule {}
