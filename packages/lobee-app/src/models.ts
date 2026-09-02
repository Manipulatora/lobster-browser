import type { Effort, ModelInfo } from './types';

export const ALL_EFFORTS: Effort[] = ['low', 'medium', 'high'];
export const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High' };

// Offline fallback roster (used before the live sync lands or when the bridge is unreachable).
// Pinned to the seven managed models, in roster order; the backend remains the source of truth.
export const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: 'openai/gpt-5.6-sol',
    label: 'GPT 5.6 Sol',
    brand: 'openai',
    efforts: ALL_EFFORTS,
    available: false,
    agentCapable: false,
  },
  {
    id: 'openai/gpt-5.6-terra',
    label: 'GPT 5.6 Terra',
    brand: 'openai',
    efforts: ALL_EFFORTS,
    available: false,
    agentCapable: false,
  },
  {
    id: 'openai/gpt-5.6-luna',
    label: 'GPT 5.6 Luna',
    brand: 'openai',
    efforts: ALL_EFFORTS,
    available: false,
    agentCapable: false,
  },
  {
    id: 'anthropic/claude-fable-5',
    label: 'Claude Fable 5',
    brand: 'anthropic',
    efforts: ALL_EFFORTS,
    available: false,
    agentCapable: false,
  },
  {
    id: 'anthropic/claude-opus-5',
    label: 'Claude Opus 5',
    brand: 'anthropic',
    efforts: ALL_EFFORTS,
    available: false,
    agentCapable: false,
  },
  {
    id: 'anthropic/claude-opus-4.8',
    label: 'Claude Opus 4.8',
    brand: 'anthropic',
    efforts: ALL_EFFORTS,
    available: false,
    agentCapable: false,
  },
  {
    id: 'anthropic/claude-sonnet-5',
    label: 'Claude Sonnet 5',
    brand: 'anthropic',
    efforts: ALL_EFFORTS,
    available: false,
    agentCapable: false,
  },
];

const BRAND_TITLE: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Claude',
  google: 'Google',
  'x-ai': 'xAI',
};
export const brandTitle = (b: string): string =>
  BRAND_TITLE[b] ?? b.charAt(0).toUpperCase() + b.slice(1);

export interface Persisted {
  mode: string;
  model: string;
  effort: Effort;
  /** Panel-owned run policy. These values are copied into every new run request. */
  autonomy: 'auto' | 'confirm';
  allowedDomains: string[];
  /** `null` is the persisted representation of an intentionally unlimited run. */
  tokenBudget: number | null;
}
const DEFAULTS: Persisted = {
  mode: 'agent',
  model: 'anthropic/claude-opus-4.8',
  effort: 'medium',
  // A new install is deliberately review-first and bounded. Users may opt into uninterrupted runs;
  // unconditional consequential-action gates still apply in either mode.
  autonomy: 'confirm',
  allowedDomains: [],
  tokenBudget: 100_000,
};

export type AllowedDomainsResult = { ok: true; domains: string[] } | { ok: false; error: string };

// This is deliberately a compact fail-closed guard, not a bundled Public Suffix List. These are the
// common entries most likely to be pasted as a dangerously broad fence. The sidecar applies the same
// authoritative check again; keeping this list aligned lets the panel show the error before Run.
const PUBLIC_SUFFIX_LIKE = new Set([
  'com',
  'org',
  'net',
  'edu',
  'gov',
  'mil',
  'int',
  'app',
  'dev',
  'info',
  'biz',
  'name',
  'pro',
  'xyz',
  'online',
  'site',
  'store',
  'tech',
  'cloud',
  'example',
  'invalid',
  'test',
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.jp',
  'co.nz',
  'co.in',
  'com.br',
  'com.cn',
  'com.sg',
]);

