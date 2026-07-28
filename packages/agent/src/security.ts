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

export function describeSafeAction(action: AgentAction, perception?: RawPerception): string {
  const safe = redactAction(action, perception);
  switch (safe.kind) {
    case 'click':
      return `click element [${safe.id}]`;
    case 'click_at':
      return `click visual coordinate (${safe.x}, ${safe.y})`;
    case 'hover':
      return `hover element [${safe.id}]`;
    case 'type':
      return `type ${safe.text === '[REDACTED]' ? 'sensitive text' : JSON.stringify(clip(safe.text, 40))} into [${safe.id}]`;
    case 'type_at':
      return `type ${safe.text === '[REDACTED]' ? 'redacted text' : JSON.stringify(clip(safe.text, 40))} at visual coordinate (${safe.x}, ${safe.y})`;
    case 'select':
      return `select ${safe.values.join(', ')} in [${safe.id}]`;
    case 'drag':
      return `drag [${safe.fromId}] to [${safe.toId}]`;
    case 'upload':
      return `upload ${safe.paths.length} local file(s) through [${safe.id}]`;
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
