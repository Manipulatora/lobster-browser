/**
 * What stands between a parsed action and its dispatch: the rewrites and fingerprints the policy
 * gates compare, the settings-surface screening inputs, and the navigation identity checks. Every
 * helper here is deterministic over an action and an observation — the decisions themselves stay
 * in the loop, where the order of the gates is the contract.
 */
import type { AgentAction } from '@lobster/shared-types';
import { urlIdentity } from '../security.js';
import { siteNamedIn } from '../site-families.js';
import type { RawPerception } from '../types.js';
import { observationFingerprint } from './observe.js';

/**
 * A wipe-all is site-scoped BY CONSTRUCTION. "Remove all cookies of outlook.com" reads, to a model,
 * as "all cookies" — and clear_all_cookies signs the user out of every site in an anti-detect
 * profile, irreversibly. Whether that is what the user meant is not a judgment call the model gets to
 * make: if the request names a site, the action becomes that site's clear_session; only a request
 * that names no site at all ("clear all cookies", "log me out everywhere") keeps the wipe-all.
 */
export function scopeWipeAllToNamedSite(action: AgentAction, task: string): AgentAction {
  if (action.kind !== 'browser_config' || action.op !== 'clear_all_cookies') return action;
  const site = siteNamedIn(task);
  if (!site) return action;
  return {
    kind: 'browser_config',
    op: 'clear_session',
    site,
    note: `scoped to ${site}: the request named that site, so its session is cleared and every other site's is kept`,
    ...(action.plan ? { plan: action.plan } : {}),
  };
}

/** The action minus the model's memo: a fresh `plan` on the same gesture must not read as a new gesture. */
function actionIdentity(action: AgentAction): string {
  return JSON.stringify({ ...action, plan: undefined });
}

export function canonicalNavigationUrl(rawUrl: string, baseUrl: string): string | undefined {
  try {
    return new URL(rawUrl, baseUrl || undefined).toString();
  } catch {
    return undefined;
  }
}

/** True when two destinations identify the same protocol/host/port authority. */
export function sameNavigationAuthority(first: string, second: string, baseUrl: string): boolean {
  try {
    return (
      new URL(first, baseUrl || undefined).origin === new URL(second, baseUrl || undefined).origin
    );
  } catch {
    return false;
  }
}

export function isSettingsUiAction(action: AgentAction): boolean {
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

export function settingsActionIntent(
  action: AgentAction,
  raw: RawPerception,
): Array<string | undefined> {
  const values: Array<string | undefined> = ['note' in action ? action.note : undefined];
  const elementName = (index: number | undefined): string | undefined =>
    index === undefined ? undefined : raw.elements.find((element) => element.index === index)?.name;
  switch (action.kind) {
    case 'click':
    case 'hover':
      values.push(elementName(action.id));
      break;
    case 'select':
      // The chosen option is the whole intent of a select: the control may be named "Language" or
      // "Time zone" innocuously enough, but it is the value that changes the persona.
      values.push(elementName(action.id), ...action.values);
      break;
    case 'type':
      values.push(elementName(action.id), action.text);
      break;
    case 'type_at':
      values.push(action.text);
      break;
    case 'key':
      // Space and Enter activate whatever currently holds focus, so the key alone says nothing
      // about what is being toggled. Screen the focused control's own name too.
      values.push(action.key, raw.elements.find((element) => element.focused)?.name);
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
 * Ephemeral binding for a confirmation prompt. This deliberately includes more than the normal
 * observation-deduplication fingerprint: target coordinates, form semantics, focus, hrefs, visible
 * page text, and viewport geometry all affect what an approved click/key/coordinate gesture will do.
 * Coordinate actions additionally require byte-identical fresh screenshot data immediately before
 * dispatch, covering canvas and cross-origin content that DOM perception cannot see. The value is
 * compared in memory only; action text (which may be secret) is never persisted or logged.
 */
export function approvalContextFingerprint(action: AgentAction, raw: RawPerception): string {
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
 * Two different questions, previously answered by one counter keyed on URL + action.
 *
 * "Stuck" is the same action against a page that did not move at all — the real no-progress
 * signal, and cheap to stop early. "Repeating" is the same action while the page KEEPS
 * CHANGING, which is what reading an infinite list, polling for late-arriving content, or
 * paging through an SPA that never changes its URL all look like. Killing the second case at
 * the fifth attempt made an explicitly supported scenario impossible: five scrolls down a feed
 * ended the run as a loop even though every scroll had appended new rows. It still cannot go on
 * forever — a page with a ticking clock would otherwise never look stuck — so it keeps a much
 * looser bound of its own, under the run's step and token ceilings.
 */
export interface RepeatDetector {
  /** Count this step's gesture; each counter restarts at 1 when its fingerprint changes. */
  note: (
    raw: RawPerception,
    safeAction: AgentAction,
  ) => { stuckCount: number; repeatCount: number };
}

export function createRepeatDetector(): RepeatDetector {
  let lastFingerprint = '';
  let repeatCount = 0;
  /** Same action AND an unchanged page: the genuine no-progress signal. */
  let lastStateFingerprint = '';
  let stuckCount = 0;
  return {
    note(raw, safeAction) {
      const actionFingerprint = `${raw.url}|${actionIdentity(safeAction)}`;
      const stateFingerprint = `${observationFingerprint(raw)}|${actionIdentity(safeAction)}`;
      stuckCount = stateFingerprint === lastStateFingerprint ? stuckCount + 1 : 1;
      repeatCount = actionFingerprint === lastFingerprint ? repeatCount + 1 : 1;
      lastStateFingerprint = stateFingerprint;
      lastFingerprint = actionFingerprint;
      return { stuckCount, repeatCount };
    },
  };
}
