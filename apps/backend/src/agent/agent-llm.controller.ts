import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import type { AgentUsageRow } from '../billing/billing.repository';
import { AgentAuthGuard, type AgentPrincipal, type AgentRequest } from './agent-auth.guard';
import { AgentLlmService } from './agent-llm.service';
import { AgentRefusalFilter } from './agent-refusal';

/**
 * Managed agent-LLM proxy (`/agent/llm/*`). OpenAI-compatible so the sidecar's existing
 * OpenAiCompatibleClient can target it unchanged in managed mode — only the base URL + bearer token
 * change (the token is a short-lived agent token from `POST /agent/token`, never an OpenRouter key).
 * Every route is guarded, and the guard resolves WHICH TEAM is spending before anything runs.
 */
@Controller('agent/llm')
@UseGuards(AgentAuthGuard)
@UseFilters(AgentRefusalFilter)
export class AgentLlmController {
  constructor(private readonly service: AgentLlmService) {}

  /**
   * Forward one chat completion to OpenRouter and pass the upstream status + JSON back verbatim.
   * `@Res()` passthrough preserves the upstream status code (e.g. a 429 balance error) so the
   * sidecar client sees the real failure. `Record<string,unknown>` (not a DTO) so the global
   * ValidationPipe doesn't strip OpenAI fields (messages/tools/…).
   */
  @Post('chat/completions')
  async chat(
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const principal = principalOf(request);
    const cancellation = new AbortController();
    const cancel = (): void => cancellation.abort();
    request.once('aborted', cancel);
    response.once('close', cancel);
    try {
      if (body.stream === true) {
        const {
          status,
          stream,
          body: error,
        } = await this.service.chatCompletionStream(body, principal, cancellation.signal);
        if (!stream) {
          response.status(status).json(error ?? {});
          return;
        }
        // Pipe the upstream SSE through verbatim. `no-transform` and the disabled Nginx buffer are
        // load-bearing: an intermediary that buffers would deliver the whole answer at once, which is
        // exactly the behaviour streaming exists to remove.
        response.status(status);
        response.setHeader('content-type', 'text/event-stream; charset=utf-8');
        response.setHeader('cache-control', 'no-cache, no-transform');
        response.setHeader('connection', 'keep-alive');
        response.setHeader('x-accel-buffering', 'no');
        response.flushHeaders?.();
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!response.write(Buffer.from(value))) {
              await new Promise((resolve) => response.once('drain', resolve));
            }
          }
        } finally {
          // Cancelling is also what settles the meter for an answer the client walked away from —
          // the transform accounts for what it saw pass rather than dropping the call.
          reader.cancel().catch(() => {});
          response.end();
        }
        return;
      }
      const { status, body: json } = await this.service.chatCompletion(
        body,
        principal,
        cancellation.signal,
      );
      response.status(status).json(json);
    } finally {
      request.off('aborted', cancel);
      response.off('close', cancel);
    }
  }

  /**
   * What this team has spent, newest first.
   *
   * PER TEAM, and it has to be: this used to report two process-wide counters summed across every
   * tenant and reset on restart, which is a number nobody can be billed or refunded on. The rows
   * carry the model, the token shape and the cents actually taken, so a disputed charge can be
   * explained line by line. Message content is not part of a usage row and never has been.
   */
  @Get('usage')
  async usage(
    @Req() request: Request,
    @Query('limit') limit?: string,
  ): Promise<{ usage: AgentUsageRow[] }> {
    const principal = principalOf(request);
    const parsed = Number(limit);
    const bounded = Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 1), 200) : 50;
    return { usage: await this.service.usage(principal.teamId, bounded) };
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

/**
 * The spender, as resolved by {@link AgentAuthGuard}. Read from the request and never from the
 * body: a caller-supplied team on a metered endpoint is a way to charge someone else's wallet.
 */
function principalOf(request: Request): AgentPrincipal {
  const principal = (request as unknown as AgentRequest).agent;
  // Unreachable while the guard is attached; the throw is what makes removing it fail loudly
  // instead of silently serving unattributed, unbilled model time.
  if (!principal) throw new Error('agent principal missing — AgentAuthGuard did not run');
  return principal;
}
