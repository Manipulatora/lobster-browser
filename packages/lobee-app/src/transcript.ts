export type StoredTurnStatus = 'done' | 'error' | 'stopped';

/** Plaintext step shape used only by the bounded availability/migration fallback. */
export interface StoredStep {
  label: string;
  ctx: string;
}

export interface StoredTurn {
  id: number;
  sessionId?: string;
  /**
   * The conversation this turn belongs to. Persisted so the panel can normally re-read the answer from
   * the profile's authoritative encrypted memory.
   */
  threadId?: string;
  /** Stable opaque identity issued by the authenticated thread endpoint. */
  turnKey?: string;
  /** Plaintext only for legacy rows or the bounded unverified availability fallback. */
  task?: string;
  status: StoredTurnStatus;
  /**
   * Normally omitted because answers live in encrypted per-profile memory and hydrate over the bridge.
   * Retained only for legacy rows or a bounded unverified availability fallback.
   */
  answer?: string;
  /** Keep legacy bodies until an exact encrypted counterpart has been verified. */
  needsSecureMigration?: true;
  startedAt?: string;
  /** Plaintext only for legacy rows or the bounded unverified availability fallback. */
  steps?: StoredStep[];
  /** Tokens this turn consumed, so cost stays visible after a reload. */
  tokensIn?: number;
  tokensOut?: number;
}

const KEY = 'lobee.transcript.v1';
const MAX_TURNS = 24;
const MAX_TOTAL_CHARS = 240_000;
const MAX_TASK_CHARS = 4_000;
const MAX_ANSWER_CHARS = 40_000;
const MAX_STEPS_PER_TURN = 60;
const MAX_STEP_CHARS = 200;

// Event streaming can schedule a newer transcript write while an older chrome.storage write is still
// in flight. Serialize them in invocation order so a slow stale write can never finish last and erase
// a newly-terminal fallback. The queue is kept alive even if an unexpected storage implementation
// rejects; saveTranscript itself remains fail-soft for the panel.
let saveQueue: Promise<void> = Promise.resolve();

