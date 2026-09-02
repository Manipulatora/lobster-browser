import {
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentModelInfo, AgentModelsResult } from '@lobster/shared-types';

import { AgentSpendService } from '../billing/agent-spend.service';
import type { AgentUsageRow } from '../billing/billing.repository';
import type { AgentPrincipal } from './agent-auth.guard';
import { insufficientCredit, modelUnpriced } from './agent-refusal';

/**
 * THE roster surfaced in the Lobee picker — exactly these ids, in exactly this order. This is the
 * SOURCE OF TRUTH for the model list — the panel no longer owns it, and neither does OpenRouter's
 * catalog: the catalog only annotates each entry with live availability and capabilities (a model
 * missing from it is still listed, greyed out, rather than silently vanishing). Ids are OpenRouter
 * model ids. To offer anything beyond these seven, list its exact id in `AGENT_ALLOWED_MODELS`.
 */
const FEATURED: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'openai/gpt-5.6-sol', label: 'GPT 5.6 Sol' },
  { id: 'openai/gpt-5.6-terra', label: 'GPT 5.6 Terra' },
  { id: 'openai/gpt-5.6-luna', label: 'GPT 5.6 Luna' },
  { id: 'anthropic/claude-fable-5', label: 'Claude Fable 5' },
  { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5' },
  { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8' },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
];
const MODELS_CACHE_MS = 60 * 60 * 1000;
/**
 * How long a failed catalog sync is remembered before OpenRouter is asked again.
 *
 * Without it, a catalog that was down when the process started was re-fetched by EVERY request —
 * each one waiting out the full sync timeout and then failing with a 400 the panel rendered as a
 * model error, at whatever rate Lobee was stepping.
 */
const MODELS_SYNC_RETRY_MS = 60 * 1000;
/** The background refresh runs this long before the cache would expire, so a request never syncs inline in steady state. */
const MODELS_REFRESH_LEAD_MS = 5 * 60 * 1000;
const DEFAULT_MODEL_SYNC_TIMEOUT_MS = 10_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 55_000;
const MODEL_ID = /^[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._:+~-]*$/i;
type AgentEffort = 'low' | 'medium' | 'high';
const VALID_EFFORTS: ReadonlySet<string> = new Set<AgentEffort>(['low', 'medium', 'high']);

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
  /**
   * Whether this call's charge has been dispatched. One call, one charge: the buffered path and
   * both ends of the streaming path all settle through {@link AgentLlmService.settle}, and this is
   * the latch that keeps a stream that reported usage and then flushed from paying twice.
   */
  settled: boolean;
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
export class AgentLlmService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentLlmService.name);
  private modelsCache?: { at: number; payload: AgentModelsResult };
  /** When the last catalog sync failed; undefined once one has succeeded since. */
  private modelsSyncFailedAt?: number;
  /** The catalog sync in flight, shared by every caller that arrives while it runs. */
  private modelsSync?: Promise<void>;
  private refreshTimer?: NodeJS.Timeout;
  /** Set on shutdown, so a sync that finishes afterwards books no further refresh. */
  private stopped = false;
  /** Wall clock, overridable by tests that need to move it. */
  private now = (): number => Date.now();

  constructor(
    private readonly config: ConfigService,
    private readonly spend: AgentSpendService,
  ) {}

  /**
   * Say at BOOT what a missing operator key costs, instead of at the first user request — and,
   * when there is a key, start warming the roster.
   *
   * NOT a boot failure, deliberately. This key powers one module; refusing to start without it would
   * take sign-in, profile sync and billing down for a deployment that simply does not sell the
   * agent, and `/health/ready` — which systemd's ExecStartPost polls — would then fail the whole
   * unit. A backend with no key serves everything else correctly. What it must not do is start
   * silently and let the operator discover the gap from a customer, which is what `.env.example`
   * not listing the variable at all made the normal outcome. `/health/agent` carries the same fact
   * for anything that reads rather than tails.
   *
   * THE WARM-UP IS NOT AWAITED EITHER, for the same reason: boot must not depend on OpenRouter
   * answering. The first request used to pay for the catalog sync inline — up to the full sync
   * timeout before its own model was even contacted — and a catalog that was slow at boot made
   * every request pay it again. Now the sync starts here, in the background, and a timer keeps the
   * cache from ever expiring under a request.
   */
  onModuleInit(): void {
    if (!this.config.get<string>('OPENROUTER_API_KEY')?.trim()) {
      this.logger.warn(
        'OPENROUTER_API_KEY is not set — the managed Lobee agent is DISABLED on this backend: ' +
          '/agent/llm/chat/completions answers 503 and /agent/llm/models serves an empty roster. ' +
          'Nothing else is affected. See apps/backend/.env.example.',
      );
      return;
    }
    this.refreshRosterInBackground();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  /**
   * Sync the catalog, then book the next sync: early enough that the cache never expires under a
   * request, or after the retry window when this one failed. `unref` so a pending refresh never
   * holds the process open.
   */
  private refreshRosterInBackground(): void {
    void this.syncRoster().then(() => {
      if (this.stopped) return;
      const delay =
        this.modelsSyncFailedAt === undefined
          ? MODELS_CACHE_MS - MODELS_REFRESH_LEAD_MS
          : MODELS_SYNC_RETRY_MS;
      this.refreshTimer = setTimeout(() => this.refreshRosterInBackground(), delay);
      this.refreshTimer.unref?.();
    });
  }

  /**
   * Lobee's model roster: the pinned {@link FEATURED} seven, annotated from the live OpenRouter catalog
   * and cached for about an hour. Text-chat models remain available to Ask mode while `agentCapable`
   * identifies the smaller set that satisfies the loop's structured-tool contract. The key stays
   * server-side. A sync failure serves only a previously verified stale cache; a cold failure returns an
   * empty roster rather than inventing models.
   *
   * NEVER MORE THAN ONE CATALOG FETCH AT A TIME, AND NONE FOR A MINUTE AFTER ONE FAILS. The cache
   * is warmed at boot and refreshed by a timer, so in steady state this is a lookup. When the cache
   * is cold or has expired, every caller that arrives during a sync shares THAT sync rather than
   * starting its own; and a failed sync is remembered for {@link MODELS_SYNC_RETRY_MS}, during
   * which the stale roster (or an empty one) is served at once instead of each request waiting out
   * the sync timeout and hammering a catalog that is already struggling.
   */
  async listModels(): Promise<AgentModelsResult> {
    const key = this.config.get<string>('OPENROUTER_API_KEY')?.trim();
    if (!key) {
      this.logger.warn('OpenRouter model sync skipped: OPENROUTER_API_KEY is not configured');
      return { updatedAt: new Date().toISOString(), stale: true, models: [] };
    }
    const cached = this.freshRoster();
    if (cached) return cached;
    const retryDue =
      this.modelsSyncFailedAt === undefined ||
      this.now() - this.modelsSyncFailedAt >= MODELS_SYNC_RETRY_MS;
    if (retryDue) await this.syncRoster();
    const synced = this.freshRoster();
    if (synced) return synced;
    // A real stale roster is safe; invented ids are not. On a cold failure expose no selectable model.
    if (this.modelsCache) return { ...this.modelsCache.payload, stale: true };
    return { updatedAt: new Date().toISOString(), stale: true, models: [] };
  }

  /** The cached roster, when it is younger than the cache window. */
  private freshRoster(): AgentModelsResult | undefined {
    if (!this.modelsCache) return undefined;
    return this.now() - this.modelsCache.at < MODELS_CACHE_MS
      ? this.modelsCache.payload
      : undefined;
  }

  /** Coalesce: every caller during a sync awaits the same one. */
  private syncRoster(): Promise<void> {
    if (!this.modelsSync) {
      this.modelsSync = this.loadRoster().finally(() => {
        this.modelsSync = undefined;
      });
    }
    return this.modelsSync;
  }

  /**
   * One catalog fetch: on success the roster is rebuilt and cached, on failure the failure is
   * remembered. Never throws — a broken catalog is a stale roster, not a broken request.
   */
  private async loadRoster(): Promise<void> {
    const key = this.config.get<string>('OPENROUTER_API_KEY')?.trim();
    if (!key) return;
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
      if (!res.ok) throw new CatalogSyncError(`status=${res.status}`);
      const body = (await res.json()) as { data?: OpenRouterModel[] };
      if (!Array.isArray(body.data)) throw new CatalogSyncError('invalid_model_catalog');
      // The build sits inside the try as well: this runs unattended at boot, where a malformed
      // catalog entry has to become a remembered failure, not an unhandled rejection that takes
      // the process down with it.
      const payload = this.buildRoster(new Map(body.data.map((m) => [m.id, m])));
      this.modelsCache = { at: this.now(), payload };
      this.modelsSyncFailedAt = undefined;
    } catch (error) {
      // Remembered, so the next minute of requests is answered from what we have instead of each
      // one asking a catalog that just failed to answer.
      this.modelsSyncFailedAt = this.now();
      const detail =
        error instanceof CatalogSyncError ? error.detail : `kind=${diagnosticKind(error)}`;
      this.logger.warn(
        `OpenRouter model sync failed ${detail}; next attempt in ${MODELS_SYNC_RETRY_MS / 1000}s`,
      );
    }
  }

  /** The roster as the panel sees it, from one live catalog. Pure: the catalog in, the payload out. */
  private buildRoster(live: Map<string, OpenRouterModel>): AgentModelsResult {
    // THE ROSTER IS A PRODUCT SURFACE, NOT A MIRROR OF OPENROUTER. The previous build walked the
    // live catalog filtered by brand, so the dropdown offered the ENTIRE OpenAI / Anthropic /
    // Google catalogs and FEATURED was only decoration (a nicer label plus sort order) — and a
    // curated id the catalog happened to lack silently vanished. Inverted: FEATURED is walked in
    // its own order, and the catalog's only job is to say whether each entry is live and what it
    // can do. A curated id the catalog is missing (or cannot serve under the forwarded request
    // contract — the mandatory `max_tokens` spend bound, text output, not expired) is STILL
    // emitted, with `available: false`, so the picker greys it out instead of the model
    // disappearing without explanation; `assertModelAllowed` requires `available`, so a greyed
    // entry can never actually run. `AGENT_ALLOWED_MODELS` remains the escape hatch: live ids it
    // names append AFTER the seven.
    const explicitlyAllowed = this.configuredModels();
    /** Can this live catalog entry accept the request contract the proxy forwards? */
    const servable = (id: string, entry: OpenRouterModel): boolean => {
      const supported = new Set(entry.supported_parameters ?? []);
      return (
        id.length <= 300 &&
        MODEL_ID.test(id) &&
        !NON_CHAT.test(id) &&
        supported.has('max_tokens') &&
        !isExpired(entry.expiration_date) &&
        !isNonTextOutput(entry.architecture?.output_modalities)
      );
    };
    /** Annotate one servable catalog entry with the capabilities the panel branches on. */
    const describe = (
      id: string,
      label: string,
      featured: boolean,
      entry: OpenRouterModel,
    ): AgentModelInfo => {
      const supported = new Set(entry.supported_parameters ?? []);
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
      return {
        id,
        label,
        brand: id.split('/')[0] ?? '',
        featured,
        available: true,
        agentCapable,
        reasoning,
        efforts: reasoning ? efforts : [],
        ...(entry.context_length ? { contextLength: entry.context_length } : {}),
      };
    };
    const models: AgentModelInfo[] = [];
    for (const { id, label } of FEATURED) {
      const entry = live.get(id);
      models.push(
        entry && servable(id, entry)
          ? describe(id, label, true, entry)
          : // Greyed out, not gone — the curated label still names it, nothing about it can run.
            {
              id,
              label,
              brand: id.split('/')[0] ?? '',
              featured: true,
              available: false,
              agentCapable: false,
              reasoning: false,
              efforts: [],
            },
      );
    }
    // Env-configured extras append after the seven, in catalog order. Unlike FEATURED these are an
    // operator's own additions, so an id the catalog cannot serve is omitted rather than seeded.
    const pinned = new Set(FEATURED.map((f) => f.id));
    for (const [id, entry] of live) {
      if (pinned.has(id) || !explicitlyAllowed.has(id) || !servable(id, entry)) continue;
      models.push(describe(id, entry.name ?? id, false, entry));
    }
    // No sort: FEATURED order IS the product order, and extras keep the catalog's own.
    return {
      updatedAt: new Date().toISOString(),
      stale: false,
      models,
    };
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
      this.settleFailure(prepared, principal, body.usage);
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
    let observedChars = 0;

    const settle = (usage?: OpenRouterUsage): void =>
      this.settle(prepared, principal, usage, {
        tokensIn: prepared.promptTokens,
        tokensOut: Math.ceil(observedChars / CHARS_PER_TOKEN),
      });

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
        // `tool_choice` is forwarded exactly as sent. This used to be rewritten to 'auto' for every
        // Anthropic model, a shim for old desktop bundles — which silently discarded the loop's
        // forced `act` call, so Claude could answer a step in prose, and a step with no action is
        // one the run cannot execute. The roster admits a model to Agent mode only when the catalog
        // says it accepts `tool_choice`, and the CLIENT is the one place that decides what to send
        // (`usesAutomaticToolChoice` in packages/agent); a choice the provider will not take is now
        // its own visible 400 rather than a downgrade nobody can see.
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
      settled: false,
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
      this.settle(prepared, principal, body.usage, {
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
      this.settleFailure(prepared, principal, body.usage);
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
  private settleFailure(
    prepared: PreparedCall,
    principal: AgentPrincipal,
    usage: OpenRouterUsage | undefined,
  ): void {
    if (!usage) return;
    this.settle(prepared, principal, usage, { tokensIn: 0, tokensOut: 0 });
  }

  /**
   * Meter one call OFF THE CRITICAL PATH: exactly once, and only after the answer has left.
   *
   * The buffered path used to run reserve → upstream → debit inline, and the debit is the
   * expensive half: two transactions on the wallet row plus the usage row, several round trips,
   * before the sidecar saw the tool call it was waiting on — on every step of every run, with two
   * runs on one team queueing on the same row. The customer has their tokens the moment OpenRouter
   * answers; the ledger does not have to be written before they are told so. `setImmediate` runs
   * the charge once the current turn has finished writing the response, and the accrual it goes
   * through is the durable one (`AgentSpendService.charge`: accrue first, flush second), so a
   * charge that fails is under-collected micros the next flush recovers, never a double.
   *
   * ONCE. The latch on the prepared call is what makes settlement idempotent per request across
   * every path that can reach it — a 2xx, a non-2xx that still reported usage, a stream's usage
   * frame and then its flush.
   */
  private settle(
    prepared: PreparedCall,
    principal: AgentPrincipal,
    usage: OpenRouterUsage | undefined,
    fallback: { tokensIn: number; tokensOut: number },
  ): void {
    if (prepared.settled) return;
    prepared.settled = true;
    setImmediate(() => void this.charge(prepared, principal, usage, fallback));
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

/** A catalog answer that could not be used, carrying what the log line needs and nothing else. */
class CatalogSyncError extends Error {
  constructor(readonly detail: string) {
    super('catalog_sync_failed');
    this.name = 'CatalogSyncError';
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
