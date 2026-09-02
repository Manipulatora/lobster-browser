import { homedir } from 'node:os';
import { basename, isAbsolute } from 'node:path';
import type {
  AgentAction,
  AgentConfig,
  AgentEvent,
  AgentLlmConfig,
  AgentUsage,
} from '@lobster/shared-types';
import { ACT_TOOL, actionCapability, parseAction } from './actions.js';
import {
  assessUiSettingsIntent,
  isBrowserConfigSurfaceUrl,
  isPrivilegedInternalUrl,
  isVettedBrowserConfigUrl,
} from './browser-config-guard.js';
import type { BrowserDriver } from './driver.js';
import { MAX_SCREENSHOT_BASE64_CHARS } from './driver.js';
import { executeAction } from './executor.js';
import type { EffectDelivery, Sleep } from './executor.js';
import type { LlmClient } from './llm/index.js';
import { usesAutomaticToolChoice } from './llm/index.js';
import type { LlmMessage, LlmTool } from './llm/types.js';
import { normalizeMessages } from './llm/types.js';
import { budgetedMaxTokens, contextOverflowHeadroom, tokenBudgetExceeded } from './loop/decide.js';
import {
  actionIdentity,
  approvalContextFingerprint,
  canonicalNavigationUrl,
  isSettingsUiAction,
  sameNavigationAuthority,
  scopeWipeAllToNamedSite,
  settingsActionIntent,
} from './loop/gate.js';
import {
  appendExtractedEvidence,
  attachImageToLastTurn,
  clip,
  firstLine,
  observationFingerprint,
  pruneObservations,
  renderDataset,
  runLedger,
} from './loop/observe.js';
import type {
  AppendRunJournalEventV1,
  JournalActionEffect,
  RunJournalSnapshot,
} from './journal/index.js';
import type { RunJournalStore } from './journal/index.js';
import type { MemoryStore } from './memory/index.js';
import {
  actionCommitIntent,
  actionRisk,
  assessCurrentPage,
  assessNavigation,
  assessNavigationDrift,
  commitIntentGatesUnattended,
  normalizeAllowedDomains,
  targetUrlForAction,
} from './policy.js';
import type { PolicyDecision } from './policy.js';
import { EXTRACT_SCRIPT } from './perception/extract-script.js';
import { perceive } from './perception/perceive.js';
import {
  describeSituationChange,
  situationSignals,
  situationTransitions,
} from './perception/situation.js';
import type { SituationSignal } from './perception/situation.js';
import { renderObservation, sameElements } from './perception/serialize.js';
import {
  buildAskPrompt,
  buildStepPrompt,
  buildSystemPrompt,
  VERBATIM_OBSERVATIONS,
  buildVolatileTail,
  userMessageBlock,
} from './prompt.js';
import type { WorkingMemory } from './prompt.js';
import {
  describeSafeAction,
  isSensitiveElement,
  redactAction,
  redactRawActionInput,
  redactUrl,
  urlIdentity,
} from './security.js';
import { redactCredentialLikeText } from './sensitive-text.js';
import type { PerceivedElement, RawPerception } from './types.js';

// Kept on the loop's public surface after the split; it lives with the request budgeting now.
export { contextOverflowHeadroom } from './loop/decide.js';

export interface AgentRunDeps {
  driver: BrowserDriver;
  llm: LlmClient;
  memory: MemoryStore;
  emit: (event: AgentEvent) => void;
  waitForInput: (prompt: string, kind: 'ask' | 'confirm', action?: AgentAction) => Promise<string>;
  /**
   * Drain the messages the user sent since the last step (steering). Each becomes a trusted user
   * turn at the top of the next step, so a change of plan lands without stopping the run.
   */
  takeSteering?: () => string[];
  signal: AbortSignal;
  now: () => string;
  sleep?: Sleep;
  /**
   * Durable safety journal. Optional only so focused loop tests and embedders can use an in-memory
   * harness; the production manager always supplies the encrypted per-profile implementation.
   *
   * `removeFinished` is separately optional so a minimal `{create, append}` harness keeps working:
   * when present, `finish()` deletes the journal file the moment the run's terminal marker lands —
   * a finished journal has discharged its recovery duty and the product persists nothing about a
   * completed run. When absent the terminal file simply remains, which is safe (admission skips and
   * sweeps terminal journals) just not clean.
   */
  journal?: Pick<RunJournalStore, 'create' | 'append'> & {
    removeFinished?: RunJournalStore['removeFinished'];
  };
}

export interface AgentRunParams {
  sessionId: string;
  profileId: string;
  task: string;
  runId: string;
  /**
   * The conversation id the panel groups this run under. Wire-compat identity ONLY: the core neither
   * loads prior turns from it nor appends this run's exchange to it. Every run starts from a clean
   * context and persists no conversation — that is the product contract, not an omission. The id is
   * still accepted (and validated upstream) so the panel's transcript grouping keeps working.
   */
  threadId?: string;
  llmConfig: AgentLlmConfig;
  config: AgentConfig;
}

