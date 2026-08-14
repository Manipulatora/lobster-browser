import type { AgentAction, AgentConfig } from '@lobster/shared-types';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { parse as parseDomain } from 'tldts';
import { isVettedBrowserConfigUrl } from './browser-config-guard.js';
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
    | 'coordinate-activation';
  reason: string;
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
    // composition-only from its attacker-controlled label. Semantic typing has its own verified
    // text-entry path; explicit click gestures therefore fail closed in every autonomy mode.
    return {
      kind: 'semantic-commit',
      reason: `page activation may immediately persist or invoke an uninspectable handler: ${el?.name || `element ${action.id}`}`,
    };
  }
  if (
    action.kind === 'browser_config' &&
    (action.op === 'set_downloads' ||
      action.op === 'set_theme' ||
      action.op === 'set_privacy' ||
      action.op === 'set_content_default')
  ) {
    return {
      kind: 'semantic-commit',
      reason: `persist browser setting: ${action.op.replaceAll('_', ' ')}`,
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

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host === 'localhost.localdomain' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'home.arpa' ||
    host.endsWith('.home.arpa') ||
    (isIP(host) === 0 && !host.includes('.')) ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1'
  ) {
    return true;
  }

  const ipv4 = parseIpv4(host);
  if (ipv4) {
    const [a, b] = ipv4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && ipv4[2] === 100) ||
      (a === 203 && b === 0 && ipv4[2] === 113) ||
      a >= 224
    );
  }

  // Parse IPv6 structurally. URL canonicalization commonly renders IPv4-mapped addresses in HEX
  // (`::ffff:7f00:1`), so matching only a dotted tail lets loopback/RFC1918 destinations bypass the
  // literal-IP guard. The byte form also handles compressed and mixed notation consistently.
  const ipv6 = parseIpv6(host);
  if (ipv6) {
    const allZero = ipv6.every((byte) => byte === 0);
    const loopback = ipv6.slice(0, 15).every((byte) => byte === 0) && ipv6[15] === 1;
    const ula = (ipv6[0]! & 0xfe) === 0xfc; // fc00::/7
    const linkOrSiteLocal = ipv6[0] === 0xfe && (ipv6[1]! & 0xc0) >= 0x80; // fe80::/10 + fec0::/10
    const multicast = ipv6[0] === 0xff; // ff00::/8
    const discardOnly = ipv6[0] === 0x01 && ipv6.slice(1, 8).every((byte) => byte === 0); // 100::/64
    const documentation =
      ipv6[0] === 0x20 && ipv6[1] === 0x01 && ipv6[2] === 0x0d && ipv6[3] === 0xb8;
    const teredo = ipv6[0] === 0x20 && ipv6[1] === 0x01 && ipv6[2] === 0x00 && ipv6[3] === 0x00; // 2001::/32
    const localNat64 =
      ipv6[0] === 0x00 &&
      ipv6[1] === 0x64 &&
      ipv6[2] === 0xff &&
      ipv6[3] === 0x9b &&
      ipv6[4] === 0x00 &&
      ipv6[5] === 0x01; // 64:ff9b:1::/48
    if (
      allZero ||
      loopback ||
      ula ||
      linkOrSiteLocal ||
      multicast ||
      discardOnly ||
      documentation ||
      teredo ||
      localNat64
    )
      return true;

    const embeddedIpv4 = (offset: number): boolean =>
      isPrivateIpv4([ipv6[offset]!, ipv6[offset + 1]!, ipv6[offset + 2]!, ipv6[offset + 3]!]);
    const firstTenZero = ipv6.slice(0, 10).every((byte) => byte === 0);
    const mapped = firstTenZero && ipv6[10] === 0xff && ipv6[11] === 0xff;
    const compatible = ipv6.slice(0, 12).every((byte) => byte === 0);
    if ((mapped || compatible) && embeddedIpv4(12)) return true;

    // Well-known NAT64 and 6to4 forms embed an IPv4 destination. Refuse private embedded targets too;
    // otherwise a textual public-looking IPv6 literal can still route to a local IPv4 service.
    const nat64 =
      ipv6[0] === 0x00 &&
      ipv6[1] === 0x64 &&
      ipv6[2] === 0xff &&
      ipv6[3] === 0x9b &&
      ipv6.slice(4, 12).every((byte) => byte === 0);
    if (nat64 && embeddedIpv4(12)) return true;
    const sixToFour = ipv6[0] === 0x20 && ipv6[1] === 0x02;
    if (sixToFour && embeddedIpv4(2)) return true;
  }
  return false;
}

/** Parse every RFC 4291 compressed/mixed IPv6 spelling into network-order bytes. */
function parseIpv6(value: string): Uint8Array | undefined {
  let address = value.toLowerCase().split('%', 1)[0] ?? '';
  if (!address.includes(':')) return undefined;

  // Convert a mixed dotted tail (`::ffff:127.0.0.1`) into two ordinary hextets first.
  const dotted = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) {
    const bytes = parseIpv4(dotted[1]!);
    if (!bytes) return undefined;
    const replacement = `${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${(
      (bytes[2]! << 8) |
      bytes[3]!
    ).toString(16)}`;
    address = `${address.slice(0, dotted.index)}${address[dotted.index] === ':' ? ':' : ''}${replacement}`;
  }

  if ((address.match(/::/g) ?? []).length > 1) return undefined;
  const compressed = address.includes('::');
  const [leftRaw, rightRaw = ''] = address.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  if ((!compressed && left.length !== 8) || (compressed && left.length + right.length >= 8)) {
    return undefined;
  }
  const groups = compressed
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const word = Number.parseInt(group, 16);
    bytes[index * 2] = word >>> 8;
    bytes[index * 2 + 1] = word & 0xff;
  });
  return bytes;
}

function isPrivateIpv4(bytes: ArrayLike<number>): boolean {
  const a = bytes[0]!;
  const b = bytes[1]!;
  const c = bytes[2]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
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

function parseIpv4(host: string): [number, number, number, number] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const values = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (values.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return values as [number, number, number, number];
}
