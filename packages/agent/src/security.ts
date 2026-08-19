import { createHash } from 'node:crypto';
import type { AgentAction } from '@lobster/shared-types';
import { REDACTED_SENSITIVE, redactCredentialLikeText } from './sensitive-text.js';
import type { PerceivedElement, RawPerception } from './types.js';

const SECRET_LABEL =
  /(pass(word|code)?|pin|otp|one[ -]?time|2fa|mfa|verification|security code|secret|token|api[ -]?key|cvv|cvc|card number|credit card|private key|seed phrase)/i;

export function isSensitiveElement(el: PerceivedElement | undefined): boolean {
  return Boolean(el?.sensitive || el?.type === 'password' || SECRET_LABEL.test(el?.name ?? ''));
}

export function elementForAction(
  action: AgentAction,
  perception: RawPerception,
): PerceivedElement | undefined {
  const id =
    'id' in action && typeof action.id === 'number'
      ? action.id
      : action.kind === 'drag'
        ? action.fromId
        : undefined;
  return id === undefined ? undefined : perception.elements.find((el) => el.index === id);
}

/** A copy safe for UI events, logs, model history, and disk. Execution must use the original. */
export function redactAction(action: AgentAction, perception?: RawPerception): AgentAction {
  // Scrub every free-text field first. Branches below add stronger channel-specific treatment, but a
  // new note, summary, dataset cell, or description must not silently become an unredacted event field
  // merely because it belongs to a different action variant.
  const safe = scrubCredentialStrings(action) as AgentAction;
  const typedCredential =
    (action.kind === 'type' || action.kind === 'type_at') &&
    redactCredentialLikeText(action.text).sensitive;
  if (
    safe.kind === 'type' &&
    (typedCredential || isSensitiveElement(elementForAction(safe, perception ?? empty())))
  ) {
    return { ...safe, text: '[REDACTED]' };
  }
  if (safe.kind === 'type_at') return { ...safe, text: '[REDACTED]' };
  if (safe.kind === 'upload') {
    return { ...safe, paths: safe.paths.map(() => '[LOCAL FILE]') };
  }
  if (safe.kind === 'navigate') {
    const originalUrl = action.kind === 'navigate' ? action.url : safe.url;
    return { ...safe, url: redactUrl(originalUrl) };
  }
  if (safe.kind === 'tab' && safe.url) {
    const originalUrl = action.kind === 'tab' ? action.url : safe.url;
    return { ...safe, url: redactUrl(originalUrl ?? safe.url) };
  }
  if (safe.kind === 'remember') {
    const key = redactCredentialLikeText(safe.factKey);
    const value = redactCredentialLikeText(safe.factValue);
    const labelledValue = redactCredentialLikeText(`${safe.factKey}: ${safe.factValue}`);
    return key.sensitive || value.sensitive || labelledValue.sensitive
      ? {
          ...safe,
          ...(key.sensitive ? { factKey: REDACTED_SENSITIVE } : {}),
          ...(value.sensitive || labelledValue.sensitive ? { factValue: REDACTED_SENSITIVE } : {}),
        }
      : safe;
  }
  if (safe.kind === 'learn') {
    const name = redactCredentialLikeText(safe.skillName);
    const trigger = redactCredentialLikeText(safe.skillTrigger);
    const steps = redactCredentialLikeText(safe.skillSteps);
    return name.sensitive || trigger.sensitive || steps.sensitive
      ? {
          ...safe,
          ...(name.sensitive ? { skillName: REDACTED_SENSITIVE } : {}),
          ...(trigger.sensitive ? { skillTrigger: REDACTED_SENSITIVE } : {}),
          ...(steps.sensitive ? { skillSteps: REDACTED_SENSITIVE } : {}),
        }
      : safe;
  }
  return safe;
}

function scrubCredentialStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactCredentialLikeText(value).text;
  if (Array.isArray(value)) return value.map(scrubCredentialStrings);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      scrubCredentialStrings(nested),
    ]),
  );
}

/**
 * Blank the secret-bearing fields of an action payload that FAILED to parse.
 *
 * {@link redactAction} cannot help here: it takes a parsed `AgentAction`, and on a parse failure there
 * is none. But the rejected payload still has to go back into the conversation — the model cannot fix a
 * call it is not shown — and a malformed `type`/`type_at`/`upload` can carry exactly the material the
 * redaction rules exist to keep out of history. So blank by KEY, unconditionally: an unparsed payload
 * has no trustworthy `kind` to decide on, and over-blanking a diagnosis costs nothing.
 */
