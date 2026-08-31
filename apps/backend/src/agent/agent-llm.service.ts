import {
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentModelInfo, AgentModelsResult } from '@lobster/shared-types';

import { AgentSpendService } from '../billing/agent-spend.service';
import type { AgentUsageRow } from '../billing/billing.repository';
import type { AgentPrincipal } from './agent-auth.guard';
import { insufficientCredit, modelUnpriced } from './agent-refusal';

/**
 * Curated roster surfaced first in the Lobee picker. This is the SOURCE OF TRUTH for the model list —
 * the panel no longer owns it. Ids are OpenRouter model ids; live availability + reasoning support are
 * annotated from the catalog at request time.
 */
const FEATURED: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'openai/gpt-5.4', label: 'GPT 5.4' },
  { id: 'openai/gpt-5.5', label: 'GPT 5.5' },
  { id: 'openai/gpt-5.6-luna', label: 'GPT 5.6 Luna' },
  { id: 'openai/gpt-5.6-terra', label: 'GPT 5.6 Terra' },
  { id: 'openai/gpt-5.6-sol', label: 'GPT 5.6 Sol' },
  { id: 'anthropic/claude-fable-5', label: 'Claude Fable 5' },
  { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8' },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
];
const MODELS_CACHE_MS = 60 * 60 * 1000;
const DEFAULT_MODEL_SYNC_TIMEOUT_MS = 10_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 55_000;
const MODEL_ID = /^[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._:+~-]*$/i;
type AgentEffort = 'low' | 'medium' | 'high';
const VALID_EFFORTS: ReadonlySet<string> = new Set<AgentEffort>(['low', 'medium', 'high']);

/**
 * The provider brands whose FULL live catalog we expose. The picker shows every OpenAI / Anthropic /
 * Google model from OpenRouter, and the chat gate allows exactly these same brands — so the roster and
 * what actually runs can never drift apart (that drift is what caused the earlier "managed 400"). To add
 * a model outside these brands, list its exact id in `AGENT_ALLOWED_MODELS`.
 */
const ALLOWED_BRANDS: ReadonlySet<string> = new Set(['openai', 'anthropic', 'google']);
const brandRank: Record<string, number> = { openai: 0, anthropic: 1, google: 2 };
/** Exclude non-chat model ids (embeddings, audio, image, moderation) that would fail a chat call. */
const NON_CHAT =
  /(embed|embedding|whisper|\btts\b|audio|dall-e|dalle|\bimage\b|moderation|rerank|guard)/i;

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  architecture?: { output_modalities?: string[] };
  expiration_date?: string | null;
  reasoning?: {
    supported_efforts?: string[] | null;
    mandatory?: boolean;
  } | null;
}

interface OpenRouterErrorBody {
  error?: { code?: unknown; type?: unknown; message?: unknown };
  message?: unknown;
}

/** OpenAI/OpenRouter chat-completions shape (only the fields we touch — the rest passes through). */
interface ChatBody {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  max_tokens?: unknown;
  stream?: unknown;
  [key: string]: unknown;
}

/**
 * What the provider reports about one completion.
 *
 * THE THREE FIGURES ARE NOT INTERCHANGEABLE. `prompt_tokens` includes the cached ones, output is
 * billed several times input, and cache reads are billed at about a tenth — so `total_tokens`, the
 * number a naive meter reads, cannot be priced at all. `cost` is OpenRouter's own charge for the
 * call in USD and wins over anything we compute, because it already reflects the provider it
 * actually routed to.
 */
interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

/** Everything the metering needs once a call has been authorised, carried between the two paths. */
interface PreparedCall {
  key: string;
  forward: ChatBody;
  timeoutMs: number;
  model: string;
  /**
   * Prompt size guessed from the request body, used for the reserve check and as the input figure
   * when the provider never reports one. Four characters per token is the usual rule of thumb.
   */
  promptTokens: number;
}

/** The rule-of-thumb characters-per-token used wherever a real count is unavailable. */
const CHARS_PER_TOKEN = 4;

