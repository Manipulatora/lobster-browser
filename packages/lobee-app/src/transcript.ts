export type StoredTurnStatus = 'done' | 'error' | 'stopped';

export interface StoredTurn {
  id: number;
  sessionId?: string;
  task: string;
  status: StoredTurnStatus;
  answer: string;
  startedAt?: string;
}

const KEY = 'lobee.transcript.v1';
const MAX_TURNS = 24;
const MAX_TOTAL_CHARS = 240_000;
const MAX_TASK_CHARS = 4_000;
const MAX_ANSWER_CHARS = 40_000;

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
    valid.push({
      id,
      task,
      status,
      answer: redactTranscriptText(clipped(row.answer, MAX_ANSWER_CHARS)),
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
    const size = turn.task.length + turn.answer.length;
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