export function redactRawActionInput(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (
      key === 'text' ||
      key === 'factKey' ||
      key === 'factValue' ||
      key === 'skillName' ||
      key === 'skillTrigger' ||
      key === 'skillSteps'
    )
      out[key] = '[REDACTED]';
    else if (key === 'paths') out[key] = '[LOCAL FILE]';
    else if (key === 'url' && typeof value === 'string') out[key] = redactUrl(value);
    else if (typeof value === 'string' && value.length > 200) out[key] = `${value.slice(0, 199)}…`;
    else out[key] = value;
  }
  return out;
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const [key, queryValue] of [...url.searchParams.entries()]) {
      if (
        /(token|code|key|secret|pass|session|auth|signature|credential|assertion)/i.test(key) ||
        redactCredentialLikeText(queryValue).sensitive
      ) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    let decodedPath = url.pathname;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      // The encoded spelling is still checked below.
    }
    if (redactCredentialLikeText(decodedPath).sensitive) url.pathname = '/[REDACTED]';
    if (
      /(access_token|id_token|token|code|secret|session)/i.test(url.hash) ||
      redactCredentialLikeText(url.hash).sensitive
    )
      url.hash = '#[REDACTED]';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    const structurallyRedacted = value.replace(
      /([?&#](?:token|code|key|secret|pass|session|auth|signature)=)[^&#]*/gi,
      '$1[REDACTED]',
    );
    return redactCredentialLikeText(structurallyRedacted).text;
  }
}

/**
 * Opaque, in-memory identity for a full browser URL. The model and event surfaces receive only the
 * redacted URL, but approval freshness must still notice a query, fragment, credential, or userinfo
 * change that redaction deliberately hides.
 */
export function urlIdentity(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Name an element, not just its index. `click element [3]` is the text a human is shown when asked to
 * approve an action — an index is meaningless to them, so approving became a formality. The label is
 * page-derived and therefore untrusted, so it is clipped and only ever used for display.
 */
function label(index: number | undefined, perception?: RawPerception): string {
  if (index === undefined) return '';
  const element = perception?.elements.find((el) => el.index === index);
  const name = element?.name?.trim();
  return name ? ` ${JSON.stringify(clip(name, 60))}` : '';
}

export function describeSafeAction(action: AgentAction, perception?: RawPerception): string {
  const safe = redactAction(action, perception);
  switch (safe.kind) {
    case 'click': {
      const gesture = `${safe.count === 2 ? 'double-' : ''}${safe.button === 'right' ? 'right-click' : 'click'}`;
      return `${gesture}${label(safe.id, perception)} [${safe.id}]`;
    }
    case 'click_at': {
      const gesture = `${safe.count === 2 ? 'double-' : ''}${safe.button === 'right' ? 'right-click' : 'click'}`;
      return `${gesture} visual coordinate (${safe.x}, ${safe.y})`;
    }
    case 'hover':
      return `hover${label(safe.id, perception)} [${safe.id}]`;
    case 'type':
      return `type ${safe.text === '[REDACTED]' ? 'sensitive text' : JSON.stringify(clip(safe.text, 40))} into${label(safe.id, perception)} [${safe.id}]${safe.submit ? ' and press Enter' : ''}`;
    case 'type_at':
      return `type ${safe.text === '[REDACTED]' ? 'redacted text' : JSON.stringify(clip(safe.text, 40))} at visual coordinate (${safe.x}, ${safe.y})${safe.submit ? ' and press Enter' : ''}`;
    case 'select':
      return `select ${safe.values.map((value) => JSON.stringify(clip(value, 60))).join(', ')} in${label(safe.id, perception)} [${safe.id}]`;
    case 'key':
      return `press ${safe.key === ' ' ? 'Space' : JSON.stringify(safe.key)}`;
    case 'drag':
      return `drag${label(safe.fromId, perception)} [${safe.fromId}] to${label(safe.toId, perception)} [${safe.toId}]`;
    case 'upload':
      return `upload ${safe.paths.length} local file(s) through${label(safe.id, perception)} [${safe.id}]`;
    case 'navigate':
      return `navigate to ${safe.url}`;
    case 'tab':
      return safe.operation === 'new' && safe.url
        ? `open a new tab at ${safe.url}`
        : `${safe.operation} tab${safe.tabId ? ` ${safe.tabId}` : safe.index === undefined ? '' : ` ${safe.index}`}`;
    case 'browser_config': {
      const where = safe.origin ?? safe.domain;
      const newValue = safe.values?.join(', ') ?? safe.value;
      const detail = safe.pref
        ? ` ${safe.pref}${safe.op === 'set_pref' && newValue ? ` → ${clip(newValue, 120)}` : ''}`
        : safe.op === 'set_permission'
          ? ` ${safe.permission ?? ''} → ${safe.setting ?? 'prompt'}${where ? ` for ${where}` : ''}`
          : safe.op === 'set_downloads'
            ? ` → ${safe.behavior ?? 'default'}`
            : where
              ? ` for ${where}`
              : '';
      return `browser setting: ${safe.op.replace(/_/g, ' ')}${detail}`.trim();
    }
    case 'remember':
      return `remember ${JSON.stringify(clip(safe.factKey, 80))} = ${JSON.stringify(clip(safe.factValue, 120))}`;
    case 'learn':
      return `save learned procedure ${JSON.stringify(clip(safe.skillName, 60))} for ${JSON.stringify(clip(safe.skillTrigger, 100))}: ${JSON.stringify(clip(safe.skillSteps, 160))}`;
    default:
      return safe.kind;
  }
}

function clip(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function empty(): RawPerception {
  return {
    url: '',
    title: '',
    scrollY: 0,
    viewportH: 0,
    docH: 0,
    canScrollUp: false,
    canScrollDown: false,
    elements: [],
    truncated: 0,
  };
}