/**
 * What a caller is told when the failure is OURS.
 *
 * THE OPERATOR'S WALLET IS NOT THE CUSTOMER'S WALLET. OpenRouter answers a dead operator key with
 * 401 and an empty operator balance with 402 — the same two statuses this proxy uses for "your agent
 * token expired" and "your Credit ran out". Passed through verbatim, which is what the controller's
 * `@Res()` design does with every other status, they reach the panel indistinguishable from the
 * customer's own problem: a revoked SERVER key told the user "the model credential was rejected" and
 * sent the sidecar off to re-mint a token that was never the issue, and an unpaid OpenRouter invoice
 * told the user to top up a Credit balance nothing had touched. Neither sentence is true, and the
 * second one bills the operator's arrears to the customer's conscience.
 *
 * So 401, 402 and 403 are RESERVED for this proxy's own decisions — {@link AgentAuthGuard},
 * `insufficientCredit`, `planRequired` — and an upstream failure in that range is re-stated as a 5xx
 * the client cannot mistake for its own. The provider's own words are dropped on the way out too:
 * OpenRouter's credential errors quote the operator's key-management URL back at whoever asked.
 */
const OPERATOR_FAULT_MESSAGE =
  'Lobee is temporarily unavailable — this is on our side, not yours; nothing was charged.';

/** An upstream failure re-stated as a fault of the right owner. */
interface UpstreamFault {
  /** What the client is answered with. Never the upstream's own 401/402/403. */
  status: number;
  /** True when only the operator can end this — dead key, empty provider balance, key spend cap. */
  operatorFault: boolean;
  /** Stable support code. OURS: the provider's own text is never forwarded and never logged. */
  reason: string;
  message: string;
}

/**
 * Re-state an upstream 401/402/403, or `undefined` to pass the status through as it stands.
 *
 * Only that range is touched. A 429 or a 500 from OpenRouter already means to the client exactly
 * what it means to us, and rewriting it would cost the sidecar the retry behaviour it picks from it.
 */
function translateUpstreamFailure(
  status: number,
  code: string,
  detail: string,
): UpstreamFault | undefined {
  const operatorFault = (reason: string): UpstreamFault => ({
    status: 503,
    operatorFault: true,
    reason,
    message: OPERATOR_FAULT_MESSAGE,
  });
  // 401: OpenRouter never sees the caller's agent token, so the only credential it can reject here
  // is the operator's. 402: likewise, the only balance it can find empty is the operator's.
  if (status === 401) return operatorFault('operator_key_rejected');
  if (status === 402) return operatorFault('operator_out_of_funds');
  if (status === 403) {
    // OpenRouter spends 403 on two unrelated things: a key that is out of allowance ("limit",
    // "credit", "quota") and a request its moderation declined. The first is the operator's to fix;
    // the second is about THIS request and must not be reported to everyone as an outage.
    return /\b(api[ _-]?key|key|credit|quota|limit|billing|balance|funds?)\b/i.test(
      `${code} ${detail}`,
    )
      ? operatorFault('operator_key_limited')
      : {
          status: 502,
          operatorFault: false,
          reason: 'upstream_rejected',
          message: 'The model provider declined this request.',
        };
  }
  return undefined;
}

/** The body a translated fault answers with. Carries no provider text — see OPERATOR_FAULT_MESSAGE. */
function upstreamFaultBody(fault: UpstreamFault): Record<string, unknown> {
  return {
    // `error.message` is where the sidecar's OpenAI-compatible client looks, exactly as it does for
    // a typed refusal; `operatorFault` is the field that says whose problem this is without the
    // client having to read English.
    error: {
      code: fault.operatorFault ? 'upstream_unavailable' : 'upstream_rejected',
      type: 'agent_upstream_error',
      message: fault.message,
    },
    upstream: 'openrouter',
    operatorFault: fault.operatorFault,
    reason: fault.reason,
  };
}

/**
 * The managed LLM path. It holds the SERVER's OpenRouter key and brokers the sidecar's OpenAI-compatible
 * chat/completions calls, so a managed run never exposes the key to the desktop/client (the BYOK path's
 * whole reason to exist elsewhere). It meters token usage for billing and applies cheap-by-default guard
 * rails: a hard `max_tokens` cap and an optional model allowlist, so a misconfigured or hostile client
 * can't burn the balance on an expensive model or an unbounded response.
 *
 * Streaming IS supported, and is used by Ask mode: `chatCompletionStream` forwards the SSE body through
 * `meterStream`, so a streamed answer is metered exactly like a buffered one. Agent-mode steps
 * stay non-streaming — a forced tool call produces one structured object with no prose to reveal
 * progressively, so streaming it would add reassembly risk for no benefit.
 *
 * EVERY CALL IS CHARGED TO A TEAM. Metering used to be two process-wide counters: every tenant summed
 * together, no model, no cost, reset on restart. They could not answer the only question metering is
 * for — what does this team owe — so the counters are gone. Each call now reserves against the team's
 * Credit before it runs and debits it after, through `AgentSpendService`; the wallet is the only
 * ledger and there is no second, softer record of what was spent.
 */
