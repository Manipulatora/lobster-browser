import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { AGENT_ENABLED_TIERS, AGENT_MINIMUM_TIER, PLAN_CATALOG } from '@lobster/shared-types';
import type { PlanTier } from '@lobster/shared-types';

/**
 * Display name for any tier, `free` included. `planByTier` covers only the sellable packages and
 * throws on `free` — which is precisely the tier a refusal most often has to name.
 */
function tierName(tier: PlanTier): string {
  return PLAN_CATALOG.find((plan) => plan.tier === tier)?.name ?? 'Free';
}

/**
 * Why the agent said no.
 *
 * A refusal on this endpoint is almost never a bug the user should see as "request failed" — it is
 * a product state with an obvious next action, and the panel can only offer that action if it can
 * tell the states apart. `plan_required` means buy a package; `insufficient_credit` means top up;
 * `model_unpriced` means pick another model. Three different screens, so three different codes.
 */
export type AgentRefusalReason = 'plan_required' | 'insufficient_credit' | 'model_unpriced';

/**
 * The body a refused agent call returns.
 *
 * SHAPED FOR TWO READERS AT ONCE. `error.message` is where the sidecar's OpenAI-compatible client
 * looks (it parses `{error:{message}}`, the provider convention), so the failure still reads
 * sensibly in a log and in any generic error path. Everything the panel needs to render a NAMED
 * upsell — the tier the team is actually on, the tiers that would work, the cheapest one that
 * would — sits alongside it as data, because "Upgrade to Plus" cannot be reconstructed from a
 * sentence.
 */
export interface AgentRefusalBody {
  error: {
    /** Stable machine code; `type` mirrors it for OpenAI-shaped clients. */
    code: AgentRefusalReason;
    type: 'agent_refusal';
    message: string;
  };
  reason: AgentRefusalReason;
  /** The team's current package. Present on every refusal, so the panel can name it. */
  currentTier: PlanTier;
  /** The packages that include the agent. */
  requiredTiers: readonly PlanTier[];
  /** The cheapest package that includes the agent — what the upsell button buys. */
  minimumTier: PlanTier;
  /** Set on `insufficient_credit`: what the wallet holds and what the next call needs. */
  balanceCents?: number;
  requiredCents?: number;
  /** Set on `model_unpriced`: the model that has no known rate. */
  model?: string;
}

/**
 * A refusal carrying its whole typed body.
 *
 * `HttpException` so the ordinary Nest machinery still sets the status, but the body is the
 * contract rather than a message — see {@link AgentRefusalFilter} for why it needs a filter of its
 * own to survive.
 */
export class AgentRefusalException extends HttpException {
  constructor(
    readonly body: AgentRefusalBody,
    status: HttpStatus,
  ) {
    super(body, status);
  }
}

/** The team is not on a package that includes Lobee. 403 — authenticated, and still not allowed. */
export function planRequired(currentTier: PlanTier): AgentRefusalException {
  const included = AGENT_ENABLED_TIERS.map(tierName).join(', ');
  return new AgentRefusalException(
    {
      error: {
        code: 'plan_required',
        type: 'agent_refusal',
        message: `Lobee is included with ${included}. Your team is on ${tierName(currentTier)}. Upgrade to ${tierName(AGENT_MINIMUM_TIER)} to run it.`,
      },
      reason: 'plan_required',
      currentTier,
      requiredTiers: AGENT_ENABLED_TIERS,
      minimumTier: AGENT_MINIMUM_TIER,
    },
    HttpStatus.FORBIDDEN,
  );
}

/**
 * The wallet cannot cover the next call. 402, not 403: the difference between "you may not" and
 * "you have not paid for this yet" is the difference between an upgrade and a top-up.
 */
export function insufficientCredit(args: {
  currentTier: PlanTier;
  balanceCents: number;
  requiredCents: number;
}): AgentRefusalException {
  return new AgentRefusalException(
    {
      error: {
        code: 'insufficient_credit',
        type: 'agent_refusal',
        message: 'Your Credit balance cannot cover the next agent call. Top up to continue.',
      },
      reason: 'insufficient_credit',
      currentTier: args.currentTier,
      requiredTiers: AGENT_ENABLED_TIERS,
      minimumTier: AGENT_MINIMUM_TIER,
      balanceCents: args.balanceCents,
      requiredCents: args.requiredCents,
    },
    HttpStatus.PAYMENT_REQUIRED,
  );
}

/**
 * We do not know what this model costs, so we will not serve it.
 *
 * Serving it anyway means the operator pays the difference out of their own OpenRouter balance for
 * every call, and finds out at the end of the month.
 */
export function modelUnpriced(model: string, currentTier: PlanTier): AgentRefusalException {
  return new AgentRefusalException(
    {
      error: {
        code: 'model_unpriced',
        type: 'agent_refusal',
        message: `"${model}" has no published rate and cannot be billed. Choose another model.`,
      },
      reason: 'model_unpriced',
      currentTier,
      requiredTiers: AGENT_ENABLED_TIERS,
      minimumTier: AGENT_MINIMUM_TIER,
      model,
    },
    HttpStatus.BAD_REQUEST,
  );
}

/**
 * Renders a refusal as its typed body.
 *
 * WHY IT EXISTS. The global `ApiExceptionFilter` flattens every exception to `{ code, data, msg }`
 * — it keeps the message and discards the body. That is right for the rest of the API and fatal
 * here: a refusal whose tier fields have been thrown away is exactly the generic error the panel
 * cannot upsell from. Scoped to `AgentRefusalException` alone so every other failure still falls
 * through to the global filter and answers in the shape the rest of the product does.
 */
@Catch(AgentRefusalException)
export class AgentRefusalFilter implements ExceptionFilter {
  catch(exception: AgentRefusalException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    // The proxy streams with `@Res()`; once bytes are out the status line is long gone, and a
    // second body would corrupt the SSE frame the panel is mid-way through reading.
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(exception.getStatus()).json(exception.body);
  }
}
