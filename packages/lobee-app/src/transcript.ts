export type StoredTurnStatus = 'done' | 'error' | 'stopped';

/** One recorded step of the activity trail, kept so a reopened panel still shows what the agent did. */
export interface StoredStep {
  label: string;
  ctx: string;
}

export interface StoredTurn {
  id: number;
  sessionId?: string;
  /**
   * The conversation this turn belongs to. Persisted so the panel can re-read the ANSWER from the
   * profile's encrypted memory instead of keeping its own plaintext copy.
   */
  threadId?: string;
  task: string;
  status: StoredTurnStatus;
  /**
   * DEPRECATED as a storage field. Answers are no longer written here — they live in the encrypted
   * per-profile memory and are hydrated over the bridge. The field remains so transcripts written by
   * an older panel still load (and are re-saved without it).
   */
  answer?: string;
  startedAt?: string;
  /**
   * The step trail. Previously discarded on save, so reopening the panel reduced a twenty-step agent
   * run to a single line of final text — the user lost all evidence of what had actually been done.
   */
  steps?: StoredStep[];
  /** Tokens this turn consumed, so cost stays visible after a reload. */
  tokensIn?: number;
  tokensOut?: number;
}

const KEY = 'lobee.transcript.v1';
const MAX_TURNS = 24;
const MAX_TOTAL_CHARS = 240_000;
const MAX_TASK_CHARS = 4_000;
const MAX_STEPS_PER_TURN = 60;
const MAX_STEP_CHARS = 200;

function clipped(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function redactTranscriptText(value: string): string {
  return value
    .replace(
      /\b(password|passcode|otp|one[- ]?time code|verification code|api[-_ ]?key|access[-_ ]?token|secret|cvv|cvc)\s*([:=]|\bis\b)\s*(?:["']([^"'\r\n]+)["']|([^\s,;\r\n]+))/gi,
      (_match, label: string) => `${label}: [REDACTED]`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
}

function normalize(raw: unknown): StoredTurn[] {
  if (!Array.isArray(raw)) return [];
  const valid: StoredTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const status = row.status;
    if (status !== 'done' && status !== 'error' && status !== 'stopped') continue;
    const id = Number(row.id);
    const task = redactTranscriptText(clipped(row.task, MAX_TASK_CHARS));
    if (!Number.isSafeInteger(id) || id < 1 || !task) continue;
    const steps = Array.isArray(row.steps)
      ? (row.steps as unknown[])
          .filter((step): step is Record<string, unknown> => !!step && typeof step === 'object')
          .slice(0, MAX_STEPS_PER_TURN)
          .map((step) => ({
            label: redactTranscriptText(clipped(step.label, MAX_STEP_CHARS)),
            ctx: redactTranscriptText(clipped(step.ctx, MAX_STEP_CHARS)),
          }))
          .filter((step) => step.label || step.ctx)
      : [];
    const num = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : undefined;
    valid.push({
      id,
      task,
      status,
      ...(steps.length ? { steps } : {}),
      ...(num(row.tokensIn) !== undefined ? { tokensIn: num(row.tokensIn) } : {}),
      ...(num(row.tokensOut) !== undefined ? { tokensOut: num(row.tokensOut) } : {}),
      // The ANSWER is deliberately dropped, not redacted. It lives in the profile's encrypted memory
      // and is hydrated over the bridge; keeping a second plaintext copy here defeated that store,
      // because the regexes below only ever caught labelled secrets — never the ordinary confidential
      // content an agent actually reads (an address, an order total, a private message).
      ...(typeof row.threadId === 'string' && row.threadId
        ? { threadId: row.threadId.slice(0, 128) }
        : {}),
      ...(typeof row.sessionId === 'string' && row.sessionId
        ? { sessionId: row.sessionId.slice(0, 128) }
        : {}),
      ...(typeof row.startedAt === 'string' && row.startedAt
        ? { startedAt: row.startedAt.slice(0, 64) }
        : {}),
    });
  }

  let chars = 0;
  const capped: StoredTurn[] = [];
  for (const turn of valid.slice(-MAX_TURNS).reverse()) {
    const size = turn.task.length + (turn.answer?.length ?? 0);
    if (chars + size > MAX_TOTAL_CHARS) continue;
    chars += size;
    capped.push(turn);
  }
  return capped.reverse();
}

export async function loadTranscript(): Promise<StoredTurn[]> {
  try {
    const local = window.chrome?.storage?.local;
    if (local) {
      const record = await local.get({ [KEY]: [] });
      return normalize(record[KEY]);
    }
  } catch {
    /* fall through to standalone storage */
  }
  try {
    return normalize(JSON.parse(localStorage.getItem(KEY) ?? '[]'));
  } catch {
    return [];
  }
}

export async function saveTranscript(turns: readonly StoredTurn[]): Promise<void> {
  const value = normalize(turns);
  try {
    const local = window.chrome?.storage?.local;
    if (local) {
      await Promise.resolve(local.set({ [KEY]: value }));
      return;
    }
  } catch {
    /* fall through to standalone storage */
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Storage quota/private mode must never break the chat UI.
  }
}
