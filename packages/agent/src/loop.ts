import { Buffer } from 'node:buffer';
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
import type { LlmClient } from './llm/index.js';
import { usesAutomaticToolChoice } from './llm/index.js';
import type { LlmMessage, LlmTool } from './llm/types.js';
import { normalizeMessages } from './llm/types.js';
import type {
  AppendRunJournalEventV1,
  JournalActionEffect,
  RunJournalSnapshot,
} from './journal/index.js';
import type { RunJournalStore } from './journal/index.js';
import type { MemoryStore, ThreadMessage } from './memory/index.js';
import {
  actionCommitIntent,
  actionRisk,
  assessCurrentPage,
  assessNavigation,
  assessNavigationDrift,
  normalizeAllowedDomains,
  targetUrlForAction,
} from './policy.js';
import type { PolicyDecision } from './policy.js';
import { perceive } from './perception/perceive.js';
import { renderObservation, sameElements } from './perception/serialize.js';
import {
  buildAskPrompt,
  buildStepPrompt,
  buildSystemPrompt,
  EVIDENCE_PREAMBLE,
  SITE_MEMORY_PREAMBLE,
  VERBATIM_OBSERVATIONS,
} from './prompt.js';
import {
  describeSafeAction,
  isSensitiveElement,
  redactAction,
  redactRawActionInput,
  redactUrl,
  urlIdentity,
} from './security.js';
import { redactCredentialLikeText } from './sensitive-text.js';
import { normalizeSkillHost } from './skills.js';
import type { PerceivedElement, RawPerception } from './types.js';

export interface AgentRunDeps {
  driver: BrowserDriver;
  llm: LlmClient;
  memory: MemoryStore;
  emit: (event: AgentEvent) => void;
  waitForInput: (prompt: string, kind: 'ask' | 'confirm', action?: AgentAction) => Promise<string>;
  signal: AbortSignal;
  now: () => string;
  sleep?: Sleep;
  /**
   * Durable safety journal. Optional only so focused loop tests and embedders can use an in-memory
   * harness; the production manager always supplies the encrypted per-profile implementation.
   */
  journal?: Pick<RunJournalStore, 'create' | 'append'>;
}

export interface AgentRunParams {
  sessionId: string;
  profileId: string;
  task: string;
  runId: string;
  /**
   * The conversation this run belongs to. Prior turns are loaded from it and this run's exchange is
   * appended when it finishes, which is what makes "remember what I just asked" work. Omit for a
   * one-off run with no conversational context.
   */
  threadId?: string;
  llmConfig: AgentLlmConfig;
  config: AgentConfig;
}

/**
 * A response smaller than this is not a useful budget for either a chat answer or a structured agent
 * action. Stopping before the request is safer than asking a provider for a handful of tokens, paying
 * for the full prompt, and receiving a truncated/non-executable result.
 */
const MIN_USEFUL_OUTPUT_TOKENS = 256;

