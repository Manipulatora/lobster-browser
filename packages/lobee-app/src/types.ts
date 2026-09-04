// Loose shapes for the agent event/action stream (the panel treats them as data, not a strict schema).
export interface AgentAction {
  kind: string;
  [k: string]: unknown;
}

export interface AgentEvent {
  type:
    | 'run.started'
    | 'run.needsBrowser'
    | 'step.thinking'
    | 'step.action'
    | 'step.observation'
    | 'step.outcome'
    | 'step.progress'
    | 'step.signal'
    | 'step.timing'
    | 'run.steered'
    | 'run.needsInput'
    | 'run.finished'
    | 'answer.delta'
    | 'usage'
    | 'memory.degraded'
    | 'log';
  sessionId?: string;
  profileId?: string;
  ts?: string;
  step?: number;
  action?: AgentAction;
  url?: string;
  title?: string;
  /** Streamed fragment of the assistant reply (`answer.delta`). */
  text?: string;
  /**
   * step.progress: what is streaming (`reasoning` | `text` | `tool`); run.needsInput: what is asked
   * (`ask` | `confirm`). One loosely typed field for both, because the event stream is data the panel
   * reads defensively, not a schema it enforces — and one interface cannot declare a name twice.
   */
  kind?: string;
  chars?: number;
  /** Provider-reported token counts (`usage`). */
  usage?: { tokensIn?: number; tokensOut?: number; cachedTokensIn?: number; costUsd?: number };
  prompt?: string;
  sensitive?: boolean;
  /**
   * step.signal: a page condition the harness tracks between steps — `login`, `captcha`, `otp`,
   * `dialog`, `cross-origin-frame`, … — and whether it `appeared` (true) or cleared (false) at
   * `step`. The reducer names each one for the rail and humanises any it has never seen.
   */
  signal?: string;
  appeared?: boolean;
  /**
   * step.timing: how long each phase of `step` took, in milliseconds, keyed by phase name. Only the
   * total is shown, and only when it is long enough to explain a wait.
   */
  phases?: unknown;
  status?: 'done' | 'error' | 'stopped';
  /** Which memory operation degraded (`memory.degraded`). */
  scope?: 'run' | 'thread' | 'step';
  reason?: string;
  result?: string;
  error?: string;
  [k: string]: unknown;
}

export interface AgentRunSnapshot {
  sessionId: string;
  profileId: string;
  threadId?: string;
  task: string;
  status: 'running' | 'awaiting_input' | 'done' | 'error' | 'stopped';
  step: number;
  startedAt: string;
  awaitingPrompt?: string;
  awaitingKind?: 'ask' | 'confirm';
  awaitingSensitive?: boolean;
  result?: string;
  error?: string;
}

/**
 * Why the agent said no. Mirrors the sidecar's refusal codes; the panel shows a screen per code.
 *
 * The first four are about THIS ACCOUNT and each has an action the user can take. `provider_unavailable`
 * is ours, not theirs: the operator's model provider refused the server's own credential or its
 * balance is empty. It has its own code because it used to arrive as `insufficient_credit` and put
 * a "top up your Credit" screen in front of a user whose Credit was never the problem.
 */
export type AgentRefusalCode =
  'plan_required' | 'insufficient_credit' | 'signed_out' | 'unconfigured' | 'provider_unavailable';

/**
 * What this account may do with Lobee right now, as the sidecar reports it.
 *
 * The panel reads this on mount rather than discovering the answer by starting a run: a package that
 * does not include the agent is a product state with a next action, and a composer that accepts a
 * task it can never run is a promise the product cannot keep.
 */
export interface AgentEntitlement {
  entitled: boolean;
  /** The package the account is on, when known — the upsell has to be able to name it. */
  tier?: string;
  requiredTiers?: string[];
  minimumTier?: string;
  code?: AgentRefusalCode;
  message?: string;
}

/**
 * How a message is handled. `auto` — the default — sends every message through the agent loop and
 * lets the model decide per message whether it is chat (answered on its first step, browser closed)
 * or a web task. `ask` and `agent` are the explicit overrides: chat only, or always the loop.
 */
export type Mode = 'auto' | 'ask' | 'agent';
export type Effort = 'low' | 'medium' | 'high';

export interface ModelInfo {
  id: string;
  label: string;
  brand: string;
  efforts: Effort[];
  available: boolean;
  /** Supports the forced structured-tool contract required by Agent mode. */
  agentCapable: boolean;
}

// Minimal ambient for the extension API we touch (avoids pulling in @types/chrome).
declare global {
  interface Window {
    chrome?: {
      runtime?: {
        getURL?: (p: string) => string;
      };
      storage?: {
        local?: {
          get: (d: unknown) => Promise<Record<string, unknown>>;
          set: (o: unknown) => void | Promise<void>;
        };
      };
    };
  }
}
