import type { LlmClient, LlmRequest, LlmResult, LlmToolCall } from './types.js';
import { fetchWithRetry } from './http.js';

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
    const body: Record<string, unknown> = {
      model: req.model || this.defaultModel,
      max_tokens: req.maxTokens,
      system: [
        {
          type: 'text',
          text: req.system,
          ...(req.cachePrefix !== false ? { cache_control: { type: 'ephemeral' } } : {}),
        },
      ],
      messages: [
        {
          role: 'user',
          content: req.images?.length
            ? [
                { type: 'text', text: req.user },
                ...req.images.map((image) => ({
                  type: 'image',
                  source: { type: 'base64', media_type: image.mediaType, data: image.data },
                })),
              ]
            : req.user,
        },
      ],
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema,
            })),
            tool_choice: { type: 'auto' },
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
      { ...(req.signal ? { signal: req.signal } : {}) },
    );

    if (!res.ok) {
      const detail = await safeErr(res);
      throw new Error(`Anthropic ${res.status}: ${detail}`);
    }

    const json = (await res.json()) as AnthropicResponse;
    let toolCall: LlmToolCall | undefined;
    let text = '';
    for (const block of json.content ?? []) {
      if (block.type === 'tool_use' && block.name && block.input && !toolCall) {
        toolCall = { name: block.name, input: block.input as Record<string, unknown> };
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
        tokensIn: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        tokensOut: u.output_tokens ?? 0,
        ...(u.cache_read_input_tokens !== undefined
          ? { cachedTokensIn: u.cache_read_input_tokens }
          : {}),
      },
    };
  }
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
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