export function resolveConfig(partial: Partial<AgentConfig> | undefined): AgentConfig {
  const maxSteps = boundedInteger(partial?.maxSteps, 40, 1, 200, 'maxSteps');
  const tokenBudget =
    partial?.tokenBudget === undefined
      ? undefined
      : boundedInteger(partial.tokenBudget, 0, 1_000, 10_000_000, 'tokenBudget');
  const mode = partial?.mode ?? 'agent';
  if (mode !== 'ask' && mode !== 'agent') throw new Error('mode must be ask or agent');
  // Autonomy is ALWAYS 'auto'. The agent never pauses on a human approval, so a config value that
  // used to re-enable pausing is deliberately accepted-and-ignored rather than rejected: panels and
  // stored settings from before this decision still send 'confirm', and failing their runs over a
  // field the product no longer honors would strand exactly the users the change is for. Malformed
  // values still throw — silence is only for the two spellings that were ever legal.
  if (
    partial?.autonomy !== undefined &&
    partial.autonomy !== 'auto' &&
    partial.autonomy !== 'confirm'
  ) {
    throw new Error('autonomy must be auto or confirm');
  }
  const autonomy = 'auto';
  // Same treatment for cross-domain navigation: 'confirm' was a pause, and pauses are gone, so it
  // coerces to 'allow'. 'deny' is NOT a pause — it is a hard fence the caller asked for — and stays.
  if (
    partial?.crossDomainNavigation !== undefined &&
    !['allow', 'confirm', 'deny'].includes(partial.crossDomainNavigation)
  ) {
    throw new Error('crossDomainNavigation must be allow, confirm, or deny');
  }
  const crossDomainNavigation = partial?.crossDomainNavigation === 'deny' ? 'deny' : 'allow';
  const allowedDomains = normalizeAllowedDomains(partial?.allowedDomains);
  const allowedUploadRoots = (partial?.allowedUploadRoots ?? []).map((root) => {
    if (typeof root !== 'string' || !isAbsolute(root))
      throw new Error('allowedUploadRoots must be absolute paths');
    // A root of `/` or a home directory makes the allowlist meaningless — everything is "within" it —
    // and misconfiguring it is silent, so refuse the degenerate cases outright.
    const normalized = root.replace(/[/\\]+$/, '');
    if (!normalized || normalized === homedir().replace(/[/\\]+$/, '')) {
      throw new Error('allowedUploadRoots must not be the filesystem root or the home directory');
    }
    return root;
  });
  if (allowedUploadRoots.length > 20) throw new Error('at most 20 upload roots are allowed');
  if (partial?.startUrl && partial.startUrl.length > 8192) throw new Error('startUrl is too long');
  return {
    mode,
    maxSteps,
    autonomy,
    ...(allowedDomains.length ? { allowedDomains } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    ...(partial?.startUrl ? { startUrl: partial.startUrl } : {}),
    visionFallback: partial?.visionFallback === true,
    allowPrivateNetwork: partial?.allowPrivateNetwork === true,
    crossDomainNavigation,
    ...(allowedUploadRoots.length ? { allowedUploadRoots } : {}),
  };
}

/** The phases a step's time is attributed to, in the order the debug line reports them. */
const TIMING_PHASES = ['perceive', 'llm', 'execute', 'settle', 'journal'] as const;
type TimedPhase = (typeof TIMING_PHASES)[number];

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
function instrumentDriver(
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

export async function runAgent(params: AgentRunParams, deps: AgentRunDeps): Promise<void> {
  const { sessionId, profileId, task, runId, llmConfig, config } = params;
  const { llm, memory, emit, signal, now } = deps;
  const usage: AgentUsage = { tokensIn: 0, tokensOut: 0 };
  const sendsEffort =
    llmConfig.effort !== undefined &&
    (llm.sendsEffort?.(llmConfig.stepModel || llmConfig.model, llmConfig.effort) ?? false);
  const history: string[] = [];
  const base = { sessionId, profileId };
  /**
   * Milliseconds on the clock the events are stamped with, so a step's phase durations and its
   * events' `ts` are measured the same way — and a test that injects `now` controls both.
   */
  const clock = (): number => {
    const ms = Date.parse(now());
    return Number.isNaN(ms) ? Date.now() : ms;
  };
  /** Phase accumulators for the step in progress; reported by `flushStepTiming`. */
  let stepTiming: StepTiming | undefined;
  const timed = async <T>(phase: TimedPhase, operation: () => Promise<T>): Promise<T> => {
    const startedAt = clock();
    try {
      return await operation();
    } finally {
      if (stepTiming) stepTiming.phases[phase] += Math.max(0, clock() - startedAt);
    }
  };
  /**
   * The dispatch window NET of the primitives measured inside it, so `execute` is the driver's own
   * work — cursor paths, key cadence, the executor's checks — and not a second copy of the settle,
   * journal and verification-read time that `dispatchJournaled` also spends.
   */
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
  const driver = instrumentDriver(deps.driver, timed);
  const safeTask = redactCredentialLikeText(task);
  let memoryStarted = false;
  let journalSnapshot: RunJournalSnapshot | undefined;
  let journalActionSequence = 0;

  // The journal is a safety dependency, unlike recall memory. Create it before emitting lifecycle
  // events, consulting the model, opening a URL, or touching durable profile state. A production
  // storage failure therefore rejects the run before it can do work.
  if (deps.journal) {
    journalSnapshot = await deps.journal.create({
      runId,
      // Tasks can contain credentials or private business data. Recovery needs lifecycle/effect
      // state, not a second copy of the prompt, so persist a deliberately content-free label.
      task: 'Agent task',
      mode: config.mode ?? 'agent',
    });
  }

  const appendJournal = async (event: AppendRunJournalEventV1): Promise<void> => {
    const journal = deps.journal;
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
    const reportedFailure = /^(?:error|blocked|refused|missing|stale|could not)\b/i.test(outcome);
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
  const restoreNavigationJournaled = async (
    priorUrl: string,
    currentUrl: string,
    actionId: string,
  ): Promise<void> => {
    await dispatchJournaled(
      actionId,
      'write',
      async (beginEffect) => {
        await beginEffect();
        await rollbackNavigation(driver, priorUrl);
        return 'navigation restored and verified';
      },
      (value) => value,
    );
    log(
      'info',
      `Restored the prior page after refusing unexpected navigation from ${redactUrl(currentUrl)}.`,
    );
  };

  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string): void =>
    emit({
      type: 'log',
      ...base,
      level,
      message: redactCredentialLikeText(message).text,
      ts: now(),
    });
  /**
   * Report a memory degradation on its own typed channel as well as the log. Memory failing is
   * survivable but must never be INVISIBLE: a profile that has silently stopped remembering anything
   * looked exactly like one that was working.
   */
  const memoryDegraded = (scope: 'run' | 'thread' | 'step', reason: string): void => {
    emit({
      type: 'memory.degraded',
      ...base,
      scope,
      reason: redactCredentialLikeText(reason).text,
      ts: now(),
    });
  };
  const addUsage = (value: AgentUsage): void => {
    usage.tokensIn += value.tokensIn;
    usage.tokensOut += value.tokensOut;
    if (value.cachedTokensIn)
      usage.cachedTokensIn = (usage.cachedTokensIn ?? 0) + value.cachedTokensIn;
    if (value.costUsd) usage.costUsd = (usage.costUsd ?? 0) + value.costUsd;
  };
  /**
   * Report where the finished step's time went. Called at the step BOUNDARY — the top of the next
   * iteration, and from `finish` — rather than at each of the step's dozen exits, so every path
   * through a step (executed, blocked, asked, retried) reports exactly once. A step is over when the
   * next one begins or the run ends, and that is when its number is final.
   */
  const flushStepTiming = (): void => {
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
  const finish = async (
    status: 'done' | 'error' | 'stopped',
    result: string,
    error?: string,
  ): Promise<void> => {
    // The step that ended the run is over too; its timing goes out before the terminal event.
    flushStepTiming();
    // Terminal text is model-/page-derived and crosses the UI plus thread-memory boundaries. A model
    // echoing a token it saw must not turn `run.finished` into a credential exfiltration event.
    const safeResult = redactCredentialLikeText(result).text;
    const safeFinishError = error === undefined ? undefined : redactCredentialLikeText(error).text;
    await appendJournal({
      type: status === 'done' ? 'run.completed' : status === 'error' ? 'run.failed' : 'run.stopped',
      // Result text may contain extracted/private page data. The encrypted journal only needs a
      // terminal lifecycle marker; the encrypted conversation memory owns user-visible content.
      summary:
        status === 'done' ? 'Run completed' : status === 'error' ? 'Run failed' : 'Run stopped',
    });
    if (memoryStarted) {
      try {
        await memory.finishRun(runId, {
          status,
          summary: safeResult || safeFinishError || '',
          usage,
          endedAt: now(),
        });
      } catch (memoryError) {
        log('warn', `Could not finalize encrypted run memory: ${safeError(memoryError)}`);
        memoryDegraded('run', safeError(memoryError));
      }
    }
    // NO thread turn is recorded — deliberately, not by omission. The exchange used to be appended
    // here so a follow-up could refer to it; the product decision is now the opposite: nothing about
    // a task survives it, and the next task starts from a clean context with zero bleed. The panel
    // still shows the transcript it watched live; it just cannot replay it into a later run.
    //
    // The run's own journal is equally done. Its whole purpose was to make an INTERRUPTION
    // recoverable, and the terminal marker just proved there is nothing left to recover — so delete
    // the file rather than leaving encrypted residue that every future admission would decrypt,
    // reduce, and skip. `removeFinished` re-proves the terminal phase under the store's write lock,
    // so a bug here can never delete a journal that still matters. Failure to delete is a wart, not
    // a hazard: admission sweeps terminal journals too, so the file goes at the next start.
    if (deps.journal?.removeFinished && journalSnapshot) {
      try {
        await deps.journal.removeFinished(runId);
      } catch (cleanupError) {
        log('warn', `Could not remove the finished run journal: ${safeError(cleanupError)}`);
      }
    }
    emit({
      type: 'run.finished',
      ...base,
      status,
      ...(safeResult ? { result: safeResult } : {}),
      ...(safeFinishError ? { error: safeFinishError } : {}),
      usage,
      ts: now(),
    });
  };

  emit({ type: 'run.started', ...base, task: safeTask.text, ts: now() });
  if (safeTask.sensitive) {
    return await finish(
      'error',
      '',
      'The task contains credential-like content. Remove the secret and let Lobee request it through the secure input prompt when needed.',
    );
  }
  // Memory is BEST-EFFORT context, never a hard dependency: a broken, rotated, or corrupt store must
  // never stop the agent from doing the user's task. Persistence and recall each degrade to "off" on
  // failure instead of erroring the run (which is exactly what made a single bad file kill everything).
  try {
    await memory.startRun(runId, task, now(), {
      ...(config.mode ? { mode: config.mode } : {}),
      model: llmConfig.model,
    });
    memoryStarted = true;
  } catch (error) {
    // Could not record this run — it just won't be persisted or recalled later. Continue, but keep the
    // degradation visible so an operator can distinguish memory-off from an empty profile.
    log('warn', `Could not start encrypted run memory: ${safeError(error)}`);
    memoryDegraded('run', safeError(error));
  }

  // NO prior turns are loaded — for either mode. Every run is a fresh conversation on purpose: the
  // panel kept one everlasting thread id, so "prior turns of this conversation" meant every unrelated
  // task ever typed into the composer, prefixed with "[This attempt failed]" labels that kept the
  // model chewing on the LAST task instead of this one. The context-overflow fallback below already
  // proved runs work with no history; now that is simply the contract. What the model needs from the
  // past, the user restates in the task — and only the user decides what carries over.

  // ASK mode: a single chat completion, no browser and no tools — the model answers from its own
  // knowledge in Markdown. The browser never opens (the lazy driver is never touched).
  if (config.mode === 'ask') {
    try {
      const system = buildAskPrompt();
      const messages = normalizeMessages([{ role: 'user' as const, content: task }]);
      const tools: LlmTool[] = [];
      const desiredMaxTokens = sendsEffort ? 8000 : 2048;
      const maxTokens = budgetedMaxTokens({
        desiredMaxTokens,
        tokenBudget: config.tokenBudget,
        usage,
        system,
        messages,
        tools,
      });
      if (maxTokens === 0) {
        return await finish(
          'stopped',
          `Token budget (${config.tokenBudget}) leaves too little room for a useful chat response.`,
        );
      }
      const result = await llm.complete({
        model: llmConfig.model,
        system,
        messages,
        tools,
        forceTool: '',
        maxTokens,
        cachePrefix: true,
        // Chat is where the wait is felt, so this is where streaming earns its keep. Adapters that
        // cannot stream ignore the callback and the answer simply arrives whole, as before.
        onTextDelta: (text) => emit({ type: 'answer.delta', ...base, text, ts: now() }),
        ...(llmConfig.effort ? { effort: llmConfig.effort } : {}),
        signal,
      });
      addUsage(result.usage);
      emit({ type: 'usage', ...base, usage: { ...result.usage }, ts: now() });
      if (tokenBudgetExceeded(config.tokenBudget, usage)) {
        return await finish(
          'stopped',
          `Token budget (${config.tokenBudget}) was exceeded by the model response.`,
        );
      }
      const answer = (result.text ?? '').trim();
      return await finish(
        answer ? 'done' : 'error',
        answer,
        answer ? undefined : 'The model returned no answer.',
      );
    } catch (error) {
      if (signal.aborted) return await finish('stopped', 'Stopped by user.');
      return await finish('error', '', `Chat failed: ${safeError(error)}`);
    }
  }

  try {
    if (config.startUrl) {
      let current = await safe(() => driver.currentUrl(), '');
      const destination = canonicalNavigationUrl(config.startUrl, current);
      if (!destination) {
        return await finish('error', '', 'Start URL blocked: the destination is not a valid URL');
      }

      // Bind a possibly-relative start URL to the page that was actually observed, then re-check both
      // source and absolute destination immediately before dispatch. A page may self-navigate while a
      // human reads the prompt; the original relative string must never be re-based onto that new page.
      let readyToNavigate = false;
      let startNavigationActionId: string | undefined;
      for (let attempt = 0; attempt < 3 && !readyToNavigate; attempt += 1) {
        const currentDecision = assessCurrentPage(current, config);
        if (currentDecision.verdict === 'deny') {
          return await finish(
            'error',
            '',
            `Start URL blocked because the current page changed: ${currentDecision.reason}`,
          );
        }
        const decision = assessNavigation(destination, current, config);
        if (decision.verdict === 'deny') {
          return await finish('error', '', `Start URL blocked: ${decision.reason}`);
        }
        const actionId = await proposeJournalAction(
          'navigate',
          'write',
          journalHostOf(destination),
        );
        if (decision.verdict === 'confirm') {
          const safeDestination = redactUrl(destination);
          const approved = await confirmJournaled(
            `Approve opening ${safeDestination}? (${decision.reason})`,
            { kind: 'navigate', url: safeDestination },
            actionId,
          );
          if (!approved) return await finish('stopped', 'The start navigation was rejected.');
        }
        const liveCurrent = await safe(() => driver.currentUrl(), '');
        if (liveCurrent !== current) {
          await appendJournal({
            type: 'action.cancelled',
            actionId,
            summary: 'The source page changed before navigation',
          });
          current = liveCurrent;
          continue;
        }
        // The canonical destination is immutable, but policy may have changed with configuration only
        // through code, not during a run. Reassess anyway so this line stays the dispatch boundary.
        const finalDecision = assessNavigation(destination, liveCurrent, config);
        if (finalDecision.verdict === 'deny') {
          await appendJournal({
            type: 'action.cancelled',
            actionId,
            summary: 'Navigation was cancelled by policy',
          });
          return await finish('error', '', `Start URL blocked: ${finalDecision.reason}`);
        }
        readyToNavigate = true;
        startNavigationActionId = actionId;
      }
      if (!readyToNavigate) {
        return await finish(
          'error',
          '',
          'Start URL blocked because the current page kept changing during confirmation.',
        );
      }
      await dispatchJournaled(
        startNavigationActionId!,
        'write',
        async (beginEffect) => {
          await beginEffect();
          await driver.navigate(destination);
          await driver.waitForSettle();
          return 'navigation finished';
        },
        (outcome) => outcome,
        async () => {
          await verifyBrowserStateObserved(driver);
        },
      );
    }

    // NO persisted memory reaches the prompt. Cross-run facts and learned skills used to be loaded
    // here (`memory.loadContext`) and re-loaded per host mid-run; both are gone with the durable
    // memory feature itself — the product persists nothing between tasks, so there is nothing to
    // recall AND no channel through which a past page's text can steer a future run. The vetted
    // BUILT-IN skill pack still reaches the model: it is shipped code, not memory, and
    // `buildSystemPrompt` now renders it from the constant directly.
    const system = buildSystemPrompt({
      task,
      config,
      toolChoiceIsAdvisory: usesAutomaticToolChoice(llmConfig.provider, llmConfig.model),
    });
    let previous: RawPerception | null = null;
    let stepsSinceFullSnapshot = 0;
    /** This run's assistant/tool exchange — the WHOLE conversation the model sees, built per step. */
    const stepMessages: LlmMessage[] = [];
    // Trusted user turns (steering, answers) waiting to enter the conversation after this step's
    // tool result — a tool result must directly follow its call, so they queue until then.
    const pendingUserMessages: string[] = [];
    // The previous step's regenerated tail (nudges, ledgers). It is REMOVED before this step's
    // messages are appended rather than rewritten in place: everything before it stays byte-identical
    // between requests, which is what keeps the provider's prompt cache warm.
    let volatileTail: LlmMessage | undefined;
    /** The call id the NEXT observation answers, so the pairing providers require stays intact. */
    let lastToolCallId: string | undefined;
    let readEvidence: string[] = [];
    /** Rows the run has collected, in order, deduplicated by their full content. */
    const dataset: Array<Record<string, string>> = [];
    const datasetSeen = new Set<string>();
    let datasetColumns: string[] = [];
    let pendingImage: string | undefined;
    let lastFingerprint = '';
    let repeatCount = 0;
    /** Same action AND an unchanged page: the genuine no-progress signal. */
    let lastStateFingerprint = '';
    let stuckCount = 0;
    let recovery = false;
    let invalidActions = 0;
    /** True while a token-truncated response is being retried, so the retry cannot itself loop. */
    let truncatedRetry = false;
    /** A context-overflow recovery is attempted at most once per run. */
    let oversizeRetried = false;
    /**
     * A correction for the NEXT step, delivered through the ordinary nudge channel rather than as its
     * own message. A standalone user message would sit next to the step prompt (also a user message
     * once `lastToolCallId` is cleared), and `toAnthropicMessages` turns each into its own turn.
     */
    let pendingCorrection = '';
    /**
     * Refusals by the guard chain. `repeatCount` cannot see these: it is assigned only after every gate
     * has passed, so each `continue` above it bypasses the loop detector entirely and the same denied
     * navigation could be re-issued on all 40 steps, receiving the same one-line refusal each time.
     *
     * These counters change NUDGES and TERMINATION only — never permissions. A blocked action stays
     * blocked; the agent is simply told to stop pushing on a locked door, and the run ends honestly
     * rather than silently burning its budget.
     */
    let consecutiveBlocks = 0;
    let totalBlocks = 0;
    let lastBlockReason = '';
    const noteBlocked = (reason: string): void => {
      consecutiveBlocks += 1;
      totalBlocks += 1;
      lastBlockReason = reason;
      if (consecutiveBlocks >= 3) {
        recovery = true;
        // `reason` can contain a page-authored element label/URL. It belongs in the untrusted outcome
        // transcript, never interpolated into the harness-instruction channel.
        pendingCorrection = `${consecutiveBlocks} actions in a row were refused by the harness. Pushing on the same gate will not start working — take a materially different approach. If nothing else can advance the task, finish with \`done\` (success=false) and say what was blocked.`;
      }
    };
    let lastExtractedView = '';
    /**
     * The post-action observation, reused as the next step's page read.
     *
     * A mutating step used to run the full DOM extraction THREE times — once at the top, once after
     * approval, and once inside post-action verification, whose result was then thrown away and
     * immediately re-read by the next iteration. The extraction walks up to 500 candidates, every
     * open shadow root and each same-origin frame, so on a product whose value proposition is being
     * indistinguishable from a person, running it three times a step is both latency and footprint.
     * Verification has already proved this observation agrees with the live URL.
     */
    let carriedPerception: RawPerception | undefined;
    /** The tracked situation flags of the page the previous iteration acted on, and its step. */
    let previousSituation: { step: number; signals: SituationSignal[] } | undefined;
    /** Trusted mid-run amendments (steering, answers) in arrival order; the tail restates the newest. */
    const amendments: Array<{ step: number; text: string }> = [];
    /** The model's latest `plan`; every action that carries one replaces it. */
    let plan = '';

    for (let step = 1; step <= config.maxSteps; step += 1) {
      // A step retried after a truncated reply (`step -= 1` below) keeps accumulating into its own
      // record: the retry is part of what that step cost.
      if (stepTiming && stepTiming.step !== step) flushStepTiming();
      stepTiming ??= newStepTiming(step, clock());
      if (signal.aborted) return await finish('stopped', 'Stopped by user.');
      for (const text of deps.takeSteering?.() ?? []) {
        const safe = redactCredentialLikeText(text).text.trim();
        if (!safe) continue;
        pendingUserMessages.push(safe);
        emit({ type: 'run.steered', ...base, step, text: safe, ts: now() });
      }
      // Stop honestly rather than spending the remaining budget re-issuing refused actions. The user
      // gets a real reason instead of a run that quietly hit its step limit having done nothing.
      if (totalBlocks >= 10) {
        return await finish(
          'stopped',
          `Stopped after ${totalBlocks} actions were refused by the harness. The last reason was: ${lastBlockReason}`,
        );
      }

      const raw = carriedPerception ?? (await perceive(driver));
      carriedPerception = undefined;
      const currentPageDecision = assessCurrentPage(raw.url, config);
      if (currentPageDecision.verdict === 'deny') {
        return await finish(
          'error',
          '',
          `Current page blocked by run policy: ${currentPageDecision.reason}`,
        );
      }
      // A summarised observation is only safe while a FULL one is still in the verbatim window.
      // Older tool results are pruned to their header line, so after enough consecutive unchanged
      // steps — collect, wait, a blocked action — every surviving result would say only
      // "unchanged" and the model would be acting on element indices it can no longer see anywhere.
      // That is exactly how hallucinated indices and "no element [n]" loops start.
      const unchanged =
        previous !== null &&
        sameElements(previous, raw) &&
        stepsSinceFullSnapshot < VERBATIM_OBSERVATIONS - 1;
      const rendered = unchanged
        ? `url: ${raw.url} | ${JSON.stringify(raw.title)}\n(interactive elements unchanged from the previous step)`
        : renderObservation(raw);
      stepsSinceFullSnapshot = unchanged ? stepsSinceFullSnapshot + 1 : 0;
      previous = raw;
      emit({
        type: 'step.observation',
        ...base,
        step,
        url: redactCredentialLikeText(redactUrl(raw.url)).text,
        title: redactCredentialLikeText(raw.title).text,
        summary: redactCredentialLikeText(firstLine(rendered)).text,
        elementCount: raw.elements.length,
        ts: now(),
      });

      if (
        config.visionFallback &&
        !pendingImage &&
        driver.screenshot &&
        raw.elements.length <= 2 &&
        raw.signals?.includes('canvas')
      ) {
        // A screenshot can contain credentials, messages, customer data, or cross-origin pixels the
        // DOM snapshot cannot classify. Mark the run non-resumable before capture/provider handoff.
        await markJournalSensitive('image_payload');
        const captured = await driver.screenshot().catch(() => undefined);
        if (captured && captured.length <= MAX_SCREENSHOT_BASE64_CHARS) pendingImage = captured;
      }

      const nudges: string[] = [];
      if (pendingCorrection) {
        nudges.push(pendingCorrection);
        pendingCorrection = '';
      }
      if (recovery)
        nudges.push(
          'RECOVERY: the last behavior repeated. Re-read the page and choose a materially different action.',
        );
      // Escalate rather than repeat. The same "wrap up" line from 75% to 100% carried no new
      // information after the first time, so the last quarter of a run read identically whether five
      // steps remained or one.
      if (step >= Math.ceil(config.maxSteps * 0.95)) {
        nudges.push(
          `BUDGET: step ${step} of ${config.maxSteps} — this is your LAST chance to answer. Call \`done\` NOW with whatever you have, and say plainly what is missing.`,
        );
      } else if (step >= Math.ceil(config.maxSteps * 0.75)) {
        nudges.push(
          `BUDGET: step ${step} of ${config.maxSteps}. Wrap up — consolidate what you already have and call \`done\`; do not start new exploration.`,
        );
      }
      // Situation transitions. The snapshot's `page signals` line says what is on the page now; what
      // the model needs told is that it CHANGED — a login wall that was not there a step ago, a
      // CAPTCHA that has gone — compared against the page the previous iteration acted on. The
      // panel gets the same transition as an event, so the rail can say "login wall" where the model
      // is deciding what to do about it.
      const situation = situationSignals(raw.signals);
      for (const change of situationTransitions(previousSituation?.signals ?? [], situation)) {
        nudges.push(describeSituationChange(change, previousSituation?.step));
        emit({
          type: 'step.signal',
          ...base,
          step,
          signal: change.signal,
          appeared: change.appeared,
          ts: now(),
        });
      }
      previousSituation = { step, signals: situation };
      // The tool result carries only what is STABLE for this step — header, outcome, snapshot. The
      // nudges and both ledgers change every step and go in the volatile tail below instead.
      const stepText = buildStepPrompt({
        history: [],
        observation: rendered,
        step,
        url: raw.url,
        // Every path that ends a step appends its outcome here, so the newest entry is precisely what
        // the tool result should report.
        ...(history.length ? { outcome: history[history.length - 1]! } : {}),
      });
      if (volatileTail) {
        const at = stepMessages.lastIndexOf(volatileTail);
        if (at !== -1) stepMessages.splice(at, 1);
        volatileTail = undefined;
      }
      // Step 1 opens the turn as a user message; every later step is the RESULT of the tool call the
      // model just made. Feeding observations back as tool results is what gives the model a genuine
      // record of its own actions — the old design re-narrated them as prose because a single-message
      // request had nowhere else to put them.
      if (step === 1) {
        stepMessages.push({ role: 'user', content: stepText });
      } else if (lastToolCallId) {
        stepMessages.push({ role: 'tool', toolCallId: lastToolCallId, content: stepText });
      } else {
        stepMessages.push({ role: 'user', content: stepText });
      }
      for (const text of pendingUserMessages.splice(0)) {
        stepMessages.push({ role: 'user', content: userMessageBlock(text) });
        amendments.push({ step, text });
      }
      // The working memory is harness-owned state, so it rides in the regenerated tail with the
      // ledgers: the task contract and the plan are restated every step and never age out.
      const workingMemory: WorkingMemory = {
        task,
        amendments: [...amendments].reverse(),
        ...(plan ? { plan } : {}),
      };
      const tail = buildVolatileTail({
        nudges,
        memory: workingMemory,
        ...(readEvidence.length ? { readState: readEvidence.join('\n\n') } : {}),
        ...(history.length ? { progress: runLedger(history) } : {}),
      });
      if (tail) {
        volatileTail = { role: 'user', content: tail };
        stepMessages.push(volatileTail);
      }
      // Reasoning effort consumes from `max_tokens` (OpenRouter converts effort→thinking budget for
      // Anthropic, up to ~0.8×max_tokens at High), so raise the cap when effort is on to leave room for
      // the forced action call; otherwise the tiny tool-call output only needs ~1024. Ask the adapter
      // rather than the config: a transport that discards `effort` would otherwise reserve eight
      // times the output it can use and drain the run's token allowance for no reasoning at all.
      const desiredMaxTokens = sendsEffort ? 8000 : 1024;
      // THIS RUN'S messages only. Nothing from any previous task is prepended — the conversation a
      // model step sees is exactly what this run produced, pruned for size but never for provenance.
      const conversation = normalizeMessages(pruneObservations(stepMessages));
      const imageForStep = pendingImage;
      const requestMessages = imageForStep
        ? attachImageToLastTurn(conversation, imageForStep)
        : conversation;
      const tools: LlmTool[] = [
        {
          name: ACT_TOOL.name,
          description: ACT_TOOL.description,
          inputSchema: ACT_TOOL.inputSchema,
        },
      ];
      // Reserve THIS request's complete input instead of extrapolating an average from prior steps.
      // The conversation changes every step, and one long page can be many times larger than the
      // preceding snapshots. The remaining allowance becomes a real max-output cap on the request.
      const requestMaxTokens = budgetedMaxTokens({
        desiredMaxTokens,
        tokenBudget: config.tokenBudget,
        usage,
        system,
        messages: requestMessages,
        tools,
      });
      if (requestMaxTokens === 0) {
        return await finish(
          'stopped',
          `Token budget (${config.tokenBudget}) leaves too little room for another agent step.`,
        );
      }

      emit({ type: 'step.thinking', ...base, step, ts: now() });
      pendingImage = undefined;
      let progressChars = 0;
      let progressEmittedAt = 0;
      const buildRequest = (
        overrides: { maxTokens?: number; messages?: LlmMessage[] } = {},
      ): Parameters<typeof llm.complete>[0] => ({
        model: step === 1 || recovery ? llmConfig.model : (llmConfig.stepModel ?? llmConfig.model),
        system,
        messages: overrides.messages ?? requestMessages,
        tools,
        forceTool: ACT_TOOL.name,
        maxTokens: overrides.maxTokens ?? requestMaxTokens,
        cachePrefix: true,
        sessionId: runId,
        attribution: { profileId, sessionId: runId },
        // A routine step on the step model runs at the step model's effort: the whole point of a
        // cheaper model for navigation is latency, and asking it to think hard gives that back.
        ...((
          step === 1 || recovery || !llmConfig.stepModel
            ? llmConfig.effort
            : (llmConfig.stepEffort ?? llmConfig.effort)
        )
          ? {
              effort:
                step === 1 || recovery || !llmConfig.stepModel
                  ? llmConfig.effort
                  : (llmConfig.stepEffort ?? llmConfig.effort),
            }
          : {}),
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
          emit({ type: 'step.progress', ...base, step, kind, chars: progressChars, ts: now() });
        },
        signal,
      });
      // A context-window 400 used to end the run outright: it is not in `retryableStatus`, so it
      // propagated straight to the catch that calls `finish('error')`. Recover in the cheapest order —
      // ask for fewer OUTPUT tokens first (the whole conversation survives), and only then start
      // dropping history. `normalizeMessages` already repairs an arbitrarily head-dropped list, so the
      // dangerous part of the second tier is already built.
      let result: Awaited<ReturnType<typeof llm.complete>>;
      try {
        result = await timed('llm', () => llm.complete(buildRequest()));
      } catch (error) {
        const headroom = contextOverflowHeadroom(error);
        if (headroom === null || oversizeRetried) throw error;
        oversizeRetried = true;
        // Only take the cheap path when it actually CHANGES the request. A headroom at or above the
        // current cap would re-send an identical body and burn a call to get the same 400.
        if (headroom >= 512 && headroom < requestMaxTokens) {
          log('warn', `Context limit reached; retrying this step with a smaller output budget.`);
          result = await timed('llm', () => llm.complete(buildRequest({ maxTokens: headroom })));
        } else {
          log('warn', 'Context limit reached; retrying this step with the conversation trimmed.');
          result = await timed('llm', () =>
            llm.complete(
              buildRequest({
                messages: normalizeMessages(pruneObservations(stepMessages).slice(-4)),
                maxTokens: Math.min(requestMaxTokens, 1024),
              }),
            ),
          );
        }
      }
      recovery = false;
      addUsage(result.usage);
      emit({ type: 'usage', ...base, usage: { ...result.usage }, ts: now() });
      // Provider usage is authoritative. Estimation is necessarily conservative-but-imperfect across
      // tokenizers and image accounting, so quarantine the returned tool call if the provider says the
      // cumulative ceiling was crossed. No parse, approval prompt, memory mutation, or browser action
      // may happen after this point.
      if (tokenBudgetExceeded(config.tokenBudget, usage)) {
        return await finish(
          'stopped',
          `Token budget (${config.tokenBudget}) was exceeded by the model response; no action was executed.`,
        );
      }

      if (result.stopReason === 'refusal')
        return await finish('error', '', 'The model refused this task.');

      // A response cut off at the token cap carries no usable action. Retry the SAME step once before
      // spending a strike: with `effort` on, most of `maxTokens` is thinking budget (see above), so a
      // truncation is a budgeting accident rather than a model failure. Only a second truncation in a
      // row is treated as a real invalid step.
      if (result.stopReason === 'length' && !truncatedRetry) {
        truncatedRetry = true;
        pendingCorrection =
          'Your previous response hit the output token limit before it produced an action. Resume directly — no apology, no recap. Emit only the `act` tool call.';
        lastToolCallId = undefined;
        step -= 1; // this step produced nothing; retry it without consuming step budget
        continue;
      }
      truncatedRetry = false;

      if (!result.toolCall) {
        // No tool call: the model answered in prose. On the shipped panel path `tool_choice` is 'auto'
        // (adaptive-thinking models reject a forced choice), so this is routine, not exotic.
        //
        // Clearing `lastToolCallId` is the load-bearing line. Without it the NEXT step emits a second
        // `tool` message answering an already-answered call id, `normalizeMessages` drops it as
        // answering nothing, and the model is re-sent a byte-identical conversation — no new
        // observation, no complaint, no way to recover, until the 3-strike kill fires.
        invalidActions += 1;
        if (result.text && result.text.trim()) {
          stepMessages.push({ role: 'assistant', content: result.text });
        }
        lastToolCallId = undefined;
        pendingCorrection =
          'That reply contained no `act` tool call, so nothing happened on the page. Do not answer in prose: every step is exactly one `act` tool call. If the task is already complete, call `act` with kind "done".';
        history.push(`${step}. no structured action returned`);
        if (invalidActions >= 3)
          return await finish('error', '', 'The model repeatedly returned no valid action.');
        continue;
      }
      const parsed = parseAction(result.toolCall.input);
      if (!parsed.ok) {
        // Answer the failed call ON ITS OWN id, in this same step. The rejected payload has to go back
        // (the model cannot fix a call it is not shown) but it never parsed, so `redactAction` cannot
        // be used — `redactRawActionInput` blanks by key instead.
        invalidActions += 1;
        stepMessages.push({
          role: 'assistant',
          toolCalls: [{ ...result.toolCall, input: redactRawActionInput(result.toolCall.input) }],
        });
        lastToolCallId = result.toolCall.id;
        stepMessages.push({
          role: 'tool',
          toolCallId: result.toolCall.id,
          content: `That action was rejected and nothing happened on the page: ${parsed.error}\nFix exactly that field and call \`act\` again.`,
        });
        lastToolCallId = undefined; // the diagnosis already answered this call
        history.push(`${step}. invalid action: ${parsed.error}`);
        if (invalidActions >= 3)
          return await finish('error', '', 'The model repeatedly returned invalid actions.');
        continue;
      }
      // Decay rather than reset: a model that alternates one good action with one bad one would never
      // trip the limit on a hard reset, and would burn the whole step budget instead.
      invalidActions = Math.max(0, invalidActions - 1);
      const action = scopeWipeAllToNamedSite(parsed.action, task);
      const safeAction = redactAction(action, raw);
      // The plan is the model's memo to itself and is kept whether or not the action it rode on is
      // allowed to run: a blocked action is exactly when the notes matter. The redacted copy, so a
      // credential-shaped string cannot be re-sent to the model through its own notes.
      if (safeAction.plan) plan = safeAction.plan;
      // Record the model's own choice as an assistant turn. Every path below may `continue`, and the
      // next step answers THIS call id — so the assistant/tool pairing stays well-formed even when the
      // action is blocked, rejected, or never executed.
      stepMessages.push({
        role: 'assistant',
        toolCalls: [
          { ...result.toolCall, input: safeAction as unknown as Record<string, unknown> },
        ],
      });
      lastToolCallId = result.toolCall.id;
      emit({ type: 'step.action', ...base, step, action: safeAction, ts: now() });

      // The model thought against `raw`, but a page can self-navigate during the model round trip. Re-
      // enforce the fence immediately before handling ANY proposed action (including memory/handoff
      // actions), and refuse a stale same-site observation instead of letting old element ids operate on
      // a new document. Compare an opaque digest of the full URL: comparing redacted strings would
      // collapse two different token/query resources into one approval identity.
      const browserClosed = driver.ready ? !driver.ready() : false;
      const liveUrlBeforeAction = browserClosed
        ? raw.url
        : await safe(() => driver.currentUrl(), '');
      const livePageDecision = assessCurrentPage(liveUrlBeforeAction, config);
      const observedUrlIdentity = raw.urlIdentity ?? urlIdentity(raw.url);
      if (
        livePageDecision.verdict === 'deny' ||
        urlIdentity(liveUrlBeforeAction) !== observedUrlIdentity
      ) {
        const reason =
          livePageDecision.verdict === 'deny'
            ? livePageDecision.reason
            : 'the page navigated after it was observed; inspect the new page before acting';
        const outcome = `blocked: ${reason}`;
        noteBlocked(reason);
        history.push(`${step}. ${outcome}`);
        await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log, (r) =>
          memoryDegraded('step', r),
        );
        continue;
      }

      if (
        (actionCapability(action.kind).needsScreenshot ||
          (action.kind === 'ask' && action.targetX !== undefined)) &&
        !imageForStep
      ) {
        noteBlocked('coordinate actions require a screenshot in the same model step');
        history.push(
          `${step}. blocked: coordinate actions require a screenshot in the same model step`,
        );
        continue;
      }

      if (
        (action.kind === 'type' || action.kind === 'type_at') &&
        redactCredentialLikeText(action.text).sensitive
      ) {
        const outcome =
          'blocked: credential-like text cannot use an ordinary model-authored typing action; request it through ask with sensitive:true and a verified target';
        noteBlocked(
          'credential-like text must use the direct secure human-input channel, not model-authored typing',
        );
        history.push(`${step}. ${outcome}`);
        await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log, (reason) =>
          memoryDegraded('step', reason),
        );
        continue;
      }

      if (action.kind === 'ask') {
        if (action.sensitive) await markJournalSensitive('credential');
        const askEffect: JournalActionEffect =
          action.sensitive &&
          (action.targetId !== undefined ||
            (action.targetX !== undefined && action.targetY !== undefined))
            ? 'consequential'
            : 'read';
        const actionId = await proposeJournalAction(action.kind, askEffect, journalHostOf(raw.url));
        const handled = await dispatchJournaled(
          actionId,
          askEffect,
          (beginEffect) =>
            handleAsk(
              action,
              raw,
              imageForStep,
              step,
              runId,
              history,
              base,
              { ...deps, driver },
              memory,
              now,
              beginEffect,
              (prompt, pending) => confirmJournaled(prompt, pending, actionId),
              (text) => pendingUserMessages.push(text),
            ),
          (value) => value.outcome,
          askEffect === 'read'
            ? undefined
            : async () => {
                await verifyBrowserStateObserved(driver);
              },
        );
        if (!handled.ok) history.push(`${step}. ${handled.outcome}`);
        continue;
      }
      if (action.kind === 'screenshot' && !config.visionFallback) {
        noteBlocked('visual fallback is disabled for this run');
        history.push(`${step}. blocked: visual fallback is disabled for this run`);
        continue;
      }
      if (action.kind === 'screenshot') await markJournalSensitive('image_payload');

      // A privileged browser-internal page that is NOT a vetted settings surface is off limits
      // entirely — the agent leaves rather than acting. The navigation policy already refuses to open
      // one, but the agent can still ARRIVE on one: by switching to a tab the human opened, or by the
      // driver adopting a popup. `chrome://policy` in particular exposes `setLocalTestPolicies`, which
      // sets enterprise policy — proxy included — straight past every guard in browser-config-guard.ts,
      // so a page reached by accident must not become a way around the fingerprint/proxy protections.
      if (
        isPrivilegedInternalUrl(raw.url) &&
        !isVettedBrowserConfigUrl(raw.url) &&
        !actionCapability(action.kind).allowedOnPrivilegedPage
      ) {
        const outcome =
          'blocked: this is a privileged browser page outside the vetted settings surface. Leave it (switch tabs, go back, or navigate to a normal site) before continuing.';
        noteBlocked('this is a privileged browser page outside the vetted settings surface');
        history.push(`${step}. ${outcome}`);
        await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log, (r) =>
          memoryDegraded('step', r),
        );
        recovery = true;
        continue;
      }

      // Browser WebUI is only reachable through the vetted browser_config entry points. Continue to
      // screen each semantic control/value so a safe page cannot be used as a trampoline into the
      // fingerprint/proxy layer. Coordinate clicks are deliberately disallowed here because they have
      // no trustworthy semantic target for the guard to assess.
      if (isBrowserConfigSurfaceUrl(raw.url) && isSettingsUiAction(action)) {
        const settingsAssessment = assessUiSettingsIntent(...settingsActionIntent(action, raw));
        const coordinate = action.kind === 'click_at' || action.kind === 'type_at';
        const unvettedPage = !isVettedBrowserConfigUrl(raw.url);
        if (unvettedPage || coordinate || settingsAssessment.verdict === 'block') {
          const outcome = unvettedPage
            ? 'blocked: this browser settings subsection is outside the vetted configuration surface'
            : coordinate
              ? 'blocked: coordinate actions are not allowed on browser settings pages; use a labelled control'
              : (settingsAssessment.reason ?? 'blocked: browser setting is not permitted');
          noteBlocked(outcome.replace(/^blocked: /, ''));
          history.push(`${step}. ${outcome}`);
          await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log, (r) =>
            memoryDegraded('step', r),
          );
          continue;
        }
      }

      if (action.kind === 'extract' && lastExtractedView === observationFingerprint(raw)) {
        const outcome =
          'blocked: this unchanged page view was already extracted; use the existing result or change the page';
        noteBlocked('this page view was already extracted');
        history.push(`${step}. ${outcome}`);
        recovery = true;
        continue;
      }

      // `remember`/`learn` were removed with durable memory itself: they no longer parse, the model
      // is no longer offered them, and no credential-in-memory guard is needed for a write path that
      // does not exist. A stale model that still emits one gets the ordinary invalid-action feedback.

      const commitIntent = actionCommitIntent(action, raw);
      const risk = actionRisk(action, raw);
      const target = targetUrlForAction(action, raw);
      let navigationApproved = false;
      let approvalGranted = false;
      let navigationDecision: PolicyDecision | undefined;
      if (target) {
        const trustedInternalMove =
          isVettedBrowserConfigUrl(raw.url) && isVettedBrowserConfigUrl(target);
        const decision: PolicyDecision = trustedInternalMove
          ? { verdict: 'allow' }
          : assessNavigation(target, raw.url, config);
        navigationDecision = decision;
        if (decision.verdict === 'deny') {
          const outcome = `blocked: ${decision.reason}`;
          noteBlocked(decision.reason);
          history.push(`${step}. ${outcome}`);
          await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log, (r) =>
            memoryDegraded('step', r),
          );
          continue;
        }
      }

      // Upload paths and visual payloads must never be eligible for automatic restart. This marker is
      // fsynced before approval or execution and contains no path/image data.
      if (action.kind === 'upload') await markJournalSensitive('upload_path');
      const journalEffect: JournalActionEffect = risk.consequential
        ? 'consequential'
        : actionCapability(action.kind).mutating &&
            !(action.kind === 'tab' && action.operation === 'list')
          ? 'write'
          : 'read';
      const journalActionId = await proposeJournalAction(
        action.kind,
        journalEffect,
        journalHostOf(raw.url),
      );

      if (navigationDecision?.verdict === 'confirm') {
        navigationApproved = await confirmJournaled(
          `Approve ${describeSafeAction(action, raw)}? (${navigationDecision.reason}${risk.consequential && risk.reason ? `; ${risk.reason}` : ''})`,
          safeAction,
          journalActionId,
        );
        if (!navigationApproved) {
          history.push(`${step}. user rejected ${describeSafeAction(action, raw)}`);
          continue;
        }
        approvalGranted = true;
      }

      // CONSEQUENTIAL actions no longer pause on a human, in any mode — uploads, purchases, sends,
      // deletions, account creation, permission changes, data erasure all proceed. This is the
      // owner's decision: the agent is fully autonomous, and an approval modal that fires mid-task is
      // exactly the interruption the product exists to remove. What SURVIVES the decision is
      // everything around the old gate: the journal still classifies the gesture as a commit
      // (`risk.consequential` feeds `journalEffect`, so recovery still treats an unverifiable click
      // honestly), the self-approval below still writes the requested/approved pair into the audit
      // trail, and the freshness checks that used to protect a human's stale "yes" now protect the
      // harness's own: the page observed when the commit was classified must still be the page the
      // commit lands on.
      let approvedTargetPatch: string | undefined;
      // `commitIntentGatesUnattended` keeps its policy meaning — which gestures cross the commit
      // boundary — even though nobody is asked anymore: it now decides which actions get the
      // journaled self-approval + pre-dispatch freshness re-check, not who answers.
      const commitBoundary =
        commitIntent === undefined ? risk.consequential : commitIntentGatesUnattended(commitIntent);
      if (commitBoundary && !navigationApproved) {
        // Name the files and the destination in the transcript line, exactly as the old approval
        // prompt did for the human — the audit value of a specific sentence did not leave with the
        // modal. (Redacting the transcript copy is still right; the paths here are basenames only.)
        const prompt =
          action.kind === 'upload'
            ? `uploading ${action.paths.map((p) => JSON.stringify(basename(p))).join(', ')} to ${hostOf(raw.url) || redactUrl(raw.url)}`
            : `${describeSafeAction(action, raw)}${risk.reason ? ` (${risk.reason})` : ''}`;
        // The commit target, in pixels, captured at classification time. A canvas or cross-origin
        // frame changes without touching DOM perception, so this is the only evidence that the thing
        // under the coordinate when the gesture dispatches is still the thing the model aimed at.
        approvedTargetPatch = await visualTargetPatch(driver, action);
        await confirmJournaled(prompt, safeAction, journalActionId);
        approvalGranted = true;
      }

      // A commit is authorized against this exact observation, not as a reusable "yes". The human
      // pause is gone, but the window it guarded is not: a page can mutate, navigate, replace a
      // button, or change a total during the model round trip and the classification work above.
      // Re-observe immediately before dispatch and fail closed on any security-relevant drift — the
      // next loop iteration hands the model the fresh page and it decides again against reality.
      if (approvalGranted) {
        const afterApproval = await perceive(driver);
        if (
          approvalContextFingerprint(action, raw) !==
          approvalContextFingerprint(action, afterApproval)
        ) {
          const outcome =
            'blocked: the page or commit target changed before dispatch; inspect the fresh page and act again';
          noteBlocked('the page or commit target changed before dispatch');
          history.push(`${step}. ${outcome}`);
          await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log, (r) =>
            memoryDegraded('step', r),
          );
          await appendJournal({
            type: 'action.cancelled',
            actionId: journalActionId,
            summary: 'The commit target changed before dispatch',
          });
          continue;
        }
        // Do this LAST, after the DOM check, to make the unobservable screenshot-to-dispatch race as
        // small as possible. Canvas and cross-origin frame changes do not appear in `afterApproval`.
        if (action.kind === 'click_at' || action.kind === 'type_at') {
          if (!imageForStep || !(await visualTargetHeld(driver, action, approvedTargetPatch))) {
            const outcome =
              'blocked: the visual page changed before dispatch; capture a fresh screenshot and act again';
            noteBlocked('the visual page changed before dispatch');
            history.push(`${step}. ${outcome}`);
            await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log, (r) =>
              memoryDegraded('step', r),
            );
            await appendJournal({
              type: 'action.cancelled',
              actionId: journalActionId,
              summary: 'The visual commit target changed before dispatch',
            });
            continue;
          }
        }
      }

      // Risky but NOT consequential (for example, typing into an amount field). It proceeds, and the
      // model is told to check the result — awareness without a pause.
      if (risk.high && risk.reason && !commitBoundary) {
        // The detailed risk reason may include a page-authored field label. Keep it out of the trusted
        // nudge channel; the ordinary untrusted action outcome still tells the model what it touched.
        pendingCorrection =
          'You just took a high-risk composition action. Verify from the next snapshot that it did what the task asked — and do not repeat it.';
      }

      // Two different questions, previously answered by one counter keyed on URL + action.
      //
      // "Stuck" is the same action against a page that did not move at all — the real no-progress
      // signal, and cheap to stop early. "Repeating" is the same action while the page KEEPS
      // CHANGING, which is what reading an infinite list, polling for late-arriving content, or
      // paging through an SPA that never changes its URL all look like. Killing the second case at
      // the fifth attempt made an explicitly supported scenario impossible: five scrolls down a feed
      // ended the run as a loop even though every scroll had appended new rows. It still cannot go on
      // forever — a page with a ticking clock would otherwise never look stuck — so it keeps a much
      // looser bound of its own, under the run's step and token ceilings.
      const actionFingerprint = `${raw.url}|${actionIdentity(safeAction)}`;
      const stateFingerprint = `${observationFingerprint(raw)}|${actionIdentity(safeAction)}`;
      stuckCount = stateFingerprint === lastStateFingerprint ? stuckCount + 1 : 1;
      repeatCount = actionFingerprint === lastFingerprint ? repeatCount + 1 : 1;
      lastStateFingerprint = stateFingerprint;
      lastFingerprint = actionFingerprint;
      if (stuckCount >= 5 || repeatCount >= 12) {
        return await finish(
          'error',
          '',
          'The agent entered a repeated-action loop and stopped safely.',
        );
      }
      if (stuckCount >= 3 || repeatCount >= 8) recovery = true;

      let verifiedPerception: RawPerception | undefined;
      const outcome = await timedExecute(() =>
        dispatchJournaled(
          journalActionId,
          journalEffect,
          (beginEffect) =>
            executeAction(action, raw, driver, {
              ...(deps.sleep ? { sleep: deps.sleep } : {}),
              config,
              signal,
              navigationApproved,
              beforeEffect: beginEffect,
            }),
          (value) => value.outcome,
          journalEffect === 'read'
            ? undefined
            : async () => {
                verifiedPerception = await verifyBrowserStateObserved(
                  driver,
                  movesBrowserOnly(action),
                );
              },
          (value) => value.delivery,
        ),
      );
      // An action that actually ran clears the consecutive streak (but not the total): the agent found
      // something it is allowed to do, so it is no longer stuck against the same wall.
      consecutiveBlocks = 0;
      await appendSafe(memory, runId, step, raw.url, safeAction, outcome.outcome, now, log, (r) =>
        memoryDegraded('step', r),
      );

      if (outcome.terminal) {
        // A collected dataset is the ACTUAL result of a scrape. Appending it verbatim means a
        // hundred-row table is not squeezed through a 4,000-char summary the model has to re-type
        // from memory — which is where transcription errors and dropped pages came from.
        const summary = outcome.terminal.summary || outcome.outcome;
        return outcome.terminal.success
          ? await finish(
              'done',
              dataset.length ? `${summary}\n\n${renderDataset(dataset, datasetColumns)}` : summary,
            )
          : await finish('error', '', summary);
      }
      // A popup the page opened has silently become the working target; say so in the same breath as
      // the action's outcome, so the model knows which page it is now on.
      const adopted = driver.takeAdoptedPopup?.();
      // The per-step report the panel shows beside the rail dot. Same line the model receives as the
      // step's result, so what the user reads and what the model reasons from cannot diverge.
      emit({ type: 'step.outcome', ...base, step, text: outcome.outcome, ts: now() });
      history.push(
        `${step}. ${outcome.outcome}${adopted ? ` — the page opened a new tab (${redactUrl(adopted)}); you are now on it` : ''}`,
      );
      // Keep a bounded evidence ledger across pagination. Unlike one-shot read state, page-one values
      // remain available after clicking Next, while a hard total cap prevents runaway prompt growth.
      if (outcome.extracted) {
        const description = action.kind === 'extract' ? action.description : 'page text';
        readEvidence = appendExtractedEvidence(
          readEvidence,
          step,
          raw.url,
          description,
          outcome.extracted,
        );
      }
      if (outcome.collected) {
        if (outcome.collected.columns?.length) datasetColumns = outcome.collected.columns;
        let added = 0;
        for (const row of outcome.collected.rows) {
          if (dataset.length >= 5_000) break;
          // Dedupe on the whole row: re-visiting page 1 after paginating back is normal, and silently
          // doubling every row is worse than dropping a genuine duplicate.
          const key = JSON.stringify(row);
          if (datasetSeen.has(key)) continue;
          datasetSeen.add(key);
          dataset.push(row);
          added += 1;
          for (const column of Object.keys(row)) {
            if (!datasetColumns.includes(column)) datasetColumns.push(column);
          }
        }
        const skipped = outcome.collected.rows.length - added;
        history[history.length - 1] =
          `${step}. collected ${added} new row(s)${skipped > 0 ? `, ${skipped} duplicate(s) ignored` : ''} — ${dataset.length} total so far`;
      }
      // Only a read that produced something closes this view. An extract can legitimately fail — the
      // page was still loading, or its text renders in a cross-origin frame — and marking the view
      // extracted anyway refused the retry with "already extracted; use the existing result" when
      // there was no result, which is precisely the case the guard is supposed to allow through.
      if (action.kind === 'extract' && outcome.extracted) {
        lastExtractedView = observationFingerprint(raw);
      }
      if (outcome.image) pendingImage = outcome.image;

      // Catch redirects/popups/JS navigations that could not be predicted from an href. `browser_config`
      // is exempt: its only navigation is the UI-fallback jump to a vetted `chrome://settings` page
      // (already guarded and, being a non-http scheme, would otherwise trip the web-navigation policy).
      if (actionCapability(action.kind).mutating && action.kind !== 'browser_config') {
        const afterUrl = await safe(() => driver.currentUrl(), liveUrlBeforeAction);
        if (urlIdentity(afterUrl) !== urlIdentity(liveUrlBeforeAction)) {
          const trustedInternalMove =
            isVettedBrowserConfigUrl(liveUrlBeforeAction) && isVettedBrowserConfigUrl(afterUrl);
          const drift = trustedInternalMove
            ? { verdict: 'allow' as const, reason: 'vetted browser settings navigation' }
            : assessNavigationDrift(afterUrl, liveUrlBeforeAction, config);
          if (drift.verdict === 'deny') {
            const reconcileActionId = await proposeJournalAction(
              'navigation_reconcile',
              'write',
              journalHostOf(afterUrl),
            );
            await restoreNavigationJournaled(liveUrlBeforeAction, afterUrl, reconcileActionId);
            return await finish(
              'error',
              '',
              `Navigation policy blocked page drift: ${drift.reason}`,
            );
          }
          const priorApprovalCoversDrift =
            navigationApproved &&
            target !== undefined &&
            sameNavigationAuthority(target, afterUrl, liveUrlBeforeAction);
          if (drift.verdict === 'confirm' && !priorApprovalCoversDrift) {
            const stayActionId = await proposeJournalAction(
              'navigation_reconcile',
              'write',
              journalHostOf(afterUrl),
            );
            let approved = false;
            try {
              approved = await confirmJournaled(
                `The page opened ${redactUrl(afterUrl)}. Approve staying there? (${drift.reason})`,
                { kind: 'navigate', url: redactUrl(afterUrl) },
                stayActionId,
              );
            } catch (error) {
              await restoreNavigationJournaled(liveUrlBeforeAction, afterUrl, stayActionId);
              throw error;
            }
            if (!approved) {
              await restoreNavigationJournaled(liveUrlBeforeAction, afterUrl, stayActionId);
              history.push(`${step}. user rejected unexpected navigation; went back`);
            } else {
              // A stay approval is scoped to the destination authority the human saw. Redirecting to a
              // different host while the prompt is open must not turn that answer into a reusable
              // cross-domain permission, and the new destination still has to satisfy hard fences.
              const afterConfirmation = await safe(() => driver.currentUrl(), '');
              const finalDecision = assessNavigation(
                afterConfirmation,
                liveUrlBeforeAction,
                config,
              );
              if (
                !sameNavigationAuthority(afterUrl, afterConfirmation, liveUrlBeforeAction) ||
                finalDecision.verdict === 'deny'
              ) {
                await restoreNavigationJournaled(liveUrlBeforeAction, afterUrl, stayActionId);
                const reason =
                  finalDecision.verdict === 'deny'
                    ? finalDecision.reason
                    : 'the destination changed to a different site while confirmation was pending';
                noteBlocked(reason);
                history.push(
                  `${step}. unexpected navigation approval expired: ${reason}; went back`,
                );
              } else {
                await appendJournal({
                  type: 'action.cancelled',
                  actionId: stayActionId,
                  summary: 'The user approved the observed destination',
                });
              }
            }
          }
        }
      }

      // Reuse the verified observation only while it still describes the live page. Everything above
      // this point that could have moved the browser — a rollback, an approved drift, a popup the
      // driver adopted — invalidates it, and a stale element list is worse than a second read.
      if (verifiedPerception) {
        const live = await safe(() => driver.currentUrl(), '');
        const identity = verifiedPerception.urlIdentity ?? urlIdentity(verifiedPerception.url);
        if (live && urlIdentity(live) === identity) carriedPerception = verifiedPerception;
      }
    }
    return await finish('stopped', `Reached the ${config.maxSteps}-step budget without finishing.`);
  } catch (error) {
    if (
      journalSnapshot?.state.phase === 'dispatching' ||
      journalSnapshot?.state.phase === 'recovery_required'
    ) {
      // A dispatch crossed the durable boundary but has no provably clean outcome. Do not append a
      // terminal marker over it. The manager may still report a live error event, while admission of
      // the next run remains blocked on this authenticated recovery-required record.
      throw error;
    }
    if (signal.aborted) return await finish('stopped', 'Stopped by user.');
    return await finish('error', '', safeError(error));
  }
}

