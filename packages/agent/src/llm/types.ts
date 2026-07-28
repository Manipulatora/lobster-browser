import type { AgentUsage } from '@lobster/shared-types';

/**
 * Provider-agnostic LLM surface. The agent loop speaks ONLY this interface; each provider (Anthropic,
 * OpenAI, Google, xAI, OpenRouter) has an adapter that maps to/from its wire format. This is why the
 * loop is provider-neutral. Managed transport can implement this interface when the authenticated
 * backend proxy is available; today only direct BYOK adapters are constructed.
 */

/** A function/tool the model may call. `inputSchema` is a JSON Schema object. */
export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One request. The loop rebuilds this each step: cached `system`, a single `user` message, one tool. */
export interface LlmRequest {
  model: string;
  system: string;
  /** The step's user content (task/history/observation live here or in `system`). */
  user: string;
  /** Ephemeral visual fallbacks. Adapters send these as image inputs; callers never persist them. */
  images?: Array<{ mediaType: 'image/png' | 'image/jpeg'; data: string }>;
  tools: LlmTool[];
  /** Force the model to call this tool (structured action output). */
  forceTool: string;
  maxTokens: number;
  /**
   * Hint the adapter to mark the stable prefix (system + tools) cacheable. Providers that support
   * prompt caching (Anthropic, OpenRouter) act on it; others ignore it. Default true for the loop.
   */
  cachePrefix?: boolean;
  /**
   * Stable per-run id for OpenRouter sticky routing (`session_id`, ≤256 chars): pins every step of a
   * run to the SAME provider endpoint so the cached prefix keeps hitting. Ignored by non-OpenRouter
   * adapters. The loop passes the runId.
   */
  sessionId?: string;
  /** Reasoning effort → OpenRouter `reasoning: { effort }` (cross-provider). Omit for the default. */
  effort?: 'low' | 'medium' | 'high';
  /** Abort the in-flight HTTP request when the run is stopped. */
  signal?: AbortSignal;
}

/** A tool call the model returned. */
export interface LlmToolCall {
  name: string;
  /** Parsed JSON arguments (adapters parse provider-specific encodings before returning). */
  input: Record<string, unknown>;
}

export interface LlmResult {
  /** The forced tool call, when the model produced one. */
  toolCall?: LlmToolCall;
  /** Any assistant prose (usually empty when a tool is forced). */
  text?: string;
  usage: AgentUsage;
  /** Provider stop reason, normalized loosely: `tool` | `stop` | `length` | `refusal` | other. */
  stopReason: string;
}

export interface LlmClient {
  /** One non-streaming completion. Rejects on transport/HTTP error (the loop treats it as a step error). */
  complete(req: LlmRequest): Promise<LlmResult>;
  /** Provider label for logs/usage. */
  readonly provider: string;
}
