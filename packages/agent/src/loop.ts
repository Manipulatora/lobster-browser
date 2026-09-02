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
import type { Sleep } from './executor.js';
import type { LlmClient, LlmResult } from './llm/index.js';
import { usesAutomaticToolChoice } from './llm/index.js';
import type { LlmMessage, LlmTool } from './llm/types.js';
import { normalizeMessages } from './llm/types.js';
import {
  budgetedMaxTokens,
  createStepRequestBuilder,
  recoverFromContextOverflow,
  tokenBudgetExceeded,
} from './loop/decide.js';
import { handleAsk, restoreNavigationJournaled } from './loop/execute.js';
import type { DispatchContext } from './loop/execute.js';
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
  firstLine,
  observationFingerprint,
  pruneObservations,
  renderDataset,
  runLedger,
} from './loop/observe.js';
import type { RunJournalStore } from './journal/index.js';
import {
  addUsage,
  appendSafe,
  askJournalEffect,
  createRunJournal,
  createRunLog,
  createStepTimer,
  hostOf,
  instrumentDriver,
  journalEffectOf,
  journalHostOf,
  safe,
  safeError,
} from './loop/record.js';
import {
  movesBrowserOnly,
  verifyBrowserStateObserved,
  visualTargetHeld,
  visualTargetPatch,
} from './loop/verify.js';
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
  redactAction,
  redactRawActionInput,
  redactUrl,
  urlIdentity,
} from './security.js';
import { redactCredentialLikeText } from './sensitive-text.js';
import type { RawPerception } from './types.js';

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

