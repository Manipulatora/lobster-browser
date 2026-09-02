/**
 * What the run WRITES DOWN as it goes: step timing, the per-step memory record, and the host hint
 * the journal correlates on. Recording is never allowed to change what the run does — a failure
 * here is logged and survived, never raised into the step.
 */
import type { AgentAction, AgentEvent, AgentUsage } from '@lobster/shared-types';
import { actionCapability } from '../actions.js';
import type { BrowserDriver } from '../driver.js';
import type { EffectDelivery } from '../executor.js';
import type {
  AppendRunJournalEventV1,
  JournalActionEffect,
  RunJournalSnapshot,
  RunJournalStore,
} from '../journal/index.js';
import type { MemoryStore } from '../memory/index.js';
import { EXTRACT_SCRIPT } from '../perception/extract-script.js';
import type { ActionRisk } from '../policy.js';
import { redactCredentialLikeText } from '../sensitive-text.js';
import { isReportedFailure } from './verify.js';

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

/**
 * The run's encrypted safety journal, spoken to in the loop's own terms: propose an action, mark the
 * run sensitive, self-approve a commit, and dispatch under the durable barrier. Every method is a
 * no-op for a run without a journal (focused tests, embedders), so the loop never branches on it.
 */
export interface RunJournal {
  /** The latest authenticated snapshot; undefined for a run without a journal. */
  readonly snapshot: RunJournalSnapshot | undefined;
  append: (event: AppendRunJournalEventV1) => Promise<void>;
  markSensitive: (
    reason: 'credential' | 'upload_path' | 'provider_configuration' | 'image_payload' | 'unknown',
  ) => Promise<void>;
  propose: (
    kind: AgentAction['kind'] | 'navigation_reconcile',
    effect: JournalActionEffect,
    host?: string,
  ) => Promise<string>;
  confirm: (prompt: string, action: AgentAction, actionId: string) => Promise<boolean>;
  dispatch: <T>(
    actionId: string,
    effect: JournalActionEffect,
    operation: (beginEffect: () => Promise<void>) => Promise<T>,
    outcomeOf: (value: T) => string,
    verifyAfterEffect?: (value: T) => Promise<void>,
    deliveryOf?: (value: T) => EffectDelivery | undefined,
  ) => Promise<T>;
}

