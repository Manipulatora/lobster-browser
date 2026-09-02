import { readdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  EncryptedJournalFile,
  JournalStorageError,
  type JournalFileSystem,
} from './encrypted-file.js';
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

/**
 * How long an accepted non-barrier event may wait in memory before it is written on its own. Short
 * enough that the durable record is never more than a blink behind the live run; long enough that
 * the burst a step produces (proposed → approval.requested → approval.resolved → dispatching) shares
 * one physical write.
 */
const DEFAULT_FLUSH_DELAY_MS = 250;
/**
 * A background flush that keeps failing stops retrying after this many attempts and leaves the
 * failure for the next append to surface. Retrying forever against a broken disk would create and
 * unlink a temp file every few hundred milliseconds for as long as the sidecar lives.
 */
const MAX_FLUSH_ATTEMPTS = 5;
/** `setTimeout` fires anything above this immediately, which would turn "later" into "now". */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Events `append` has accepted for one journal but has not yet written.
 *
 * WHY THIS EXISTS. Every append used to be its own read → decrypt → re-encrypt → fsync → rename
 * cycle. A mutating step appends four to six events, so the loop paid four to six fsynced rewrites
 * of the whole file per step — plausibly tens of milliseconds each under Windows real-time scanning
 * — for a record whose only load-bearing durability point is the dispatch marker. Everything else
 * is bookkeeping that recovery reads AFTER a crash and that no browser effect waits on. So the
 * bookkeeping is accepted in memory (validated, sequenced, reduced exactly as before) and reaches
 * the disk with the next durability barrier or on a short timer, whichever is first.
 *
 * WHY THE MAP IS PROCESS-GLOBAL. The sidecar builds a fresh store facade per run and another per
 * bridge request, all over one directory with one key. A buffer private to a facade would let a
 * second facade read a revision the first has already moved past, then append on top of that stale
 * view and clobber the buffered events — the exact lost update the optimistic revision exists to
 * prevent. Keyed by directory + key fingerprint + run, every same-key facade shares one buffer; a
 * wrong-key facade has no entry and fails at the authenticated read as it always did.
 *
 * WHAT A CRASH LOSES. Only events accepted after the last barrier. The barrier write carries every
 * event before it, in order, so the durable file is always a prefix of the accepted history that
 * ends on a state recovery understands.
 */
interface PendingWrites {
  runId: string;
  /** The accepted journal in full; the durable file holds a prefix of it. */
  journal: RunJournalV1;
  /** The revision the durable file held when this process last verified or wrote it. */
  durableRevision: number;
  timer: NodeJS.Timeout | undefined;
  /** Failed background flushes so far; the next append surfaces the failure by writing itself. */
  attempts: number;
}

const PENDING_WRITES = new Map<string, PendingWrites>();

/**
 * The events that must be on disk before `append` resolves.
 *
 * `action.dispatching` is THE barrier: the loop writes it immediately before handing an action to the
 * driver, and recovery's whole reasoning ("a side effect may have occurred") rests on it being durable
 * before the effect can exist. Terminal markers are barriers because their reader is a LATER process:
 * the loop deletes the file right after writing one, and the admission sweep that catches a crash in
 * between must find the marker, not an unfinished journal it then has to "resolve".
 */
function isDurabilityBarrier(type: RunJournalEventV1['type']): boolean {
  switch (type) {
    case 'action.dispatching':
    case 'run.completed':
    case 'run.failed':
    case 'run.stopped':
      return true;
    default:
      return false;
  }
}

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
 *
 * Appends are accepted immediately and written in batches: a durability barrier (`action.dispatching`
 * or a terminal marker) is fsynced before its promise resolves and carries every event accepted
 * before it; anything else is buffered and written with the next barrier or within `flushDelayMs`.
 * Every read path writes the buffer first, so no reader ever sees a revision the disk lacks.
 */