@Injectable()
export class AgentLlmService implements OnModuleInit {
  private readonly logger = new Logger(AgentLlmService.name);
  private modelsCache?: { at: number; payload: AgentModelsResult };

  constructor(
    private readonly config: ConfigService,
    private readonly spend: AgentSpendService,
  ) {}

  /**
   * Say at BOOT what a missing operator key costs, instead of at the first user request.
   *
   * NOT a boot failure, deliberately. This key powers one module; refusing to start without it would
   * take sign-in, profile sync and billing down for a deployment that simply does not sell the
   * agent, and `/health/ready` — which systemd's ExecStartPost polls — would then fail the whole
   * unit. A backend with no key serves everything else correctly. What it must not do is start
   * silently and let the operator discover the gap from a customer, which is what `.env.example`
   * not listing the variable at all made the normal outcome. `/health/agent` carries the same fact
   * for anything that reads rather than tails.
   */
  onModuleInit(): void {
    if (this.config.get<string>('OPENROUTER_API_KEY')?.trim()) return;
    this.logger.warn(
      'OPENROUTER_API_KEY is not set — the managed Lobee agent is DISABLED on this backend: ' +
        '/agent/llm/chat/completions answers 503 and /agent/llm/models serves an empty roster. ' +
        'Nothing else is affected. See apps/backend/.env.example.',
    );
  }

  /**
   * Lobee's model roster, synced from the live OpenRouter catalog and cached for about an hour. Text-chat
   * models remain available to Ask mode while `agentCapable` identifies the smaller set that satisfies
   * the loop's structured-tool contract. The key stays server-side. A sync failure serves only a
   * previously verified stale cache; a cold failure returns an empty roster rather than inventing models.
   */
  async listModels(): Promise<AgentModelsResult> {
    const key = this.config.get<string>('OPENROUTER_API_KEY')?.trim();
    if (!key) {
      this.logger.warn('OpenRouter model sync skipped: OPENROUTER_API_KEY is not configured');
      return { updatedAt: new Date().toISOString(), stale: true, models: [] };
    }
    if (this.modelsCache && Date.now() - this.modelsCache.at < MODELS_CACHE_MS) {
      return this.modelsCache.payload;
    }
    let live: Map<string, OpenRouterModel> | undefined;
    try {
      const timeoutMs = toBoundedPositiveInt(
        this.config.get('AGENT_MODEL_SYNC_TIMEOUT_MS'),
        DEFAULT_MODEL_SYNC_TIMEOUT_MS,
        120_000,
      );
      const res = await fetchWithTimeout(
        'https://openrouter.ai/api/v1/models',
        { headers: { authorization: `Bearer ${key}` } },
        timeoutMs,
      );
      if (res.ok) {
        const body = (await res.json()) as { data?: OpenRouterModel[] };
        if (!Array.isArray(body.data)) throw new Error('invalid_model_catalog');
        live = new Map(body.data.map((m) => [m.id, m]));
      } else {
        this.logger.warn(`OpenRouter model sync failed status=${res.status}`);
      }
    } catch (error) {
      this.logger.warn(`OpenRouter model sync failed kind=${diagnosticKind(error)}`);
    }

    if (!live) {
      // A real stale roster is safe; invented ids are not. On a cold failure expose no selectable model.
      if (this.modelsCache) return { ...this.modelsCache.payload, stale: true };
      return {
        updatedAt: new Date().toISOString(),
        stale: true,
        models: [],
      };
    }

    // Expose live text-chat entries that accept the proxy's mandatory `max_tokens` spend bound. Curated
    // FEATURED ids get their nicer label + ordering; a catalog entry that cannot accept the forwarded
    // request contract is omitted rather than offered as a model that will fail at completion time.
    const featuredMeta = new Map(FEATURED.map((f, i) => [f.id, { label: f.label, order: i }]));
    const explicitlyAllowed = this.configuredModels();
    const models: AgentModelInfo[] = [];
    for (const [id, entry] of live) {
      const brand = id.split('/')[0] ?? '';
      const supported = new Set(entry.supported_parameters ?? []);
      if (
        id.length > 300 ||
        !MODEL_ID.test(id) ||
        (!ALLOWED_BRANDS.has(brand) && !explicitlyAllowed.has(id)) ||
        NON_CHAT.test(id) ||
        !supported.has('max_tokens') ||
        isExpired(entry.expiration_date) ||
        isNonTextOutput(entry.architecture?.output_modalities)
      ) {
        continue;
      }
      const feat = featuredMeta.get(id);
      const reasoning = Boolean(
        entry.reasoning || supported.has('reasoning') || supported.has('include_reasoning'),
      );
      const efforts = Array.from(
        new Set(
          (entry.reasoning?.supported_efforts ?? []).filter((effort): effort is AgentEffort =>
            VALID_EFFORTS.has(effort),
          ),
        ),
      );
      const agentCapable =
        supported.has('tools') && supported.has('tool_choice') && supported.has('max_tokens');
      models.push({
        id,
        label: feat?.label ?? entry.name ?? id,
        brand,
        featured: Boolean(feat),
        available: true,
        agentCapable,
        reasoning,
        efforts: reasoning ? efforts : [],
        ...(entry.context_length ? { contextLength: entry.context_length } : {}),
      });
    }
    // Group by brand (OpenAI, Anthropic, Google); featured first within each, then alphabetical.
    models.sort((a, b) => {
      const ra = brandRank[a.brand] ?? 9;
      const rb = brandRank[b.brand] ?? 9;
      if (ra !== rb) return ra - rb;
      const fa = featuredMeta.get(a.id)?.order ?? Infinity;
      const fb = featuredMeta.get(b.id)?.order ?? Infinity;
      if (fa !== fb) return fa - fb;
      return a.label.localeCompare(b.label);
    });
    const payload: AgentModelsResult = {
      updatedAt: new Date().toISOString(),
      stale: false,
      models,
    };
    this.modelsCache = { at: Date.now(), payload };
    return payload;
  }

