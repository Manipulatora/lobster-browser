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
import type { LlmMessage } from './llm/types.js';
import { normalizeMessages } from './llm/types.js';
import type { MemoryStore, ThreadMessage } from './memory/index.js';
import {
  actionRisk,
  assessNavigation,
  normalizeAllowedDomains,
  targetUrlForAction,
} from './policy.js';
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
} from './security.js';
import type { RawPerception } from './types.js';

export interface AgentRunDeps {
  driver: BrowserDriver;
  llm: LlmClient;
  memory: MemoryStore;
  emit: (event: AgentEvent) => void;
  waitForInput: (prompt: string, kind: 'ask' | 'confirm', action?: AgentAction) => Promise<string>;
  signal: AbortSignal;
  now: () => string;
  sleep?: Sleep;
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
  // Autonomy is THE approval switch: `auto` runs end-to-end with zero approval pauses (hard denials
  // still apply), so cross-domain navigation defaults to allow there; `confirm` gates it.
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
  let memoryStarted = false;

  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string): void =>
    emit({ type: 'log', ...base, level, message, ts: now() });
  /**
   * Report a memory degradation on its own typed channel as well as the log. Memory failing is
   * survivable but must never be INVISIBLE: a profile that has silently stopped remembering anything
   * looked exactly like one that was working.
   */
  const memoryDegraded = (scope: 'run' | 'thread' | 'step', reason: string): void => {
    emit({ type: 'memory.degraded', ...base, scope, reason, ts: now() });
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
    if (memoryStarted) {
      try {
        await memory.finishRun(runId, {
          status,
          summary: result || error || '',
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
          user: task,
          assistant: result || error || '',
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
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
      usage,
      ts: now(),
    });
  };

  emit({ type: 'run.started', ...base, task, ts: now() });
  // Memory is BEST-EFFORT context, never a hard dependency: a broken, rotated, or corrupt store must
  // never stop the agent from doing the user's task. Persistence and recall each degrade to "off" on
  // failure instead of erroring the run (which is exactly what made a single bad file kill everything).
  try {
    await memory.startRun(runId, task, now(), {
      ...(config.mode ? { mode: config.mode } : {}),
      model: llmConfig.model,
    });
    memoryStarted = true;
  } catch {
    // Could not record this run — it just won't be persisted or recalled later. Continue.
  }

  // Prior turns of THIS conversation, as real messages. Scoped to the thread, so an unrelated task on
  // the same profile can no longer bleed into this one.
  let priorTurns: LlmMessage[] = [];
  if (threadId) {
    try {
      priorTurns = capPriorTurns(threadToMessages(await memory.loadThread(threadId)));
    } catch {
      priorTurns = []; // recall unavailable this turn — proceed with none
    }
  }

  // ASK mode: a single chat completion, no browser and no tools — the model answers from its own
  // knowledge in Markdown. The browser never opens (the lazy driver is never touched).
  if (config.mode === 'ask') {
    try {
      const result = await llm.complete({
        model: llmConfig.model,
        system: buildAskPrompt(),
        messages: normalizeMessages([...priorTurns, { role: 'user', content: task }]),
        tools: [],
        forceTool: '',
        maxTokens: llmConfig.effort ? 8000 : 2048,
        cachePrefix: true,
        // Chat is where the wait is felt, so this is where streaming earns its keep. Adapters that
        // cannot stream ignore the callback and the answer simply arrives whole, as before.
        onTextDelta: (text) => emit({ type: 'answer.delta', ...base, text, ts: now() }),
        ...(llmConfig.effort ? { effort: llmConfig.effort } : {}),
        signal,
      });
      addUsage(result.usage);
      emit({ type: 'usage', ...base, usage: { ...result.usage }, ts: now() });
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
      const current = await safe(() => driver.currentUrl(), '');
      const decision = assessNavigation(config.startUrl, current, config);
      if (decision.verdict === 'deny')
        return await finish('error', '', `Start URL blocked: ${decision.reason}`);
      if (decision.verdict === 'confirm') {
        const approved = await confirm(
          `Approve opening ${config.startUrl}? (${decision.reason})`,
          { kind: 'navigate', url: config.startUrl },
          base,
          deps,
        );
        if (!approved) return await finish('stopped', 'The start navigation was rejected.');
      }
      await driver.navigate(config.startUrl);
      await driver.waitForSettle();
    }

    // Skills are task-scoped and stable, so they stay in the cacheable system prefix. Site facts are
    // loaded separately after each navigation and remain user-level untrusted data.
    const memoryContext = await memory.loadContext(undefined, task);
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
    let recovery = false;
    let invalidActions = 0;
    /** True while a token-truncated response is being retried, so the retry cannot itself loop. */
    let truncatedRetry = false;
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
        pendingCorrection = `${consecutiveBlocks} actions in a row were refused by the harness (most recently: ${reason}). Pushing on this will not start working — take a materially different approach. If nothing else can advance the task, finish with \`done\` (success=false) and say what was blocked.`;
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
      const currentHost = hostOf(raw.url);
      if (currentHost !== siteMemoryHost) {
        siteMemoryHost = currentHost;
        siteMemoryContext = currentHost ? await memory.loadContext(currentHost, '') : '';
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
        url: raw.url,
        title: raw.title,
        summary: firstLine(rendered),
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
      if (step >= Math.ceil(config.maxSteps * 0.75))
        nudges.push(
          `BUDGET: step ${step} of ${config.maxSteps}. Wrap up — consolidate what you already have and call \`done\`; do not start new exploration.`,
        );
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
      const maxTokens = llmConfig.effort ? 8000 : 1024;
      const conversation = normalizeMessages([...priorTurns, ...pruneObservations(stepMessages)]);
      // Budget from what the provider ACTUALLY billed for prior steps, falling back to an estimate
      // only for the very first request (when nothing has been reported yet). A chars/3.5 guess drifts
      // per model and language, and over a 40-step run the error compounds into either an early stop
      // or a blown budget.
      const measuredPerStep = step > 1 ? (usage.tokensIn + usage.tokensOut) / (step - 1) : 0;
      const estimated =
        measuredPerStep > 0
          ? Math.ceil(measuredPerStep)
          : estimateTokens(system) +
            conversation.reduce((sum, m) => sum + estimateTokens(messageText(m)), 0) +
            maxTokens;
      if (config.tokenBudget && usage.tokensIn + usage.tokensOut + estimated > config.tokenBudget) {
        return await finish(
          'stopped',
          `Token budget (${config.tokenBudget}) would be exceeded by the next step.`,
        );
      }

      emit({ type: 'step.thinking', ...base, step, ts: now() });
      const imageForStep = pendingImage;
      pendingImage = undefined;
      const result = await llm.complete({
        model: step === 1 || recovery ? llmConfig.model : (llmConfig.stepModel ?? llmConfig.model),
        system,
        messages: imageForStep ? attachImageToLastTurn(conversation, imageForStep) : conversation,
        tools: [
          {
            name: ACT_TOOL.name,
            description: ACT_TOOL.description,
            inputSchema: ACT_TOOL.inputSchema,
          },
        ],
        forceTool: ACT_TOOL.name,
        maxTokens,
        cachePrefix: true,
        sessionId: runId,
        ...(llmConfig.effort ? { effort: llmConfig.effort } : {}),
        signal,
      });
      recovery = false;
      addUsage(result.usage);
      emit({ type: 'usage', ...base, usage: { ...result.usage }, ts: now() });

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

      if (action.kind === 'ask') {
        const handled = await handleAsk(action, raw, step, runId, history, base, deps, memory, now);
        if (!handled.ok) history.push(`${step}. ${handled.outcome}`);
        continue;
      }
      if (action.kind === 'remember') {
        // Agent-authored durable memory: persist a per-domain fact this profile will recall next time.
        const domain = hostOf(raw.url);
        if (!domain) {
          history.push(`${step}. remember skipped: no page domain`);
        } else {
          try {
            await memory.rememberFact({ domain, key: action.factKey, value: action.factValue });
            const outcome = `remembered "${action.factKey}" for ${domain}`;
            history.push(`${step}. ${outcome}`);
            await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log, (r) =>
              memoryDegraded('step', r),
            );
          } catch (error) {
            history.push(`${step}. could not remember: ${safeError(error)}`);
          }
        }
        continue;
      }
      if (action.kind === 'screenshot' && !config.visionFallback) {
        noteBlocked('visual fallback is disabled for this run');
        history.push(`${step}. blocked: visual fallback is disabled for this run`);
        continue;
      }

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

      const target = targetUrlForAction(action, raw);
      let navigationApproved = false;
      if (target) {
        const trustedInternalMove =
          isVettedBrowserConfigUrl(raw.url) && isVettedBrowserConfigUrl(target);
        const decision = trustedInternalMove
          ? { verdict: 'allow' as const, reason: 'vetted browser settings navigation' }
          : assessNavigation(target, raw.url, config);
        if (decision.verdict === 'deny') {
          const outcome = `blocked: ${decision.reason}`;
          noteBlocked(decision.reason);
          history.push(`${step}. ${outcome}`);
          await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log, (r) =>
            memoryDegraded('step', r),
          );
          continue;
        }
        if (decision.verdict === 'confirm') {
          navigationApproved = await confirm(
            `Approve ${describeSafeAction(action, raw)}? (${decision.reason})`,
            safeAction,
            base,
            deps,
          );
          if (!navigationApproved) {
            history.push(`${step}. user rejected ${describeSafeAction(action, raw)}`);
            continue;
          }
        }
      }

      // In `auto` the run NEVER pauses for approval — the user chose full autonomy, and risk
      // heuristics only annotate the confirm prompt when `confirm` mode gates mutating actions.
      const risk = actionRisk(action, raw);
      // `upload` ALWAYS asks, whatever the autonomy setting. Everything else the agent does happens
      // inside the browser and is recoverable; sending a local file to a website is the one action
      // that leaves the machine and cannot be taken back. `auto` was never meant to cover that — the
      // config's own docs say irreversible actions can still gate — and because no caller ever sets
      // `confirm`, the risk flag was being computed and then discarded on every run.
      const needsConfirm =
        action.kind === 'upload' ||
        (config.autonomy === 'confirm' && (actionCapability(action.kind).mutating || risk.high));
      if (needsConfirm && !navigationApproved) {
        // The prompt must name the files and the destination. Redaction is right for the transcript,
        // but it was also applied to the APPROVAL text, so the one human who could stop an exfiltration
        // was shown "upload 1 local file(s) through [7]" — a blank cheque.
        const prompt =
          action.kind === 'upload'
            ? `Approve uploading ${action.paths.map((p) => JSON.stringify(basename(p))).join(', ')} to ${hostOf(raw.url) || redactUrl(raw.url)}?`
            : `Approve ${describeSafeAction(action, raw)}${risk.reason ? `? (${risk.reason})` : '?'}`;
        const approved = await confirm(prompt, safeAction, base, deps);
        if (!approved) {
          history.push(`${step}. user rejected ${describeSafeAction(action, raw)}`);
          continue;
        }
      }

      // In `auto` the run never pauses, so a high-risk action proceeds — but the risk assessment was
      // previously computed and then discarded on every shipped run, since no caller sets `confirm`.
      // Surface it on the harness channel instead: the model gets one line of "you are about to do
      // something consequential" before the NEXT step, and the user sees it in the transcript. This
      // changes nothing about what is permitted.
      if (risk.high && risk.reason && !needsConfirm) {
        pendingCorrection = `You just took a consequential action (${risk.reason}). Verify from the next snapshot that it did what the task asked — and do not repeat it.`;
      }

      const fingerprint = `${raw.url}|${JSON.stringify(safeAction)}`;
      repeatCount = fingerprint === lastFingerprint ? repeatCount + 1 : 1;
      lastFingerprint = fingerprint;
      if (repeatCount >= 5) {
        return await finish(
          'error',
          '',
          'The agent entered a repeated-action loop and stopped safely.',
        );
      }
      if (repeatCount >= 3) recovery = true;

      const outcome = await executeAction(action, raw, driver, {
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        config,
        signal,
        navigationApproved,
      });
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
        const afterUrl = await safe(() => driver.currentUrl(), raw.url);
        if (afterUrl !== raw.url) {
          const trustedInternalMove =
            isVettedBrowserConfigUrl(raw.url) && isVettedBrowserConfigUrl(afterUrl);
          const drift = trustedInternalMove
            ? { verdict: 'allow' as const, reason: 'vetted browser settings navigation' }
            : assessNavigation(afterUrl, raw.url, config);
          if (drift.verdict === 'deny') {
            await rollbackNavigation(driver, raw.url);
            return await finish(
              'error',
              '',
              `Navigation policy blocked page drift: ${drift.reason}`,
            );
          }
          if (drift.verdict === 'confirm' && !navigationApproved) {
            const approved = await confirm(
              `The page opened ${redactUrl(afterUrl)}. Approve staying there? (${drift.reason})`,
              { kind: 'navigate', url: redactUrl(afterUrl) },
              base,
              deps,
            );
            if (!approved) {
              await rollbackNavigation(driver, raw.url);
              history.push(`${step}. user rejected unexpected navigation; went back`);
            }
          }
        }
      }
    }
    return await finish('stopped', `Reached the ${config.maxSteps}-step budget without finishing.`);
  } catch (error) {
    if (signal.aborted) return await finish('stopped', 'Stopped by user.');
    return await finish('error', '', safeError(error));
  }
}

