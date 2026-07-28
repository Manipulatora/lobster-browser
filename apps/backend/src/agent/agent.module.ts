import { Module } from '@nestjs/common';

import { AgentLlmController } from './agent-llm.controller';
import { AgentLlmService } from './agent-llm.service';
import { AgentProxyGuard } from './agent-proxy.guard';

/**
 * Managed agent-LLM feature — the server-side OpenRouter broker + metering for managed (non-BYOK)
 * agent runs. `ConfigService` is global (AppModule). No DB dependency: metering is process-aggregate
 * for now (a subscription-tied meter is a follow-up once billing is live).
 */
@Module({
  controllers: [AgentLlmController],
  providers: [AgentLlmService, AgentProxyGuard],
})
export class AgentModule {}
