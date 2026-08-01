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
  result?: string;
  error?: string;
  [k: string]: unknown;
}

export interface AgentRunSnapshot {
  sessionId: string;
  profileId: string;
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
