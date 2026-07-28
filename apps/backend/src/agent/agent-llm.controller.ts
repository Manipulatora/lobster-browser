import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';

import { AgentLlmService } from './agent-llm.service';
import { AgentProxyGuard } from './agent-proxy.guard';

/**
 * Managed agent-LLM proxy (`/agent/llm/*`). OpenAI-compatible so the sidecar's existing
 * OpenAiCompatibleClient can target it unchanged in managed mode — only the base URL + bearer token
 * change (the token is the AGENT_PROXY_TOKEN, never an OpenRouter key). Every route is guarded.
 */
@Controller('agent/llm')
@UseGuards(AgentProxyGuard)
export class AgentLlmController {
  constructor(private readonly service: AgentLlmService) {}

  /**
   * Forward one non-streaming chat completion to OpenRouter and pass the upstream status + JSON back
   * verbatim. `@Res()` passthrough preserves the upstream status code (e.g. a 429 balance error) so the
   * sidecar client sees the real failure. `Record<string,unknown>` (not a DTO) so the global
   * ValidationPipe doesn't strip OpenAI fields (messages/tools/…).
   */
  @Post('chat/completions')
  async chat(
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const cancellation = new AbortController();
    const cancel = (): void => cancellation.abort();
    request.once('aborted', cancel);
    response.once('close', cancel);
    try {
      const { status, body: json } = await this.service.chatCompletion(body, cancellation.signal);
      response.status(status).json(json);
    } finally {
      request.off('aborted', cancel);
      response.off('close', cancel);
    }
  }

  /** Aggregate token metering for this process (no message content) — a hook for billing/observability. */
  @Get('usage')
  usage(): { meteredTokens: number; meteredRequests: number } {
    return this.service.usage();
  }

  /**
   * Live model roster for the Lobee picker — the curated/allowlisted models annotated with current
   * OpenRouter availability + reasoning (effort) support. The OpenRouter key stays server-side.
   */
  @Get('models')
  async models(): Promise<import('@lobster/shared-types').AgentModelsResult> {
    return this.service.listModels();
  }
}