async function handleAsk(
  action: Extract<AgentAction, { kind: 'ask' }>,
  raw: RawPerception,
  approvedImage: string | undefined,
  step: number,
  runId: string,
  history: string[],
  base: { sessionId: string; profileId: string },
  deps: AgentRunDeps,
  memory: MemoryStore,
  now: () => string,
  beforeEffect: () => Promise<void>,
  requestApproval: (prompt: string, action: AgentAction) => Promise<boolean>,
  onReply: (text: string) => void,
): Promise<{ ok: boolean; outcome: string }> {
  const safeQuestion = redactCredentialLikeText(action.question).text;
  deps.emit({
    type: 'run.needsInput',
    ...base,
    kind: 'ask',
    prompt: safeQuestion,
    ...(action.sensitive !== undefined ? { sensitive: action.sensitive } : {}),
    ts: now(),
  });
  const answer = await deps.waitForInput(safeQuestion, 'ask', redactAction(action));
  if (action.sensitive && action.targetId !== undefined) {
    // Supplying the sensitive reply is the human's authorization for this exact handoff. Bind it to
    // the same page/target just like a confirm verdict; otherwise a login field can be replaced while
    // the human is retrieving an OTP and receive a secret intended for the old observation.
    const directAction: AgentAction = {
      kind: 'type',
      id: action.targetId,
      text: answer,
      clear: true,
    };
    const afterInput = await perceive(deps.driver);
    if (
      approvalContextFingerprint(directAction, raw) !==
      approvalContextFingerprint(directAction, afterInput)
    ) {
      return {
        ok: false,
        outcome:
          'blocked: the sensitive target changed while human input was pending; inspect the fresh page and ask again',
      };
    }
    const element = afterInput.elements.find((item) => item.index === action.targetId);
    if (!element)
      return { ok: false, outcome: `sensitive target [${action.targetId}] is no longer available` };
    if (!isSensitiveElement(element)) {
      return {
        ok: false,
        outcome: `refused sensitive handoff to non-sensitive field [${action.targetId}]`,
      };
    }
    const direct = await executeAction(directAction, afterInput, deps.driver, {
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      signal: deps.signal,
      beforeEffect,
    });
    const safeAction: AgentAction = {
      kind: 'type',
      id: action.targetId,
      text: '[REDACTED]',
      clear: true,
    };
    await appendSafe(memory, runId, step, raw.url, safeAction, direct.outcome, now, () => {});
    history.push(`${step}. human securely supplied sensitive input to [${action.targetId}]`);
    return { ok: true, outcome: direct.outcome };
  }
  if (action.sensitive && action.targetX !== undefined && action.targetY !== undefined) {
    const directAction: AgentAction = {
      kind: 'type_at',
      x: action.targetX,
      y: action.targetY,
      text: answer,
      clear: true,
    };
    const afterInput = await perceive(deps.driver);
    if (
      approvalContextFingerprint(directAction, raw) !==
      approvalContextFingerprint(directAction, afterInput)
    ) {
      return {
        ok: false,
        outcome:
          'blocked: the page changed while sensitive coordinate input was pending; capture a fresh screenshot and ask again',
      };
    }
    // The coordinate channel exists for surfaces DOM perception cannot see — a canvas widget, a
    // cross-origin payment frame — so an unperceived point is expected and the human approval above
    // is what authorizes it. A point perception CAN see is different: if it resolves to an ordinary
    // control, the secret would be typed somewhere page script can read it, and the `targetId`
    // branch would have refused the very same handoff.
    const atPoint = elementAtPoint(afterInput, action.targetX, action.targetY);
    if (atPoint && !isSensitiveElement(atPoint)) {
      return {
        ok: false,
        outcome: `refused sensitive handoff to ${atPoint.role} ${JSON.stringify(atPoint.name)} at the requested coordinate; it is not a secret-bearing field`,
      };
    }
    // The first thing `type_at` does is CLICK the model's pixel, and nobody — not the policy, not
    // the harness — can see what handler sits under it. A separate human approval used to bind here;
    // under full autonomy the human's ANSWER is the authorization: they just supplied the secret for
    // exactly this handoff, and `requestApproval` (→ `confirmJournaled`) now records the coordinate
    // activation in the journal and transcript without pausing on a second question. What still
    // gates is physics, not permission: a canvas/frame can change without affecting DOM perception,
    // so the target's pixels are sampled here and re-sampled just before dispatch — a moved target
    // refuses the handoff rather than typing a secret into whatever replaced it.
    const approvedTargetPatch = await visualTargetPatch(deps.driver, directAction);
    await requestApproval(
      `Type the value the human just supplied at visual coordinate (${action.targetX}, ${action.targetY}) on ${redactUrl(afterInput.url)}. Anything under that point is clicked first.`,
      directAction,
    );
    if (
      !approvedImage ||
      !(await visualTargetHeld(deps.driver, directAction, approvedTargetPatch))
    ) {
      return {
        ok: false,
        outcome:
          'blocked: the visual page changed while sensitive coordinate input was pending; capture a fresh screenshot and ask again',
      };
    }
    const direct = await executeAction(directAction, afterInput, deps.driver, {
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      signal: deps.signal,
      beforeEffect,
    });
    const safeAction = redactAction(directAction, raw);
    await appendSafe(memory, runId, step, raw.url, safeAction, direct.outcome, now, () => {});
    history.push(
      `${step}. human securely supplied sensitive input at the requested visual coordinate`,
    );
    return { ok: true, outcome: direct.outcome };
  }
  const safeAnswer = redactCredentialLikeText(answer).text;
  history.push(
    action.sensitive
      ? `${step}. human completed the sensitive handoff (reply withheld)`
      : `${step}. human replied to ${JSON.stringify(clip(safeQuestion, 100))}: ${JSON.stringify(clip(safeAnswer, 120))}`,
  );
  // The answer itself reaches the model in full, as a trusted user turn — not as a 120-character
  // clip inside a fence the model is told never to obey, which is how a reply used to arrive.
  if (!action.sensitive && safeAnswer.trim()) {
    onReply(
      `In answer to your question ${JSON.stringify(clip(safeQuestion, 200))}: ${safeAnswer.trim()}`,
    );
  }
  return { ok: true, outcome: 'human input received' };
}