export class RunJournalStore {
  private readonly root: string;
  private readonly files: EncryptedJournalFile;
  private readonly maxEvents: number;
  private readonly flushDelayMs: number;
  private readonly clock: () => string;

  constructor(
    journalDir: string,
    opts: {
      encryptionKey: string | Uint8Array;
      maxEvents?: number;
      maxBytes?: number;
      clock?: () => string;
      /** How long a non-barrier event may stay buffered before it is written on its own. */
      flushDelayMs?: number;
      /** Test seam: count the physical writes and fsyncs the store actually performs. */
      fs?: JournalFileSystem;
    },
  ) {
    this.root = resolve(journalDir);
    this.maxEvents = normalizeEventCap(opts.maxEvents);
    this.flushDelayMs = normalizeFlushDelay(opts.flushDelayMs);
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.files = new EncryptedJournalFile(this.root, {
      encryptionKey: opts.encryptionKey,
      ...(opts.maxBytes === undefined
        ? {}
        : { maxPlaintextBytes: Math.min(MAX_JOURNAL_BYTES, opts.maxBytes) }),
      ...(opts.fs === undefined ? {} : { fs: opts.fs }),
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
          (await this.loadRequiredLocked(input.runId)).journal.revision,
        );
      }
      // A buffer can only outlive its file if something outside this store deleted the journal. The
      // new journal starts from its own first revision, not on top of a ghost's.
      this.dropPending(input.runId);
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
      await this.files.write(path, JSON.stringify(journal));
      return cloneSnapshot({ journal, state });
    });
  }

  async load(runId: string): Promise<RunJournalSnapshot | null> {
    assertJournalRunId(runId);
    return this.serialize(runId, () => this.loadLocked(runId));
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
      const pending = PENDING_WRITES.get(this.pendingKey(runId));
      const current = pending?.journal ?? (await this.loadRequiredFromDisk(runId)).journal;
      if (current.revision !== expectedRevision) {
        throw new JournalRevisionConflictError(runId, expectedRevision, current.revision);
      }
      if (current.events.length >= this.maxEvents) {
        throw new JournalStorageError(`event cap exceeded (${this.maxEvents})`);
      }
      const { event, sensitive } = sanitizeAppendEvent(
        eventInput,
        current.revision + 1,
        this.clock,
        current.updatedAt,
      );
      const candidate = parseRunJournalV1({
        ...current,
        updatedAt: event.at,
        revision: event.seq,
        sensitive: current.sensitive || sensitive || event.type === 'run.sensitive',
        events: [...current.events, event],
      });
      const state = reduceRunJournal(candidate);
      const serialized = JSON.stringify(candidate);
      // Enforced at acceptance, exactly as when every append was a write: the event that crosses
      // the cap is the one refused, not an unrelated flush seconds later.
      this.files.assertPlaintextWithinCap(serialized);
      if (isDurabilityBarrier(event.type) || (pending !== undefined && pending.attempts > 0)) {
        // A barrier writes through. So does any append after a background flush failed: a disk that
        // cannot take the buffer must be reported to the loop now, before the next effect, not
        // hidden behind a resolved promise. A failure here leaves the buffer as it was — the events
        // it holds were accepted; this one was not.
        await this.persist(runId, serialized, pending?.durableRevision);
        this.dropPending(runId);
      } else if (pending) {
        pending.journal = candidate;
      } else {
        this.startBuffer(runId, candidate, current.revision);
      }
      return cloneSnapshot({ journal: candidate, state });
    });
  }

  /**
   * Write every buffered event now — for one run, or for all runs this store's directory and key
   * hold. Barriers make this unnecessary in the ordinary flow; an embedder that is about to exit
   * without a terminal marker calls it so the last observations are not left to a timer that will
   * never fire.
   */
  async flush(runId?: string): Promise<void> {
    if (runId !== undefined) {
      assertJournalRunId(runId);
      await this.flushRun(runId);
      return;
    }
    const owned = `${this.root}\0${this.files.keyFingerprint}\0`;
    const runIds = [...PENDING_WRITES.entries()]
      .filter(([key]) => key.startsWith(owned))
      .map(([, entry]) => entry.runId);
    for (const id of runIds) await this.flushRun(id);
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
      const snapshot = await this.serialize(runId, () => this.loadRequiredLocked(runId));
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
          snapshot = await this.loadRequiredLocked(runId);
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

  /**
   * Delete one journal, but only after a fresh authenticated read proves it terminal.
   *
   * The product contract is that NOTHING about a run persists once it is over — the journal exists to
   * make an interruption recoverable, and a journal whose run has a terminal marker has discharged
   * that duty. Leaving it behind was pure residue: every start decrypts and reduces every file in the
   * directory (`listUnfinished`), so the residue also made admission slower forever. The terminal
   * check is what keeps this primitive safe to call from anywhere: an unfinished journal — the one
   * kind that still carries recovery meaning — is never deletable through it.
   *
   * Path safety is inherited from `pathFor` → `EncryptedJournalFile.resolveFile`, which validates the
   * filename shape and asserts containment in the journals directory.
   */
  async removeFinished(runId: string): Promise<boolean> {
    assertJournalRunId(runId);
    return this.serialize(runId, async () => {
      let snapshot: RunJournalSnapshot | null;
      try {
        snapshot = await this.loadLocked(runId);
      } catch {
        // Unreadable is not provably terminal; retain fail-closed exactly like pruneFinished.
        return false;
      }
      if (!snapshot || !isTerminalPhase(snapshot.state.phase)) return false;
      await this.files.remove(this.pathFor(runId));
      return true;
    });
  }

  /**
   * Move a journal that cannot be read (corrupt bytes, failed authentication, schema violation) aside
   * as `<runId>.journal.corrupt`, so it stops matching `listRunIds` and can never block admission
   * again — while its bytes survive for forensics instead of being destroyed on an automated path.
   *
   * The load is re-attempted HERE, inside the per-run write queue, rather than trusting the caller's
   * earlier failure: between the caller's read and this call the file could have been repaired or
   * replaced, and renaming a journal that now reads fine would silently discard real recovery state.
   * A readable journal is therefore refused (`false`), whatever the caller saw before.
   *
   * Readability is a property of the durable file alone. Buffered events are not consulted, and a
   * buffer the disk cannot currently take is a write problem, not what "unreadable" means — so a
   * healthy file is never quarantined for it.
   */
  async quarantineUnreadable(runId: string): Promise<boolean> {
    assertJournalRunId(runId);
    return this.serialize(runId, async () => {
      try {
        await this.loadFromDisk(runId);
        return false; // readable — never quarantine a journal that still parses and authenticates
      } catch {
        // fall through: provably unreadable right now, under the write lock
      }
      const path = this.pathFor(runId); // validated + containment-asserted
      await rename(path, `${path}.corrupt`);
      this.dropPending(runId); // whatever was buffered extended bytes that no longer exist here
      return true;
    });
  }

  /** Write the buffer, then read the file: the caller sees exactly what the disk holds. */
  private async loadLocked(runId: string): Promise<RunJournalSnapshot | null> {
    try {
      await this.flushLocked(runId);
    } catch (error) {
      // A buffer the durable file proved stale has already been discarded, and the file it lost to
      // is the truth this read should return. Anything else means the disk cannot currently take
      // the buffered revision — and describing a journal that cannot be made durable would be a lie.
      if (!(error instanceof JournalRevisionConflictError)) throw error;
    }
    return this.loadFromDisk(runId);
  }

  private async loadRequiredLocked(runId: string): Promise<RunJournalSnapshot> {
    const loaded = await this.loadLocked(runId);
    if (!loaded) throw new RunJournalNotFoundError(runId);
    return loaded;
  }

  private async loadRequiredFromDisk(runId: string): Promise<RunJournalSnapshot> {
    const loaded = await this.loadFromDisk(runId);
    if (!loaded) throw new RunJournalNotFoundError(runId);
    return loaded;
  }

  private async loadFromDisk(runId: string): Promise<RunJournalSnapshot | null> {
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

  /**
   * One physical write of the complete journal.
   *
   * When the caller has been working from the buffer, the durable file is re-read first and must
   * still hold the revision this process last wrote: a writer this process knows nothing about —
   * another sidecar on the same profile, a restore from backup — is then a revision conflict, never
   * an overwrite with a stale copy from memory. The buffer is dropped in that case because it is
   * provably built on a file that no longer exists in that form. A caller that has just read the
   * disk inside the same critical section passes `undefined` and skips the redundant read.
   */
  private async persist(
    runId: string,
    serialized: string,
    durableRevision: number | undefined,
  ): Promise<void> {
    if (durableRevision !== undefined) {
      let onDisk: RunJournalSnapshot;
      try {
        onDisk = await this.loadRequiredFromDisk(runId);
      } catch (error) {
        if (error instanceof RunJournalNotFoundError) this.dropPending(runId);
        throw error;
      }
      if (onDisk.journal.revision !== durableRevision) {
        this.dropPending(runId);
        throw new JournalRevisionConflictError(runId, durableRevision, onDisk.journal.revision);
      }
    }
    await this.files.write(this.pathFor(runId), serialized);
  }

  private startBuffer(runId: string, journal: RunJournalV1, durableRevision: number): void {
    const entry: PendingWrites = { runId, journal, durableRevision, timer: undefined, attempts: 0 };
    PENDING_WRITES.set(this.pendingKey(runId), entry);
    this.scheduleFlush(entry, this.flushDelayMs);
  }

  private scheduleFlush(entry: PendingWrites, delayMs: number): void {
    entry.timer = setTimeout(
      () => {
        entry.timer = undefined;
        // A rejected timer callback would be an unhandled rejection that takes the sidecar down. The
        // failure is recorded on the entry instead and surfaced by the next append or read.
        void this.flushRun(entry.runId).catch(() => {});
      },
      Math.min(MAX_TIMER_MS, delayMs),
    );
    // Never keep an exiting process alive for a flush: by construction it holds nothing a barrier
    // covered, and a process that is exiting has no next effect to protect.
    entry.timer.unref();
  }

  private flushRun(runId: string): Promise<void> {
    return this.serialize(runId, () => this.flushLocked(runId));
  }

  /** Write the buffered events, if any. The caller holds the run's queue. */
  private async flushLocked(runId: string): Promise<void> {
    const entry = PENDING_WRITES.get(this.pendingKey(runId));
    if (!entry) return;
    try {
      await this.persist(runId, JSON.stringify(entry.journal), entry.durableRevision);
    } catch (error) {
      // The journal was deleted underneath the buffer: there is nowhere for these events to go, and
      // the reader that follows will report the absence, which is the durable truth.
      if (error instanceof RunJournalNotFoundError) return;
      // `persist` already discarded a buffer the file proved stale; the conflict is the caller's.
      if (error instanceof JournalRevisionConflictError) throw error;
      entry.attempts += 1;
      if (entry.attempts < MAX_FLUSH_ATTEMPTS && entry.timer === undefined) {
        this.scheduleFlush(entry, this.flushDelayMs * (entry.attempts + 1));
      }
      throw error;
    }
    this.dropPending(runId);
  }

  private dropPending(runId: string): void {
    const key = this.pendingKey(runId);
    const entry = PENDING_WRITES.get(key);
    if (!entry) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    PENDING_WRITES.delete(key);
  }

  private pendingKey(runId: string): string {
    return `${this.root}\0${this.files.keyFingerprint}\0${runId}`;
  }

  private pathFor(runId: string): string {
    return this.files.resolveFile(`${runId}.journal`);
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

function normalizeFlushDelay(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FLUSH_DELAY_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new JournalStorageError('flush delay must be a positive integer of milliseconds');
  }
  return value;
}
