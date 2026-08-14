import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EncryptedJournalFile, JournalStorageError } from './encrypted-file.js';
import { isTerminalPhase, reduceRunJournal, type RunJournalState } from './reducer.js';
import {
  MAX_JOURNAL_BYTES,
  MAX_JOURNAL_EVENTS,
  JournalValidationError,
  assertJournalRunId,
  parseRunJournalV1,
  type AppendRunJournalEventV1,
  type JournalRunMode,
  type RunJournalEventV1,
  type RunJournalV1,
} from './schema.js';
import { scrubJournalText } from './scrub.js';

// The desktop core may construct more than one store facade for a profile. Serialize by canonical
// directory + run id across every facade in this process so optimistic revisions cannot race locally.
const RUN_WRITE_QUEUES = new Map<string, Promise<void>>();

export interface CreateRunJournalInput {
  runId: string;
  task: string;
  mode: JournalRunMode;
  model?: string;
  createdAt?: string;
}

export interface RunJournalSnapshot {
  journal: RunJournalV1;
  state: RunJournalState;
}

export interface PruneFinishedResult {
  deleted: string[];
  /** Unreadable files are retained because their terminal status cannot be proven. */
  retainedUnreadable: string[];
}

export class JournalRevisionConflictError extends Error {
  constructor(runId: string, expected: number, actual: number) {
    super(`run journal revision conflict for ${runId}: expected ${expected}, found ${actual}`);
    this.name = 'JournalRevisionConflictError';
  }
}

export class RunJournalNotFoundError extends Error {
  constructor(runId: string) {
    super(`run journal not found: ${runId}`);
    this.name = 'RunJournalNotFoundError';
  }
}

/**
 * Encrypted per-profile journal store. Each run has one serialized writer, and every append uses an
 * optimistic revision so concurrent producers cannot silently overwrite one another.
 */
export class RunJournalStore {
  private readonly root: string;
  private readonly files: EncryptedJournalFile;
  private readonly maxEvents: number;
  private readonly clock: () => string;

  constructor(
    journalDir: string,
    opts: {
      encryptionKey: string | Uint8Array;
      maxEvents?: number;
      maxBytes?: number;
      clock?: () => string;
    },
  ) {
    this.root = resolve(journalDir);
    this.maxEvents = normalizeEventCap(opts.maxEvents);
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.files = new EncryptedJournalFile(this.root, {
      encryptionKey: opts.encryptionKey,
      ...(opts.maxBytes === undefined
        ? {}
        : { maxPlaintextBytes: Math.min(MAX_JOURNAL_BYTES, opts.maxBytes) }),
    });
  }