async function appendSafe(
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

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function journalHostOf(url: string): string | undefined {
  const host = hostOf(url).replace(/\.$/, '');
  // IPv6 literals contain colons and are intentionally omitted: the schema's optional host field is
  // a DNS/IPv4 correlation hint, never an authority parser or an execution target.
  return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ? host : undefined;
}

/**
 * The perceived control containing a visual coordinate, if perception can see one there.
 *
 * Perception measures each element's centre plus its width and height, so containment is decidable
 * without going back to the page — which matters here, because this is asked immediately before a
 * secret is typed and a fresh round trip would only widen the window it is guarding. An unperceived
 * point is a real answer, not a failure: canvas widgets and cross-origin frames are exactly why the
 * coordinate channel exists.
 */
function elementAtPoint(raw: RawPerception, x: number, y: number): PerceivedElement | undefined {
  return raw.elements.find(
    (element) =>
      x >= element.x - element.w / 2 &&
      x <= element.x + element.w / 2 &&
      y >= element.y - element.h / 2 &&
      y <= element.y + element.h / 2,
  );
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * How many times a still-moving page is re-observed before its state is called ambiguous.
 *
 * The two reads this compares — perception's URL and the follow-up `currentUrl()` — are separate
 * round trips, so anything that rewrites the location between them looks like drift: a deferred
 * redirect, an SPA route change, or an analytics/consent script calling `history.replaceState` to
 * strip a `?utm_source=`. None of those means an effect was lost, but a single-shot comparison
 * reported them as "delivery completed, post-state ambiguous" — which is not merely a failed run.
 * It leaves the journal `recovery_required`, and admission then refuses EVERY later run on that
 * profile, permanently, over a query string. Re-observing distinguishes the two: a page that has
 * settled agrees with itself, and a page still turning over after this many attempts genuinely
 * cannot testify about what just happened.
 */
const POST_ACTION_SETTLE_ATTEMPTS = 3;

/**
 * Does this action's effect stop at "which document the browser is showing"?
 *
 * The distinction decides what an unreadable page after the action MEANS. A click, a keystroke, an
 * upload or a durable memory write can commit something the browser cannot take back, so being
 * unable to re-read the page genuinely leaves it unknown whether that happened, and the run must
 * block rather than guess. Moving the browser is not like that: it commits nothing outside the
 * browser and repeating it is idempotent, so an unreadable destination is a fact ABOUT THE PAGE, to
 * be reported to the model, not an unresolved external effect.
 *
 * Treating them alike had a disproportionate cost. A page that calls `alert()` blocks its renderer,
 * so nothing on it can be read — and navigating to one therefore ended the run as an ambiguous
 * write, left the journal `recovery_required`, and refused admission for every later run on that
 * profile. One ordinary `alert()` on one site permanently disabled the agent for that profile, with
 * no supported way to clear it.
 */
function movesBrowserOnly(action: AgentAction): boolean {
  return action.kind === 'navigate' || action.kind === 'back' || action.kind === 'tab';
}

/**
 * Confirm the page can testify about what just happened — and hand back the observation it used, so
 * the next step reads the page it already read instead of extracting the whole DOM again.
 */
async function verifyBrowserStateObserved(
  driver: BrowserDriver,
  browserMoveOnly = false,
): Promise<RawPerception | undefined> {
  for (let attempt = 1; ; attempt += 1) {
    const observed = await perceive(driver);
    if (observed.signals?.includes('page-unreadable') && !browserMoveOnly) {
      throw new Error('the post-action page could not be read');
    }
    if (observed.signals?.includes('page-unreadable')) {
      // The move itself is not in doubt, and the next step's own observation carries the reason the
      // page cannot be read — a blocking dialog, a hostile CSP — so the model can hand off or leave.
      return undefined;
    }
    if (driver.ready && !driver.ready()) {
      throw new Error('the browser detached before post-action verification');
    }
    const liveUrl = await driver.currentUrl();
    if (urlIdentity(liveUrl) === (observed.urlIdentity ?? urlIdentity(observed.url))) {
      return observed;
    }
    if (attempt >= POST_ACTION_SETTLE_ATTEMPTS) {
      throw new Error('the page changed during post-action verification');
    }
    // Let the navigation finish rather than sampling it again immediately; a failure to settle is
    // itself part of the evidence that the state is not observable.
    await driver.waitForSettle(3000).catch(() => {});
  }
}

/**
 * Side of the square of pixels around a coordinate gesture that must survive an approval unchanged.
 *
 * The check used to demand two byte-identical FULL-PAGE screenshots taken either side of a human
 * reading a modal. Any caret blink, spinner, lazy image, video frame, or CSS transition anywhere on
 * the page changed those bytes, so the documented escape hatch for canvas widgets, captchas and
 * cross-origin payment frames could essentially never run: the agent burned a screenshot, an
 * approval and a block, then reported failure. Bounding the comparison to the neighbourhood of the
 * click keeps the property that actually matters — the thing under the cursor is still the thing
 * that was approved — and stops unrelated motion from vetoing it.
 */
const VISUAL_TARGET_PATCH_PX = 160;

/** How many times a patch is re-sampled before the target counts as changed. */
const VISUAL_TARGET_SAMPLES = 3;

function visualTargetPatch(
  driver: BrowserDriver,
  action: AgentAction,
): Promise<string | undefined> {
  if ((action.kind !== 'click_at' && action.kind !== 'type_at') || !driver.screenshot) {
    return Promise.resolve(undefined);
  }
  const half = Math.round(VISUAL_TARGET_PATCH_PX / 2);
  return driver
    .screenshot({
      x: Math.max(0, Math.round(action.x) - half),
      y: Math.max(0, Math.round(action.y) - half),
      width: VISUAL_TARGET_PATCH_PX,
      height: VISUAL_TARGET_PATCH_PX,
    })
    .catch(() => undefined);
}

/**
 * Is the approved coordinate's neighbourhood still the one that was approved?
 *
 * Re-sampled a few times because a patch can legitimately differ for one frame — a caret in a field
 * the gesture is about to focus, a hover transition finishing — without the target having moved. A
 * missing capture is a refusal, not a pass: an unverifiable coordinate gesture is exactly the case
 * this gate exists for.
 */
async function visualTargetHeld(
  driver: BrowserDriver,
  action: AgentAction,
  approved: string | undefined,
): Promise<boolean> {
  if (!approved) return false;
  for (let sample = 0; sample < VISUAL_TARGET_SAMPLES; sample += 1) {
    const fresh = await visualTargetPatch(driver, action);
    if (fresh && fresh === approved) return true;
  }
  return false;
}

async function rollbackNavigation(driver: BrowserDriver, priorUrl: string): Promise<void> {
  try {
    await driver.goBack();
    await driver.waitForSettle(3000);
    if (urlIdentity(await driver.currentUrl()) === urlIdentity(priorUrl)) return;
  } catch {
    // A popup/new tab has no back entry; close the active extra tab instead.
  }
  try {
    const tabs = await driver.listTabs();
    const active = tabs.find((tab) => tab.active);
    if (active && tabs.length > 1) {
      await driver.closeTab(active.index);
      await driver.waitForSettle(3000);
      if (urlIdentity(await driver.currentUrl()) === urlIdentity(priorUrl)) return;
    }
  } catch {
    // Last resort below.
  }
  await driver.navigate(priorUrl);
  await driver.waitForSettle(3000);
  if (urlIdentity(await driver.currentUrl()) !== urlIdentity(priorUrl)) {
    throw new Error('could not verify restoration of the prior page');
  }
}