  /**
   * Forward a STREAMING completion, returning the upstream SSE body for the controller to pipe.
   *
   * Streaming exists for one reason: an answer that appears a token at a time reads as responsive,
   * while the same answer delivered whole after ten seconds reads as broken. The panel previously
   * faked it with a typewriter over the finished text, which cannot help with the part that actually
   * feels slow — the wait before anything appears.
   *
   * Metering still happens, just at the end: `stream_options.include_usage` makes OpenRouter emit a
   * final chunk carrying usage, which {@link meterStream} reads as the bytes pass through. The
   * proxy therefore never has to buffer the response to account for it.
   */
  async chatCompletionStream(
    raw: ChatBody,
    principal: AgentPrincipal,
    signal?: AbortSignal,
  ): Promise<{ status: number; stream: ReadableStream<Uint8Array> | null; body?: unknown }> {
    const prepared = await this.prepare(raw, principal);
    const { key, forward, timeoutMs } = prepared;
    const streaming: ChatBody = {
      ...forward,
      stream: true,
      // Ask for the usage chunk explicitly; without it a streamed run would be unmetered.
      stream_options: { include_usage: true },
    };
    let res: Response;
    try {
      res = await fetchWithTimeout(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'http-referer': 'https://lobster.browser',
            'x-title': 'Lobster Agent',
          },
          body: JSON.stringify(streaming),
        },
        timeoutMs,
        signal,
      );
    } catch (error) {
      if (error instanceof UpstreamTimeoutError) {
        throw new GatewayTimeoutException('upstream OpenRouter request timed out');
      }
      throw new ServiceUnavailableException('upstream OpenRouter request failed');
    }

    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as OpenRouterErrorBody & {
        usage?: OpenRouterUsage;
      };
      const code = diagnosticCode(body.error?.code ?? body.error?.type);
      this.logger.warn(
        `agent/llm upstream_error stream model=${String(forward.model)} status=${res.status} code=${code}`,
      );
      // Same translation as the buffered path — nothing has been written to the client yet, so the
      // status line is still ours to choose. Streaming itself is untouched: this branch is the one
      // where there is no stream to pipe.
      const fault = translateUpstreamFailure(res.status, code, errorMessageOf(body));
      if (fault?.operatorFault) {
        // NOT metered, and that is a deliberate exception to `settleFailure`'s rule. A generation
        // cut short because the OPERATOR's key hit its ceiling was still billed to us by the
        // provider — but the sentence the user is handed says nothing was charged, and a promise
        // the ledger contradicts costs more than the fraction of a cent it would recover.
        this.reportUpstreamFault(fault, prepared.model, res.status, code, requestIdOf(res));
        return { status: fault.status, stream: null, body: upstreamFaultBody(fault) };
      }
      await this.settleFailure(prepared, principal, body.usage);
      if (fault) {
        return { status: fault.status, stream: null, body: upstreamFaultBody(fault) };
      }
      return { status: res.status, stream: null, body };
    }
    return {
      status: res.status,
      stream: res.body.pipeThrough(this.meterStream(prepared, principal)),
    };
  }

  /**
   * Pass SSE bytes through untouched while accounting for what flows past.
   *
   * Deliberately a transform and not a parse: the panel needs the frames verbatim, and the only thing
   * the server needs from them is the accounting. Message content is never logged (anonymity product).
   *
   * THE HOLE THIS CLOSES. A streamed call was charged only if the final usage chunk arrived, so the
   * two cases where it does not — the user closes the panel mid-answer, or the upstream connection
   * dies part-way — produced a completed generation the provider billed us for and we billed nobody
   * for. The delta lengths are therefore counted as they pass, giving a real output figure to fall
   * back on when the authoritative one never comes. Length, never content.
   */
  private meterStream(
    prepared: PreparedCall,
    principal: AgentPrincipal,
  ): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    let pending = '';
    let settled = false;
    let observedChars = 0;

    const settle = (usage?: OpenRouterUsage): void => {
      if (settled) return;
      settled = true;
      void this.charge(prepared, principal, usage, {
        tokensIn: prepared.promptTokens,
        tokensOut: Math.ceil(observedChars / CHARS_PER_TOKEN),
      });
    };

    return new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        controller.enqueue(chunk);
        // Each complete line is read EXACTLY ONCE — the trailing partial frame is carried to the
        // next chunk instead. Re-scanning a rolling window would count the same deltas repeatedly
        // and inflate the fallback figure a client is charged on.
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        // No SSE frame we care about is this long; a buffer that big is a stuck parse, not a usage
        // chunk, and holding it would grow without bound.
        if (pending.length > 64_000) pending = '';
        for (const line of lines) {
          const payload = line.startsWith('data:') ? line.slice(5).trim() : '';
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as {
              usage?: OpenRouterUsage;
              choices?: Array<{ delta?: { content?: unknown; reasoning?: unknown } }>;
            };
            for (const choice of parsed.choices ?? []) {
              observedChars +=
                textLength(choice.delta?.content) + textLength(choice.delta?.reasoning);
            }
            if (parsed.usage) settle(parsed.usage);
          } catch {
            // A partial frame at the boundary — the next chunk completes it.
          }
        }
      },
      // Both endings settle: `flush` for a stream that finished, `cancel` for a client that walked
      // away. Whichever fires first wins, and the other is a no-op.
      flush: () => settle(),
      cancel: () => settle(),
    });
  }

  /**
   * Shared validation, guard rails and PRE-FLIGHT SPEND CHECK for both paths.
   *
   * The reserve check lives here rather than in the guard because it needs the model and the output
   * ceiling, which only exist once the body has been validated and capped. Refusing before the call
   * is what bounds an exhausted team's overspend to one call instead of a whole run: the cost of a
   * completion is not knowable until it has been produced, so the charge cannot come first.
   */
  private async prepare(raw: ChatBody, principal: AgentPrincipal): Promise<PreparedCall> {
    const key = this.config.get<string>('OPENROUTER_API_KEY')?.trim();
    if (!key) {
      // The variable name goes in the JOURNAL, not in the answer: the client is not the operator,
      // and "OPENROUTER_API_KEY is not configured" is a sentence no user can act on. 503 also puts
      // this in the same bucket as a refused key, which is right — both are the operator's to fix.
      this.logger.error(
        'agent/llm OPERATOR_FAULT reason=key_missing — OPENROUTER_API_KEY is not set, so every ' +
          'managed Lobee call is refused. See apps/backend/.env.example.',
      );
      throw new ServiceUnavailableException(OPERATOR_FAULT_MESSAGE);
    }
    if (typeof raw.model !== 'string' || !Array.isArray(raw.messages)) {
      throw new BadRequestException('body must include a string `model` and a `messages` array');
    }
    const model = raw.model;
    if (model.length > 300 || !MODEL_ID.test(model)) {
      throw new BadRequestException('body contains an invalid `model` id');
    }
    if (raw.tools !== undefined && !Array.isArray(raw.tools)) {
      throw new BadRequestException('`tools` must be an array when provided');
    }
    const requiresTools = Array.isArray(raw.tools) && raw.tools.length > 0;
    if (!requiresTools && raw.tool_choice !== undefined) {
      throw new BadRequestException('`tool_choice` requires at least one tool');
    }
    await this.assertModelAllowed(model, requiresTools);

    // The loop allows up to 8k for reasoning-heavy steps; cap there by default instead of silently
    // truncating the loop's request to 2k. Deployments can still choose a lower spend ceiling.
    const cap = toBoundedPositiveInt(this.config.get('AGENT_MAX_OUTPUT_TOKENS'), 8192, 32_768);
    const maxTokensOut = Math.min(toPositiveInt(raw.max_tokens, cap), cap);
    const promptTokens = estimatePromptTokens(raw);

    const estimatedMicros = this.spend.estimateMicros({
      model,
      tokensIn: promptTokens,
      maxTokensOut,
    });
    // A model we cannot price is refused rather than served: the alternative is the operator paying
    // for it out of their own OpenRouter balance and finding out at the end of the month.
    if (estimatedMicros === undefined) throw modelUnpriced(model, principal.tier);

    const affordability = await this.spend.canAfford(principal.teamId, estimatedMicros);
    if (!affordability.ok) {
      throw insufficientCredit({
        currentTier: principal.tier,
        balanceCents: affordability.balanceCents,
        requiredCents: affordability.requiredCents,
      });
    }

    return {
      key,
      forward: {
        ...raw,
        model,
        max_tokens: maxTokensOut,
        // Defense-in-depth for older desktop bundles: Claude thinking rejects forced tool selection.
        ...(requiresTools && model.startsWith('anthropic/') ? { tool_choice: 'auto' } : {}),
        // Ask OpenRouter to return what it actually charged. That figure is authoritative — it
        // already reflects the provider it routed to and the discounts that applied — and the local
        // price table is only the fallback for a response that carries no cost. Placed AFTER the
        // spread so a client cannot switch its own billing off.
        usage: { include: true },
      },
      timeoutMs: toBoundedPositiveInt(
        this.config.get('AGENT_UPSTREAM_TIMEOUT_MS'),
        DEFAULT_COMPLETION_TIMEOUT_MS,
        120_000,
      ),
      model,
      promptTokens,
    };
  }

  async chatCompletion(
    raw: ChatBody,
    principal: AgentPrincipal,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }> {
    const prepared = await this.prepare(raw, principal);
    const { key, forward, timeoutMs, model } = prepared;

    let res: Response;
    try {
      res = await fetchWithTimeout(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            'http-referer': 'https://lobster.browser',
            'x-title': 'Lobster Agent',
          },
          body: JSON.stringify(forward),
        },
        timeoutMs,
        signal,
      );
    } catch (error) {
      if (error instanceof UpstreamTimeoutError) {
        this.logger.warn(`agent/llm timeout model=${model} afterMs=${timeoutMs}`);
        throw new GatewayTimeoutException('upstream OpenRouter request timed out');
      }
      const kind = error instanceof UpstreamCancelledError ? 'cancelled' : diagnosticKind(error);
      this.logger.warn(`agent/llm transport_error model=${model} kind=${kind}`);
      throw new ServiceUnavailableException('upstream OpenRouter request failed');
    }

    const body = (await res.json().catch(() => ({}))) as OpenRouterErrorBody & {
      usage?: OpenRouterUsage;
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    if (res.ok) {
      // A 2xx with no usage block still produced tokens someone paid for. Fall back to the prompt
      // estimate and the length of what came back rather than serving the call for free.
      await this.charge(prepared, principal, body.usage, {
        tokensIn: prepared.promptTokens,
        tokensOut: Math.ceil(
          (body.choices ?? []).reduce((sum, c) => sum + textLength(c.message?.content), 0) /
            CHARS_PER_TOKEN,
        ),
      });
    } else {
      const code = diagnosticCode(body.error?.code ?? body.error?.type);
      const requestId = requestIdOf(res);
      this.logger.warn(
        `agent/llm upstream_error model=${model} status=${res.status} code=${code} requestId=${requestId}`,
      );
      const fault = translateUpstreamFailure(res.status, code, errorMessageOf(body));
      if (fault?.operatorFault) {
        // Deliberately NOT metered — see the streaming path for why "nothing was charged" has to be
        // true rather than nearly true.
        this.reportUpstreamFault(fault, model, res.status, code, requestId);
        return { status: fault.status, body: upstreamFaultBody(fault) };
      }
      await this.settleFailure(prepared, principal, body.usage);
      if (fault) {
        return { status: fault.status, body: upstreamFaultBody(fault) };
      }
    }
    return { status: res.status, body };
  }

  /** Newest-first per-team usage, for the panel's spend view and for explaining a charge. */
  async usage(teamId: string, limit = 50): Promise<AgentUsageRow[]> {
    return this.spend.listUsage(teamId, limit);
  }

  /**
   * Say loudly, in the operator's log, that this one is theirs.
   *
   * The user is given one honest sentence and no way to act on it, so the only thing that can end
   * this outage is somebody reading the journal. `error` and not `warn`: a revoked key or an empty
   * provider balance stops EVERY managed run on the deployment at once, and at `warn` it sits
   * indistinguishable from the ordinary upstream noise until a customer complains.
   */
  private reportUpstreamFault(
    fault: UpstreamFault,
    model: string,
    upstreamStatus: number,
    code: string,
    requestId: string,
  ): void {
    if (!fault.operatorFault) return;
    this.logger.error(
      `agent/llm OPERATOR_FAULT reason=${fault.reason} upstreamStatus=${upstreamStatus} ` +
        `code=${code} requestId=${requestId} model=${model} — OpenRouter refused the ` +
        'OPENROUTER_API_KEY this backend runs on (revoked key, exhausted operator balance, or key ' +
        'spend cap). Every managed Lobee run fails until it is fixed; no customer was charged.',
    );
  }

  /**
   * Account for a call the upstream refused.
   *
   * Only when the provider reported usage. A rejected request usually generated nothing and must
   * not be charged for — but a generation that was cut off part-way HAS been billed to us, and the
   * usage block is the only evidence of it. Metering nothing in either case, which is what happened
   * before, means every truncated generation was free to the customer and paid for by the operator.
   */
  private async settleFailure(
    prepared: PreparedCall,
    principal: AgentPrincipal,
    usage: OpenRouterUsage | undefined,
  ): Promise<void> {
    if (!usage) return;
    await this.charge(prepared, principal, usage, { tokensIn: 0, tokensOut: 0 });
  }

  /**
   * Turn one call's usage into a charge against the team's Credit.
   *
   * `fallback` is used per-field: the provider's figure wins whenever it exists, and each missing
   * one is replaced individually, so a payload that reports input but not output is not treated as
   * a payload that reports nothing.
   *
   * NEVER THROWS. The answer has already been served — the customer has their tokens whatever
   * happens here — so a metering failure is logged and swallowed rather than turned into a 500 on a
   * request that succeeded. The accrual is idempotent-by-carry: unflushed micros stay owed.
   */
  private async charge(
    prepared: PreparedCall,
    principal: AgentPrincipal,
    usage: OpenRouterUsage | undefined,
    fallback: { tokensIn: number; tokensOut: number },
  ): Promise<void> {
    const tokensIn = usage?.prompt_tokens ?? fallback.tokensIn;
    const tokensOut = usage?.completion_tokens ?? fallback.tokensOut;
    const cachedIn = Math.min(usage?.prompt_tokens_details?.cached_tokens ?? 0, tokensIn);
    try {
      const result = await this.spend.charge({
        teamId: principal.teamId,
        userId: principal.userId,
        profileId: principal.profileId,
        sessionId: principal.sessionId,
        model: prepared.model,
        tokensIn,
        tokensOut,
        cachedIn,
        ...(typeof usage?.cost === 'number' ? { providerCostUsd: usage.cost } : {}),
      });
      // Log ONLY accounting — never message content (anonymity product).
      this.logger.log(
        `agent/llm model=${prepared.model} team=${principal.teamId} in=${tokensIn} cached=${cachedIn} out=${tokensOut} micros=${result.costMicros} cents=${result.chargedCents} measured=${usage ? 1 : 0}`,
      );
    } catch (error) {
      this.logger.error(
        `agent/llm charge_failed team=${principal.teamId} model=${prepared.model} kind=${diagnosticKind(error)}`,
      );
    }
  }

  private async assertModelAllowed(model: string, requiresTools: boolean): Promise<void> {
    const roster = await this.listModels();
    const selected = roster.models.find((entry) => entry.id === model && entry.available);
    if (!selected) {
      throw new BadRequestException(`model "${model}" is not in the current managed-model roster`);
    }
    if (requiresTools && !selected.agentCapable) {
      throw new BadRequestException(
        `model "${model}" supports Ask mode but not the structured tools required by Agent mode`,
      );
    }
  }

  private configuredModels(): ReadonlySet<string> {
    const configured = (this.config.get<string>('AGENT_ALLOWED_MODELS') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length <= 300 && MODEL_ID.test(entry));
    return new Set(configured);
  }
}