  async create(input: CreateRunJournalInput): Promise<RunJournalSnapshot> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new JournalValidationError('create input must be an object');
    }
    assertExactInputKeys(input, ['runId', 'task', 'mode'], ['model', 'createdAt']);
    assertJournalRunId(input.runId);
    return this.serialize(input.runId, async () => {
      const path = this.pathFor(input.runId);
      if (await this.files.exists(path)) {
        throw new JournalRevisionConflictError(
          input.runId,
          0,
          (await this.loadRequired(input.runId)).journal.revision,
        );
      }
      const task = scrubJournalText(requireString(input.task, 'task'));
      const model =
        input.model === undefined
          ? undefined
          : scrubJournalText(requireString(input.model, 'model'));
      const at = input.createdAt ?? this.clock();
      const start: RunJournalEventV1 = {
        type: 'run.started',
        seq: 1,
        at,
        task: task.text,
        mode: input.mode,
        ...(model === undefined ? {} : { model: model.text }),
      };
      const journal = parseRunJournalV1({
        version: 1,
        runId: input.runId,
        createdAt: at,
        updatedAt: at,
        revision: 1,
        sensitive: task.sensitive || model?.sensitive === true,
        events: [start],
      });
      const state = reduceRunJournal(journal);
      await this.write(path, journal);
      return cloneSnapshot({ journal, state });
    });
  }

  async load(runId: string): Promise<RunJournalSnapshot | null> {
    assertJournalRunId(runId);
    return this.loadInternal(runId);
  }

  async append(
    runId: string,
    eventInput: AppendRunJournalEventV1,
    expectedRevision: number,
  ): Promise<RunJournalSnapshot> {
    assertJournalRunId(runId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new JournalValidationError('expected revision must be a positive integer');
    }
    return this.serialize(runId, async () => {
      const current = await this.loadRequired(runId);
      if (current.journal.revision !== expectedRevision) {
        throw new JournalRevisionConflictError(runId, expectedRevision, current.journal.revision);
      }
      if (current.journal.events.length >= this.maxEvents) {
        throw new JournalStorageError(`event cap exceeded (${this.maxEvents})`);
      }
      const { event, sensitive } = sanitizeAppendEvent(
        eventInput,
        current.journal.revision + 1,
        this.clock,
        current.journal.updatedAt,
      );
      const candidate = parseRunJournalV1({
        ...current.journal,
        updatedAt: event.at,
        revision: event.seq,
        sensitive: current.journal.sensitive || sensitive || event.type === 'run.sensitive',
        events: [...current.journal.events, event],
      });
      const state = reduceRunJournal(candidate);
      await this.write(this.pathFor(runId), candidate);
      return cloneSnapshot({ journal: candidate, state });
    });
  }

  /** List exact journal ids. Interrupted temp files and unrelated directory entries are ignored. */
  async listRunIds(): Promise<string[]> {
    if (!(await this.files.verifyRoot())) return [];
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const ids: string[] = [];
    for (const entry of entries) {
      const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.journal$/.exec(entry.name);
      if (!match) continue;
      if (!entry.isFile()) {
        throw new JournalStorageError(`${entry.name} is not a regular journal file`);
      }
      ids.push(match[1]!);
    }
    return ids.sort();
  }

  /** Startup surface: corruption is surfaced, never mistaken for "no unfinished work". */
  async listUnfinished(): Promise<RunJournalSnapshot[]> {
    const snapshots: RunJournalSnapshot[] = [];
    for (const runId of await this.listRunIds()) {
      const snapshot = await this.loadRequired(runId);
      if (!isTerminalPhase(snapshot.state.phase)) snapshots.push(snapshot);
    }
    return snapshots;
  }

  /**
   * Retention may remove only journals proven terminal by a fresh authenticated read and reducer pass.
   * Corrupt, unreadable, or unfinished files are retained fail-closed.
   */
  async pruneFinished(opts: {
    finishedBefore: string;
    maxDeletes?: number;
  }): Promise<PruneFinishedResult> {
    const cutoff = Date.parse(opts.finishedBefore);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(opts.finishedBefore) ||
      !Number.isFinite(cutoff) ||
      new Date(cutoff).toISOString() !== opts.finishedBefore
    ) {
      throw new JournalValidationError('prune cutoff is not ISO-8601');
    }
    if (
      opts.maxDeletes !== undefined &&
      (!Number.isSafeInteger(opts.maxDeletes) || opts.maxDeletes < 0)
    ) {
      throw new JournalValidationError('maxDeletes must be a non-negative integer');
    }
    const maxDeletes = Math.min(1_000, opts.maxDeletes ?? 100);
    const deleted: string[] = [];
    const retainedUnreadable: string[] = [];
    for (const runId of await this.listRunIds()) {
      if (deleted.length >= maxDeletes) break;
      await this.serialize(runId, async () => {
        let snapshot: RunJournalSnapshot;
        try {
          snapshot = await this.loadRequired(runId);
        } catch {
          retainedUnreadable.push(runId);
          return;
        }
        if (
          isTerminalPhase(snapshot.state.phase) &&
          Date.parse(snapshot.journal.updatedAt) < cutoff
        ) {
          await this.files.remove(this.pathFor(runId));
          deleted.push(runId);
        }
      });
    }
    return { deleted, retainedUnreadable };
  }

  private async loadRequired(runId: string): Promise<RunJournalSnapshot> {
    const loaded = await this.loadInternal(runId);
    if (!loaded) throw new RunJournalNotFoundError(runId);
    return loaded;
  }

  private async loadInternal(runId: string): Promise<RunJournalSnapshot | null> {
    const plaintext = await this.files.read(this.pathFor(runId));
    if (plaintext === null) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(plaintext) as unknown;
    } catch {
      throw new JournalStorageError(`${runId}.journal contains corrupt JSON`);
    }
    const journal = parseRunJournalV1(decoded);
    assertStoredContentScrubbed(journal);
    if (journal.runId !== runId) {
      throw new JournalValidationError('run id does not match its path');
    }
    const state = reduceRunJournal(journal);
    return cloneSnapshot({ journal, state });
  }

  private pathFor(runId: string): string {
    return this.files.resolveFile(`${runId}.journal`);
  }

  private async write(path: string, journal: RunJournalV1): Promise<void> {
    const serialized = JSON.stringify(journal);
    await this.files.write(path, serialized);
  }

  private async serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const queueKey = `${this.root}\0${runId}`;
    const predecessor = RUN_WRITE_QUEUES.get(queueKey) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = predecessor.catch(() => {}).then(() => gate);
    RUN_WRITE_QUEUES.set(queueKey, tail);
    await predecessor.catch(() => {});
    try {
      return await operation();
    } finally {
      release?.();
      if (RUN_WRITE_QUEUES.get(queueKey) === tail) RUN_WRITE_QUEUES.delete(queueKey);
    }
  }
}

