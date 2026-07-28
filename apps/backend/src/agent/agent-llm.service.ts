import {
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentModelInfo, AgentModelsResult } from '@lobster/shared-types';

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

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * The managed LLM path. It holds the SERVER's OpenRouter key and brokers the sidecar's OpenAI-compatible
 * chat/completions calls, so a managed run never exposes the key to the desktop/client (the BYOK path's
 * whole reason to exist elsewhere). It meters token usage for billing and applies cheap-by-default guard
 * rails: a hard `max_tokens` cap and an optional model allowlist, so a misconfigured or hostile client
 * can't burn the balance on an expensive model or an unbounded response.
 *
 * Streaming is intentionally not supported: the agent loop uses ONE non-streaming completion per step,
 * so a plain request→response forward is the correct, simplest contract (and easiest to meter).
 */
@Injectable()
export class AgentLlmService {
  private readonly logger = new Logger(AgentLlmService.name);
  private meteredTokens = 0;
  private meteredRequests = 0;
  private modelsCache?: { at: number; payload: AgentModelsResult };

  constructor(private readonly config: ConfigService) {}

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

  async chatCompletion(
    raw: ChatBody,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }> {
    const key = this.config.get<string>('OPENROUTER_API_KEY')?.trim();
    if (!key) throw new ServiceUnavailableException('OPENROUTER_API_KEY is not configured');

    if (typeof raw.model !== 'string' || !Array.isArray(raw.messages)) {
      throw new BadRequestException('body must include a string `model` and a `messages` array');
    }
    const model = raw.model;
    if (model.length > 300 || !MODEL_ID.test(model)) {
      throw new BadRequestException('body contains an invalid `model` id');
    }
    if (raw.stream === true) {
      throw new BadRequestException('streaming is not supported on the managed proxy');
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
    const requested = toPositiveInt(raw.max_tokens, cap);
    const forward: ChatBody = {
      ...raw,
      model,
      max_tokens: Math.min(requested, cap),
      // Defense-in-depth for older desktop bundles: Claude thinking rejects forced tool selection.
      ...(requiresTools && model.startsWith('anthropic/') ? { tool_choice: 'auto' } : {}),
    };

    let res: Response;
    const timeoutMs = toBoundedPositiveInt(
      this.config.get('AGENT_UPSTREAM_TIMEOUT_MS'),
      DEFAULT_COMPLETION_TIMEOUT_MS,
      120_000,
    );
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
    };
    if (res.ok && body.usage) {
      const used = (body.usage.prompt_tokens ?? 0) + (body.usage.completion_tokens ?? 0);
      this.meteredTokens += used;
      this.meteredRequests += 1;
      // Log ONLY aggregate accounting — never message content (anonymity product).
      this.logger.log(
        `agent/llm model=${forward.model} in=${body.usage.prompt_tokens ?? 0} out=${body.usage.completion_tokens ?? 0} lifetimeTokens=${this.meteredTokens}`,
      );
    } else if (!res.ok) {
      const code = diagnosticCode(body.error?.code ?? body.error?.type);
      const requestId = diagnosticCode(
        res.headers.get('x-request-id') ?? res.headers.get('openrouter-request-id'),
      );
      this.logger.warn(
        `agent/llm upstream_error model=${model} status=${res.status} code=${code} requestId=${requestId} tools=${requiresTools}`,
      );
    }
    return { status: res.status, body };
  }

  usage(): { meteredTokens: number; meteredRequests: number } {
    return { meteredTokens: this.meteredTokens, meteredRequests: this.meteredRequests };
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
  timer.unref();

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