async function handleAsk(
  action: Extract<AgentAction, { kind: 'ask' }>,
  raw: RawPerception,
  step: number,
  runId: string,
  history: string[],
  base: { sessionId: string; profileId: string },
  deps: AgentRunDeps,
  memory: MemoryStore,
  now: () => string,
): Promise<{ ok: boolean; outcome: string }> {
  deps.emit({
    type: 'run.needsInput',
    ...base,
    kind: 'ask',
    prompt: action.question,
    ...(action.sensitive !== undefined ? { sensitive: action.sensitive } : {}),
    ts: now(),
  });
  const answer = await deps.waitForInput(action.question, 'ask', action);
  if (action.sensitive && action.targetId !== undefined) {
    const element = raw.elements.find((item) => item.index === action.targetId);
    if (!element)
      return { ok: false, outcome: `sensitive target [${action.targetId}] is no longer available` };
    if (!isSensitiveElement(element)) {
      return {
        ok: false,
        outcome: `refused sensitive handoff to non-sensitive field [${action.targetId}]`,
      };
    }
    const direct = await executeAction(
      { kind: 'type', id: action.targetId, text: answer, clear: true },
      raw,
      deps.driver,
      { ...(deps.sleep ? { sleep: deps.sleep } : {}), signal: deps.signal },
    );
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
    const direct = await executeAction(directAction, raw, deps.driver, {
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      signal: deps.signal,
    });
    const safeAction = redactAction(directAction, raw);
    await appendSafe(memory, runId, step, raw.url, safeAction, direct.outcome, now, () => {});
    history.push(
      `${step}. human securely supplied sensitive input at the requested visual coordinate`,
    );
    return { ok: true, outcome: direct.outcome };
  }
  history.push(
    action.sensitive
      ? `${step}. human completed the sensitive handoff (reply withheld)`
      : `${step}. human replied to ${JSON.stringify(clip(action.question, 100))}: ${JSON.stringify(clip(answer, 120))}`,
  );
  return { ok: true, outcome: 'human input received' };
}

