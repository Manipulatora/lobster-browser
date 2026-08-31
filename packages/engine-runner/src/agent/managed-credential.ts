import {
  AGENT_ENABLED_TIERS,
  AGENT_MINIMUM_TIER,
  PLAN_CATALOG,
  planAllowsAgent,
} from '@lobster/shared-types';
import type { AgentLlmConfig, PlanTier } from '@lobster/shared-types';

/**
 * The managed-Lobee credential: where the backend agent proxy is, and the short-lived token that
 * says WHO is spending on it.
 *
 * PUSHED BY THE DESKTOP, NOT READ FROM THE ENVIRONMENT. The proxy token is minted from the
 * signed-in session (`POST /agent/token`), lives half an hour, and names one user and one team — so
 * it cannot come from an installer-set variable, and nothing here can invent one. The desktop core
 * pushes it over the stdio RPC and re-pushes before it expires; a run in flight when the token turns
 * over simply picks up the new one on its next model call, because every call resolves the token
 * from here rather than capturing it at run start.
 *
 * `LOBSTER_AGENT_PROXY_URL` + `LOBSTER_AGENT_PROXY_TOKEN` remain the development and CI path
 * (ci/validation/agent-battery*.mjs points the sidecar at an operator proxy with no desktop in the
 * picture). They are only consulted when no credential has been pushed.
 *
 * A REFUSAL IS ALSO A CREDENTIAL STATE. When the account may not run the agent — the wrong package,
 * an empty wallet, no sign-in — the desktop pushes that instead of a token, so the panel can say
 * which of the three it is before a task is typed rather than after a model call fails.
 */

/** Tolerance for clock skew and flight time: a token this close to expiry is already spent. */
const EXPIRY_SKEW_MS = 60_000;
/** How long a run waits for the desktop to answer a refresh request before trying the old token. */
const REFRESH_TIMEOUT_MS = 10_000;

/**
 * How long a refusal the backend returned mid-run keeps the panel locked.
 *
 * Long enough that the card explaining an emptied wallet is what the user sees after the run dies,
 * and short enough that topping up does not require restarting the browser: nothing here can observe
 * a payment, so the honest behaviour is to say what happened and then let the account try again.
 */
const NOTED_REFUSAL_TTL_MS = 60_000;

/**
 * Why Lobee is not running.
 *
 * The first four are about THIS ACCOUNT and each has an action the user can take. `provider_unavailable`
 * is the odd one out and deliberately so: it means the OPERATOR's side could not serve the call — the
 * server's own OpenRouter credential was refused, the operator's provider balance is empty, or the
 * backend has no key at all. It exists because those failures used to be reported as
 * `insufficient_credit`, i.e. the operator's unpaid bill rendered as the customer's empty wallet,
 * complete with a "top up" button that would have taken money for nothing.
 */
export type AgentRefusalCode =
  'plan_required' | 'insufficient_credit' | 'signed_out' | 'unconfigured' | 'provider_unavailable';

export interface ManagedCredential {
  baseUrl: string;
  token: string;
  /** Epoch ms at which the token stops being accepted. `0` means the credential does not expire. */
  expiresAt: number;
  /** The package the token was minted under, so the panel can name it. */
  tier?: PlanTier;
}

/** Why the agent said no, in the shape the panel renders and the bridge answers with. */
export interface AgentRefusal {
  code: AgentRefusalCode;
  message: string;
  tier?: PlanTier;
  requiredTiers: readonly PlanTier[];
  minimumTier: PlanTier;
}

/** What this installation may currently do with Lobee, and if it may not, why. */
export interface AgentEntitlement {
  entitled: boolean;
  tier?: PlanTier;
  requiredTiers: readonly PlanTier[];
  minimumTier: PlanTier;
  code?: AgentRefusalCode;
  message?: string;
}

let credential: ManagedCredential | undefined;
let refusal: AgentRefusal | undefined;
/** A refusal the proxy returned during a run, which outranks a credential that still looks valid. */
let noted: { refusal: AgentRefusal; at: number } | undefined;
let requestRefresh: (() => void) | undefined;
const refreshWaiters = new Set<() => void>();

function tierName(tier: PlanTier | undefined): string {
  if (!tier) return 'your current package';
  return PLAN_CATALOG.find((plan) => plan.tier === tier)?.name ?? 'Free';
}

