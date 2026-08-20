import type { AgentAction, AgentConfig } from '@lobster/shared-types';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { parse as parseDomain } from 'tldts';
import { normalizeActionKey } from './actions.js';
import { isPrivateHostname } from './private-network.js';
import { isVettedBrowserConfigUrl } from './browser-config-guard.js';

export { isPrivateHostname };
import type { PerceivedElement, RawPerception } from './types.js';

export type PolicyDecision =
  | { verdict: 'allow' }
  | { verdict: 'confirm'; reason: string }
  | { verdict: 'deny'; reason: string };

const HIGH_RISK =
  /\b(delete|destroy|trash|discard|remove|erase|deactivate|close account|cancel subscription|purchase|buy now|pay|place order|submit order|send money|transfer|wire|publish|post|send|share|save|confirm|submit|checkout|authorize|approve|create account|sign up|register|sign in|log in|log out|sign out|unsubscribe|subscribe|follow|connect|invite|apply now|submit application|accept terms|agree and|confirm booking|book now)\b/i;

/** Operations whose appearance in a destination path/query is itself a commit warning. */
const CONSEQUENTIAL_URL =
  /\b(delete|destroy|trash|discard|erase|deactivate|close account|cancel (?:subscription|order)|place order|submit (?:order|application)|send money|transfer (?:money|funds?)|publish|create account|accept terms|confirm booking|book now|log ?out|sign ?out|unsubscribe)\b/i;

/**
 * A browser gesture which may cross the composition/commit boundary.  This classification is kept
 * separate from the broader risk score on purpose: the model's choice of action must never be able to
 * hide a submit behind a generic `type`, `key`, `select`, or coordinate primitive.
 */
export interface CommitIntent {
  kind:
    | 'semantic-commit'
    | 'form-submit'
    | 'explicit-submit'
    | 'keyboard-activation'
    | 'selection-change'
    | 'drag-drop'
    | 'coordinate-activation'
    | 'opaque-activation';
  reason: string;
}

/**
 * Keys whose whole purpose is to move around the page rather than to act on it.
 *
 * Everything else — Enter, Space, Tab, Delete, Backspace, a letter — can submit a form, activate the
 * focused control, or blur-save a field, so it stays on the always-gated side.
 */
const NAVIGATION_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Escape',
]);

/**
 * Must a human authorize this gesture even when the run was started as unattended (`auto`)?
 *
 * `auto` promises the agent does not stop to check its work; it never promised it may spend money or
 * delete an account. But treating EVERY classified gesture alike collapsed the distinction the panel
 * toggle advertises: an ordinary click on an ordinary button gated too, so a twenty-step task fired
 * about ten modals in the mode named "Auto", and a run genuinely left alone died at the first click
 * when the human-input wait timed out. `opaque-activation` marks the gestures whose only evidence of
 * risk is that page JavaScript is unreadable — true of every click on the web. Those defer to the
 * autonomy setting. Everything else — a form submit, an explicit Enter, a coordinate gesture, a
 * high-risk label, a consequential destination — gates regardless.
 */
export function commitIntentGatesUnattended(intent: CommitIntent): boolean {
  return intent.kind !== 'opaque-activation';
}

/**
 * Determine whether an action can immediately publish, submit, persist, or otherwise produce an
 * externally visible effect.  Ambiguous primitives fail closed when the browser does not expose
 * enough semantics to distinguish composition from commitment:
 *
 * - a coordinate click can activate any control under that pixel;
 * - Enter/Space can submit a form or activate the focused control (including one omitted by the
 *   bounded element list);
 * - changing a select dispatches `input`/`change`, and sites commonly persist or submit from those
 *   handlers.  Browser APIs do not provide a complete, framework-independent listener inventory.
 *
 * Ordinary semantic typing into a known text-entry control without `submit`, navigation, scrolling,
 * and non-activation keys remain outside the commit boundary.
 */
