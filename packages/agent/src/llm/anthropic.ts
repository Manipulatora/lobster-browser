import type { LlmClient, LlmMessage, LlmRequest, LlmResult, LlmToolCall } from './types.js';
import { fetchWithRetry } from './http.js';
import { classifyProviderError, usesAutomaticToolChoice } from './openai-compatible.js';

/**
 * Anthropic Messages API adapter (BYOK), via raw fetch — no SDK. Raw HTTP is the deliberate choice
 * here: the agent needs ONE uniform client interface across five providers, and the sidecar is bundled
 * by copying a hand-listed set of node_modules (scripts/bundle-sidecar.mjs), so a per-provider SDK per
 * adapter is more weight and drift than one shared fetch pattern. Matches the repo's first-party-client
 * ethos (cdp-client.ts speaks raw DevTools; @lobster/proxy speaks raw undici).
 *
 * Correctness pins for the Opus family (from the claude-api reference): the model id is passed through
 * verbatim (default `claude-opus-4-8`); we send NO `temperature`/`top_p`/`top_k` and NO `thinking`
 * (all rejected or unnecessary here — steps are small, fast tool calls); tool choice stays `auto`
 * because current Claude adaptive-thinking models reject forced tool use; and `cache_control` on the
 * system block caches tools+system across the run's steps (tools render before system, so one
 * breakpoint covers both).
 */
export class AnthropicClient implements LlmClient {
  readonly provider = 'anthropic';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(opts: { apiKey: string; baseUrl?: string; model?: string }) {
    if (!opts.apiKey) throw new Error('Anthropic BYOK requires an API key');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.defaultModel = opts.model ?? 'claude-opus-4-8';
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const model = req.model || this.defaultModel;
    // Read from the same predicate the system prompt reads, so "the transport may not force the tool"
    // and "the prompt says every step is one `act` call" cannot disagree.
    const automaticToolChoice = usesAutomaticToolChoice(this.provider, model);
    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens,
      system: [
        {
          type: 'text',
          text: req.system,
          ...(req.cachePrefix !== false ? { cache_control: { type: 'ephemeral' } } : {}),
        },
      ],
      messages: toAnthropicMessages(req.messages, req.cachePrefix !== false),
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema,
            })),
            tool_choice:
              req.forceTool && !automaticToolChoice
                ? { type: 'tool', name: req.forceTool }
                : { type: 'auto' },
          }
        : {}),
    };

    const res = await fetchWithRetry(
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      {
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.onRetry ? { onRetry: req.onRetry } : {}),
      },
    );

    if (!res.ok) {
      const detail = await safeErr(res);
      throw new Error(classifyProviderError('anthropic', res.status, detail));
    }

    const json = (await res.json()) as AnthropicResponse;
    let toolCall: LlmToolCall | undefined;
    let text = '';
    for (const block of json.content ?? []) {
      if (block.type === 'tool_use' && block.name && block.input && !toolCall) {
        toolCall = {
          id: block.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      } else if (block.type === 'text' && typeof block.text === 'string') {
        text += block.text;
      }
    }
    const u = json.usage ?? {};
    return {
      ...(toolCall ? { toolCall } : {}),
      ...(text ? { text } : {}),
      stopReason: normalizeStop(json.stop_reason),
      usage: {
        // Anthropic reports cache reads separately from ordinary/cache-creation input. They still
        // consumed context and must count against Lobee's per-run safety budget.
        tokensIn:
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0),
        tokensOut: u.output_tokens ?? 0,
        ...(u.cache_read_input_tokens !== undefined
          ? { cachedTokensIn: u.cache_read_input_tokens }
          : {}),
      },
    };
  }
}

/**
 * Map the neutral message list onto Anthropic's wire shape.
 *
 * Two rules drive the structure. Tool results are USER content blocks here (not a `tool` role as in the
 * OpenAI dialect), and consecutive results must be merged into ONE user message — sending them as
 * separate user turns is rejected. A `cache_control` breakpoint also goes on the final block, so the
 * whole conversation prefix is cached across steps rather than only the system prompt; on a long run
 * that is the difference between re-paying for every prior observation and reading it at ~0.1×.
 */
function toAnthropicMessages(
  messages: readonly LlmMessage[],
  cache: boolean,
): Array<Record<string, unknown>> {
  const out: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      const last = out.at(-1);
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
      };
      // Merge into the open user turn when the previous message was also a result.
      if (last?.role === 'user' && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (message.role === 'assistant') {
      const content: Array<Record<string, unknown>> = [];
      if (message.content?.trim()) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }
      if (content.length) out.push({ role: 'assistant', content });
      continue;
    }
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: message.content }];
    for (const image of message.images ?? []) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.data },
      });
    }
    out.push({ role: 'user', content });
  }

  // Collapse any consecutive same-role turns into one. Anthropic requires alternating roles, and the
  // mapping above can legitimately produce two user turns in a row — a tool result becomes a user turn,
  // so a result immediately followed by the next step's user message is two. Merging their content
  // blocks is exactly equivalent on the wire and removes a whole class of 400s at the source, rather
  // than making every call site remember not to emit the shape.
  const merged: typeof out = [];
  for (const turn of out) {
    const last = merged.at(-1);
    if (last?.role === turn.role) last.content.push(...turn.content);
    else merged.push(turn);
  }

  if (cache) {
    const lastBlock = merged.at(-1)?.content.at(-1);
    if (lastBlock) lastBlock.cache_control = { type: 'ephemeral' };
  }
  return merged;
}

interface AnthropicResponse {
  content?: Array<{ type: string; id?: string; text?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function normalizeStop(reason: string | undefined): string {
  switch (reason) {
    case 'tool_use':
      return 'tool';
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'refusal';
    default:
      return reason ?? 'unknown';
  }
}

async function safeErr(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    return j.error?.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}