export async function runAgent(params: AgentRunParams, deps: AgentRunDeps): Promise<void> {
  const { sessionId, profileId, task, runId, llmConfig, config } = params;
  const { llm, memory, emit, signal, now } = deps;
  const usage: AgentUsage = { tokensIn: 0, tokensOut: 0 };
  const sendsEffort =
    llmConfig.effort !== undefined &&
    (llm.sendsEffort?.(llmConfig.stepModel || llmConfig.model, llmConfig.effort) ?? false);
  const history: string[] = [];
  const base = { sessionId, profileId };
  const { log, memoryDegraded } = createRunLog({ emit, base, now });
  const timer = createStepTimer({ now, emit, base, log });
  const { timed, timedExecute } = timer;
  const driver = instrumentDriver(deps.driver, timed);
  /** The per-step memory record, best-effort: a failure lands on the memory channel, never in the step. */
  const recordStep = (
    step: number,
    url: string,
    action: AgentAction,
    outcome: string,
  ): Promise<void> =>
    appendSafe(memory, runId, step, url, action, outcome, now, log, (reason) =>
      memoryDegraded('step', reason),
    );
  const safeTask = redactCredentialLikeText(task);
  let memoryStarted = false;

  // The journal is a safety dependency, unlike recall memory. Create it before emitting lifecycle
  // events, consulting the model, opening a URL, or touching durable profile state. A production
  // storage failure therefore rejects the run before it can do work.
  const journal = createRunJournal({
    journal: deps.journal,
    runId,
    snapshot: deps.journal
      ? await deps.journal.create({
          runId,
          // Tasks can contain credentials or private business data. Recovery needs lifecycle/effect
          // state, not a second copy of the prompt, so persist a deliberately content-free label.
          task: 'Agent task',
          mode: config.mode ?? 'agent',
        })
      : undefined,
    timed,
    log,
  });
  /** The run-scoped services the dispatch helpers act through. */
  const ctx: DispatchContext = {
    driver,
    config,
    signal,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    journal,
    timer,
    log,
  };

  const finish = async (
    status: 'done' | 'error' | 'stopped',
    result: string,
    error?: string,
  ): Promise<void> => {
    // The step that ended the run is over too; its timing goes out before the terminal event.
    timer.flush();
    // Terminal text is model-/page-derived and crosses the UI plus thread-memory boundaries. A model
    // echoing a token it saw must not turn `run.finished` into a credential exfiltration event.
    const safeResult = redactCredentialLikeText(result).text;
    const safeFinishError = error === undefined ? undefined : redactCredentialLikeText(error).text;
    await journal.append({
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
    if (deps.journal?.removeFinished && journal.snapshot) {
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
      addUsage(usage, result.usage);
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
        const actionId = await journal.propose('navigate', 'write', journalHostOf(destination));
        if (decision.verdict === 'confirm') {
          const safeDestination = redactUrl(destination);
          const approved = await journal.confirm(
            `Approve opening ${safeDestination}? (${decision.reason})`,
            { kind: 'navigate', url: safeDestination },
            actionId,
          );
          if (!approved) return await finish('stopped', 'The start navigation was rejected.');
        }
        const liveCurrent = await safe(() => driver.currentUrl(), '');
        if (liveCurrent !== current) {
          await journal.append({
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
          await journal.append({
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
      await journal.dispatch(
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
    const overflow = { retried: false };
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
      timer.begin(step);
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
        await journal.markSensitive('image_payload');
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
      const buildRequest = createStepRequestBuilder({
        llmConfig,
        step,
        recovery,
        system,
        messages: requestMessages,
        tools,
        maxTokens: requestMaxTokens,
        runId,
        profileId,
        signal,
        log,
        onProgress: (kind, chars) =>
          emit({ type: 'step.progress', ...base, step, kind, chars, ts: now() }),
      });
      let result: LlmResult;
      try {
        result = await timed('llm', () => llm.complete(buildRequest()));
      } catch (error) {
        result = await recoverFromContextOverflow(error, {
          llm,
          buildRequest,
          timed,
          requestMaxTokens,
          stepMessages,
          overflow,
          log,
        });
      }
      recovery = false;
      addUsage(usage, result.usage);
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
        await recordStep(step, raw.url, safeAction, outcome);
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
        await recordStep(step, raw.url, safeAction, outcome);
        continue;
      }

      if (action.kind === 'ask') {
        if (action.sensitive) await journal.markSensitive('credential');
        const askEffect = askJournalEffect(action);
        const actionId = await journal.propose(action.kind, askEffect, journalHostOf(raw.url));
        const handled = await journal.dispatch(
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
              (prompt, pending) => journal.confirm(prompt, pending, actionId),
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
      if (action.kind === 'screenshot') await journal.markSensitive('image_payload');

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
        await recordStep(step, raw.url, safeAction, outcome);
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
          await recordStep(step, raw.url, safeAction, outcome);
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
          await recordStep(step, raw.url, safeAction, outcome);
          continue;
        }
      }

      // Upload paths and visual payloads must never be eligible for automatic restart. This marker is
      // fsynced before approval or execution and contains no path/image data.
      if (action.kind === 'upload') await journal.markSensitive('upload_path');
      const journalEffect = journalEffectOf(action, risk);
      const journalActionId = await journal.propose(
        action.kind,
        journalEffect,
        journalHostOf(raw.url),
      );

      if (navigationDecision?.verdict === 'confirm') {
        navigationApproved = await journal.confirm(
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
        await journal.confirm(prompt, safeAction, journalActionId);
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
          await recordStep(step, raw.url, safeAction, outcome);
          await journal.append({
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
            await recordStep(step, raw.url, safeAction, outcome);
            await journal.append({
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
        journal.dispatch(
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
      await recordStep(step, raw.url, safeAction, outcome.outcome);

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
            const reconcileActionId = await journal.propose(
              'navigation_reconcile',
              'write',
              journalHostOf(afterUrl),
            );
            await restoreNavigationJournaled(ctx, liveUrlBeforeAction, afterUrl, reconcileActionId);
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
            const stayActionId = await journal.propose(
              'navigation_reconcile',
              'write',
              journalHostOf(afterUrl),
            );
            let approved = false;
            try {
              approved = await journal.confirm(
                `The page opened ${redactUrl(afterUrl)}. Approve staying there? (${drift.reason})`,
                { kind: 'navigate', url: redactUrl(afterUrl) },
                stayActionId,
              );
            } catch (error) {
              await restoreNavigationJournaled(ctx, liveUrlBeforeAction, afterUrl, stayActionId);
              throw error;
            }
            if (!approved) {
              await restoreNavigationJournaled(ctx, liveUrlBeforeAction, afterUrl, stayActionId);
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
                await restoreNavigationJournaled(ctx, liveUrlBeforeAction, afterUrl, stayActionId);
                const reason =
                  finalDecision.verdict === 'deny'
                    ? finalDecision.reason
                    : 'the destination changed to a different site while confirmation was pending';
                noteBlocked(reason);
                history.push(
                  `${step}. unexpected navigation approval expired: ${reason}; went back`,
                );
              } else {
                await journal.append({
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
      journal.snapshot?.state.phase === 'dispatching' ||
      journal.snapshot?.state.phase === 'recovery_required'
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