class UpstreamTimeoutError extends Error {
  constructor() {
    super('upstream_timeout');
    this.name = 'UpstreamTimeoutError';
  }
}

class UpstreamCancelledError extends Error {
  constructor() {
    super('upstream_cancelled');
    this.name = 'UpstreamCancelledError';
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<Response> {
  if (parentSignal?.aborted) throw new UpstreamCancelledError();

  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const onCancel = (): void => {
    cancelled = true;
    controller.abort();
  };
  parentSignal?.addEventListener('abort', onCancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new UpstreamTimeoutError();
    if (cancelled || parentSignal?.aborted) throw new UpstreamCancelledError();
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onCancel);
  }
}

function isExpired(expirationDate: string | null | undefined): boolean {
  if (!expirationDate) return false;
  const timestamp = Date.parse(expirationDate);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function isNonTextOutput(outputModalities: string[] | undefined): boolean {
  return Boolean(outputModalities?.length && !outputModalities.includes('text'));
}

function diagnosticKind(error: unknown): string {
  if (error instanceof UpstreamTimeoutError) return 'timeout';
  if (error instanceof UpstreamCancelledError) return 'cancelled';
  return diagnosticCode(error instanceof Error ? error.name : typeof error);
}

/** The provider's own sentence, for CLASSIFYING a failure. Never forwarded, never logged. */
function errorMessageOf(body: OpenRouterErrorBody): string {
  const message = body.error?.message ?? body.message;
  return typeof message === 'string' ? message : '';
}

/** OpenRouter's id for this call — the one thing that makes a support ticket answerable. */
function requestIdOf(res: Response): string {
  return diagnosticCode(
    res.headers.get('x-request-id') ?? res.headers.get('openrouter-request-id'),
  );
}

function diagnosticCode(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return 'unknown';
  const safe = String(value)
    .slice(0, 64)
    .replace(/[^a-z0-9._:-]/gi, '_');
  return safe || 'unknown';
}

function toPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function toBoundedPositiveInt(value: unknown, fallback: number, maximum: number): number {
  return Math.min(toPositiveInt(value, fallback), maximum);
}

/**
 * Length of a message part, whether it is a plain string or the multi-part content array the
 * OpenAI schema also allows. Only the LENGTH is ever read — the text itself is never inspected,
 * stored or logged.
 */
function textLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const part of value) {
    const text = (part as { text?: unknown } | null)?.text;
    if (typeof text === 'string') total += text.length;
  }
  return total;
}

/**
 * Prompt size before the call, for the reserve check.
 *
 * A real tokenizer would be more accurate and would also mean shipping a per-model vocabulary and
 * running it on every request. This is used to RESERVE, not to bill — the charge is always made
 * against what the provider reports — so being within a few percent is enough, and the direction
 * that matters (under-reserving) is covered by the estimate pricing the full authorised output.
 */
function estimatePromptTokens(raw: ChatBody): number {
  let chars = 0;
  for (const message of Array.isArray(raw.messages) ? raw.messages : []) {
    const content = (message as { content?: unknown } | null)?.content;
    chars += textLength(content);
  }
  if (Array.isArray(raw.tools)) chars += JSON.stringify(raw.tools).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
