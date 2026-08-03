import type { LlmClient, LlmMessage, LlmRequest, LlmResult, LlmToolCall } from './types.js';
import { fetchWithRetry } from './http.js';

/**
 * True when this (provider, model) pair cannot be given a FORCED tool choice, so the model may answer
 * in prose instead of calling `act`. Claude's adaptive-thinking models reject `tool_choice: {function}`
 * over OpenRouter, so the adapter sends `'auto'` for them.
 *
 * Exported because the system prompt has to compensate with an explicit "every step is one `act` call"
 * clause — and the condition must be stated in exactly ONE place, or the prompt and the wire drift
 * apart silently.
 */
export function usesAutomaticToolChoice(provider: string, model: string): boolean {
  const openRouter = provider === 'managed' || provider === 'openrouter';
  return openRouter && model.startsWith('anthropic/');
}

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
    const model = req.model || this.defaultModel;
    // Prompt caching (OpenRouter dialect only): mark the STABLE system block (which renders after the
    // tool schema, so one breakpoint caches tools+system) as cacheable. Across a run's steps the system
    // prompt is byte-identical, so step 2+ reads it at ~0.1× instead of re-paying full price. Anthropic
    // needs the explicit `cache_control`; OpenAI/Google cache automatically and ignore it.
    const cache = this.openRouter && req.cachePrefix !== false;
    // Claude's current adaptive-thinking models reject a forced tool choice. Keep the schema and rely on
    // the agent system prompt plus its strict result validator, but let Claude select the action tool.
    const useAutomaticToolChoice = usesAutomaticToolChoice(this.provider, model);
    const systemContent = cache
      ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
      : req.system;
    const body = {
      model,
      max_tokens: req.maxTokens,
      messages: [
        { role: 'system', content: systemContent },
        ...toOpenAiMessages(req.messages, cache),
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
    // Stream only when the caller wants deltas AND no tool is in play. A forced tool call produces a
    // single structured object with no prose to reveal progressively, so streaming it would add
    // reassembly risk for no benefit — Ask mode is where the wait is actually felt.
    const wantsStream = Boolean(req.onTextDelta) && req.tools.length === 0;
    const response = await fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          ...(wantsStream ? { accept: 'text/event-stream' } : {}),
        },
        body: JSON.stringify(wantsStream ? { ...body, stream: true } : body),
      },
      {
        ...(req.signal ? { signal: req.signal } : {}),
        // The managed backend already owns the upstream deadline. Retrying its 504 would turn one
        // bounded 55s attempt into a multi-minute client hang that outlives the agent watchdog.
        ...(this.provider === 'managed' ? { attempts: 1 } : {}),
        ...(req.onRetry ? { onRetry: req.onRetry } : {}),
      },
    );
    if (!response.ok) {
      throw new Error(
        classifyProviderError(this.provider, response.status, await safeError(response)),
      );
    }
    if (wantsStream && response.body) {
      return readSseCompletion(response.body, req.onTextDelta!, req.signal);
    }
    const json = (await response.json()) as OpenAiResponse;
    const choice = json.choices?.[0];
    const rawCall = choice?.message?.tool_calls?.[0];
    const call = rawCall?.function;
    let toolCall: LlmToolCall | undefined;
    if (call?.name) {
      const id = rawCall?.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
      try {
        toolCall = {
          id,
          name: call.name,
          input: JSON.parse(call.arguments || '{}') as Record<string, unknown>,
        };
      } catch {
        toolCall = { id, name: call.name, input: {} };
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

/**
 * Map the neutral message list onto the OpenAI chat dialect: tool results are their own `tool` role
 * keyed by `tool_call_id`, and assistant tool calls carry JSON-encoded `arguments` (the wire format is
 * a string, not an object).
 */
/**
 * Place the ONE rolling cache breakpoint on the last message.
 *
 * The system block alone is not where the cost is. Measured against claude-sonnet-5 through the managed
 * proxy on a realistic 18k-token step (a ~2.5k system prefix plus six page snapshots):
 *
 *   system block marked only          -> 6,441 / 18,060 cached  (36%)
 *   + last message marked             -> 18,058 / 18,060 cached (100%)
 *
 * i.e. ~11.6k additional prompt tokens per step read at the cached rate instead of full price. The
 * conversation prefix is stable across a run's steps — observations are appended, never rewritten —
 * so the marker rolls forward and each step reads everything before it from cache.
 *
 * EXACTLY ONE marker is added here. Anthropic caps cache breakpoints, and the system block already
 * carries one; adding more risks a 400 on the only transport the product ships.
 *
 * An assistant turn is deliberately skipped: its content may be null alongside `tool_calls`, and there
 * is no safe place to hang the marker. In Lobee's flow the tail is always a tool result or a user
 * message, so this is a defensive fallback rather than a live path.
 */
function markCacheBreakpoint(message: Record<string, unknown>): Record<string, unknown> {
  const cacheControl = { type: 'ephemeral' };
  if (message.role === 'assistant') return message;
  if (typeof message.content === 'string') {
    return {
      ...message,
      content: [{ type: 'text', text: message.content, cache_control: cacheControl }],
    };
  }
  if (Array.isArray(message.content) && message.content.length > 0) {
    const parts = [...(message.content as Array<Record<string, unknown>>)];
    parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: cacheControl };
    return { ...message, content: parts };
  }
  return message;
}

function toOpenAiMessages(
  messages: readonly LlmMessage[],
  cacheConversation = false,
): Array<Record<string, unknown>> {
  const mapped: Array<Record<string, unknown>> = messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
    if (message.role === 'assistant') {
      const calls = message.toolCalls ?? [];
      return {
        role: 'assistant',
        content: message.content ?? '',
        ...(calls.length
          ? {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }
          : {}),
      };
    }
    if (!message.images?.length) return { role: 'user', content: message.content };
    return {
      role: 'user',
      content: [
        { type: 'text', text: message.content },
        ...message.images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mediaType};base64,${image.data}`, detail: 'auto' },
        })),
      ],
    };
  });
  const last = mapped.length - 1;
  if (cacheConversation && last >= 0) mapped[last] = markCacheBreakpoint(mapped[last]!);
  return mapped;
}

/**
 * Consume an OpenAI-dialect SSE stream into the same {@link LlmResult} the non-streaming path returns,
 * reporting text deltas as they arrive.
 *
 * The caller is deliberately unaware of which transport was used: the loop still gets one resolved
 * result, so streaming is purely additive and a provider that cannot stream degrades to the buffered
 * path with no behavioural difference beyond the missing deltas.
 */
/**
 * Longest gap between stream chunks before the body is treated as dead.
 *
 * `fetchWithRetry`'s per-attempt timeout only covers the initial `fetch()`; once the response is
 * returned it clears that timer, so nothing bounds how long the BODY takes. A proxy that accepts the
 * request and then stalls left `runAgent` unresolved forever, and because the manager keeps the session
 * in `running` until the run resolves, that wedged the profile against every subsequent run — with
 * `stop()` unable to break it. This watchdog is what makes a stalled stream fail instead of hang.
 */
const STREAM_IDLE_TIMEOUT_MS = 90_000;

async function readSseCompletion(
  body: ReadableStream<Uint8Array>,
  onTextDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<LlmResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let stopReason = 'stop';
  const usage = { tokensIn: 0, tokensOut: 0, cachedTokensIn: undefined as number | undefined };

  // Cancelling the reader is what unblocks the pending `read()`; the loop then throws and the caller
  // sees a real error rather than an unresolved promise.
  const onAbort = (): void => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      let idle: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          idle = setTimeout(
            () => reject(new Error('the model stream stalled (no data for 90s)')),
            STREAM_IDLE_TIMEOUT_MS,
          );
          idle.unref?.();
        }),
      ]).finally(() => clearTimeout(idle));
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk: OpenAiStreamChunk;
        try {
          chunk = JSON.parse(payload) as OpenAiStreamChunk;
        } catch {
          continue; // a keep-alive or comment frame
        }
        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) {
          text += delta;
          onTextDelta(delta);
        }
        if (choice?.finish_reason) stopReason = normalizeStop(choice.finish_reason);
        if (chunk.usage) {
          usage.tokensIn = chunk.usage.prompt_tokens ?? usage.tokensIn;
          usage.tokensOut = chunk.usage.completion_tokens ?? usage.tokensOut;
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
          if (cached !== undefined) usage.cachedTokensIn = cached;
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }

  // A 200 that yields no content at all is a proxy failure mode, not an answer. Say so plainly rather
  // than returning an empty result the loop reports as "the model returned no answer".
  if (!text.trim() && usage.tokensOut === 0) {
    throw new Error('the model stream ended without producing any content');
  }

  return {
    ...(text ? { text } : {}),
    stopReason,
    usage: {
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      ...(usage.cachedTokensIn !== undefined ? { cachedTokensIn: usage.cachedTokensIn } : {}),
    },
  };
}

interface OpenAiStreamChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

interface OpenAiResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
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

/**
 * Turn a provider failure into something the user can act on.
 *
 * The panel renders this string directly. Raw upstream bodies are written for API consumers, not
 * people — "managed 403: Key limit exceeded (total limit). Manage it using https://…/keys/55792472…"
 * tells a user nothing about what THEY should do, and a 502 with an HTML body renders as markup. Keep
 * the original detail on the end; it is what makes a bug report useful.
 */
export function classifyProviderError(provider: string, status: number, detail: string): string {
  const cause =
    status === 401 || status === 403
      ? detail.toLowerCase().includes('limit')
        ? 'the model account has run out of credit or hit its spend limit'
        : 'the model credential was rejected'
      : status === 429
        ? 'the model provider is rate-limiting this key'
        : status === 400 && /context|too long|max_tokens|token/i.test(detail)
          ? 'the conversation grew past the model context window'
          : status === 400
            ? 'the model provider rejected the request'
            : status === 408 || status === 504
              ? 'the model provider timed out'
              : status >= 500
                ? 'the model provider is unavailable'
                : `the model provider returned ${status}`;
  return `${cause} (${provider} ${status}: ${detail})`;
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