export function actionCommitIntent(
  action: AgentAction,
  perception: RawPerception,
): CommitIntent | undefined {
  const el = elementFor(action, perception);
  const words = `${el?.name ?? ''} ${'note' in action ? (action.note ?? '') : ''}`;
  const destination = targetUrlForAction(action, perception);
  const dangerousDestination = destination
    ? consequentialUrlKeyword(destination, perception.url)
    : undefined;

  if (dangerousDestination) {
    return {
      kind: 'semantic-commit',
      reason: `destination URL names a consequential operation (${dangerousDestination})`,
    };
  }

  if (action.kind === 'click_at') {
    return {
      kind: 'coordinate-activation',
      reason: 'coordinate click may activate an uninspectable commit control',
    };
  }
  if (action.kind === 'type_at') {
    return {
      kind: action.submit ? 'explicit-submit' : 'coordinate-activation',
      reason: action.submit
        ? 'coordinate typing explicitly presses Enter and may submit the current form'
        : 'coordinate typing first clicks an uninspectable target that may be a commit control',
    };
  }
  if (action.kind === 'type' && action.submit) {
    return {
      kind: 'explicit-submit',
      reason: 'typing action explicitly presses Enter and may submit the current form',
    };
  }
  if (action.kind === 'type' && /[\r\n\t]/.test(action.text)) {
    return {
      kind: 'keyboard-activation',
      reason:
        'typed text contains Enter or Tab control keys that may submit or activate another control',
    };
  }
  if (action.kind === 'type' && el && !isTextEntryElement(el)) {
    return {
      kind: 'semantic-commit',
      reason: `typing would first activate non-text ${el.role} ${JSON.stringify(el.name)}`,
    };
  }
  if (action.kind === 'key') {
    const focused = perception.elements.find((candidate) => candidate.focused);
    if (NAVIGATION_KEYS.has(normalizeActionKey(action.key) ?? action.key)) {
      return {
        kind: 'opaque-activation',
        reason: `${action.key} moves within the page, but a site may still bind it to a shortcut`,
      };
    }
    return {
      kind: 'keyboard-activation',
      reason: focused
        ? `${action.key} may activate, change, or blur-save focused ${focused.role} ${JSON.stringify(focused.name)}`
        : `${action.key} may trigger a page shortcut or activate an unobserved focused control`,
    };
  }
  if (action.kind === 'select') {
    return {
      kind: 'selection-change',
      reason: 'changing a selection may immediately submit or persist through a change handler',
    };
  }
  if (action.kind === 'drag') {
    const destinationElement = perception.elements.find(
      (candidate) => candidate.index === action.toId,
    );
    const dragWords = `${destinationElement?.name ?? ''} ${action.note ?? ''}`;
    return {
      kind: 'drag-drop',
      reason: HIGH_RISK.test(dragWords)
        ? `drag destination looks irreversible or externally visible: ${destinationElement?.name || `element ${action.toId}`}`
        : `dropping on ${destinationElement?.name ? JSON.stringify(destinationElement.name) : `element ${action.toId}`} may immediately persist through an uninspectable drop handler`,
    };
  }
  if (action.kind === 'click') {
    if (el?.submitsForm || el?.type === 'submit' || el?.type === 'image') {
      return {
        kind: 'form-submit',
        reason: `activate form submit control: ${el.name || `element ${action.id}`}`,
      };
    }
    if (HIGH_RISK.test(words)) {
      return {
        kind: 'semantic-commit',
        reason: `this looks irreversible or externally visible: ${el?.name || action.kind}`,
      };
    }
    // Page JavaScript is opaque to the harness. A generic-looking button, checkbox, label, or even
    // context-menu handler can send/persist/delete immediately, so page activation cannot be proved
    // composition-only from its attacker-controlled label. That is a reason to TELL the human, not a
    // reason to stop an unattended run: it is true of every click on the web, so gating on it alone
    // meant "Auto" gated as often as "Review" and no run could proceed without a human.
    return {
      kind: 'opaque-activation',
      reason: `page activation may immediately persist or invoke an uninspectable handler: ${el?.name || `element ${action.id}`}`,
    };
  }
  if (
    action.kind === 'browser_config' &&
    (action.op === 'set_downloads' ||
      action.op === 'set_pref' ||
      action.op === 'set_theme' ||
      action.op === 'set_privacy' ||
      action.op === 'set_content_default')
  ) {
    return {
      kind: 'semantic-commit',
      reason: `persist browser setting: ${action.pref ?? action.op.replaceAll('_', ' ')}`,
    };
  }
  if (action.kind === 'remember' || action.kind === 'learn') {
    return {
      kind: 'semantic-commit',
      reason:
        action.kind === 'learn'
          ? 'save a model-authored procedure into future runs for this site'
          : 'save a model-authored fact into future runs for this site',
    };
  }
  return undefined;
}