function clipped(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function redactTranscriptText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(
      /\b(password|passcode|otp|one[- ]?time code|verification code|api[-_ ]?key|access[-_ ]?token|secret|cvv|cvc)\s*([:=]|\bis\b)\s*(?:["']([^"'\r\n]+)["']|([^\s,;\r\n]+))/gi,
      (_match, label: string) => `${label}: [REDACTED]`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]')
    .replace(
      /\b(VENICE_INFERENCE_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|LOBEE_MEMORY_KEY|LOBSTER_MEMORY_KEY)[_=: -]+[A-Za-z0-9._~-]{8,}\b/gi,
      '$1=[REDACTED]',
    )
    .replace(/\b(?:sk|pk|rk|api|tsk)[-_][A-Za-z0-9_-]{12,}\b/gi, '[REDACTED KEY]')
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})\b/g,
      '[REDACTED KEY]',
    )
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(
      /([?&#](?:sig|signature|access[_-]?key|client[_-]?secret|auth|session|token)=)[^&#\s]{8,}/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(\/(?:token|secret|session|auth|api[-_]?key)\/)[A-Za-z0-9._~-]{12,}(?=[/?#]|$)/gi,
      '$1[REDACTED]',
    );
}

/**
 * Validate the local index. Legacy bodies are retained only while `needsSecureMigration` is true;
 * that marker is cleared only after an exact encrypted counterpart is verified.
 */
function normalize(raw: unknown, reading: boolean): StoredTurn[] {
  if (!Array.isArray(raw)) return [];
  const valid: StoredTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const status = row.status;
    if (status !== 'done' && status !== 'error' && status !== 'stopped') continue;
    const id = Number(row.id);
    const task = redactTranscriptText(clipped(row.task, MAX_TASK_CHARS));
    const threadId =
      typeof row.threadId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(row.threadId)
        ? row.threadId
        : '';
    const sessionId =
      typeof row.sessionId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(row.sessionId)
        ? row.sessionId
        : '';
    const turnKey =
      typeof row.turnKey === 'string' && /^[a-zA-Z0-9_-]{32,64}$/.test(row.turnKey)
        ? row.turnKey
        : '';
    const hasLegacyBody =
      Boolean(task) || typeof row.answer === 'string' || Array.isArray(row.steps);
    const keepLegacyBodies = reading ? hasLegacyBody : row.needsSecureMigration === true;
    // New rows intentionally contain no task. A legacy row needs a body or an identifier so corrupt
    // empty objects cannot grow an unusable history index forever.
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      (keepLegacyBodies ? !task && !threadId && !sessionId : !threadId && !sessionId && !turnKey)
    )
      continue;
    const steps =
      keepLegacyBodies && Array.isArray(row.steps)
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
      status,
      ...(keepLegacyBodies && task ? { task } : {}),
      ...(keepLegacyBodies && steps.length ? { steps } : {}),
      ...(keepLegacyBodies && typeof row.answer === 'string'
        ? { answer: redactTranscriptText(clipped(row.answer, MAX_ANSWER_CHARS)) }
        : {}),
      ...(keepLegacyBodies ? { needsSecureMigration: true as const } : {}),
      ...(num(row.tokensIn) !== undefined ? { tokensIn: num(row.tokensIn) } : {}),
      ...(num(row.tokensOut) !== undefined ? { tokensOut: num(row.tokensOut) } : {}),
      ...(threadId ? { threadId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(turnKey ? { turnKey } : {}),
      ...(typeof row.startedAt === 'string' && row.startedAt
        ? { startedAt: row.startedAt.slice(0, 64) }
        : {}),
    });
  }

  // A current metadata row is reproducible from encrypted memory, while an unverified legacy row is
  // not. Reserve the bounded history slots for every migration row first, then use the remainder for
  // the newest metadata. This prevents a newly completed turn from evicting the only remaining copy
  // of legacy plaintext before its encrypted counterpart has been positively identified.
  const migrationIndices = valid.flatMap((turn, index) =>
    turn.needsSecureMigration ? [index] : [],
  );
  const keptMigrationIndices = migrationIndices.slice(-MAX_TURNS);
  const remainingSlots = Math.max(0, MAX_TURNS - keptMigrationIndices.length);
  const ordinaryIndices = valid.flatMap((turn, index) =>
    turn.needsSecureMigration ? [] : [index],
  );
  const keptOrdinaryIndices = remainingSlots ? ordinaryIndices.slice(-remainingSlots) : [];

  // Migration rows have already been individually clipped and old panel builds never retained more
  // than MAX_TURNS rows. Keep them even when their combined bodies exceed today's metadata-oriented
  // character budget; dropping one here would be irreversible. Ordinary rows remain within the cap.
  let chars = keptMigrationIndices.reduce((sum, index) => {
    const turn = valid[index]!;
    return sum + (turn.task?.length ?? 0) + (turn.answer?.length ?? 0);
  }, 0);
  const selected = new Set(keptMigrationIndices);
  for (const index of keptOrdinaryIndices.reverse()) {
    const turn = valid[index]!;
    const size = (turn.task?.length ?? 0) + (turn.answer?.length ?? 0);
    if (chars + size > MAX_TOTAL_CHARS) continue;
    chars += size;
    selected.add(index);
  }
  return valid.filter((_, index) => selected.has(index));
}

export async function loadTranscript(): Promise<StoredTurn[]> {
  try {
    const local = window.chrome?.storage?.local;
    if (local) {
      const record = await local.get({ [KEY]: [] });
      return normalize(record[KEY], true);
    }
  } catch {
    /* fall through to standalone storage */
  }
  try {
    return normalize(JSON.parse(localStorage.getItem(KEY) ?? '[]'), true);
  } catch {
    return [];
  }
}

export function saveTranscript(turns: readonly StoredTurn[]): Promise<void> {
  const value = normalize(turns, false);
  const write = async (): Promise<void> => {
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
  };
  const pending = saveQueue.then(write, write);
  saveQueue = pending.catch(() => {});
  return pending;
}
