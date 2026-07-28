import type { LlmClient, LlmRequest, LlmResult, LlmToolCall } from './types.js';
import { fetchWithRetry } from './http.js';

export class OpenAiCompatibleClient implements LlmClient {
  readonly provider: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  /**
   * Whether this endpoint speaks OpenRouter's dialect (managed proxy → OpenRouter, or BYOK OpenRouter).
   * ONLY these get OpenRouter-specific fields — `cache_control` breakpoints and `provider` pinning.
   * Direct OpenAI/xAI would 400 on those (OpenAI caches automatically and needs neither).
   */
  private readonly openRouter: boolean;

  constructor(opts: { provider: string; apiKey: string; baseUrl: string; model: string }) {
    if (!opts.apiKey) throw new Error(`${opts.provider} BYOK requires an API key`);
    this.provider = opts.provider;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.defaultModel = opts.model;
    this.openRouter = opts.provider === 'managed' || opts.provider === 'openrouter';
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const user = req.images?.length
      ? [
          { type: 'text', text: req.user },
          ...req.images.map((image) => ({
            type: 'image_url',
            image_url: { url: `data:${image.mediaType};base64,${image.data}`, detail: 'auto' },
          })),
        ]
      : req.user;
    const model = req.model || this.defaultModel;
    // Prompt caching (OpenRouter dialect only): mark the STABLE system block (which renders after the
    // tool schema, so one breakpoint caches tools+system) as cacheable. Across a run's steps the system
    // prompt is byte-identical, so step 2+ reads it at ~0.1× instead of re-paying full price. Anthropic
    // needs the explicit `cache_control`; OpenAI/Google cache automatically and ignore it.
    const cache = this.openRouter && req.cachePrefix !== false;
    // Claude's current adaptive-thinking models reject a forced tool choice. Keep the schema and rely on
    // the agent system prompt plus its strict result validator, but let Claude select the action tool.
    const useAutomaticToolChoice = this.openRouter && model.startsWith('anthropic/');
    const systemContent = cache
      ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
      : req.system;
    const body = {
      model,
      max_tokens: req.maxTokens,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: user },
      ],
      // Tool-less chat (Ask mode) sends no tools/tool_choice and gets a plain text answer.
      ...(req.tools.length
        ? {
            tools: req.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
            tool_choice:
              req.forceTool && !useAutomaticToolChoice
                ? { type: 'function', function: { name: req.forceTool } }
                : 'auto',
          }
        : {}),
      ...reasoningParameters(this.provider, model, req.effort),
      // Sticky routing: a stable per-run session id pins every step to the SAME provider endpoint so the
      // cache above actually gets hits (OpenRouter otherwise spreads steps across endpoints with separate
      // caches). `provider.order` is the coarse pin (which provider); `session_id` is the fine pin (which
      // endpoint within it). Both are OpenRouter body fields our proxy forwards verbatim.
      ...(cache && req.sessionId ? { session_id: req.sessionId.slice(0, 256) } : {}),
      ...providerPin(model, cache),
    };
    const response = await fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      {
        ...(req.signal ? { signal: req.signal } : {}),
        // The managed backend already owns the upstream deadline. Retrying its 504 would turn one
        // bounded 55s attempt into a multi-minute client hang that outlives the agent watchdog.
        ...(this.provider === 'managed' ? { attempts: 1 } : {}),
      },
    );
    if (!response.ok)
      throw new Error(`${this.provider} ${response.status}: ${await safeError(response)}`);
    const json = (await response.json()) as OpenAiResponse;
    const choice = json.choices?.[0];
    const call = choice?.message?.tool_calls?.[0]?.function;
    let toolCall: LlmToolCall | undefined;
    if (call?.name) {
      try {
        toolCall = {
          name: call.name,
          input: JSON.parse(call.arguments || '{}') as Record<string, unknown>,
        };
      } catch {
        toolCall = { name: call.name, input: {} };
      }
    }
    return {
      ...(toolCall ? { toolCall } : {}),
      ...(choice?.message?.content ? { text: choice.message.content } : {}),
      stopReason: normalizeStop(choice?.finish_reason),
      usage: {
        tokensIn: json.usage?.prompt_tokens ?? 0,
        tokensOut: json.usage?.completion_tokens ?? 0,
        ...(json.usage?.prompt_tokens_details?.cached_tokens !== undefined
          ? { cachedTokensIn: json.usage.prompt_tokens_details.cached_tokens }
          : {}),
      },
    };
  }
}

interface OpenAiResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function reasoningParameters(
  provider: string,
  model: string,
  effort: LlmRequest['effort'],
): Record<string, unknown> {
  if (!effort) return {};
  if (provider === 'managed' || provider === 'openrouter') {
    // OpenRouter's unified field translates effort across OpenAI, Anthropic, Google, and other models.
    return { reasoning: { effort } };
  }
  if (provider === 'openai' && supportsOpenAiReasoningEffort(model, effort)) {
    // Native OpenAI Chat Completions uses `reasoning_effort`, not OpenRouter's `reasoning` object.
    return { reasoning_effort: effort };
  }
  if (provider === 'xai' && /^grok-4\.5(?:[-.]|$)/i.test(model)) {
    // xAI Chat Completions documents low/medium/high reasoning effort for the Grok 4.5 family.
    return { reasoning_effort: effort };
  }
  // Unknown/non-reasoning direct models reject provider-specific reasoning fields; omission is safe.
  return {};
}

function supportsOpenAiReasoningEffort(model: string, effort: LlmRequest['effort']): boolean {
  const reasoningFamily = /^(?:gpt-5(?:[-.]|$)|o(?:1|3|4)(?:[-.]|$))/i.test(model);
  if (!reasoningFamily) return false;
  return !/(?:^|[-.])pro(?:[-.]|$)/i.test(model) || effort === 'high';
}

/**
 * Pin routing to the model's first-party provider (`anthropic`/`openai`) so a run's steps hit one
 * endpoint and the prompt cache persists. `order` prefers it but still falls back if it's down. Google
 * (google-vertex vs google-ai-studio) is left to OpenRouter's implicit routing + auto caching.
 */
function providerPin(model: string, enabled: boolean): Record<string, unknown> {
  if (!enabled) return {};
  const brand = model.split('/')[0];
  const slug = brand === 'anthropic' ? 'anthropic' : brand === 'openai' ? 'openai' : undefined;
  return slug ? { provider: { order: [slug] } } : {};
}

function normalizeStop(reason: string | undefined): string {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool';
  if (reason === 'content_filter') return 'refusal';
  if (reason === 'length') return 'length';
  if (reason === 'stop') return 'stop';
  return reason ?? 'unknown';
}

async function safeError(response: Response): Promise<string> {
  try {
    // Cover both shapes: OpenAI/OpenRouter `{error:{message}}` and NestJS `{message, error:"Bad Request"}`
    // (whose real reason lives in `message`, sometimes an array of validation strings).
    const json = (await response.json()) as { error?: { message?: string }; message?: unknown };
    const m = json.error?.message ?? json.message;
    if (Array.isArray(m)) return m.join('; ');
    if (typeof m === 'string' && m) return m;
    return response.statusText;
  } catch {
    return response.statusText;
  }
}