/** True only for controls the semantic `type` primitive may safely focus before entering text. */
export function isTextEntryElement(element: PerceivedElement): boolean {
  // Native activation controls keep their native behavior even when a page supplies a conflicting
  // ARIA role. Trusting `<button role="textbox">` here lets `type` click and submit it before any text
  // is entered, bypassing both the semantic click gate and the executor's text-target check.
  if (element.submitsForm || /^(a|button|select|summary|label|option)$/i.test(element.tag)) {
    return false;
  }
  if (element.tag === 'textarea') return true;
  if (element.tag === 'input') {
    return !/^(button|submit|reset|checkbox|radio|file|image|range|color|hidden)$/i.test(
      element.type ?? 'text',
    );
  }
  // ARIA describes accessibility behavior; it does not make a node editable. Requiring the browser's
  // `isContentEditable` result prevents a plain `<div role="textbox" onclick="…">` from using `type`
  // to smuggle an activation click past the commit gate.
  return (
    element.editable === true &&
    (element.role === 'textbox' ||
      element.role === 'searchbox' ||
      element.role === 'spinbutton' ||
      element.role === 'combobox')
  );
}

export function normalizeAllowedDomains(domains: readonly string[] | undefined): string[] {
  if (!domains) return [];
  const out = new Set<string>();
  for (const entry of domains) {
    out.add(normalizeAllowedDomain(entry));
  }
  return [...out];
}

export function isDomainAllowed(hostname: string, allowedDomains: readonly string[]): boolean {
  const host = canonicalHostname(hostname);
  if (!host) return false;
  return allowedDomains.some((rawEntry) => {
    try {
      const entry = normalizeAllowedDomain(rawEntry);
      return host === entry || (isIP(entry) === 0 && host.endsWith(`.${entry}`));
    } catch {
      // AgentConfig normally passes through resolveConfig first, but this exported helper also
      // accepts direct callers. A malformed or overly broad raw fence must fail closed, not match.
      return false;
    }
  });
}

/** Canonicalize and validate one explicitly configured domain-fence boundary. */
function normalizeAllowedDomain(entry: string): string {
  if (typeof entry !== 'string') {
    throw new Error(`invalid allowed domain: ${JSON.stringify(entry)}`);
  }
  const withoutWildcard = entry.trim().replace(/^\*\./, '');
  if (withoutWildcard.endsWith('..')) {
    throw new Error(`invalid allowed domain: ${JSON.stringify(entry)}`);
  }
  const candidate = withoutWildcard.endsWith('.') ? withoutWildcard.slice(0, -1) : withoutWildcard;
  const canonical = canonicalHostname(candidate);
  if (!canonical) {
    throw new Error(`invalid allowed domain: ${JSON.stringify(entry)}`);
  }

  if (isIP(canonical) === 0) {
    const parsed = parseDomain(canonical, {
      allowPrivateDomains: true,
      detectSpecialUse: true,
    });
    const deliberatelyLocal = canonical === 'localhost';
    const unregisteredSingleLabel =
      !canonical.includes('.') &&
      parsed.isIcann !== true &&
      parsed.isPrivate !== true &&
      parsed.isSpecialUse !== true;

    // `domain === null` means the candidate itself is a PSL boundary. Private PSL entries are just
    // as important as ICANN ones here: allowing `github.io`, for example, would grant every tenant.
    // Keep explicit localhost and unknown single-label private DNS names such as `intranet` usable.
    if (parsed.domain === null && !deliberatelyLocal && !unregisteredSingleLabel) {
      throw new Error(`allowed domain is too broad to identify a site: ${JSON.stringify(entry)}`);
    }
  }
  return canonical;
}