/** Turn the compact policy input into the exact domain array accepted by the sidecar. */
export function parseAllowedDomains(value: string): AllowedDomainsResult {
  const entries = value
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, ''))
    .filter(Boolean);
  if (entries.length > 50) {
    return { ok: false, error: 'Use at most 50 allowed domains.' };
  }
  const domains: string[] = [];
  for (const domain of entries) {
    if (
      domain.length > 253 ||
      !domain.includes('.') ||
      PUBLIC_SUFFIX_LIKE.has(domain) ||
      /^[a-z]{2}$/.test(domain)
    ) {
      return {
        ok: false,
        error: `${domain || 'This value'} is too broad; enter a complete site domain (for example, example.com).`,
      };
    }
    const labels = domain.split('.');
    if (
      labels.some(
        (label) =>
          !label ||
          label.length > 63 ||
          !/^[a-z0-9-]+$/.test(label) ||
          label.startsWith('-') ||
          label.endsWith('-'),
      )
    ) {
      return { ok: false, error: `${domain} is not a valid domain.` };
    }
    if (!domains.includes(domain)) domains.push(domain);
  }
  return { ok: true, domains };
}

function normalizePersisted(raw: Partial<Persisted>): Persisted {
  const tokenBudget =
    raw.tokenBudget === null
      ? null
      : typeof raw.tokenBudget === 'number' &&
          Number.isSafeInteger(raw.tokenBudget) &&
          raw.tokenBudget >= 1_000 &&
          raw.tokenBudget <= 10_000_000
        ? raw.tokenBudget
        : DEFAULTS.tokenBudget;
  const storedDomains = Array.isArray(raw.allowedDomains)
    ? raw.allowedDomains.filter((item) => typeof item === 'string')
    : DEFAULTS.allowedDomains;
  const parsedDomains = parseAllowedDomains(storedDomains.join(','));
  return {
    mode: raw.mode === 'ask' ? 'ask' : 'agent',
    model: typeof raw.model === 'string' && raw.model ? raw.model : DEFAULTS.model,
    effort: ALL_EFFORTS.includes(raw.effort as Effort) ? (raw.effort as Effort) : DEFAULTS.effort,
    autonomy: raw.autonomy === 'auto' ? 'auto' : 'confirm',
    // Preserve an invalid/corrupt stored fence so the editor shows its validation error and blocks a
    // run. Replacing it with [] would silently turn a requested fence into unrestricted browsing.
    allowedDomains: parsedDomains.ok ? parsedDomains.domains : storedDomains,
    tokenBudget,
  };
}

/** A fresh conversation id. Constrained to the charset the sidecar accepts for a memory filename. */
export function newThreadId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `t${Date.now().toString(36)}${random}`.replace(/[^a-zA-Z0-9_-]/g, '');
}

/** Persist to chrome.storage.local when available, else localStorage (standalone). */
export const store = {
  async get(): Promise<Persisted> {
    try {
      const local = window.chrome?.storage?.local;
      if (local) return normalizePersisted(await local.get(DEFAULTS));
    } catch {
      /* fall through */
    }
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof Persisted)[]) {
      const v = localStorage.getItem('lobee.' + k);
      if (v != null)
        try {
          (out as Record<string, unknown>)[k] = JSON.parse(v);
        } catch {
          /* ignore */
        }
    }
    return normalizePersisted(out);
  },
  set(obj: Partial<Persisted>): void {
    try {
      const local = window.chrome?.storage?.local;
      if (local) {
        local.set(obj);
        return;
      }
    } catch {
      /* fall through */
    }
    for (const [k, v] of Object.entries(obj)) localStorage.setItem('lobee.' + k, JSON.stringify(v));
  },
};

export function mapRoster(models: Array<Record<string, unknown>>): ModelInfo[] {
  return models.map((m) => ({
    id: String(m.id),
    label: String(m.label ?? m.id),
    brand: String(m.brand ?? String(m.id).split('/')[0] ?? 'openrouter'),
    efforts: Array.isArray(m.efforts) ? (m.efforts as Effort[]) : ALL_EFFORTS,
    available: m.available !== false,
    agentCapable: m.agentCapable === true,
  }));
}