function sanitizeAppendEvent(
  input: AppendRunJournalEventV1,
  seq: number,
  clock: () => string,
  currentUpdatedAt: string,
): { event: RunJournalEventV1; sensitive: boolean } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new JournalValidationError('append event must be an object');
  }
  const raw = input as unknown as Record<string, unknown>;
  const type = raw.type;
  if (type === 'run.started') throw new JournalValidationError('run.started cannot be appended');
  if (typeof type !== 'string') throw new JournalValidationError('append event type is missing');
  if ('seq' in raw) throw new JournalValidationError('event sequence is harness-owned');
  // A wall-clock correction must not strand an otherwise valid journal in the future. Clamp only
  // harness-generated timestamps: a caller that explicitly supplies `at` still goes through the strict
  // schema and chronological validation below, including when it supplies null/undefined at runtime.
  const at = Object.prototype.hasOwnProperty.call(raw, 'at')
    ? raw.at
    : clampHarnessTimestamp(clock(), currentUpdatedAt);
  let sensitive = false;
  const safeSummary = (): string => {
    const scrubbed = scrubJournalText(requireString(raw.summary, `${type}.summary`));
    sensitive ||= scrubbed.sensitive;
    return scrubbed.text;
  };
  let event: unknown;
  switch (type) {
    case 'action.proposed': {
      const summary = safeSummary();
      assertIdentifierIsNotSensitive(raw.actionId, 'actionId');
      assertIdentifierIsNotSensitive(raw.actionKind, 'actionKind');
      const fields = { ...raw };
      if (raw.host !== undefined) {
        const scrubbedHost = scrubJournalText(requireString(raw.host, 'action.proposed.host'));
        if (scrubbedHost.sensitive) {
          // A redaction token is not a hostname. Omit the optional correlation hint entirely and make
          // the unfinished journal non-resumable instead of persisting a credential-shaped DNS label.
          delete fields.host;
          sensitive = true;
        }
      }
      event = { ...fields, seq, at, summary };
      break;
    }
    case 'action.observed':
    case 'action.cancelled':
    case 'recovery.resolved':
    case 'run.completed':
    case 'run.failed':
    case 'run.stopped':
      if ('actionId' in raw) assertIdentifierIsNotSensitive(raw.actionId, 'actionId');
      event = { ...raw, seq, at, summary: safeSummary() };
      break;
    case 'approval.requested':
    case 'approval.resolved':
    case 'action.dispatching':
      assertIdentifierIsNotSensitive(raw.actionId, 'actionId');
      event = { ...raw, seq, at };
      break;
    case 'run.sensitive':
      event = { ...raw, seq, at };
      sensitive = true;
      break;
    default:
      event = { ...raw, seq, at };
  }
  const temporary = parseRunJournalV1({
    version: 1,
    runId: 'validation',
    createdAt: at,
    updatedAt: at,
    revision: 2,
    sensitive,
    events: [
      { type: 'run.started', seq: 1, at, task: '', mode: 'agent' },
      { ...(event as Record<string, unknown>), seq: 2 },
    ],
  });
  return { event: { ...temporary.events[1]!, seq }, sensitive };
}

function clampHarnessTimestamp(candidate: string, minimum: string): string {
  const parsed = Date.parse(candidate);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== candidate
  ) {
    // Preserve strict schema validation for a broken injected/system clock rather than laundering an
    // invalid value into the prior timestamp.
    return candidate;
  }
  return parsed < Date.parse(minimum) ? minimum : candidate;
}

function assertIdentifierIsNotSensitive(value: unknown, field: string): void {
  const text = requireString(value, field);
  if (scrubJournalText(text).sensitive) {
    throw new JournalValidationError(`${field} contains sensitive material`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new JournalValidationError(`${field} must be a string`);
  return value;
}

function assertExactInputKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
): void {
  const record = value as unknown as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new JournalValidationError(`unexpected create field ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new JournalValidationError(`missing create field ${key}`);
    }
  }
}

function cloneSnapshot(snapshot: RunJournalSnapshot): RunJournalSnapshot {
  return structuredClone(snapshot);
}

/** A second fail-closed boundary for same-version files written by an older or buggy caller. */
function assertStoredContentScrubbed(journal: RunJournalV1): void {
  const values: string[] = [];
  for (const event of journal.events) {
    switch (event.type) {
      case 'run.started':
        values.push(event.task);
        if (event.model !== undefined) values.push(event.model);
        break;
      case 'action.proposed':
        values.push(event.actionId, event.actionKind, event.summary);
        if (event.host !== undefined) values.push(event.host);
        break;
      case 'action.observed':
      case 'action.cancelled':
      case 'recovery.resolved':
        values.push(event.actionId, event.summary);
        break;
      case 'approval.requested':
      case 'approval.resolved':
      case 'action.dispatching':
        values.push(event.actionId);
        break;
      case 'run.completed':
      case 'run.failed':
      case 'run.stopped':
        values.push(event.summary);
        break;
      case 'run.sensitive':
        break;
    }
  }
  if (values.some((value) => scrubJournalText(value).text !== value)) {
    throw new JournalValidationError('journal contains unsanitized sensitive material');
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function normalizeEventCap(value: number | undefined): number {
  if (value === undefined) return MAX_JOURNAL_EVENTS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new JournalStorageError('event cap must be a positive integer');
  }
  return Math.min(MAX_JOURNAL_EVENTS, value);
}