export function createRunJournal(input: {
  journal: Pick<RunJournalStore, 'append'> | undefined;
  runId: string;
  /** What `create` returned, or undefined when the run has no journal. */
  snapshot: RunJournalSnapshot | undefined;
  timed: StepTimer['timed'];
  log: RunLog['log'];
}): RunJournal {
  const { journal, runId, timed, log } = input;
  let journalSnapshot = input.snapshot;
  let journalActionSequence = 0;

  const appendJournal = async (event: AppendRunJournalEventV1): Promise<void> => {
    const snapshot = journalSnapshot;
    if (!journal || !snapshot) return;
    journalSnapshot = await timed('journal', () =>
      journal.append(runId, event, snapshot.journal.revision),
    );
  };
  const markJournalSensitive = async (
    reason: 'credential' | 'upload_path' | 'provider_configuration' | 'image_payload' | 'unknown',
  ): Promise<void> => {
    if (!journalSnapshot || journalSnapshot.journal.sensitive) return;
    await appendJournal({ type: 'run.sensitive', reason });
  };
  const proposeJournalAction = async (
    kind: AgentAction['kind'] | 'navigation_reconcile',
    effect: JournalActionEffect,
    host?: string,
  ): Promise<string> => {
    const actionId = `action-${++journalActionSequence}`;
    await appendJournal({
      type: 'action.proposed',
      actionId,
      actionKind: kind,
      effect,
      // Never derive this from the live arguments or page label. That would turn an encrypted safety
      // checkpoint into a second store of selectors, values, paths, URLs, or attacker text.
      summary: `Proposed ${kind.replaceAll('_', ' ')} action`,
      ...(host ? { host } : {}),
    });
    return actionId;
  };
  /**
   * SELF-approval. The agent never stops mid-task to ask a human whether it may act — that is the
   * product decision, not a default: an unattended run that pauses on every commit either dies at the
   * ten-minute input timeout or trains the user to click Approve reflexively, and both outcomes are
   * worse than acting. The one legitimate stop that remains is the `ask` action for information the
   * agent cannot know (credentials, a captcha, a task-defining choice) — that still goes through
   * `waitForInput` in `handleAsk`.
   *
   * The approval EVENTS are deliberately kept: `approval.requested` + `approval.resolved approved`
   * still land in the encrypted journal for every gesture the risk policy classifies as a commit, so
   * the audit trail records that the harness recognised the boundary and crossed it autonomously —
   * and an interrupted journal still reduces through the same phases recovery understands. What
   * changed is only WHO answers, and how long that takes. The `log` line keeps the crossing visible
   * in the transcript without blocking on anyone; `prompt` may quote page-authored text, and `log`
   * already scrubs credential-like content before it leaves the process.
   */
  const confirmJournaled = async (
    prompt: string,
    _action: AgentAction,
    actionId: string,
  ): Promise<boolean> => {
    await appendJournal({ type: 'approval.requested', actionId });
    await appendJournal({ type: 'approval.resolved', actionId, decision: 'approved' });
    log('info', `Proceeding autonomously: ${prompt}`);
    return true;
  };
  const dispatchJournaled = async <T>(
    actionId: string,
    effect: JournalActionEffect,
    operation: (beginEffect: () => Promise<void>) => Promise<T>,
    outcomeOf: (value: T) => string,
    verifyAfterEffect?: (value: T) => Promise<void>,
    deliveryOf?: (value: T) => EffectDelivery | undefined,
  ): Promise<T> => {
    if (!journalSnapshot) return operation(async () => {});
    let effectBegan = false;
    const beginEffect = async (): Promise<void> => {
      if (effectBegan) return;
      // RunJournalStore fsyncs this append before returning. Nothing with effects crosses the driver /
      // memory boundary unless that durability barrier succeeds. The executor invokes this only after
      // deterministic target, policy, path and capability validation has passed.
      await appendJournal({ type: 'action.dispatching', actionId });
      effectBegan = true;
    };
    // Reads do not need preflight/effect separation and are safe to close during startup recovery.
    if (effect === 'read') await beginEffect();
    let value: T;
    try {
      value = await operation(beginEffect);
    } catch (error) {
      if (!effectBegan) {
        await appendJournal({
          type: 'action.cancelled',
          actionId,
          summary: 'The action failed before dispatch',
        });
      }
      throw error;
    }
    const outcome = outcomeOf(value);
    const reportedFailure = isReportedFailure(outcome);
    if (!effectBegan) {
      // A structured missing dispatch marker proves the executor returned during deterministic
      // preflight. It is safe to retry from a fresh observation and must not poison the profile as an
      // ambiguous write merely because the human-readable outcome starts with "blocked" or "error".
      await appendJournal({
        type: 'action.cancelled',
        actionId,
        summary: reportedFailure
          ? 'The action was rejected before dispatch'
          : 'The action completed without a browser-side effect',
      });
      return value;
    }
    if (reportedFailure && effect !== 'read') {
      // Driver methods can fail after an input event was delivered (for example, wait-for-settle after
      // a click). A returned error therefore does not prove a write was absent. But it does not prove
      // one HAPPENED either, and treating every driver rejection as possibly-written meant one CDP
      // hiccup on an ordinary click recorded an unverifiable effect and refused every later run on the
      // profile. The executor reports how far the action actually got, so only the case that is truly
      // in doubt — a rejection while an input was in flight — is preserved as an ambiguity.
      const delivery = deliveryOf?.(value);
      if (delivery === 'none') {
        await appendJournal({
          type: 'action.cancelled',
          actionId,
          summary: 'The action failed before any input reached the page',
        });
        return value;
      }
      if (delivery === 'delivered') {
        // Every input landed; only the settling or reading that follows failed. The effect is a fact,
        // not a maybe, and the next observation is what tells the model where it ended up — so this is
        // an ordinary failed step, not a profile-wide block. Post-effect verification is deliberately
        // skipped: the driver has already said it cannot read this page, and re-asking could only
        // downgrade a known state back into a lockout.
        await appendJournal({
          type: 'action.observed',
          actionId,
          outcome: 'succeeded',
          summary: 'The input was delivered; the page state after it could not be read',
        });
        return value;
      }
      await appendJournal({
        type: 'action.observed',
        actionId,
        outcome: 'unknown',
        summary: 'The action effect could not be verified',
      });
      throw new Error(
        'action outcome is ambiguous; manual recovery is required before another run',
      );
    }
    if (!reportedFailure && effect !== 'read' && verifyAfterEffect) {
      try {
        await verifyAfterEffect(value);
      } catch {
        await appendJournal({
          type: 'action.observed',
          actionId,
          outcome: 'unknown',
          summary: 'The browser effect was delivered but fresh state could not be verified',
        });
        throw new Error(
          'action delivery completed but post-action browser state is ambiguous; manual recovery is required before another run',
        );
      }
    }
    await appendJournal({
      type: 'action.observed',
      actionId,
      outcome: reportedFailure ? 'failed' : 'succeeded',
      summary: reportedFailure
        ? 'The action was observed to fail'
        : verifyAfterEffect
          ? 'The driver completed and fresh browser state was observed'
          : 'The action effect was acknowledged by its durable subsystem',
    });
    return value;
  };
  return {
    get snapshot() {
      return journalSnapshot;
    },
    append: appendJournal,
    markSensitive: markJournalSensitive,
    propose: proposeJournalAction,
    confirm: confirmJournaled,
    dispatch: dispatchJournaled,
  };
}

/**
 * How the journal classifies what an action can do — which is what recovery must assume happened if
 * the run dies mid-dispatch: a commit the risk policy flagged, a plain browser write, or a read.
 */
export function journalEffectOf(action: AgentAction, risk: ActionRisk): JournalActionEffect {
  return risk.consequential
    ? 'consequential'
    : actionCapability(action.kind).mutating &&
        !(action.kind === 'tab' && action.operation === 'list')
      ? 'write'
      : 'read';
}

/** An `ask` only has an effect when a sensitive answer is typed straight into a target on the page. */
export function askJournalEffect(
  action: Extract<AgentAction, { kind: 'ask' }>,
): JournalActionEffect {
  return action.sensitive &&
    (action.targetId !== undefined ||
      (action.targetX !== undefined && action.targetY !== undefined))
    ? 'consequential'
    : 'read';
}
