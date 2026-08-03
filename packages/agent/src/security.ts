import type { AgentAction } from '@lobster/shared-types';
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
  if (
    action.kind === 'type' &&
    isSensitiveElement(elementForAction(action, perception ?? empty()))
  ) {
    return { ...action, text: '[REDACTED]', ...(action.note ? { note: '[redacted]' } : {}) };
  }
  if (action.kind === 'type_at')
    return { ...action, text: '[REDACTED]', ...(action.note ? { note: '[redacted]' } : {}) };
  if (action.kind === 'upload') {
    return { ...action, paths: action.paths.map(() => '[LOCAL FILE]') };
  }
  if (action.kind === 'navigate') return { ...action, url: redactUrl(action.url) };
  if (action.kind === 'tab' && action.url) return { ...action, url: redactUrl(action.url) };
  return action;
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
    if (key === 'text' || key === 'factValue') out[key] = '[REDACTED]';
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
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|code|key|secret|pass|session|auth|signature|credential|assertion)/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    if (/(access_token|id_token|token|code|secret|session)/i.test(url.hash))
      url.hash = '#[REDACTED]';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value.replace(
      /([?&#](?:token|code|key|secret|pass|session|auth|signature)=)[^&#]*/gi,
      '$1[REDACTED]',
    );
  }
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
    case 'click':
      return `click${label(safe.id, perception)} [${safe.id}]`;
    case 'click_at':
      return `click visual coordinate (${safe.x}, ${safe.y})`;
    case 'hover':
      return `hover${label(safe.id, perception)} [${safe.id}]`;
    case 'type':
      return `type ${safe.text === '[REDACTED]' ? 'sensitive text' : JSON.stringify(clip(safe.text, 40))} into${label(safe.id, perception)} [${safe.id}]`;
    case 'type_at':
      return `type ${safe.text === '[REDACTED]' ? 'redacted text' : JSON.stringify(clip(safe.text, 40))} at visual coordinate (${safe.x}, ${safe.y})`;
    case 'select':
      return `select ${safe.values.join(', ')} in${label(safe.id, perception)} [${safe.id}]`;
    case 'drag':
      return `drag [${safe.fromId}] to [${safe.toId}]`;
    case 'upload':
      return `upload ${safe.paths.length} local file(s) through${label(safe.id, perception)} [${safe.id}]`;
    case 'navigate':
      return `navigate to ${safe.url}`;
    case 'tab':
      return `${safe.operation} tab${safe.index === undefined ? '' : ` ${safe.index}`}`;
    case 'browser_config': {
      const where = safe.origin ?? safe.domain;
      const detail =
        safe.op === 'set_permission'
          ? ` ${safe.permission ?? ''} → ${safe.setting ?? 'prompt'}`
          : safe.op === 'set_downloads'
            ? ` → ${safe.behavior ?? 'default'}`
            : where
              ? ` for ${where}`
              : '';
      return `browser setting: ${safe.op.replace(/_/g, ' ')}${detail}`.trim();
    }
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