async function confirm(
  prompt: string,
  action: AgentAction,
  base: { sessionId: string; profileId: string },
  deps: AgentRunDeps,
): Promise<boolean> {
  deps.emit({
    type: 'run.needsInput',
    ...base,
    kind: 'confirm',
    prompt,
    action,
    ts: deps.now(),
  });
  const verdict = await deps.waitForInput(prompt, 'confirm', action);
  return /^(approve|approved|yes|ok)$/i.test(verdict.trim());
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

function observationFingerprint(raw: RawPerception): string {
  return JSON.stringify([
    raw.url,
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

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 3.5);
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

async function rollbackNavigation(driver: BrowserDriver, priorUrl: string): Promise<void> {
  try {
    await driver.goBack();
    await driver.waitForSettle(3000);
    if ((await driver.currentUrl()) === priorUrl) return;
  } catch {
    // A popup/new tab has no back entry; close the active extra tab instead.
  }
  try {
    const tabs = await driver.listTabs();
    const active = tabs.find((tab) => tab.active);
    if (active && tabs.length > 1) {
      await driver.closeTab(active.index);
      return;
    }
  } catch {
    // Last resort below.
  }
  await driver.navigate(priorUrl).catch(() => {});
  await driver.waitForSettle(3000).catch(() => {});
}
