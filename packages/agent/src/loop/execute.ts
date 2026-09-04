/**
 * What actually TOUCHES the browser on the loop's behalf: opening the start URL, dispatching the
 * model's action under the journal barrier, the human-input handoff (including the direct secure
 * typing path a sensitive answer takes), the rollback that undoes a navigation the policy refused
 * after the fact, and the note that a popup has become the working page.
 */
import type { AgentAction, AgentConfig } from '@lobster/shared-types';
import type { BrowserDriver } from '../driver.js';
import { executeAction } from '../executor.js';
import type { ExecOutcome, Sleep } from '../executor.js';
import type { JournalActionEffect } from '../journal/index.js';
import type { AgentRunDeps } from '../loop.js';
import type { MemoryStore } from '../memory/index.js';
import { perceive } from '../perception/perceive.js';
import { assessCurrentPage, assessNavigation } from '../policy.js';
import { isSensitiveElement, redactAction, redactUrl, urlIdentity } from '../security.js';
import { redactCredentialLikeText } from '../sensitive-text.js';
import type { PerceivedElement, RawPerception } from '../types.js';
import { approvalContextFingerprint, canonicalNavigationUrl } from './gate.js';
import { clip } from './observe.js';
import { appendSafe, journalHostOf, safe } from './record.js';
import type { RunJournal, RunLog, StepTimer } from './record.js';
import {
  movesBrowserOnly,
  verifyBrowserStateObserved,
  visualTargetHeld,
  visualTargetPatch,
} from './verify.js';

export async function handleAsk(
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

/** The run-scoped services the dispatch helpers act through. */
export interface DispatchContext {
  driver: BrowserDriver;
  config: AgentConfig;
  signal: AbortSignal;
  sleep?: Sleep;
  journal: RunJournal;
  timer: StepTimer;
  log: RunLog['log'];
}

/** Undo a navigation the policy refused after the fact, journaled as a write of its own. */
export async function restoreNavigationJournaled(
  ctx: DispatchContext,
  priorUrl: string,
  currentUrl: string,
  actionId: string,
): Promise<void> {
  await ctx.journal.dispatch(
    actionId,
    'write',
    async (beginEffect) => {
      await beginEffect();
      await rollbackNavigation(ctx.driver, priorUrl);
      return 'navigation restored and verified';
    },
    (value) => value,
  );
  ctx.log(
    'info',
    `Restored the prior page after refusing unexpected navigation from ${redactUrl(currentUrl)}.`,
  );
}

/** A verdict that ends the run, in the shape the orchestrator's `finish` takes. */
export interface RunEnd {
  status: 'done' | 'error' | 'stopped';
  result: string;
  error?: string;
}

/**
 * Open the run's start URL under the navigation policy, journaled like any other write. Returns how
 * the run must end when the page cannot be opened, or undefined once the browser is on it.
 */
export async function openStartUrl(
  ctx: DispatchContext,
  startUrl: string,
): Promise<RunEnd | undefined> {
  const { driver, config, journal } = ctx;
  let current = await safe(() => driver.currentUrl(), '');
  const destination = canonicalNavigationUrl(startUrl, current);
  if (!destination) {
    return {
      status: 'error',
      result: '',
      error: 'Start URL blocked: the destination is not a valid URL',
    };
  }

  // Bind a possibly-relative start URL to the page that was actually observed, then re-check both
  // source and absolute destination immediately before dispatch. A page may self-navigate while a
  // human reads the prompt; the original relative string must never be re-based onto that new page.
  let readyToNavigate = false;
  let startNavigationActionId: string | undefined;
  for (let attempt = 0; attempt < 3 && !readyToNavigate; attempt += 1) {
    const currentDecision = assessCurrentPage(current, config);
    if (currentDecision.verdict === 'deny') {
      return {
        status: 'error',
        result: '',
        error: `Start URL blocked because the current page changed: ${currentDecision.reason}`,
      };
    }
    const decision = assessNavigation(destination, current, config);
    if (decision.verdict === 'deny') {
      return { status: 'error', result: '', error: `Start URL blocked: ${decision.reason}` };
    }
    const actionId = await journal.propose('navigate', 'write', journalHostOf(destination));
    if (decision.verdict === 'confirm') {
      const safeDestination = redactUrl(destination);
      const approved = await journal.confirm(
        `Approve opening ${safeDestination}? (${decision.reason})`,
        { kind: 'navigate', url: safeDestination },
        actionId,
      );
      if (!approved) return { status: 'stopped', result: 'The start navigation was rejected.' };
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
      return { status: 'error', result: '', error: `Start URL blocked: ${finalDecision.reason}` };
    }
    readyToNavigate = true;
    startNavigationActionId = actionId;
  }
  if (!readyToNavigate) {
    return {
      status: 'error',
      result: '',
      error: 'Start URL blocked because the current page kept changing during confirmation.',
    };
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
  return undefined;
}

/**
 * Run the model's action under the journal's durable barrier on the step's execute stopwatch, and —
 * for anything but a read — verify the page can testify afterwards. The verified observation comes
 * back with the outcome so the next step can reuse it instead of extracting the DOM again.
 */
export async function dispatchAction(
  ctx: DispatchContext,
  input: {
    action: AgentAction;
    raw: RawPerception;
    actionId: string;
    effect: JournalActionEffect;
    /** The loop already cleared this action's cross-domain destination. */
    navigationApproved: boolean;
  },
): Promise<{ outcome: ExecOutcome; verifiedPerception: RawPerception | undefined }> {
  const { action, raw, actionId, effect, navigationApproved } = input;
  let verifiedPerception: RawPerception | undefined;
  const outcome = await ctx.timer.timedExecute(() =>
    ctx.journal.dispatch(
      actionId,
      effect,
      (beginEffect) =>
        executeAction(action, raw, ctx.driver, {
          ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
          config: ctx.config,
          signal: ctx.signal,
          navigationApproved,
          beforeEffect: beginEffect,
        }),
      (value) => value.outcome,
      effect === 'read'
        ? undefined
        : async () => {
            verifiedPerception = await verifyBrowserStateObserved(
              ctx.driver,
              movesBrowserOnly(action),
            );
          },
      (value) => value.delivery,
    ),
  );
  return { outcome, verifiedPerception };
}

/**
 * A popup the page opened has silently become the working target; say so in the same breath as
 * the action's outcome, so the model knows which page it is now on.
 */
export function adoptedPopupNote(driver: BrowserDriver): string {
  const adopted = driver.takeAdoptedPopup?.();
  return adopted ? ` — the page opened a new tab (${redactUrl(adopted)}); you are now on it` : '';
}
