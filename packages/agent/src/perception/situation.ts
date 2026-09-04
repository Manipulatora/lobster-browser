import type { RawPerception } from '../types.js';

/**
 * The page situations the loop tracks ACROSS steps.
 *
 * The extraction script flags what a snapshot contains; these are the flags whose CHANGE is news. A
 * login wall, a CAPTCHA or a one-time-code prompt decide whether the task can go on without the
 * human; an error page or a rate-limit/blocked page decide whether retrying can work at all. `dialog`
 * and `canvas` are deliberately not tracked: a modal opens and closes on every other click, and a
 * page with a canvas stays a page with a canvas — neither transition changes what the agent should do
 * next, and a note it should ignore teaches it to ignore notes.
 */
export const SITUATION_SIGNALS = ['login', 'captcha', 'otp', 'error-page', 'blocked'] as const;
export type SituationSignal = (typeof SITUATION_SIGNALS)[number];

export interface SituationChange {
  signal: SituationSignal;
  /** True when the situation is on this page and was not on the previous one; false when it has gone. */
  appeared: boolean;
}

/**
 * Error and block pages, recognised harness-side from the title and the top of the visible text.
 *
 * Kept OUT of the page-evaluated script on purpose: that script runs in the page's own main world,
 * where every added line is more behaviour a page can time or trip over, and an error or block page
 * has nothing but a title and a few hundred characters of text anyway. The patterns are the STOCK
 * phrasings — Chromium's own `ERR_*` tokens, status-code sentences, the sentences rate limiters and
 * WAFs print — because a match becomes a harness note the model is told to trust, and a note that
 * cries "error page" at a docs page about error handling costs a step of misdirected recovery.
 */
const ERROR_PAGE =
  /\b(?:HTTP ERROR \d{3}|ERR_[A-Z0-9_]{4,}|page not found|(?:404|410)\b[^\n]{0,40}\bnot found|(?:site|page) can(?:'|’|no)t be reached|internal server error|service unavailable|bad gateway|gateway time-?out)\b/i;
const BLOCKED_PAGE =
  /\b(?:too many requests|rate[ -]?limit(?:ed| exceeded| reached)|429\b[^\n]{0,40}\btoo many|unusual traffic|access denied|(?:you (?:have been|are|'ve been) |temporarily )blocked|attention required|request blocked)\b/i;
/** How much of the text digest is read; an error or block page states its case at the top. */
const SITUATION_TEXT_CHARS = 600;

export function detectHarnessSignals(
  page: Pick<RawPerception, 'title' | 'text'>,
): Array<'error-page' | 'blocked'> {
  const head = `${page.title}\n${(page.text ?? '').slice(0, SITUATION_TEXT_CHARS)}`;
  const out: Array<'error-page' | 'blocked'> = [];
  if (ERROR_PAGE.test(head)) out.push('error-page');
  if (BLOCKED_PAGE.test(head)) out.push('blocked');
  return out;
}

/** The tracked situations present in a perception's signals, in canonical order, deduplicated. */
export function situationSignals(signals: readonly string[] | undefined): SituationSignal[] {
  return SITUATION_SIGNALS.filter((signal) => signals?.includes(signal));
}

/**
 * What changed between the page the previous step acted on and this one. Only transitions are
 * reported: a footer that says "sign in" trips `login` on every step of a run, so the flag itself
 * carries no information — its appearance and disappearance do.
 */
export function situationTransitions(
  before: readonly string[],
  after: readonly string[],
): SituationChange[] {
  const changes: SituationChange[] = [];
  for (const signal of SITUATION_SIGNALS) {
    const was = before.includes(signal);
    const is = after.includes(signal);
    if (is !== was) changes.push({ signal, appeared: is });
  }
  return changes;
}

const SITUATION_NAMES: Record<SituationSignal, { article: 'A' | 'An'; noun: string }> = {
  login: { article: 'A', noun: 'login wall' },
  captcha: { article: 'A', noun: 'CAPTCHA challenge' },
  otp: { article: 'A', noun: 'one-time-code (2FA) prompt' },
  'error-page': { article: 'An', noun: 'error page' },
  blocked: { article: 'A', noun: 'rate-limit or access-blocked page' },
};

// What to do about each, in the harness's voice. The advice repeats operating principles the system
// prompt already states, on purpose: the moment a login wall appears is when the rule about
// credentials matters, and a rule stated once thirty steps ago is not the rule in front of the model.
const SITUATION_ADVICE: Record<SituationSignal, string> = {
  login:
    'decide whether the task needs it or whether to ask for credentials through the secure channel',
  captcha: 'a human has to complete it — hand off with `ask`; never try to solve or bypass it',
  otp: 'request the code through `ask` with sensitive:true and the code field as targetId',
  'error-page':
    'read what it says before retrying; the same request will most likely fail the same way, so take another route or report it honestly',
  blocked:
    'do not keep hitting it — wait, take another route, or finish with what you have and say what blocked you',
};

/**
 * The harness note for one transition. `sinceStep` is the step whose page the comparison was made
 * against; absent on the very first page of a run, where there is nothing to have changed from.
 */
export function describeSituationChange(
  change: SituationChange,
  sinceStep: number | undefined,
): string {
  const { article, noun } = SITUATION_NAMES[change.signal];
  if (change.appeared) {
    const when =
      sinceStep === undefined ? 'is present on the first page' : `appeared since step ${sinceStep}`;
    return `${article} ${noun} ${when} — ${SITUATION_ADVICE[change.signal]}.`;
  }
  const seen = sinceStep === undefined ? 'seen earlier' : `seen at step ${sinceStep}`;
  return `The ${noun} ${seen} has cleared — carry on with the task from where it was interrupted.`;
}
