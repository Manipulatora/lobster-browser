/**
 * How a step's model request is shaped: the token-budget arithmetic that caps its output, and the
 * recognition of a provider's context-window rejection so the step can be retried smaller.
 */
import { Buffer } from 'node:buffer';
import type { AgentUsage } from '@lobster/shared-types';
import type { LlmMessage, LlmTool } from '../llm/types.js';

/**
 * A response smaller than this is not a useful budget for either a chat answer or a structured agent
 * action. Stopping before the request is safer than asking a provider for a handful of tokens, paying
 * for the full prompt, and receiving a truncated/non-executable result.
 */
const MIN_USEFUL_OUTPUT_TOKENS = 256;

/**
 * Headroom left for OUTPUT tokens when a provider rejects a request for exceeding its context window,
 * or `null` when the error is something else entirely.
 *
 * Anthropic states the arithmetic verbatim — "input length and `max_tokens` exceed context limit:
 * 190000 + 8000 > 200000" — and OpenRouter forwards the message, so the cheapest fix is usually just
 * asking for fewer output tokens. `0` means "recognised as an overflow but the numbers were not
 * stated", which tells the caller to fall back to trimming the conversation.
 */
export function contextOverflowHeadroom(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/context (window|limit|length)|too long|max_tokens/i.test(message)) return null;
  const m = /(\d[\d,]*)\s*\+\s*(\d[\d,]*)\s*>\s*(\d[\d,]*)/.exec(message);
  if (!m) return 0;
  const n = (v: string): number => Number(v.replace(/,/g, ''));
  // Leave a margin: the reported input length is for the request that FAILED, and the retry's own
  // prompt is not byte-identical.
  const headroom = n(m[3]!) - n(m[1]!) - 1_000;
  return headroom > 0 ? headroom : 0;
}

interface BudgetedRequest {
  desiredMaxTokens: number;
  tokenBudget: number | undefined;
  usage: AgentUsage;
  system: string;
  messages: readonly LlmMessage[];
  tools: readonly LlmTool[];
}

/**
 * Cap the request's output by the allowance left after its CURRENT input. Provider usage remains
 * authoritative after the response and is checked before any returned action is dispatched.
 */
export function budgetedMaxTokens(request: BudgetedRequest): number {
  if (request.tokenBudget === undefined) return request.desiredMaxTokens;
  const remaining = request.tokenBudget - budgetedTokens(request.usage);
  const outputRoom = remaining - requestInputReserve(request);
  if (outputRoom < MIN_USEFUL_OUTPUT_TOKENS) return 0;
  return Math.min(request.desiredMaxTokens, Math.floor(outputRoom));
}

function requestInputReserve(
  request: Pick<BudgetedRequest, 'system' | 'messages' | 'tools'>,
): number {
  const FIXED_REQUEST_OVERHEAD = 256;
  const MESSAGE_OVERHEAD = 24;
  const TOOL_OVERHEAD = 32;
  let reserve = FIXED_REQUEST_OVERHEAD + estimatedTokens(request.system);
  reserve += estimatedTokens(JSON.stringify(request.tools)) + request.tools.length * TOOL_OVERHEAD;
  for (const message of request.messages) {
    reserve += MESSAGE_OVERHEAD + estimatedTokens(messageText(message));
    if (message.role === 'user') {
      for (const image of message.images ?? []) {
        // Native image inputs are billed by pixels rather than base64 text. The compressed byte count
        // is a useful signal but can dwarf actual vision usage, so bound it at a deliberately generous
        // per-image reserve rather than making every normal screenshot exceed the run budget.
        reserve += 64 + Math.min(8_192, Math.max(1_024, Math.ceil(image.data.length / 4)));
      }
    }
  }
  return reserve;
}

/**
 * Tokens a string is worth, for reserving room BEFORE the provider has counted it.
 *
 * Reserving UTF-8 bytes was tokenizer-independent but not a token estimate at all: English prose is
 * about one byte per character and roughly four characters per token, so the reserve came out ~4×
 * the real input and the budget appeared spent long before it was. Dividing keeps the property that
 * mattered — no tokenizer, and still an over-estimate — while staying in the right order of
 * magnitude. The divisor is deliberately below the ~4 bytes/token English average so the reserve
 * errs high, and multi-byte scripts (which pack more bytes into a token) land near 1 token/char.
 */
function estimatedTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 3);
}

/** A cached prefix read is billed at roughly a tenth of a fresh one. */
const CACHE_READ_BUDGET_WEIGHT = 0.1;

/**
 * What this run has spent against its budget.
 *
 * The budget exists to bound COST. Counting cache reads at full price meant prompt caching — the one
 * mechanism that makes a long run affordable — accelerated the shutdown instead: every step re-reads
 * the whole prefix, so the total grew by an entire prompt per step and a forty-step run halted around
 * step ten. `tokensIn` stays the honest context measure everything else reports; only this
 * arithmetic is weighted.
 */
function budgetedTokens(value: AgentUsage): number {
  const cached = Math.min(value.cachedTokensIn ?? 0, value.tokensIn);
  const fresh = value.tokensIn - cached;
  return fresh + Math.ceil(cached * CACHE_READ_BUDGET_WEIGHT) + value.tokensOut;
}

export function tokenBudgetExceeded(tokenBudget: number | undefined, usage: AgentUsage): boolean {
  return tokenBudget !== undefined && budgetedTokens(usage) > tokenBudget;
}

/** All text in a message, for budgeting. */
function messageText(message: LlmMessage): string {
  if (message.role === 'assistant') {
    return (message.content ?? '') + JSON.stringify(message.toolCalls ?? []);
  }
  return message.content;
}
