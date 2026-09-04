/**
 * How a step's model request is shaped: which model and effort it runs at, the token-budget
 * arithmetic that caps its output, and the recovery when a provider rejects it for exceeding the
 * context window.
 */
import { Buffer } from 'node:buffer';
import type { AgentLlmConfig, AgentUsage } from '@lobster/shared-types';
import { ACT_TOOL } from '../actions.js';
import type { LlmClient, LlmMessage, LlmRequest, LlmResult, LlmTool } from '../llm/types.js';
import { normalizeMessages } from '../llm/types.js';
import { pruneObservations } from './observe.js';
import type { RunLog, StepTimer } from './record.js';

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

/**
 * Which model a step runs on, and at what effort. Step 1 and every recovery step go to the primary
 * model; a routine step goes to the cheaper step model when one is configured.
 */
export function selectStepModel(
  llmConfig: AgentLlmConfig,
  step: number,
  recovery: boolean,
): { model: string; effort?: NonNullable<LlmRequest['effort']> } {
  const model = step === 1 || recovery ? llmConfig.model : (llmConfig.stepModel ?? llmConfig.model);
  // A routine step on the step model runs at the step model's effort: the whole point of a
  // cheaper model for navigation is latency, and asking it to think hard gives that back.
  const effort =
    step === 1 || recovery || !llmConfig.stepModel
      ? llmConfig.effort
      : (llmConfig.stepEffort ?? llmConfig.effort);
  return { model, ...(effort ? { effort } : {}) };
}

/** What a recovery retry may change about a step's request; everything else stays put. */
export interface StepRequestOverrides {
  maxTokens?: number;
  messages?: LlmMessage[];
}

export interface StepRequestInput {
  llmConfig: AgentLlmConfig;
  step: number;
  /** A recovery step goes back to the primary model at its full effort. */
  recovery: boolean;
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  maxTokens: number;
  runId: string;
  profileId: string;
  signal: AbortSignal;
  log: RunLog['log'];
  /** Streaming progress for the panel, already throttled: the cumulative `chars` of `kind` so far. */
  onProgress: (kind: 'reasoning' | 'text' | 'tool', chars: number) => void;
}

/**
 * The request for one step, as a builder: a context-overflow retry re-issues it with a smaller
 * output cap or a trimmed conversation while the model, tools and attribution stay identical.
 */
export function createStepRequestBuilder(
  input: StepRequestInput,
): (overrides?: StepRequestOverrides) => LlmRequest {
  const { llmConfig, step, recovery, log, signal } = input;
  let progressChars = 0;
  let progressEmittedAt = 0;
  return (overrides = {}) => ({
    ...selectStepModel(llmConfig, step, recovery),
    system: input.system,
    messages: overrides.messages ?? input.messages,
    tools: input.tools,
    forceTool: ACT_TOOL.name,
    maxTokens: overrides.maxTokens ?? input.maxTokens,
    cachePrefix: true,
    sessionId: input.runId,
    attribution: { profileId: input.profileId, sessionId: input.runId },
    // A silent retry is indistinguishable from a hang: three BYOK attempts plus backoff is minutes
    // of a panel showing only "thinking", which invites killing a run that was recovering fine.
    onRetry: ({ attempt, attempts, delayMs, reason }) =>
      log(
        'warn',
        `The model provider did not respond (${reason}). Retrying in ${Math.round(delayMs / 1000)}s — attempt ${attempt} of ${attempts}.`,
      ),
    // Asking for progress is what makes the step STREAM (see the adapter): the model's thinking
    // becomes activity for the idle watchdog instead of time against a wall clock, and the
    // panel can say the model is still working. Throttled: one event a second and a half.
    onProgress: ({ kind, chars }) => {
      progressChars += chars;
      const at = Date.now();
      if (at - progressEmittedAt < 1500) return;
      progressEmittedAt = at;
      input.onProgress(kind, progressChars);
    },
    signal,
  });
}

/**
 * A context-window 400 used to end the run outright: it is not in `retryableStatus`, so it
 * propagated straight to the catch that calls `finish('error')`. Recover in the cheapest order —
 * ask for fewer OUTPUT tokens first (the whole conversation survives), and only then start
 * dropping history. `normalizeMessages` already repairs an arbitrarily head-dropped list, so the
 * dangerous part of the second tier is already built.
 *
 * Rethrows `error` untouched when it is not a recognised overflow, or when the run has already
 * spent its one recovery.
 */
export async function recoverFromContextOverflow(
  error: unknown,
  input: {
    llm: LlmClient;
    buildRequest: (overrides?: StepRequestOverrides) => LlmRequest;
    timed: StepTimer['timed'];
    requestMaxTokens: number;
    stepMessages: readonly LlmMessage[];
    /** Shared by every step of the run: the recovery is attempted at most once per run. */
    overflow: { retried: boolean };
    log: RunLog['log'];
  },
): Promise<LlmResult> {
  const { llm, buildRequest, timed, requestMaxTokens, stepMessages, overflow, log } = input;
  const headroom = contextOverflowHeadroom(error);
  if (headroom === null || overflow.retried) throw error;
  overflow.retried = true;
  // Only take the cheap path when it actually CHANGES the request. A headroom at or above the
  // current cap would re-send an identical body and burn a call to get the same 400.
  if (headroom >= 512 && headroom < requestMaxTokens) {
    log('warn', `Context limit reached; retrying this step with a smaller output budget.`);
    return timed('llm', () => llm.complete(buildRequest({ maxTokens: headroom })));
  }
  log('warn', 'Context limit reached; retrying this step with the conversation trimmed.');
  return timed('llm', () =>
    llm.complete(
      buildRequest({
        messages: normalizeMessages(pruneObservations(stepMessages).slice(-4)),
        maxTokens: Math.min(requestMaxTokens, 1024),
      }),
    ),
  );
}