/** Copy of the backend's own wording, so the panel says the same thing whichever side refused. */
export function planRefusal(tier?: PlanTier): AgentRefusal {
  const included = AGENT_ENABLED_TIERS.map((entry) => tierName(entry)).join(', ');
  return {
    code: 'plan_required',
    message: `Lobee is included with ${included}. Your team is on ${tierName(tier)}. Upgrade to ${tierName(AGENT_MINIMUM_TIER)} to run it.`,
    ...(tier ? { tier } : {}),
    requiredTiers: AGENT_ENABLED_TIERS,
    minimumTier: AGENT_MINIMUM_TIER,
  };
}

function refusalOf(code: AgentRefusalCode, message: string, tier?: PlanTier): AgentRefusal {
  return {
    code,
    message,
    ...(tier ? { tier } : {}),
    requiredTiers: AGENT_ENABLED_TIERS,
    minimumTier: AGENT_MINIMUM_TIER,
  };
}

function isPlanTier(value: unknown): value is PlanTier {
  return (
    value === 'free' || value === 'light' || value === 'plus' || value === 'pro' || value === 'max'
  );
}

/**
 * Reject a base URL that could send the token somewhere else. `createLlmClient` validates it again
 * before any request; this refuses to STORE one, so a bad push cannot survive as live state.
 */
function validBaseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return false;
    return !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function envCredential(): ManagedCredential | undefined {
  const baseUrl = process.env.LOBSTER_AGENT_PROXY_URL;
  const token = process.env.LOBSTER_AGENT_PROXY_TOKEN;
  if (!baseUrl || !token || !validBaseUrl(baseUrl)) return undefined;
  return { baseUrl, token, expiresAt: 0 };
}

function resolveWaiters(): void {
  for (const waiter of refreshWaiters) waiter();
  refreshWaiters.clear();
}

/**
 * Record what the desktop pushed: either a live credential, or the reason there isn't one.
 *
 * Validated rather than trusted even though the sender is the desktop core, because this value ends
 * up as the target of an authenticated HTTPS call.
 */
export function setManagedCredential(input: unknown): void {
  const value = (input ?? {}) as Record<string, unknown>;
  const tier = isPlanTier(value.tier) ? value.tier : undefined;

  if (typeof value.refusal === 'string' && value.refusal) {
    const code = value.refusal as AgentRefusalCode;
    credential = undefined;
    noted = undefined;
    refusal =
      code === 'plan_required'
        ? planRefusal(tier)
        : refusalOf(
            code,
            typeof value.message === 'string' && value.message
              ? value.message
              : 'Lobee is not available for this account right now.',
            tier,
          );
    resolveWaiters();
    return;
  }

  if (!validBaseUrl(value.baseUrl) || typeof value.token !== 'string' || !value.token) {
    throw new Error('a managed agent credential needs a valid proxy base URL and token');
  }
  const ttlSeconds =
    typeof value.expiresInSeconds === 'number' && Number.isFinite(value.expiresInSeconds)
      ? Math.max(0, value.expiresInSeconds)
      : 0;
  credential = {
    baseUrl: value.baseUrl.replace(/\/$/, ''),
    token: value.token,
    expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1_000 : 0,
    ...(tier ? { tier } : {}),
  };
  refusal = undefined;
  resolveWaiters();
}

/** Forget the pushed credential (sign-out). The env pair, if any, is deliberately left in place. */
export function clearManagedCredential(): void {
  credential = undefined;
  noted = undefined;
  refusal = refusalOf('signed_out', 'Sign in to the Lobster app to use Lobee.');
  resolveWaiters();
}

/**
 * Remember a refusal the backend returned mid-run, so the panel's next entitlement read tells the
 * truth. A run that died because the wallet emptied must not leave the panel offering another one.
 */
export function noteManagedRefusal(code: AgentRefusalCode, message: string): void {
  noted = { refusal: refusalOf(code, message, credential?.tier ?? refusal?.tier), at: Date.now() };
}

/** A call went through, so whatever the last one refused about is no longer true. */
export function clearNotedRefusal(): void {
  noted = undefined;
}

function liveNotedRefusal(): AgentRefusal | undefined {
  if (!noted) return undefined;
  if (Date.now() - noted.at > NOTED_REFUSAL_TTL_MS) {
    noted = undefined;
    return undefined;
  }
  return noted.refusal;
}

/** How the desktop is asked for a fresh token; wired by the sidecar entry point. */
export function setCredentialRefresher(refresher: (() => void) | undefined): void {
  requestRefresh = refresher;
}

function expiring(entry: ManagedCredential): boolean {
  return entry.expiresAt > 0 && entry.expiresAt - Date.now() <= EXPIRY_SKEW_MS;
}

