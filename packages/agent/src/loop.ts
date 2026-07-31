import { isAbsolute } from 'node:path';
import type {
  AgentAction,
  AgentConfig,
  AgentEvent,
  AgentLlmConfig,
  AgentUsage,
} from '@lobster/shared-types';
import { ACT_TOOL, parseAction } from './actions.js';
import {
  assessUiSettingsIntent,
  isBrowserConfigSurfaceUrl,
  isPrivilegedInternalUrl,
  isVettedBrowserConfigUrl,
} from './browser-config-guard.js';
import type { BrowserDriver } from './driver.js';
import { executeAction } from './executor.js';
import type { Sleep } from './executor.js';
import type { LlmClient } from './llm/index.js';
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
import { buildAskPrompt, buildStepPrompt, buildSystemPrompt } from './prompt.js';
import { describeSafeAction, isSensitiveElement, redactAction, redactUrl } from './security.js';
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

const MUTATING: ReadonlySet<AgentAction['kind']> = new Set([
  'click',
  'click_at',
  'type',
  'type_at',
  'select',
  'key',
  'drag',
  'upload',
  'navigate',
  'back',
  'tab',
  'browser_config',
]);

export async function runAgent(params: AgentRunParams, deps: AgentRunDeps): Promise<void> {
  const { sessionId, profileId, task, runId, threadId, llmConfig, config } = params;
  const { driver, llm, memory, emit, signal, now } = deps;
  const usage: AgentUsage = { tokensIn: 0, tokensOut: 0 };
  const history: string[] = [];
  const base = { sessionId, profileId };
  let memoryStarted = false;

  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string): void =>
    emit({ type: 'log', ...base, level, message, ts: now() });
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
      priorTurns = threadToMessages(await memory.loadThread(threadId));
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
    const system = buildSystemPrompt({ task, config, memoryContext });
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
    let lastExtractedView = '';

    for (let step = 1; step <= config.maxSteps; step += 1) {
      if (signal.aborted) return await finish('stopped', 'Stopped by user.');

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
        if (captured && captured.length <= 16_000_000) pendingImage = captured;
      }

      const nudges: string[] = [];
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
      const estimated =
        estimateTokens(system) +
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
      if (!result.toolCall) {
        invalidActions += 1;
        history.push(`${step}. no structured action returned`);
        if (invalidActions >= 3)
          return await finish('error', '', 'The model repeatedly returned no valid action.');
        continue;
      }
      const parsed = parseAction(result.toolCall.input);
      if (!parsed.ok) {
        invalidActions += 1;
        history.push(`${step}. invalid action: ${parsed.error}`);
        if (invalidActions >= 3)
          return await finish('error', '', 'The model repeatedly returned invalid actions.');
        continue;
      }
      invalidActions = 0;
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
        (action.kind === 'click_at' ||
          action.kind === 'type_at' ||
          (action.kind === 'ask' && action.targetX !== undefined)) &&
        !imageForStep
      ) {
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
            await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log);
          } catch (error) {
            history.push(`${step}. could not remember: ${safeError(error)}`);
          }
        }
        continue;
      }
      if (action.kind === 'screenshot' && !config.visionFallback) {
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
        action.kind !== 'tab' &&
        action.kind !== 'navigate' &&
        action.kind !== 'back' &&
        action.kind !== 'done'
      ) {
        const outcome =
          'blocked: this is a privileged browser page outside the vetted settings surface. Leave it (switch tabs, go back, or navigate to a normal site) before continuing.';
        history.push(`${step}. ${outcome}`);
        await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log);
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
          history.push(`${step}. ${outcome}`);
          await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log);
          continue;
        }
      }

      if (action.kind === 'extract' && lastExtractedView === observationFingerprint(raw)) {
        const outcome =
          'blocked: this unchanged page view was already extracted; use the existing result or change the page';
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
          history.push(`${step}. ${outcome}`);
          await appendSafe(memory, runId, step, raw.url, safeAction, outcome, now, log);
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
      const needsConfirm =
        config.autonomy === 'confirm' && (MUTATING.has(action.kind) || risk.high);
      if (needsConfirm && !navigationApproved) {
        const approved = await confirm(
          `Approve ${describeSafeAction(action, raw)}${risk.reason ? `? (${risk.reason})` : '?'}`,
          safeAction,
          base,
          deps,
        );
        if (!approved) {
          history.push(`${step}. user rejected ${describeSafeAction(action, raw)}`);
          continue;
        }
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
      await appendSafe(memory, runId, step, raw.url, safeAction, outcome.outcome, now, log);

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
      history.push(`${step}. ${outcome.outcome}`);
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
      if (MUTATING.has(action.kind) && action.kind !== 'browser_config') {
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

const MAX_EXTRACT_ENTRY_CHARS = 3_000;
const MAX_EXTRACT_LEDGER_CHARS = 8_000;

function appendExtractedEvidence(
  existing: string[],
  step: number,
  url: string,
  description: string,
  text: string,
): string[] {
  const entry = `Extract ${step} — ${clip(description, 160)} — ${redactUrl(url)}\n${clip(text, MAX_EXTRACT_ENTRY_CHARS)}`;
  const next = [...existing, entry];
  while (next.length > 1 && next.join('\n\n').length > MAX_EXTRACT_LEDGER_CHARS) next.shift();
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

/** Number of recent step observations kept at full size. */
const VERBATIM_OBSERVATIONS = 6;

/**
 * Keep the run's own exchange bounded without breaking its structure.
 *
 * Page snapshots dominate an agent run's token cost, and every one of them stays relevant only for a
 * step or two. Older TOOL RESULTS are therefore reduced to their first line (the URL/title and outcome),
 * while every assistant turn — the record of what the agent actually DID — is preserved in full. The
 * shape of the conversation is never altered, so the call/result pairing providers require survives.
 */
function pruneObservations(messages: readonly LlmMessage[]): LlmMessage[] {
  const toolIndices = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  if (toolIndices.length <= VERBATIM_OBSERVATIONS) return [...messages];
  const cutoff = toolIndices[toolIndices.length - VERBATIM_OBSERVATIONS]!;
  return messages.map((message, index) => {
    if (message.role !== 'tool' || index >= cutoff) return message;
    const firstLine = message.content.split('\n', 1)[0] ?? '';
    return {
      ...message,
      content: `${firstLine.slice(0, 300)}\n(older page snapshot omitted to save context)`,
    };
  });
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
