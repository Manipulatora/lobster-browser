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
  /** Provider-reported token counts (`usage`). */
  usage?: { tokensIn?: number; tokensOut?: number; cachedTokensIn?: number; costUsd?: number };
  prompt?: string;
  kind?: 'ask' | 'confirm';
  sensitive?: boolean;
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

/** Why the agent said no. Mirrors the backend's refusal codes; the panel shows a screen per code. */
export type AgentRefusalCode =
  'plan_required' | 'insufficient_credit' | 'signed_out' | 'unconfigured';

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

export type Mode = 'ask' | 'agent';
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
