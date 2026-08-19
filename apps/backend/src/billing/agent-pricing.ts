/**
 * What a Lobee call costs, and what we charge for it.
 *
 * MONEY REPRESENTATION HERE IS MICRO-USD, not cents. The rest of billing is whole cents because
 * that is what a wallet and a ledger row are; a single agent call is routinely worth a fraction of
 * one cent, so cents cannot be the unit of measurement. Rounding each call up to a cent would
 * overcharge a chatty session by orders of magnitude, and rounding down would make the agent free.
 * Calls are therefore priced in micro-USD (1 USD = 1,000,000 µ$ = 100 cents), accrued, and flushed
 * to the wallet only in whole cents — see `AgentSpendService`.
 */

/** 1 cent, in micro-USD. */
export const MICROS_PER_CENT = 10_000;

/** 1 USD, in micro-USD. */
export const MICROS_PER_USD = 1_000_000;

/**
 * What we charge over the raw model cost, as a multiplier.
 *
 * ONE named constant rather than a factor sprinkled through the pricing table, so the margin is a
 * single decision that can be read off, argued about and changed without touching a single price.
 * Overridable per deployment through `LOBSTER_AGENT_MARGIN` — an operator running their own
 * OpenRouter key at cost may legitimately want 1.0.
 */
export const DEFAULT_AGENT_MARGIN = 1.5;

/**
 * Read the deployment's margin, falling back to {@link DEFAULT_AGENT_MARGIN}.
 *
 * A margin below 1 sells model time at a loss, which is never what a typo means, so anything that
 * is not a finite number of at least 1 is rejected rather than honoured.
 */
export function resolveAgentMargin(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_AGENT_MARGIN;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_AGENT_MARGIN;
  return parsed;
}

/**
 * The three rates a chat completion is billed at, in micro-USD per 1,000,000 tokens — which makes
 * the numbers here read as plain dollars per million tokens: 5_000_000 µ$/MTok is $5.00/MTok.
 *
 * THEY ARE THREE RATES AND NOT ONE. Output typically costs 3–5x fresh input, and input served from
 * the provider's cache costs about a tenth of fresh input. Summing prompt and completion tokens at
 * parity — which is what "tokens used" meters usually do — can be wrong by a factor of five in
 * either direction depending on the shape of the call, so the shape has to be priced, not the sum.
 */
export interface AgentModelPrice {
  inputMicrosPerMTok: number;
  outputMicrosPerMTok: number;
  cachedInputMicrosPerMTok: number;
}

/**
 * THE agent price list, keyed by OpenRouter model id.
 *
 * Deliberately in code and not in the database, for the same reason as `PLAN_CATALOG`: a price is
 * a product decision that ships with a release and belongs under review, not a row an operator can
 * edit into an inconsistent state.
 *
 * WHAT THIS TABLE IS FOR. OpenRouter returns its own authoritative cost for most completions, and
 * that figure wins whenever it is present — see {@link computeAgentCostMicros}. The table is the
 * pre-flight estimate (there is no cost until after the call, and the reserve check has to happen
 * before it) and the fallback for a response that carried no cost. A model absent from here is
 * REFUSED rather than guessed at: charging an unknown rate is how an operator ends up paying the
 * difference out of their own OpenRouter balance.
 *
 * The rates are list prices, not our cost basis — the margin is applied separately and once.
 */
export const AGENT_MODEL_PRICES: Readonly<Record<string, AgentModelPrice>> = {
  // Anthropic. Cached input is a tenth of fresh input across the family.
  'anthropic/claude-fable-5': {
    inputMicrosPerMTok: 10_000_000,
    outputMicrosPerMTok: 50_000_000,
    cachedInputMicrosPerMTok: 1_000_000,
  },
  'anthropic/claude-opus-5': {
    inputMicrosPerMTok: 5_000_000,
    outputMicrosPerMTok: 25_000_000,
    cachedInputMicrosPerMTok: 500_000,
  },
  'anthropic/claude-opus-4.8': {
    inputMicrosPerMTok: 5_000_000,
    outputMicrosPerMTok: 25_000_000,
    cachedInputMicrosPerMTok: 500_000,
  },
  'anthropic/claude-opus-4.7': {
    inputMicrosPerMTok: 5_000_000,
    outputMicrosPerMTok: 25_000_000,
    cachedInputMicrosPerMTok: 500_000,
  },
  'anthropic/claude-opus-4.6': {
    inputMicrosPerMTok: 5_000_000,
    outputMicrosPerMTok: 25_000_000,
    cachedInputMicrosPerMTok: 500_000,
  },
  'anthropic/claude-sonnet-5': {
    inputMicrosPerMTok: 3_000_000,
    outputMicrosPerMTok: 15_000_000,
    cachedInputMicrosPerMTok: 300_000,
  },
  'anthropic/claude-sonnet-4.6': {
    inputMicrosPerMTok: 3_000_000,
    outputMicrosPerMTok: 15_000_000,
    cachedInputMicrosPerMTok: 300_000,
  },
  'anthropic/claude-haiku-4.5': {
    inputMicrosPerMTok: 1_000_000,
    outputMicrosPerMTok: 5_000_000,
    cachedInputMicrosPerMTok: 100_000,
  },

  // OpenAI.
  'openai/gpt-5.6-sol': {
    inputMicrosPerMTok: 2_500_000,
    outputMicrosPerMTok: 20_000_000,
    cachedInputMicrosPerMTok: 250_000,
  },
  'openai/gpt-5.6-terra': {
    inputMicrosPerMTok: 1_750_000,
    outputMicrosPerMTok: 14_000_000,
    cachedInputMicrosPerMTok: 175_000,
  },
  'openai/gpt-5.6-luna': {
    inputMicrosPerMTok: 1_250_000,
    outputMicrosPerMTok: 10_000_000,
    cachedInputMicrosPerMTok: 125_000,
  },
  'openai/gpt-5.5': {
    inputMicrosPerMTok: 1_250_000,
    outputMicrosPerMTok: 10_000_000,
    cachedInputMicrosPerMTok: 125_000,
  },
  'openai/gpt-5.4': {
    inputMicrosPerMTok: 1_250_000,
    outputMicrosPerMTok: 10_000_000,
    cachedInputMicrosPerMTok: 125_000,
  },
  'openai/gpt-5-mini': {
    inputMicrosPerMTok: 250_000,
    outputMicrosPerMTok: 2_000_000,
    cachedInputMicrosPerMTok: 25_000,
  },

  // Google.
  'google/gemini-3-pro': {
    inputMicrosPerMTok: 2_000_000,
    outputMicrosPerMTok: 12_000_000,
    cachedInputMicrosPerMTok: 200_000,
  },
  'google/gemini-3-flash': {
    inputMicrosPerMTok: 300_000,
    outputMicrosPerMTok: 2_500_000,
    cachedInputMicrosPerMTok: 30_000,
  },
  'google/gemini-2.5-pro': {
    inputMicrosPerMTok: 1_250_000,
    outputMicrosPerMTok: 10_000_000,
    cachedInputMicrosPerMTok: 125_000,
  },
  'google/gemini-2.5-flash': {
    inputMicrosPerMTok: 300_000,
    outputMicrosPerMTok: 2_500_000,
    cachedInputMicrosPerMTok: 30_000,
  },
};