/** Return lower-case ASCII/IDNA hostname form, or undefined for malformed host input. */
function canonicalHostname(raw: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  const candidate = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  if (!candidate) return undefined;

  const bracketedIpv6 = /^\[([^\]]+)\]$/.exec(candidate);
  const ipCandidate = bracketedIpv6?.[1] ?? candidate;
  const ipVersion = isIP(ipCandidate);
  if (ipVersion === 4) return ipCandidate;
  if (ipVersion === 6) {
    try {
      // URL supplies one stable compressed spelling, so bracketed URL.hostnames and user-entered
      // unbracketed literals compare identically.
      return new URL(`http://[${ipCandidate}]/`).hostname.slice(1, -1).toLowerCase();
    } catch {
      return undefined;
    }
  }
  if (bracketedIpv6 || /[:/\\@?#\s]/u.test(candidate)) return undefined;

  const ascii = domainToASCII(candidate).toLowerCase();
  if (!ascii || ascii.length > 253 || ascii.startsWith('.') || ascii.endsWith('.'))
    return undefined;
  const labels = ascii.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return undefined;
  }
  return ascii;
}

export function assessNavigation(
  rawUrl: string,
  currentUrl: string,
  config: AgentConfig,
): PolicyDecision {
  let url: URL;
  try {
    url = new URL(rawUrl, currentUrl || undefined);
  } catch {
    return { verdict: 'deny', reason: 'the destination is not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      verdict: 'deny',
      reason: `the ${url.protocol || 'unknown'} URL scheme is not allowed`,
    };
  }
  if (!config.allowPrivateNetwork && isPrivateHostname(url.hostname)) {
    return { verdict: 'deny', reason: `private or local destination ${url.hostname} is blocked` };
  }
  const allowed = config.allowedDomains ?? [];
  if (allowed.length > 0 && !isDomainAllowed(url.hostname, allowed)) {
    return { verdict: 'deny', reason: `${url.hostname} is outside the allowed-domain fence` };
  }

  const current = safeUrl(currentUrl);
  const crossing = current && current.hostname !== url.hostname;
  if (crossing) {
    switch (config.crossDomainNavigation) {
      case 'deny':
        return {
          verdict: 'deny',
          reason: `cross-domain navigation to ${url.hostname} is disabled`,
        };
      case 'confirm':
        return { verdict: 'confirm', reason: `leave ${current.hostname} for ${url.hostname}` };
      default:
        break;
    }
  }
  return { verdict: 'allow' };
}

/**
 * Apply the destination fence to an already-open page. A tab can be outside the fence before a run
 * starts, or can self-navigate between agent steps without any harness action; checking only proposed
 * navigation therefore is not a complete boundary. Only the empty lazy-driver state, exact
 * `about:blank`, and explicitly vetted browser-configuration pages may sit outside HTTP(S). Allowing
 * arbitrary non-web schemes here would let an already-open `file:`, `data:`, `blob:`, or extension
 * page expose its contents to the model even though navigation to that same URL is forbidden.
 */
export function assessCurrentPage(rawUrl: string, config: AgentConfig): PolicyDecision {
  // No page exists yet for a lazy driver. This is not an invalid destination: the first actual browser
  // action will launch a blank tab and pass through the ordinary navigation policy.
  if (!rawUrl.trim()) return { verdict: 'allow' };
  const current = safeUrl(rawUrl);
  if (!current) return { verdict: 'deny', reason: 'the current page URL is not valid' };
  if (current.protocol === 'http:' || current.protocol === 'https:') {
    return assessNavigation(current.toString(), current.toString(), config);
  }
  if (current.protocol === 'about:' && current.pathname === 'blank') return { verdict: 'allow' };
  if (isVettedBrowserConfigUrl(current.toString())) return { verdict: 'allow' };
  return {
    verdict: 'deny',
    reason: `the current page uses a blocked ${current.protocol || 'unknown'} URL scheme`,
  };
}

