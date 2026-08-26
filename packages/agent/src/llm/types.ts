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

/** An image attached to a user turn. Ephemeral — never persisted into thread history. */
export interface LlmImage {
  mediaType: 'image/png' | 'image/jpeg';
  data: string;
}

/**
 * One turn in the conversation.
 *
 * This is a REAL message array, not a transcript pasted into a single user string. That distinction is
 * load-bearing: the model must see its own prior tool calls as assistant turns and their outcomes as
 * tool results, otherwise every step is a stateless guess and the harness has to re-narrate history as
 * prose (which is both lossy and far more expensive).
 *
 * `tool` turns MUST directly follow the assistant turn whose `toolCalls` they answer, and every tool
 * call needs a matching result — Anthropic and OpenAI both reject a dangling call. {@link normalizeMessages}
 * enforces that so a cancelled or errored step cannot produce an unsendable history.
 */
export type LlmMessage =
  | { role: 'user'; content: string; images?: LlmImage[] }
  | { role: 'assistant'; content?: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

/** One request. `system` is the cached stable prefix; `messages` is the conversation. */
export interface LlmRequest {
  model: string;
  /** Stable, cacheable system prefix (persona + operating rules + task). */
  system: string;
  /** The conversation so far, oldest first. Must end with a `user` or `tool` turn. */
  messages: LlmMessage[];
  tools: LlmTool[];
  /** Force the model to call this tool (structured action output). Empty = let the model choose. */
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
  /**
   * Who to bill this call to, beyond the team the token already names.
   *
   * The backend has always been ready for it — AgentAuthGuard reads `x-lobster-profile-id` and
   * `x-lobster-session-id` into the principal and agent-llm.service charges with them, and
   * AgentUsage has the columns — but nothing ever sent the headers, so every row was written with
   * both NULL and per-profile spend could not be reported at all.
   *
   * Sent ONLY to the managed endpoint. A profile id is an internal identifier of the user's own
   * infrastructure; forwarding it to OpenRouter or an Anthropic BYOK key would hand a third party a
   * stable per-profile correlator for no benefit.
   */
  attribution?: { profileId: string; sessionId: string };
  /** Abort the in-flight HTTP request when the run is stopped. */
  signal?: AbortSignal;
  /** Receive assistant text as it arrives. Adapters that stream call this; others never do. */
  onTextDelta?: (delta: string) => void;
  /**
   * Called before each transport retry. The loop turns it into a visible event, so a run waiting out
   * a rate limit reads as "retrying in 8s" rather than as a hang the user is tempted to kill.
   */
  onRetry?: (info: { attempt: number; attempts: number; delayMs: number; reason: string }) => void;
}

/** A tool call the model returned. */
export interface LlmToolCall {
  /**
   * Provider-assigned call id, echoed back on the matching `tool` turn. Synthesized when a provider
   * omits it (Google names calls rather than issuing ids), because the correlation is what makes a
   * multi-step history replayable.
   */
  id: string;
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
  /** One completion. Rejects on transport/HTTP error (the loop treats it as a step error). */
  complete(req: LlmRequest): Promise<LlmResult>;
  /** Provider label for logs/usage. */
  readonly provider: string;
  /**
   * Will this adapter actually put `effort` on the wire for this model?
   *
   * The loop raises its output reservation eightfold when effort is set, because where effort IS sent
   * the reasoning budget comes out of `max_tokens`. Adapters that silently drop it — the direct
   * Anthropic and Google ones, and every non-reasoning model on the OpenAI dialect — got the
   * eightfold reservation anyway, draining the run's token allowance for no reasoning at all. An
   * adapter that omits this answers "no", which is the safe reading of an unimplemented capability.
   */
  sendsEffort?(model: string, effort: NonNullable<LlmRequest['effort']>): boolean;
}

/**
 * Make a message list safe to send to any provider.
 *
 * Providers are strict about tool-call bookkeeping in ways that are easy to violate accidentally: a run
 * aborted mid-step, a step that threw before executing, or a history trimmed at the wrong boundary all
 * leave an assistant `tool_use` with no result, which is a hard 400 rather than a degraded answer. Rather
 * than making every call site defensive, repair it in one place:
 *
 *   - a tool result with no preceding call is dropped (it would reference an unknown id);
 *   - a tool call with no result gets a synthetic one, so the turn stays well-formed;
 *   - an assistant turn with neither text nor calls is dropped (some providers reject empty content);
 *   - leading tool turns are dropped, since a conversation cannot open with a result.
 */
export function normalizeMessages(messages: readonly LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  /** Ids called by the most recent assistant turn that have not yet been answered. */
  let outstanding: string[] = [];

  const settleOutstanding = (): void => {
    for (const id of outstanding) {
      out.push({
        role: 'tool',
        toolCallId: id,
        content: 'This step did not complete, so no result was produced.',
      });
    }
    outstanding = [];
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      const index = outstanding.indexOf(message.toolCallId);
      if (index === -1) continue; // answers nothing we asked for
      outstanding.splice(index, 1);
      out.push(message);
      continue;
    }
    // A new user/assistant turn closes the previous tool round.
    settleOutstanding();
    if (message.role === 'assistant') {
      const hasText = Boolean(message.content && message.content.trim());
      const calls = message.toolCalls ?? [];
      if (!hasText && calls.length === 0) continue;
      out.push(message);
      outstanding = calls.map((call) => call.id);
      continue;
    }
    out.push(message);
  }
  settleOutstanding();

  while (out.length && out[0]!.role === 'tool') out.shift();
  return out;
}