/**
 * Look a model's rates up, or `undefined` when we do not know them.
 *
 * Returning undefined rather than a default is the whole point — the caller refuses the call. A
 * default rate would be wrong in one of two directions, and the direction that loses money is the
 * one an unknown expensive model takes.
 *
 * OpenRouter accepts routing suffixes on an id (`:nitro`, `:floor`, `:online`). They select a
 * provider, not a different model, so the base id before the colon is what carries the price.
 */
export function agentModelPrice(model: string): AgentModelPrice | undefined {
  const base = model.trim().toLowerCase().split(':')[0];
  return AGENT_MODEL_PRICES[base];
}

/** Everything about one completion that bears on what it cost. */
export interface AgentCallUsage {
  model: string;
  /**
   * TOTAL prompt tokens, cached ones included — the `prompt_tokens` the provider reports verbatim.
   * `cachedIn` is a SUBSET of this, exactly as it is in the upstream payload, and is subtracted
   * here rather than at every call site: a caller that forgets to subtract bills cache hits at the
   * fresh rate and quietly overcharges every long conversation.
   */
  tokensIn: number;
  tokensOut: number;
  /** Prompt tokens served from the provider's cache. */
  cachedIn: number;
  /**
   * The provider's own cost for this call, in USD, when it returned one. Authoritative: it already
   * accounts for the routing decision, the discounts and the rate that actually applied.
   */
  providerCostUsd?: number;
}

/**
 * What to charge for one completion, in micro-USD, margin included.
 *
 * `undefined` means the call could not be priced — no provider cost and no entry in the table — so
 * the caller must refuse the model rather than serve it for free.
 */
export function computeAgentCostMicros(
  usage: AgentCallUsage,
  marginMultiplier: number = DEFAULT_AGENT_MARGIN,
): number | undefined {
  const raw = rawCostMicros(usage);
  if (raw === undefined) return undefined;
  // Rounded to whole micro-USD and no further. A tenth of a cent is still 1,000 of these, so
  // nothing that matters is lost here — and the flush to the wallet, which is where rounding
  // actually costs someone money, keeps the remainder rather than dropping it.
  return Math.max(0, Math.round(raw * marginMultiplier));
}

/** The model's own cost before margin, in micro-USD. */
function rawCostMicros(usage: AgentCallUsage): number | undefined {
  const { providerCostUsd } = usage;
  if (typeof providerCostUsd === 'number' && Number.isFinite(providerCostUsd)) {
    return Math.max(0, providerCostUsd * MICROS_PER_USD);
  }

  const price = agentModelPrice(usage.model);
  if (!price) return undefined;

  const cached = Math.max(0, usage.cachedIn);
  const fresh = Math.max(0, usage.tokensIn - cached);
  const out = Math.max(0, usage.tokensOut);

  return (
    (fresh * price.inputMicrosPerMTok +
      cached * price.cachedInputMicrosPerMTok +
      out * price.outputMicrosPerMTok) /
    1_000_000
  );
}

/**
 * What a call is likely to cost BEFORE it is made, for the reserve check.
 *
 * The completion length is unknown at this point, so it is assumed rather than measured:
 * `maxTokensOut` is what the caller has authorised the model to produce, and pricing all of it is
 * the only estimate that cannot under-reserve. Returns `undefined` for an unpriced model, which is
 * the pre-flight refusal.
 */
export function estimateAgentCostMicros(
  args: { model: string; tokensIn: number; maxTokensOut: number },
  marginMultiplier: number = DEFAULT_AGENT_MARGIN,
): number | undefined {
  return computeAgentCostMicros(
    {
      model: args.model,
      tokensIn: args.tokensIn,
      tokensOut: args.maxTokensOut,
      cachedIn: 0,
    },
    marginMultiplier,
  );
}
