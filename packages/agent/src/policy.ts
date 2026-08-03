import type { AgentAction, AgentConfig } from '@lobster/shared-types';
import type { PerceivedElement, RawPerception } from './types.js';

export type PolicyDecision =
  | { verdict: 'allow' }
  | { verdict: 'confirm'; reason: string }
  | { verdict: 'deny'; reason: string };

const HIGH_RISK =
  /\b(delete|remove|erase|deactivate|close account|cancel subscription|purchase|buy now|pay|place order|submit order|send money|transfer|wire|publish|post|send|create account|sign up|register|accept terms|agree and|confirm booking|book now)\b/i;

export function normalizeAllowedDomains(domains: readonly string[] | undefined): string[] {
  if (!domains) return [];
  const out = new Set<string>();
  for (const entry of domains) {
    const candidate = entry.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
    if (
      !candidate ||
      candidate.includes('/') ||
      candidate.includes(':') ||
      candidate.includes(' ')
    ) {
      throw new Error(`invalid allowed domain: ${JSON.stringify(entry)}`);
    }
    if (!/^[a-z0-9.-]+$/.test(candidate) || candidate.startsWith('.') || candidate.endsWith('.')) {
      throw new Error(`invalid allowed domain: ${JSON.stringify(entry)}`);
    }
    out.add(candidate);
  }
  return [...out];
}

export function isDomainAllowed(hostname: string, allowedDomains: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return allowedDomains.some((entry) => host === entry || host.endsWith(`.${entry}`));
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
      a >= 224
    );
  }

  // IPv6 loopback, unspecified, ULA, link-local, and IPv4-mapped private addresses.
  if (host.includes(':')) {
    if (/^(fc|fd)/i.test(host) || /^fe[89ab]/i.test(host)) return true;
    const mapped = host.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    return mapped ? isPrivateHostname(mapped[1] as string) : false;
  }
  return false;
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
 * the run on every coordinate click — un-inspectable, but harmless and reversible — and on every
 * keystroke into an amount field. Blocking the COMMIT and not the COMPOSITION is the line: typing an
 * amount is not consequential, pressing "Send money" is.
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
  if (action.kind === 'click_at' || action.kind === 'type_at') {
    // Un-inspectable, but reversible: worth flagging, not worth stopping an unattended run for.
    return {
      high: true,
      consequential: false,
      reason: 'coordinate fallback has no inspectable DOM semantics',
    };
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
  const words = `${el?.name ?? ''} ${'note' in action ? (action.note ?? '') : ''}`;
  if ((action.kind === 'click' || action.kind === 'key') && HIGH_RISK.test(words)) {
    return {
      high: true,
      consequential: true,
      reason: `this looks irreversible or externally visible: ${el?.name || action.kind}`,
    };
  }
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
