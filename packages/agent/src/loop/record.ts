/**
 * What the run WRITES DOWN as it goes: step timing, the per-step memory record, and the host hint
 * the journal correlates on. Recording is never allowed to change what the run does — a failure
 * here is logged and survived, never raised into the step.
 */
import type { AgentAction, AgentEvent, AgentUsage } from '@lobster/shared-types';
import type { BrowserDriver } from '../driver.js';
import type { MemoryStore } from '../memory/index.js';
import { EXTRACT_SCRIPT } from '../perception/extract-script.js';
import { redactCredentialLikeText } from '../sensitive-text.js';

/** The phases a step's time is attributed to, in the order the debug line reports them. */
const TIMING_PHASES = ['perceive', 'llm', 'execute', 'settle', 'journal'] as const;
export type TimedPhase = (typeof TIMING_PHASES)[number];

interface StepTiming {
  step: number;
  startedAt: number;
  phases: Record<TimedPhase | 'total', number>;
}

function newStepTiming(step: number, startedAt: number): StepTiming {
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

/** The identity every event of a run is stamped with. */
export interface RunIdentity {
  sessionId: string;
  profileId: string;
}

/**
 * The run's own voice. Both channels stamp the run's identity and scrub credential-like text before
 * anything leaves the process, so a model or page echoing a token cannot turn a log line into an
 * exfiltration event.
 */
export interface RunLog {
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /**
   * Report a memory degradation on its own typed channel as well as the log. Memory failing is
   * survivable but must never be INVISIBLE: a profile that has silently stopped remembering anything
   * looked exactly like one that was working.
   */
  memoryDegraded: (scope: 'run' | 'thread' | 'step', reason: string) => void;
}

export function createRunLog(input: {
  emit: (event: AgentEvent) => void;
  base: RunIdentity;
  now: () => string;
}): RunLog {
  const { emit, base, now } = input;
  return {
    log: (level, message) =>
      emit({
        type: 'log',
        ...base,
        level,
        message: redactCredentialLikeText(message).text,
        ts: now(),
      }),
    memoryDegraded: (scope, reason) => {
      emit({
        type: 'memory.degraded',
        ...base,
        scope,
        reason: redactCredentialLikeText(reason).text,
        ts: now(),
      });
    },
  };
}

/** Fold one response's usage into the run's running total. */
export function addUsage(usage: AgentUsage, value: AgentUsage): void {
  usage.tokensIn += value.tokensIn;
  usage.tokensOut += value.tokensOut;
  if (value.cachedTokensIn)
    usage.cachedTokensIn = (usage.cachedTokensIn ?? 0) + value.cachedTokensIn;
  if (value.costUsd) usage.costUsd = (usage.costUsd ?? 0) + value.costUsd;
}

/** The stopwatch a step's phases are charged to; `TIMING_PHASES` lists what is measured. */
export interface StepTimer {
  /** Charge `operation` to `phase` of the step in progress (nothing is recorded between steps). */
  timed: <T>(phase: TimedPhase, operation: () => Promise<T>) => Promise<T>;
  /**
   * The dispatch window NET of the primitives measured inside it, so `execute` is the driver's own
   * work — cursor paths, key cadence, the executor's checks — and not a second copy of the settle,
   * journal and verification-read time that `dispatchJournaled` also spends.
   */
  timedExecute: <T>(operation: () => Promise<T>) => Promise<T>;
  /**
   * Open `step`'s record, reporting the previous step's first. A record that is already open under
   * the same number is kept: a step retried after a truncated reply keeps accumulating into its own
   * record, because the retry is part of what that step cost.
   */
  begin: (step: number) => void;
  /**
   * Report where the finished step's time went. Called at the step BOUNDARY — the top of the next
   * iteration, and from `finish` — rather than at each of the step's dozen exits, so every path
   * through a step (executed, blocked, asked, retried) reports exactly once. A step is over when the
   * next one begins or the run ends, and that is when its number is final.
   */
  flush: () => void;
}

export function createStepTimer(input: {
  now: () => string;
  emit: (event: AgentEvent) => void;
  base: RunIdentity;
  log: RunLog['log'];
}): StepTimer {
  const { now, emit, base, log } = input;
  /**
   * Milliseconds on the clock the events are stamped with, so a step's phase durations and its
   * events' `ts` are measured the same way — and a test that injects `now` controls both.
   */
  const clock = (): number => {
    const ms = Date.parse(now());
    return Number.isNaN(ms) ? Date.now() : ms;
  };
  /** Phase accumulators for the step in progress; reported by `flush`. */
  let stepTiming: StepTiming | undefined;
  const timed = async <T>(phase: TimedPhase, operation: () => Promise<T>): Promise<T> => {
    const startedAt = clock();
    try {
      return await operation();
    } finally {
      if (stepTiming) stepTiming.phases[phase] += Math.max(0, clock() - startedAt);
    }
  };
  const timedExecute = async <T>(operation: () => Promise<T>): Promise<T> => {
    const startedAt = clock();
    const inner = (): number =>
      stepTiming
        ? stepTiming.phases.perceive + stepTiming.phases.settle + stepTiming.phases.journal
        : 0;
    const innerBefore = inner();
    try {
      return await operation();
    } finally {
      if (stepTiming) {
        stepTiming.phases.execute += Math.max(0, clock() - startedAt - (inner() - innerBefore));
      }
    }
  };
  const flush = (): void => {
    if (!stepTiming) return;
    const { step, startedAt, phases } = stepTiming;
    stepTiming = undefined;
    phases.total = Math.max(0, clock() - startedAt);
    emit({ type: 'step.timing', ...base, step, phases: { ...phases }, ts: now() });
    log(
      'debug',
      `Step ${step} timing: ${TIMING_PHASES.map((phase) => `${phase} ${phases[phase]}ms`).join(', ')} (total ${phases.total}ms).`,
    );
  };
  const begin = (step: number): void => {
    if (stepTiming && stepTiming.step !== step) flush();
    stepTiming ??= newStepTiming(step, clock());
  };
  return { timed, timedExecute, begin, flush };
}
