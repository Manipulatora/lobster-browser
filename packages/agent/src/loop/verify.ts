/**
 * What the loop believes AFTER an action: whether the page can testify about what just happened,
 * and whether the pixels under an approved coordinate gesture are still the ones that were approved.
 * Everything here reads the browser; nothing here changes it.
 */
import type { AgentAction } from '@lobster/shared-types';
import type { BrowserDriver } from '../driver.js';
import { perceive } from '../perception/perceive.js';
import { urlIdentity } from '../security.js';
import type { RawPerception } from '../types.js';

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
export function movesBrowserOnly(action: AgentAction): boolean {
  return action.kind === 'navigate' || action.kind === 'back' || action.kind === 'tab';
}

/**
 * Confirm the page can testify about what just happened — and hand back the observation it used, so
 * the next step reads the page it already read instead of extracting the whole DOM again.
 */
export async function verifyBrowserStateObserved(
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

export function visualTargetPatch(
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
export async function visualTargetHeld(
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
