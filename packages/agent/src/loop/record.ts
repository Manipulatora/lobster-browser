/**
 * What the run WRITES DOWN as it goes: step timing, the per-step memory record, and the host hint
 * the journal correlates on. Recording is never allowed to change what the run does — a failure
 * here is logged and survived, never raised into the step.
 */
import type { AgentAction } from '@lobster/shared-types';
import type { BrowserDriver } from '../driver.js';
import type { MemoryStore } from '../memory/index.js';
import { EXTRACT_SCRIPT } from '../perception/extract-script.js';

/** The phases a step's time is attributed to, in the order the debug line reports them. */
export const TIMING_PHASES = ['perceive', 'llm', 'execute', 'settle', 'journal'] as const;
export type TimedPhase = (typeof TIMING_PHASES)[number];

export interface StepTiming {
  step: number;
  startedAt: number;
  phases: Record<TimedPhase | 'total', number>;
}

export function newStepTiming(step: number, startedAt: number): StepTiming {
  return {
    step,
    startedAt,
    phases: { perceive: 0, llm: 0, execute: 0, settle: 0, journal: 0, total: 0 },
  };
}

/**
 * The driver with its two slow primitives on the stopwatch: the DOM walk (`evaluate` of the extract
 * script, i.e. every `perceive`) and `waitForSettle`. Timing them HERE attributes the cost wherever
 * it is paid — the top-of-step read, the pre-dispatch freshness read, the post-action verification,
 * the executor's own settle waits — without threading a clock through each caller.
 *
 * A Proxy rather than a wrapper class: every other member is forwarded BOUND TO THE REAL DRIVER, so a
 * driver that keeps private fields or compares `this` never meets a foreign receiver, and optional
 * members (`ready`, `screenshot`, `takeAdoptedPopup`) stay absent when the driver lacks them — the
 * loop decides behaviour by their presence.
 */
export function instrumentDriver(
  driver: BrowserDriver,
  timed: <T>(phase: 'perceive' | 'settle', operation: () => Promise<T>) => Promise<T>,
): BrowserDriver {
  return new Proxy(driver, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (property === 'evaluate') {
        return (expression: string): unknown =>
          expression === EXTRACT_SCRIPT
            ? timed('perceive', () => method.call(target, expression) as Promise<unknown>)
            : method.call(target, expression);
      }
      if (property === 'waitForSettle') {
        return (...args: unknown[]): Promise<void> =>
          timed('settle', () => method.call(target, ...args) as Promise<void>);
      }
      return method.bind(target);
    },
  });
}

export async function appendSafe(
  memory: MemoryStore,
  runId: string,
  step: number,
  url: string,
  action: AgentAction,
  outcome: string,
  now: () => string,
  log: (level: 'warn', message: string) => void,
  onDegraded?: (reason: string) => void,
): Promise<void> {
  try {
    await memory.appendStep(runId, {
      index: step,
      url,
      action: JSON.stringify(action),
      outcome,
      ts: now(),
    });
  } catch (error) {
    log('warn', `Could not persist encrypted agent step: ${safeError(error)}`);
    onDegraded?.(safeError(error));
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function journalHostOf(url: string): string | undefined {
  const host = hostOf(url).replace(/\.$/, '');
  // IPv6 literals contain colons and are intentionally omitted: the schema's optional host field is
  // a DNS/IPv4 correlation hint, never an authority parser or an execution target.
  return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ? host : undefined;
}

export function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