/**
 * Ask the desktop to mint a new token and wait briefly for it to arrive.
 *
 * Bounded and best-effort on purpose: a long run must not be killed because a refresh was slow, so
 * the caller falls back to the token it already has, which the proxy will reject clearly if it has
 * genuinely expired.
 */
export async function refreshManagedCredential(
  timeoutMs = REFRESH_TIMEOUT_MS,
): Promise<ManagedCredential | undefined> {
  if (!requestRefresh) return credential ?? envCredential();
  const arrived = new Promise<void>((resolve) => {
    const waiter = (): void => resolve();
    refreshWaiters.add(waiter);
    const timer = setTimeout(() => {
      refreshWaiters.delete(waiter);
      resolve();
    }, timeoutMs);
    timer.unref?.();
  });
  requestRefresh();
  await arrived;
  return credential ?? envCredential();
}

/**
 * The credential to authenticate the next model call with, refreshed first if it is about to expire.
 * Returns `undefined` when this account has none — see {@link managedEntitlement} for why.
 */
export async function currentManagedCredential(): Promise<ManagedCredential | undefined> {
  const entry = credential ?? envCredential();
  if (entry && !expiring(entry)) return entry;
  const refreshed = await refreshManagedCredential();
  return refreshed ?? entry;
}

/** The credential as it stands, with no refresh round-trip. */
export function peekManagedCredential(): ManagedCredential | undefined {
  return credential ?? envCredential();
}

/** What this account may do with Lobee right now. */
export function managedEntitlement(): AgentEntitlement {
  const entry = credential ?? envCredential();
  const live = liveNotedRefusal();
  if (live) {
    return {
      entitled: false,
      ...(live.tier ? { tier: live.tier } : {}),
      requiredTiers: live.requiredTiers,
      minimumTier: live.minimumTier,
      code: live.code,
      message: live.message,
    };
  }
  if (entry && (!entry.tier || planAllowsAgent(entry.tier))) {
    return {
      entitled: true,
      ...(entry.tier ? { tier: entry.tier } : {}),
      requiredTiers: AGENT_ENABLED_TIERS,
      minimumTier: AGENT_MINIMUM_TIER,
    };
  }
  const denial =
    entry?.tier && !planAllowsAgent(entry.tier)
      ? planRefusal(entry.tier)
      : (refusal ??
        refusalOf(
          'unconfigured',
          'The Lobster app has not signed this profile in to the managed agent yet.',
        ));
  return {
    entitled: false,
    ...(denial.tier ? { tier: denial.tier } : {}),
    requiredTiers: denial.requiredTiers,
    minimumTier: denial.minimumTier,
    code: denial.code,
    message: denial.message,
  };
}

export type ManagedLlmResolution =
  { ok: true; llm: AgentLlmConfig } | { ok: false; refusal: AgentRefusal };

/**
 * The managed LLM config for a run, or the typed refusal to answer the caller with.
 *
 * The token is resolved again per model call by the run's client, so the one embedded here is only
 * the starting value — what matters at this point is that a refused account never starts a run at
 * all, and hears WHY in a form the panel can act on.
 */
export function managedLlmConfig(
  model: string,
  effort?: AgentLlmConfig['effort'],
): ManagedLlmResolution {
  const entitlement = managedEntitlement();
  if (!entitlement.entitled) {
    return {
      ok: false,
      refusal: {
        code: entitlement.code ?? 'unconfigured',
        message: entitlement.message ?? 'Lobee is not available for this account right now.',
        ...(entitlement.tier ? { tier: entitlement.tier } : {}),
        requiredTiers: entitlement.requiredTiers,
        minimumTier: entitlement.minimumTier,
      },
    };
  }
  const entry = peekManagedCredential()!;
  return {
    ok: true,
    llm: {
      provider: 'openrouter',
      model,
      managed: true,
      baseUrl: entry.baseUrl,
      apiKey: entry.token,
      ...(effort ? { effort } : {}),
    },
  };
}

/**
 * HTTP status for a refusal: 402 is "you have not paid for this yet", 403 is "you may not", and 503
 * is "we could not" — an outage on our side, which is not a thing the account did wrong and must
 * not be answered in the 4xx range that says it was.
 */
export function refusalStatus(code: AgentRefusalCode): number {
  if (code === 'insufficient_credit') return 402;
  if (code === 'provider_unavailable') return 503;
  return 403;
}

/** Test-only lifecycle reset; the sidecar holds this state for its whole process life. */
export function __resetManagedCredentialForTests(): void {
  credential = undefined;
  refusal = undefined;
  noted = undefined;
  requestRefresh = undefined;
  refreshWaiters.clear();
}