/**
 * Judge where an action UNEXPECTEDLY left the browser, as opposed to where it asked to go.
 *
 * These are different questions and were being answered by the same function. Proposed navigation is
 * a destination the run chose, so `about:blank` there is a malformed request. Drift is wherever the
 * browser ended up, and landing on the empty page is a routine consequence of ordinary tab work: the
 * driver switches to a surviving tab when the active one is closed, `tab new` without a URL opens
 * blank, and a page can open a blank popup. Treating that as a navigation policy violation ended the
 * run with an error AND performed a journaled "rollback" — an unrequested navigation of the tab the
 * user was left on — for a page that {@link assessCurrentPage} already accepts as safe to sit on and
 * that perception already replaces with a synthetic blank page carrying none of its inherited DOM.
 *
 * Everything else still goes through the full fence: scheme, domain allowlist, private network, and
 * cross-domain autonomy.
 */
export function assessNavigationDrift(
  afterUrl: string,
  beforeUrl: string,
  config: AgentConfig,
): PolicyDecision {
  const after = safeUrl(afterUrl);
  if (after && after.protocol === 'about:' && after.pathname === 'blank') {
    return { verdict: 'allow' };
  }
  return assessNavigation(afterUrl, beforeUrl, config);
}

export function targetUrlForAction(
  action: AgentAction,
  perception: RawPerception,
): string | undefined {
  if (action.kind === 'navigate') return action.url;
  if (action.kind === 'tab' && action.operation === 'new' && action.url) return action.url;
  if (action.kind !== 'click') return undefined;
  return perception.elements.find((el) => el.index === action.id)?.href;
}

/**
 * `high` means "worth telling the model about". `consequential` is the stricter, blocking class: the
 * action leaves the machine or destroys something, so it cannot be taken back by re-reading the page.
 *
 * The distinction is what makes a confirm gate usable in `auto`. Blocking everything `high` would stop
 * every keystroke into an amount field even though it only composes a value. Blocking the COMMIT and
 * not the COMPOSITION is the line: typing an amount is not consequential; submitting it, pressing
 * "Send money", or using an uninspectable coordinate is.
 */
export interface ActionRisk {
  high: boolean;
  /** Irreversible or externally visible. Gated in EVERY autonomy mode, including `auto`. */
  consequential: boolean;
  reason?: string;
}

export function actionRisk(action: AgentAction, perception: RawPerception): ActionRisk {
  if (action.kind === 'upload') {
    return { high: true, consequential: true, reason: 'upload local files to a website' };
  }
  const commit = actionCommitIntent(action, perception);
  if (commit) {
    return { high: true, consequential: true, reason: commit.reason };
  }
  if (action.kind === 'browser_config') {
    if (
      action.op === 'clear_cookies' ||
      action.op === 'clear_all_cookies' ||
      action.op === 'clear_site_data'
    ) {
      return {
        high: true,
        consequential: true,
        reason: `erase stored data (${action.domain ?? action.origin ?? 'a site'})`,
      };
    }
    if (action.op === 'set_permission') {
      return {
        high: true,
        consequential: true,
        reason: `change a site permission (${action.permission ?? '?'})`,
      };
    }
    return { high: false, consequential: false };
  }
  const el = elementFor(action, perception);
  if (
    action.kind === 'type' &&
    /message|comment|post|recipient|amount|price/i.test(el?.name ?? '')
  ) {
    // Composing is not committing — the submit that follows is what gets gated.
    return {
      high: true,
      consequential: false,
      reason: `enter data into consequential field: ${el?.name || el?.role}`,
    };
  }
  return { high: false, consequential: false };
}

function elementFor(action: AgentAction, perception: RawPerception): PerceivedElement | undefined {
  if ('id' in action && typeof action.id === 'number') {
    return perception.elements.find((el) => el.index === action.id);
  }
  return undefined;
}

function consequentialUrlKeyword(rawUrl: string, currentUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl, currentUrl || undefined);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const encoded = `${url.pathname} ${url.search}`.replace(/\+/g, ' ');
  let decoded = encoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    // A malformed escape still leaves the raw path available for conservative keyword matching.
  }
  const words = decoded.replace(/[^a-z0-9]+/gi, ' ').trim();
  return CONSEQUENTIAL_URL.exec(words)?.[0]?.toLowerCase();
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