export function resolveConfig(partial: Partial<AgentConfig> | undefined): AgentConfig {
  const maxSteps = boundedInteger(partial?.maxSteps, 40, 1, 200, 'maxSteps');
  const tokenBudget =
    partial?.tokenBudget === undefined
      ? undefined
      : boundedInteger(partial.tokenBudget, 0, 1_000, 10_000_000, 'tokenBudget');
  const mode = partial?.mode ?? 'agent';
  if (mode !== 'ask' && mode !== 'agent') throw new Error('mode must be ask or agent');
  const autonomy = partial?.autonomy ?? 'auto';
  if (autonomy !== 'auto' && autonomy !== 'confirm')
    throw new Error('autonomy must be auto or confirm');
  // Autonomy controls approval for ordinary mutations. Consequential/commit actions are still gated
  // in every mode. Cross-domain navigation defaults to allow in `auto`; `confirm` gates it.
  const crossDomainNavigation =
    partial?.crossDomainNavigation ?? (autonomy === 'auto' ? 'allow' : 'confirm');
  if (!['allow', 'confirm', 'deny'].includes(crossDomainNavigation)) {
    throw new Error('crossDomainNavigation must be allow, confirm, or deny');
  }
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
  const { sessionId, profileId, task, runId, threadId, llmConfig, config } = params;
  const { driver, llm, memory, emit, signal, now } = deps;
  const usage: AgentUsage = { tokensIn: 0, tokensOut: 0 };
  const history: string[] = [];
  const base = { sessionId, profileId };
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
    if (!deps.journal || !journalSnapshot) return;
    journalSnapshot = await deps.journal.append(runId, event, journalSnapshot.journal.revision);
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
  const confirmJournaled = async (
    prompt: string,
    action: AgentAction,
    actionId: string,
  ): Promise<boolean> => {
    await appendJournal({ type: 'approval.requested', actionId });
    let approved = false;
    try {
      approved = await confirm(prompt, action, base, deps);
    } catch (error) {
      // Timeout/abort is rejection, never an unresolved approval that a terminal marker may silently
      // erase. Callers that already have browser drift can now journal and verify their rollback.
      await appendJournal({ type: 'approval.resolved', actionId, decision: 'rejected' });
      throw error;
    }
    await appendJournal({
      type: 'approval.resolved',
      actionId,
      decision: approved ? 'approved' : 'rejected',
    });
    return approved;
  };
  const dispatchJournaled = async <T>(
    actionId: string,
    effect: JournalActionEffect,
    operation: (beginEffect: () => Promise<void>) => Promise<T>,
    outcomeOf: (value: T) => string,
    verifyAfterEffect?: (value: T) => Promise<void>,
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
      // a click). A returned error therefore does not prove a write was absent. Preserve that ambiguity
      // and stop; a later run must never hide or replay the possible side effect.
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
  const finish = async (
    status: 'done' | 'error' | 'stopped',
    result: string,
    error?: string,
  ): Promise<void> => {
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
    // Record the exchange in its thread REGARDLESS of outcome. A failed or stopped attempt is exactly
    // what the next message ("try that again, but…") refers to; excluding it was why follow-ups landed
    // with no idea what had just been attempted.
    if (threadId) {
      try {
        await memory.appendThreadTurn(threadId, {
          user: safeTask.text,
          assistant: safeResult || safeFinishError || '',
          status,
        });
      } catch (threadError) {
        log('warn', `Could not append the conversation turn: ${safeError(threadError)}`);
        memoryDegraded('thread', safeError(threadError));
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

  // Prior turns of THIS conversation, as real messages. Scoped to the thread, so an unrelated task on
  // the same profile can no longer bleed into this one.
  let priorTurns: LlmMessage[] = [];
  if (threadId) {
    try {
      priorTurns = capPriorTurns(threadToMessages(await memory.loadThread(threadId)));
    } catch (error) {
      priorTurns = []; // recall unavailable this turn — proceed with none
      log('warn', `Could not load encrypted conversation history: ${safeError(error)}`);
      memoryDegraded('thread', safeError(error));
    }
  }

  // ASK mode: a single chat completion, no browser and no tools — the model answers from its own
  // knowledge in Markdown. The browser never opens (the lazy driver is never touched).
  if (config.mode === 'ask') {
    try {
      const system = buildAskPrompt();
      const messages = normalizeMessages([...priorTurns, { role: 'user' as const, content: task }]);
      const tools: LlmTool[] = [];
      const desiredMaxTokens = llmConfig.effort ? 8000 : 2048;
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
        () => verifyBrowserStateObserved(driver),
      );
    }

    // Skills are task-scoped and stable, so they stay in the cacheable system prefix. Site facts are
    // loaded separately after each navigation and remain user-level untrusted data.
    let memoryContext = '';
    try {
      memoryContext = await memory.loadContext(undefined, task);
    } catch (error) {
      // Recall is advisory. A rotated key, corrupt legacy record, or unavailable disk must not gain the
      // authority to stop an otherwise safe browser run.
      log('warn', `Could not load encrypted profile memory: ${safeError(error)}`);
      memoryDegraded('run', safeError(error));
    }
    const system = buildSystemPrompt({
      task,
      config,
      memoryContext,
      toolChoiceIsAdvisory: usesAutomaticToolChoice(llmConfig.provider, llmConfig.model),
    });
    let previous: RawPerception | null = null;
    /** This run's assistant/tool exchange, appended to the thread's prior turns each step. */
    const stepMessages: LlmMessage[] = [];
    /** The call id the NEXT observation answers, so the pairing providers require stays intact. */
    let lastToolCallId: string | undefined;
    let readEvidence: string[] = [];
    /** Rows the run has collected, in order, deduplicated by their full content. */
    const dataset: Array<Record<string, string>> = [];
    const datasetSeen = new Set<string>();
    let datasetColumns: string[] = [];
    let siteMemoryHost = '';
    let siteMemoryContext = '';
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

    for (let step = 1; step <= config.maxSteps; step += 1) {
      if (signal.aborted) return await finish('stopped', 'Stopped by user.');
      // Stop honestly rather than spending the remaining budget re-issuing refused actions. The user
      // gets a real reason instead of a run that quietly hit its step limit having done nothing.
      if (totalBlocks >= 10) {
        return await finish(
          'stopped',
          `Stopped after ${totalBlocks} actions were refused by the harness. The last reason was: ${lastBlockReason}`,
        );
      }

      const raw = await perceive(driver);
      const currentPageDecision = assessCurrentPage(raw.url, config);
      if (currentPageDecision.verdict === 'deny') {
        return await finish(
          'error',
          '',
          `Current page blocked by run policy: ${currentPageDecision.reason}`,
        );
      }
      const currentHost = hostOf(raw.url);
      if (currentHost !== siteMemoryHost) {
        siteMemoryHost = currentHost;
        if (!currentHost) {
          siteMemoryContext = '';
        } else {
          try {
            siteMemoryContext = await memory.loadContext(currentHost, '');
          } catch (error) {
            siteMemoryContext = '';
            log('warn', `Could not load encrypted site memory: ${safeError(error)}`);
            memoryDegraded('step', safeError(error));
          }
        }
      }
      const rendered =
        previous && sameElements(previous, raw)
          ? `url: ${raw.url} | ${JSON.stringify(raw.title)}\n(interactive elements unchanged from the previous step)`
          : renderObservation(raw);
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
      const stepText = buildStepPrompt({
        history: nudges,
        observation: rendered,
        step,
        url: raw.url,
        // Every path that ends a step appends its outcome here, so the newest entry is precisely what
        // the tool result should report.
        ...(history.length ? { outcome: history[history.length - 1]! } : {}),
        ...(readEvidence.length ? { readState: readEvidence.join('\n\n') } : {}),
        ...(siteMemoryContext ? { siteMemoryContext } : {}),
      });
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
      // Reasoning effort consumes from `max_tokens` (OpenRouter converts effort→thinking budget for
      // Anthropic, up to ~0.8×max_tokens at High), so raise the cap when effort is on to leave room for
      // the forced action call; otherwise the tiny tool-call output only needs ~1024.
      const desiredMaxTokens = llmConfig.effort ? 8000 : 1024;
      const conversation = normalizeMessages([...priorTurns, ...pruneObservations(stepMessages)]);
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
        ...(llmConfig.effort ? { effort: llmConfig.effort } : {}),
        // A silent retry is indistinguishable from a hang: three BYOK attempts plus backoff is minutes
        // of a panel showing only "thinking", which invites killing a run that was recovering fine.
        onRetry: ({ attempt, attempts, delayMs, reason }) =>
          log(
            'warn',
            `The model provider did not respond (${reason}). Retrying in ${Math.round(delayMs / 1000)}s — attempt ${attempt} of ${attempts}.`,
          ),
        signal,
      });
      // A context-window 400 used to end the run outright: it is not in `retryableStatus`, so it
      // propagated straight to the catch that calls `finish('error')`. Recover in the cheapest order —
      // ask for fewer OUTPUT tokens first (the whole conversation survives), and only then start
      // dropping history. `normalizeMessages` already repairs an arbitrarily head-dropped list, so the
      // dangerous part of the second tier is already built.
      let result: Awaited<ReturnType<typeof llm.complete>>;
      try {
        result = await llm.complete(buildRequest());
      } catch (error) {
        const headroom = contextOverflowHeadroom(error);
        if (headroom === null || oversizeRetried) throw error;
        oversizeRetried = true;
        // Only take the cheap path when it actually CHANGES the request. A headroom at or above the
        // current cap would re-send an identical body and burn a call to get the same 400.
        if (headroom >= 512 && headroom < requestMaxTokens) {
          log('warn', `Context limit reached; retrying this step with a smaller output budget.`);
          result = await llm.complete(buildRequest({ maxTokens: headroom }));
        } else {
          log('warn', 'Context limit reached; retrying this step with the conversation trimmed.');
          priorTurns = [];
          result = await llm.complete(
            buildRequest({
              messages: normalizeMessages(pruneObservations(stepMessages).slice(-4)),
              maxTokens: Math.min(requestMaxTokens, 1024),
            }),
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
      const action = parsed.action;
      const safeAction = redactAction(action, raw);
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
              deps,
              memory,
              now,
              beginEffect,
              (prompt, pending) => confirmJournaled(prompt, pending, actionId),
            ),
          (value) => value.outcome,
          askEffect === 'read' ? undefined : () => verifyBrowserStateObserved(driver),
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

      // FileMemoryStore rejects these before reading/writing its document. Mirror that deterministic
      // validation before proposing/dispatching so a known non-applied validation failure cannot be
      // mistaken for an ambiguous durable write in the recovery journal.
      if (memoryActionContainsCredential(action)) {
        const outcome = `blocked: credentials must not be saved through ${action.kind}`;
        noteBlocked('credentials must not be saved to durable agent memory');
        history.push(`${step}. ${outcome}`);
        await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log, (reason) =>
          memoryDegraded('step', reason),
        );
        continue;
      }
      const durableMemoryDomain =
        action.kind === 'remember' || action.kind === 'learn'
          ? normalizeSkillHost(hostOf(raw.url))
          : undefined;
      if ((action.kind === 'remember' || action.kind === 'learn') && !durableMemoryDomain) {
        const outcome = `blocked: ${action.kind} requires a current tenant/site domain, not a public suffix or malformed host`;
        noteBlocked('durable memory requires a valid tenant/site scope');
        history.push(`${step}. ${outcome}`);
        await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log, (reason) =>
          memoryDegraded('step', reason),
        );
        continue;
      }

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

      // CONSEQUENTIAL actions gate in EVERY mode, `auto` included: uploads, purchases, sends,
      // deletions, account creation, permission changes, data erasure. `auto` means the agent does not
      // stop to check its work — it never meant it may spend money or delete an account unattended.
      // Ordinary composition/navigation inside the browser gates only in `confirm`.
      //
      // This is only safe because the pause can now END. `waitForInput` has a timeout, and a
      // panel-origin run with no panel attached fails immediately rather than waiting for an answer
      // nobody can give — without those, a gate here would have wedged the profile permanently.
      const needsConfirm =
        Boolean(commitIntent) ||
        risk.consequential ||
        (config.autonomy === 'confirm' && (actionCapability(action.kind).mutating || risk.high));
      if (needsConfirm && !navigationApproved) {
        // The prompt must name the files and the destination. Redaction is right for the transcript,
        // but it was also applied to the APPROVAL text, so the one human who could stop an exfiltration
        // was shown "upload 1 local file(s) through [7]" — a blank cheque.
        const prompt =
          action.kind === 'upload'
            ? `Approve uploading ${action.paths.map((p) => JSON.stringify(basename(p))).join(', ')} to ${hostOf(raw.url) || redactUrl(raw.url)}?`
            : `Approve ${describeSafeAction(action, raw)}${risk.reason ? `? (${risk.reason})` : '?'}`;
        const approved = await confirmJournaled(prompt, safeAction, journalActionId);
        if (!approved) {
          history.push(`${step}. user rejected ${describeSafeAction(action, raw)}`);
          continue;
        }
        approvalGranted = true;
      }

      // Approval is for this exact action against this exact observation, not a reusable "yes". A
      // page can mutate, navigate, replace a button, change a total, or move a coordinate target while
      // the human is reading the prompt. Re-observe immediately before dispatch and fail closed on any
      // security-relevant drift. The normal next loop iteration gives the model the fresh page and it
      // may propose a new action, which requires a new approval.
      if (approvalGranted) {
        const afterApproval = await perceive(driver);
        if (
          approvalContextFingerprint(action, raw) !==
          approvalContextFingerprint(action, afterApproval)
        ) {
          const outcome =
            'blocked: the page or approved target changed while confirmation was pending; inspect the fresh page and request approval again';
          noteBlocked('the page or approved target changed while confirmation was pending');
          history.push(`${step}. ${outcome}`);
          await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log, (r) =>
            memoryDegraded('step', r),
          );
          await appendJournal({
            type: 'action.cancelled',
            actionId: journalActionId,
            summary: 'The approved target changed before dispatch',
          });
          continue;
        }
        // Do this LAST, after the DOM check, to make the unobservable screenshot-to-dispatch race as
        // small as possible. Canvas and cross-origin frame changes do not appear in `afterApproval`.
        if (action.kind === 'click_at' || action.kind === 'type_at') {
          const freshImage = await driver.screenshot?.().catch(() => undefined);
          if (!imageForStep || !freshImage || freshImage !== imageForStep) {
            const outcome =
              'blocked: the visual page changed while confirmation was pending; capture a fresh screenshot and request approval again';
            noteBlocked('the visual page changed while confirmation was pending');
            history.push(`${step}. ${outcome}`);
            await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log, (r) =>
              memoryDegraded('step', r),
            );
            await appendJournal({
              type: 'action.cancelled',
              actionId: journalActionId,
              summary: 'The approved visual target changed before dispatch',
            });
            continue;
          }
        }
      }

      // Risky but NOT consequential (for example, typing into an amount field). It proceeds, and the
      // model is told to check the result — awareness without a pause.
      if (risk.high && risk.reason && !needsConfirm) {
        // The detailed risk reason may include a page-authored field label. Keep it out of the trusted
        // nudge channel; the ordinary untrusted action outcome still tells the model what it touched.
        pendingCorrection =
          'You just took a high-risk composition action. Verify from the next snapshot that it did what the task asked — and do not repeat it.';
      }

      if (action.kind === 'remember' || action.kind === 'learn') {
        // Durable memory changes future runs, so they pass through the same action-bound approval and
        // post-confirmation freshness checks as browser commits. The scope remains harness-owned: the
        // model can propose text, but never choose which host will receive it.
        const domain = durableMemoryDomain;
        if (!domain) {
          history.push(`${step}. ${action.kind} skipped: no page domain`);
          await appendJournal({
            type: 'action.cancelled',
            actionId: journalActionId,
            summary: 'The durable-memory action had no valid host scope',
          });
          continue;
        }
        await dispatchJournaled(
          journalActionId,
          journalEffect,
          async (beginEffect) => {
            await beginEffect();
            if (action.kind === 'remember') {
              await memory.rememberFact({
                domain,
                key: action.factKey,
                value: action.factValue,
              });
            } else {
              await memory.learnSkill({
                name: action.skillName,
                trigger: action.skillTrigger,
                steps: action.skillSteps,
                origin: 'learned',
                domain,
                learnedAt: now(),
              });
            }
            return 'durable memory updated';
          },
          (value) => value,
        );
        const outcome =
          action.kind === 'remember'
            ? `remembered "${action.factKey}" for ${domain}`
            : `learned procedure "${action.skillName}" for ${domain}`;
        history.push(`${step}. ${outcome}`);
        await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log, (reason) =>
          memoryDegraded('step', reason),
        );
        continue;
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
      const actionFingerprint = `${raw.url}|${JSON.stringify(safeAction)}`;
      const stateFingerprint = `${observationFingerprint(raw)}|${JSON.stringify(safeAction)}`;
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

      const outcome = await dispatchJournaled(
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
          : () => verifyBrowserStateObserved(driver, movesBrowserOnly(action)),
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
      if (action.kind === 'extract') lastExtractedView = observationFingerprint(raw);
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
    // Last, because it is the only check that costs a human's attention: a page that already drifted
    // is refused above rather than turned into a prompt nobody should answer.
    //
    // The first thing `type_at` does is CLICK the model's pixel. `actionRisk` classifies a
    // coordinate gesture as consequential in every autonomy mode precisely because nobody — not the
    // policy, not the human — can see what handler sits under it. Reaching that click through `ask`
    // does not make it less of an activation: without this gate the model chose the coordinate, the
    // human was shown only the question, and the click was dispatched with no approval bound to it.
    const approved = await requestApproval(
      `Type the value you just supplied at visual coordinate (${action.targetX}, ${action.targetY}) on ${redactUrl(afterInput.url)}. Anything under that point will be clicked first.`,
      directAction,
    );
    if (!approved) {
      return { ok: false, outcome: 'the sensitive coordinate handoff was rejected' };
    }
    // A canvas/frame can change without affecting DOM perception. Capture immediately before the
    // focus click and require the exact image the human/model acted against.
    const freshImage = await deps.driver.screenshot?.().catch(() => undefined);
    if (!approvedImage || !freshImage || freshImage !== approvedImage) {
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
  return { ok: true, outcome: 'human input received' };
}

async function confirm(
  prompt: string,
  action: AgentAction,
  base: { sessionId: string; profileId: string },
  deps: AgentRunDeps,
): Promise<boolean> {
  const safeAction = redactAction(action);
  const safePrompt = redactCredentialLikeText(prompt).text;
  deps.emit({
    type: 'run.needsInput',
    ...base,
    kind: 'confirm',
    prompt: safePrompt,
    action: safeAction,
    ts: deps.now(),
  });
  const verdict = await deps.waitForInput(safePrompt, 'confirm', safeAction);
  return /^(approve|approved|yes|ok)$/i.test(verdict.trim());
}

function canonicalNavigationUrl(rawUrl: string, baseUrl: string): string | undefined {
  try {
    return new URL(rawUrl, baseUrl || undefined).toString();
  } catch {
    return undefined;
  }
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

function firstLine(value: string): string {
  return value.split('\n', 1)[0] ?? '';
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function memoryActionContainsCredential(action: AgentAction): boolean {
  if (action.kind === 'remember') {
    return (
      /(password|passcode|otp|token|secret|api.?key|private.?key|seed|cvv|cvc)/i.test(
        action.factKey,
      ) || redactCredentialLikeText(`${action.factKey}: ${action.factValue}`).sensitive
    );
  }
  if (action.kind === 'learn') {
    return [action.skillName, action.skillTrigger, action.skillSteps].some(
      (value) => redactCredentialLikeText(value).sensitive,
    );
  }
  return false;
}

/**
 * Per-extract and whole-ledger budgets, in characters.
 *
 * The entry budget MUST NOT be smaller than what `extract` can produce (its own cap is 12,000), or a
 * single page is silently beheaded: the outcome line still reports "extracted 3933 characters" while
 * the model receives 3,000 of them. That is exactly how a 400-row index lost the row it was asked
 * for — the extractor found it at character ~3,700 and the ledger cut it off, so the agent scrolled
 * and re-extracted the same page repeatedly, each time being told it had succeeded.
 *
 * Affording this got much cheaper: since the ledger is now stripped from every tool message except
 * the newest, a bigger budget rides once per request rather than up to seven times.
 */
const MAX_EXTRACT_ENTRY_CHARS = 12_000;
const MAX_EXTRACT_LEDGER_CHARS = 16_000;

function appendExtractedEvidence(
  existing: string[],
  step: number,
  url: string,
  description: string,
  text: string,
): string[] {
  // Clip LOUDLY. A bare ellipsis reads as a formatting flourish; a count reads as missing evidence and
  // is something the model can act on (narrow the read, or use `collect` page by page).
  const body =
    text.length > MAX_EXTRACT_ENTRY_CHARS
      ? `${text.slice(0, MAX_EXTRACT_ENTRY_CHARS)}\n[…${text.length - MAX_EXTRACT_ENTRY_CHARS} more characters of this page were cut from the record. If what you need is missing, read a narrower part of the page or use \`collect\` as you go.]`
      : text;
  const entry = `Extract ${step} — ${clip(description, 160)} — ${redactUrl(url)}\n${body}`;
  const next = [...existing, entry];
  let dropped = 0;
  while (next.length > 1 && next.join('\n\n').length > MAX_EXTRACT_LEDGER_CHARS) {
    next.shift();
    dropped += 1;
  }
  // Say what was lost. Dropping the earliest pages silently let a paginated read report a total that
  // quietly excluded page one; a visible notice lets the model re-read or switch to `collect`.
  if (dropped > 0) {
    next.unshift(
      `[${dropped} earlier extract(s) dropped to stay within the context budget — if you still need that data, re-read those pages or use \`collect\` so the harness keeps rows for you]`,
    );
  }
  if (next[0] && next[0].length > MAX_EXTRACT_LEDGER_CHARS) {
    next[0] = clip(next[0], MAX_EXTRACT_LEDGER_CHARS);
  }
  return next;
}

/**
 * Render the collected rows as a Markdown table, which the panel now renders properly and which the
 * user can copy straight into a spreadsheet. Falls back to listing rows when there are too many
 * columns for a table to stay readable.
 */
function renderDataset(
  rows: ReadonlyArray<Record<string, string>>,
  columns: readonly string[],
): string {
  const cols = columns.length ? columns : [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const header = `Collected ${rows.length} row(s):`;
  if (cols.length === 0) return header;
  const escape = (value: string): string => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${cols.map((c) => escape(row[c] ?? '')).join(' | ')} |`),
  ];
  return `${header}\n\n${lines.join('\n')}`;
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

/** True when two destinations identify the same protocol/host/port authority. */
function sameNavigationAuthority(first: string, second: string, baseUrl: string): boolean {
  try {
    return (
      new URL(first, baseUrl || undefined).origin === new URL(second, baseUrl || undefined).origin
    );
  } catch {
    return false;
  }
}

function isSettingsUiAction(action: AgentAction): boolean {
  return (
    action.kind === 'click' ||
    action.kind === 'click_at' ||
    action.kind === 'hover' ||
    action.kind === 'type' ||
    action.kind === 'type_at' ||
    action.kind === 'select' ||
    action.kind === 'key' ||
    action.kind === 'drag'
  );
}

function settingsActionIntent(action: AgentAction, raw: RawPerception): Array<string | undefined> {
  const values: Array<string | undefined> = ['note' in action ? action.note : undefined];
  const elementName = (index: number | undefined): string | undefined =>
    index === undefined ? undefined : raw.elements.find((element) => element.index === index)?.name;
  switch (action.kind) {
    case 'click':
    case 'hover':
    case 'select':
      values.push(elementName(action.id));
      break;
    case 'type':
      values.push(elementName(action.id), action.text);
      break;
    case 'type_at':
      values.push(action.text);
      break;
    case 'key':
      values.push(action.key);
      break;
    case 'drag':
      values.push(elementName(action.fromId), elementName(action.toId));
      break;
    default:
      break;
  }
  return values;
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

function observationFingerprint(raw: RawPerception): string {
  return JSON.stringify([
    raw.urlIdentity ?? urlIdentity(raw.url),
    raw.scrollY,
    raw.text ?? '',
    raw.elements.map((element) => [
      element.role,
      element.name,
      element.value ?? '',
      element.state ?? '',
    ]),
  ]);
}

/**
 * Ephemeral binding for a confirmation prompt. This deliberately includes more than the normal
 * observation-deduplication fingerprint: target coordinates, form semantics, focus, hrefs, visible
 * page text, and viewport geometry all affect what an approved click/key/coordinate gesture will do.
 * Coordinate actions additionally require byte-identical fresh screenshot data immediately before
 * dispatch, covering canvas and cross-origin content that DOM perception cannot see. The value is
 * compared in memory only; action text (which may be secret) is never persisted or logged.
 */
function approvalContextFingerprint(action: AgentAction, raw: RawPerception): string {
  return JSON.stringify([
    action,
    raw.urlIdentity ?? urlIdentity(raw.url),
    raw.title,
    raw.scrollY,
    raw.viewportW ?? 0,
    raw.viewportH,
    raw.text ?? '',
    raw.signals ?? [],
    raw.elements.map((element) => [
      element.index,
      element.tag,
      element.role,
      element.name,
      element.type ?? '',
      element.submitsForm ?? false,
      element.focused ?? false,
      element.editable ?? false,
      element.value ?? '',
      element.filled ?? false,
      element.href ?? '',
      element.state ?? '',
      element.context ?? '',
      element.x,
      element.y,
      element.w,
      element.h,
    ]),
  ]);
}

/**
 * Headroom left for OUTPUT tokens when a provider rejects a request for exceeding its context window,
 * or `null` when the error is something else entirely.
 *
 * Anthropic states the arithmetic verbatim — "input length and `max_tokens` exceed context limit:
 * 190000 + 8000 > 200000" — and OpenRouter forwards the message, so the cheapest fix is usually just
 * asking for fewer output tokens. `0` means "recognised as an overflow but the numbers were not
 * stated", which tells the caller to fall back to trimming the conversation.
 */
export function contextOverflowHeadroom(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/context (window|limit|length)|too long|max_tokens/i.test(message)) return null;
  const m = /(\d[\d,]*)\s*\+\s*(\d[\d,]*)\s*>\s*(\d[\d,]*)/.exec(message);
  if (!m) return 0;
  const n = (v: string): number => Number(v.replace(/,/g, ''));
  // Leave a margin: the reported input length is for the request that FAILED, and the retry's own
  // prompt is not byte-identical.
  const headroom = n(m[3]!) - n(m[1]!) - 1_000;
  return headroom > 0 ? headroom : 0;
}

interface BudgetedRequest {
  desiredMaxTokens: number;
  tokenBudget: number | undefined;
  usage: AgentUsage;
  system: string;
  messages: readonly LlmMessage[];
  tools: readonly LlmTool[];
}

/**
 * Cap the request's output by the allowance left after its CURRENT input. UTF-8 bytes form a simple
 * tokenizer-independent upper-ish bound for text (deliberately much more conservative than the old
 * chars/3.5 guess), while explicit structural overhead covers roles/provider wrappers. Provider usage
 * remains authoritative after the response and is checked before any returned action is dispatched.
 */
function budgetedMaxTokens(request: BudgetedRequest): number {
  if (request.tokenBudget === undefined) return request.desiredMaxTokens;
  const remaining = request.tokenBudget - totalTokens(request.usage);
  const outputRoom = remaining - requestInputReserve(request);
  if (outputRoom < MIN_USEFUL_OUTPUT_TOKENS) return 0;
  return Math.min(request.desiredMaxTokens, Math.floor(outputRoom));
}

function requestInputReserve(
  request: Pick<BudgetedRequest, 'system' | 'messages' | 'tools'>,
): number {
  const FIXED_REQUEST_OVERHEAD = 256;
  const MESSAGE_OVERHEAD = 24;
  const TOOL_OVERHEAD = 32;
  let reserve = FIXED_REQUEST_OVERHEAD + utf8Bytes(request.system);
  reserve += utf8Bytes(JSON.stringify(request.tools)) + request.tools.length * TOOL_OVERHEAD;
  for (const message of request.messages) {
    reserve += MESSAGE_OVERHEAD + utf8Bytes(messageText(message));
    if (message.role === 'user') {
      for (const image of message.images ?? []) {
        // Native image inputs are billed by pixels rather than base64 text. The compressed byte count
        // is a useful signal but can dwarf actual vision usage, so bound it at a deliberately generous
        // per-image reserve rather than making every normal screenshot exceed the run budget.
        reserve += 64 + Math.min(8_192, Math.max(1_024, Math.ceil(image.data.length / 4)));
      }
    }
  }
  return reserve;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function totalTokens(value: AgentUsage): number {
  return value.tokensIn + value.tokensOut;
}

function tokenBudgetExceeded(tokenBudget: number | undefined, usage: AgentUsage): boolean {
  return tokenBudget !== undefined && totalTokens(usage) > tokenBudget;
}

/** All text in a message, for budgeting. */
function messageText(message: LlmMessage): string {
  if (message.role === 'assistant') {
    return (message.content ?? '') + JSON.stringify(message.toolCalls ?? []);
  }
  return message.content;
}

/**
 * Per-request budget for conversation history, in characters (~8.5k tokens).
 *
 * Separate from the STORE's own bound: a thread may legitimately hold `MAX_THREAD_CHARS` (120k) and
 * Ask mode benefits from all of it, but in an agent run that block rides on every one of up to 40
 * steps and is uncached on the managed path. Cap the request view; leave the durable record alone.
 */
const MAX_PRIOR_TURN_CHARS = 30_000;

/**
 * Keep the newest whole turns that fit the budget. Walking BACKWARDS matters: the most recent exchange
 * is what a follow-up ("try that again, but…") refers to. Whole messages only — a half-dropped turn
 * would strip the `[This attempt failed]` labelling that makes a retry request intelligible.
 */
function capPriorTurns(messages: readonly LlmMessage[]): LlmMessage[] {
  const kept: LlmMessage[] = [];
  let budget = MAX_PRIOR_TURN_CHARS;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    const size = messageText(message).length;
    if (kept.length > 0 && size > budget) break;
    budget -= size;
    kept.unshift(message);
  }
  return kept;
}

/** Stored thread turns → request messages. */
function threadToMessages(stored: readonly ThreadMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const message of stored) {
    if (!message.content.trim()) continue;
    if (message.role === 'compaction') {
      out.push({
        role: 'user',
        content: `[Earlier context, summarized] ${message.content}`,
      });
      continue;
    }
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }
    // Label an unsuccessful attempt rather than dropping it, so the model can tell a real answer from
    // one that failed — and so "try that again" has something to refer to.
    const prefix =
      message.status === 'error'
        ? '[This attempt failed] '
        : message.status === 'stopped'
          ? '[This attempt was stopped before finishing] '
          : '';
    out.push({ role: 'assistant', content: `${prefix}${message.content}` });
  }
  return out;
}

/**
 * Keep the run's own exchange bounded without breaking its structure.
 *
 * Page snapshots dominate an agent run's token cost, and every one of them stays relevant only for a
 * step or two. Older TOOL RESULTS are therefore reduced to their HEADER LINE — step number, URL and the
 * outcome of the action that produced them (see `buildStepPrompt`) — while every assistant turn, the
 * record of what the agent actually DID, is preserved in full. The shape of the conversation is never
 * altered, so the call/result pairing providers require survives.
 */
function pruneObservations(messages: readonly LlmMessage[]): LlmMessage[] {
  const toolIndices = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  const cutoff =
    toolIndices.length > VERBATIM_OBSERVATIONS
      ? toolIndices[toolIndices.length - VERBATIM_OBSERVATIONS]!
      : -1;
  // The newest message that carries the re-sent blocks keeps them; every older copy is stale by
  // definition, since both blocks are rebuilt in full on every step.
  const newestWithBlocks = messages.reduce(
    (found, message, index) => (hasResentBlocks(message) ? index : found),
    -1,
  );

  return messages.map((message, index) => {
    if (message.role === 'tool' && cutoff >= 0 && index < cutoff) {
      const headerLine = message.content.split('\n', 1)[0] ?? '';
      return {
        ...message,
        content: `${headerLine.slice(0, 300)}\n(older page snapshot omitted to save context)`,
      };
    }
    if (index !== newestWithBlocks && hasResentBlocks(message)) {
      return { ...message, content: stripResentBlocks(message.content) };
    }
    return message;
  });
}

function hasResentBlocks(message: LlmMessage): message is LlmMessage & { content: string } {
  if (message.role === 'assistant') return false;
  const content = message.content;
  return (
    typeof content === 'string' &&
    (content.includes(EVIDENCE_PREAMBLE) || content.includes(SITE_MEMORY_PREAMBLE))
  );
}

/**
 * Remove the evidence-ledger and site-memory blocks from a step prompt that is no longer the newest.
 *
 * Both are rebuilt in full on EVERY step, so up to seven byte-identical copies of an 8,000-char ledger
 * plus a 4,000-char memory block could be live in one request — re-billed in full on the managed path,
 * which places no cache breakpoint on the message array.
 *
 * The cut is anchored on each block's preamble and ends at the FIRST closing fence after it. That
 * precision is the whole trick: the ledger shares `BEGIN/END_UNTRUSTED_WEB_CONTENT` with the page
 * snapshot, so a greedy match would delete the observation the step exists to deliver. Whatever is
 * removed is always a COMPLETE fenced unit — never content stripped of its "untrusted data" framing.
 */
function stripResentBlocks(content: string): string {
  const cut = (text: string, preamble: string, endFence: string): string => {
    const start = text.indexOf(preamble);
    if (start === -1) return text;
    const end = text.indexOf(endFence, start);
    if (end === -1) return text; // malformed: leave it whole rather than truncate mid-fence
    return `${text.slice(0, start)}(earlier copy of this block omitted; the current one is below)\n${text.slice(end + endFence.length + 1)}`;
  };
  return cut(
    cut(content, EVIDENCE_PREAMBLE, 'END_UNTRUSTED_WEB_CONTENT'),
    SITE_MEMORY_PREAMBLE,
    'END_UNTRUSTED_LOCAL_MEMORY',
  );
}

/**
 * Attach a screenshot to the newest turn. Vision arrives as an extra content part on the message the
 * model is about to answer; a tool result cannot carry an image on every provider, so in that case a
 * trailing user turn carries it instead.
 */
function attachImageToLastTurn(messages: readonly LlmMessage[], image: string): LlmMessage[] {
  const out = [...messages];
  const last = out.at(-1);
  if (last?.role === 'user') {
    out[out.length - 1] = { ...last, images: [{ mediaType: 'image/png', data: image }] };
    return out;
  }
  out.push({
    role: 'user',
    content: 'Visual observation of the current page:',
    images: [{ mediaType: 'image/png', data: image }],
  });
  return out;
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

async function verifyBrowserStateObserved(
  driver: BrowserDriver,
  browserMoveOnly = false,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const observed = await perceive(driver);
    if (observed.signals?.includes('page-unreadable') && !browserMoveOnly) {
      throw new Error('the post-action page could not be read');
    }
    if (observed.signals?.includes('page-unreadable')) {
      // The move itself is not in doubt, and the next step's own observation carries the reason the
      // page cannot be read — a blocking dialog, a hostile CSP — so the model can hand off or leave.
      return;
    }
    if (driver.ready && !driver.ready()) {
      throw new Error('the browser detached before post-action verification');
    }
    const liveUrl = await driver.currentUrl();
    if (urlIdentity(liveUrl) === (observed.urlIdentity ?? urlIdentity(observed.url))) return;
    if (attempt >= POST_ACTION_SETTLE_ATTEMPTS) {
      throw new Error('the page changed during post-action verification');
    }
    // Let the navigation finish rather than sampling it again immediately; a failure to settle is
    // itself part of the evidence that the state is not observable.
    await driver.waitForSettle(3000).catch(() => {});
  }
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
