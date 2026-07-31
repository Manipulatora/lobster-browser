import type { Effort, ModelInfo } from './types';

export const ALL_EFFORTS: Effort[] = ['low', 'medium', 'high'];
export const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High' };

// Offline fallback roster (used before the live sync lands or when the bridge is unreachable).
export const FALLBACK_MODELS: ModelInfo[] = [
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
  {
    id: 'openai/gpt-5.5',
    label: 'GPT 5.5',
    brand: 'openai',
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
  /**
   * The conversation the composer is currently writing into. Persisted so closing and reopening the
   * panel continues the SAME conversation rather than silently starting a new one — the sidecar
   * resolves prior turns from this id, so losing it would look exactly like amnesia.
   */
  threadId: string;
}
const DEFAULTS: Persisted = {
  mode: 'agent',
  model: 'anthropic/claude-opus-4.8',
  effort: 'medium',
  threadId: '',
};

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
      if (local) return { ...DEFAULTS, ...(await local.get(DEFAULTS)) } as Persisted;
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
    return out;
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
