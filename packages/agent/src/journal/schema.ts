/**
 * Durable run-journal wire format.
 *
 * This is deliberately smaller than the live agent state. In particular, an action record is only a
 * non-executable digest: arguments, selectors, coordinates, typed values, screenshots, upload paths,
 * provider endpoints, and secrets do not belong in a recovery journal.
 */

export const RUN_JOURNAL_VERSION = 1 as const;
export const MAX_JOURNAL_EVENTS = 2_048;
export const MAX_JOURNAL_BYTES = 1_048_576;
export const MAX_JOURNAL_TASK_CHARS = 16_000;
export const MAX_JOURNAL_SUMMARY_CHARS = 4_000;

export type JournalRunMode = 'ask' | 'agent';
export type JournalActionEffect = 'read' | 'write' | 'consequential';
export type JournalTerminalStatus = 'completed' | 'failed' | 'stopped';
export type JournalSensitiveReason =
  'credential' | 'upload_path' | 'provider_configuration' | 'image_payload' | 'unknown';

interface JournalEventBaseV1 {
  /** Strictly monotonic, one-based journal revision assigned by the store. */
  seq: number;
  /** ISO-8601 timestamp. Event timestamps may not move backwards. */
  at: string;
}

export interface RunStartedEventV1 extends JournalEventBaseV1 {
  type: 'run.started';
  task: string;
  mode: JournalRunMode;
  /** Model identifier only. Provider configuration and endpoint URLs are forbidden. */
  model?: string;
}

/** A human-readable, deliberately non-executable action digest. */
export interface ActionProposedEventV1 extends JournalEventBaseV1 {
  type: 'action.proposed';
  actionId: string;
  actionKind: string;
  effect: JournalActionEffect;
  summary: string;
  /** Canonical host only; never a URL, query string, selector, or local path. */
  host?: string;
}

export interface ApprovalRequestedEventV1 extends JournalEventBaseV1 {
  type: 'approval.requested';
  actionId: string;
}

export interface ApprovalResolvedEventV1 extends JournalEventBaseV1 {
  type: 'approval.resolved';
  actionId: string;
  decision: 'approved' | 'rejected';
}

/** Written and fsynced immediately before handing the live action to the driver. */
export interface ActionDispatchingEventV1 extends JournalEventBaseV1 {
  type: 'action.dispatching';
  actionId: string;
}

export interface ActionObservedEventV1 extends JournalEventBaseV1 {
  type: 'action.observed';
  actionId: string;
  outcome: 'succeeded' | 'failed' | 'unknown';
  summary: string;
}

export interface ActionCancelledEventV1 extends JournalEventBaseV1 {
  type: 'action.cancelled';
  actionId: string;
  summary: string;
}

export interface RecoveryResolvedEventV1 extends JournalEventBaseV1 {
  type: 'recovery.resolved';
  actionId: string;
  resolution: 'verified_applied' | 'verified_not_applied' | 'abandoned';
  summary: string;
}

/** Marks a live run as deliberately non-resumable without persisting the sensitive value. */
export interface RunSensitiveEventV1 extends JournalEventBaseV1 {
  type: 'run.sensitive';
  reason: JournalSensitiveReason;
}

export interface RunCompletedEventV1 extends JournalEventBaseV1 {
  type: 'run.completed';
  summary: string;
}

export interface RunFailedEventV1 extends JournalEventBaseV1 {
  type: 'run.failed';
  summary: string;
}

export interface RunStoppedEventV1 extends JournalEventBaseV1 {
  type: 'run.stopped';
  summary: string;
}

export type RunJournalEventV1 =
  | RunStartedEventV1
  | ActionProposedEventV1
  | ApprovalRequestedEventV1
  | ApprovalResolvedEventV1
  | ActionDispatchingEventV1
  | ActionObservedEventV1
  | ActionCancelledEventV1
  | RecoveryResolvedEventV1
  | RunSensitiveEventV1
  | RunCompletedEventV1
  | RunFailedEventV1
  | RunStoppedEventV1;

export interface RunJournalV1 {
  version: typeof RUN_JOURNAL_VERSION;
  runId: string;
  createdAt: string;
  updatedAt: string;
  /** Equals the last event's sequence and the number of events. */
  revision: number;
  /** Sensitive unfinished journals are never eligible for automatic recovery. */
  sensitive: boolean;
  events: RunJournalEventV1[];
}

type AppendableEventV1 = Exclude<RunJournalEventV1, RunStartedEventV1>;

/** Input accepted by append(); sequence and default timestamp are harness-owned. */
export type AppendRunJournalEventV1<T extends AppendableEventV1 = AppendableEventV1> =
  T extends AppendableEventV1 ? Omit<T, 'seq' | 'at'> & { at?: string } : never;

export class JournalValidationError extends Error {
  constructor(message: string) {
    super(`invalid run journal: ${message}`);
    this.name = 'JournalValidationError';
  }
}

export function assertJournalRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) {
    throw new JournalValidationError('run id must be a bounded opaque identifier');
  }
}

/** Parse unknown disk data without accepting extra keys or future versions by accident. */
export function parseRunJournalV1(value: unknown): RunJournalV1 {
  const journal = object(value, 'document');
  exactKeys(journal, [
    'version',
    'runId',
    'createdAt',
    'updatedAt',
    'revision',
    'sensitive',
    'events',
  ]);
  if (journal.version !== RUN_JOURNAL_VERSION) {
    throw new JournalValidationError(`unsupported version ${String(journal.version)}`);
  }
  const runId = boundedString(journal.runId, 'runId', 128);
  assertJournalRunId(runId);
  const createdAt = timestamp(journal.createdAt, 'createdAt');
  const updatedAt = timestamp(journal.updatedAt, 'updatedAt');
  const revision = integer(journal.revision, 'revision', 1, MAX_JOURNAL_EVENTS);
  if (typeof journal.sensitive !== 'boolean') {
    throw new JournalValidationError('sensitive must be a boolean');
  }
  if (!Array.isArray(journal.events) || journal.events.length === 0) {
    throw new JournalValidationError('events must be a non-empty array');
  }
  if (journal.events.length > MAX_JOURNAL_EVENTS) {
    throw new JournalValidationError(`event cap exceeded (${MAX_JOURNAL_EVENTS})`);
  }

  const events = journal.events.map((event, index) => parseEvent(event, index + 1));
  if (events[0]?.type !== 'run.started') {
    throw new JournalValidationError('first event must be run.started');
  }
  if (revision !== events.length || revision !== events.at(-1)?.seq) {
    throw new JournalValidationError('revision must equal the final event sequence');
  }
  if (createdAt !== events[0].at || updatedAt !== events.at(-1)?.at) {
    throw new JournalValidationError('document timestamps must match its boundary events');
  }
  for (let index = 1; index < events.length; index += 1) {
    if (Date.parse(events[index]!.at) < Date.parse(events[index - 1]!.at)) {
      throw new JournalValidationError('event timestamps may not move backwards');
    }
  }
  return {
    version: RUN_JOURNAL_VERSION,
    runId,
    createdAt,
    updatedAt,
    revision,
    sensitive: journal.sensitive,
    events,
  };
}

function parseEvent(value: unknown, expectedSeq: number): RunJournalEventV1 {
  const event = object(value, `event ${expectedSeq}`);
  const type = boundedString(event.type, `event ${expectedSeq}.type`, 40);
  const seq = integer(event.seq, `event ${expectedSeq}.seq`, 1, MAX_JOURNAL_EVENTS);
  if (seq !== expectedSeq) throw new JournalValidationError('event sequences must be contiguous');
  const at = timestamp(event.at, `event ${expectedSeq}.at`);

  switch (type) {
    case 'run.started': {
      exactKeys(event, ['type', 'seq', 'at', 'task', 'mode'], ['model']);
      const task = boundedString(event.task, 'run.started.task', MAX_JOURNAL_TASK_CHARS, true);
      const mode = oneOf(event.mode, 'run.started.mode', ['ask', 'agent'] as const);
      const model = optionalString(event.model, 'run.started.model', 300);
      return { type, seq, at, task, mode, ...(model === undefined ? {} : { model }) };
    }
    case 'action.proposed': {
      exactKeys(
        event,
        ['type', 'seq', 'at', 'actionId', 'actionKind', 'effect', 'summary'],
        ['host'],
      );
      const actionId = opaqueId(event.actionId, 'action.proposed.actionId');
      const actionKind = actionKindValue(event.actionKind);
      const effect = oneOf(event.effect, 'action.proposed.effect', [
        'read',
        'write',
        'consequential',
      ] as const);
      const summary = boundedString(
        event.summary,
        'action.proposed.summary',
        MAX_JOURNAL_SUMMARY_CHARS,
        true,
      );
      const host = optionalHost(event.host);
      return {
        type,
        seq,
        at,
        actionId,
        actionKind,
        effect,
        summary,
        ...(host === undefined ? {} : { host }),
      };
    }
    case 'approval.requested':
      exactKeys(event, ['type', 'seq', 'at', 'actionId']);
      return { type, seq, at, actionId: opaqueId(event.actionId, `${type}.actionId`) };
    case 'approval.resolved':
      exactKeys(event, ['type', 'seq', 'at', 'actionId', 'decision']);
      return {
        type,
        seq,
        at,
        actionId: opaqueId(event.actionId, `${type}.actionId`),
        decision: oneOf(event.decision, `${type}.decision`, ['approved', 'rejected'] as const),
      };
    case 'action.dispatching':
      exactKeys(event, ['type', 'seq', 'at', 'actionId']);
      return { type, seq, at, actionId: opaqueId(event.actionId, `${type}.actionId`) };
    case 'action.observed':
      exactKeys(event, ['type', 'seq', 'at', 'actionId', 'outcome', 'summary']);
      return {
        type,
        seq,
        at,
        actionId: opaqueId(event.actionId, `${type}.actionId`),
        outcome: oneOf(event.outcome, `${type}.outcome`, [
          'succeeded',
          'failed',
          'unknown',
        ] as const),
        summary: boundedString(event.summary, `${type}.summary`, MAX_JOURNAL_SUMMARY_CHARS, true),
      };
    case 'action.cancelled':
      exactKeys(event, ['type', 'seq', 'at', 'actionId', 'summary']);
      return {
        type,
        seq,
        at,
        actionId: opaqueId(event.actionId, `${type}.actionId`),
        summary: boundedString(event.summary, `${type}.summary`, MAX_JOURNAL_SUMMARY_CHARS, true),
      };
    case 'recovery.resolved':
      exactKeys(event, ['type', 'seq', 'at', 'actionId', 'resolution', 'summary']);
      return {
        type,
        seq,
        at,
        actionId: opaqueId(event.actionId, `${type}.actionId`),
        resolution: oneOf(event.resolution, `${type}.resolution`, [
          'verified_applied',
          'verified_not_applied',
          'abandoned',
        ] as const),
        summary: boundedString(event.summary, `${type}.summary`, MAX_JOURNAL_SUMMARY_CHARS, true),
      };
    case 'run.sensitive':
      exactKeys(event, ['type', 'seq', 'at', 'reason']);
      return {
        type,
        seq,
        at,
        reason: oneOf(event.reason, `${type}.reason`, [
          'credential',
          'upload_path',
          'provider_configuration',
          'image_payload',
          'unknown',
        ] as const),
      };
    case 'run.completed':
    case 'run.failed':
    case 'run.stopped':
      exactKeys(event, ['type', 'seq', 'at', 'summary']);
      return {
        type,
        seq,
        at,
        summary: boundedString(event.summary, `${type}.summary`, MAX_JOURNAL_SUMMARY_CHARS, true),
      };
    default:
      throw new JournalValidationError(`unknown event type ${type}`);
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JournalValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new JournalValidationError(`unexpected field ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new JournalValidationError(`missing field ${key}`);
    }
  }
}

function boundedString(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max) {
    throw new JournalValidationError(`${field} must be a bounded string`);
  }
  if (/\0/.test(value)) throw new JournalValidationError(`${field} contains a NUL byte`);
  return value;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, field, max);
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new JournalValidationError(`${field} must be an integer in range`);
  }
  return value as number;
}

function timestamp(value: unknown, field: string): string {
  const text = boundedString(value, field, 64);
  const parsed = Date.parse(text);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== text
  )
    throw new JournalValidationError(`${field} is not ISO-8601`);
  return text;
}

function opaqueId(value: unknown, field: string): string {
  const id = boundedString(value, field, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) {
    throw new JournalValidationError(`${field} is not an opaque id`);
  }
  return id;
}

function actionKindValue(value: unknown): string {
  const kind = boundedString(value, 'action.proposed.actionKind', 64);
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(kind)) {
    throw new JournalValidationError('action.proposed.actionKind is invalid');
  }
  return kind;
}

function optionalHost(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const host = boundedString(value, 'action.proposed.host', 253).toLowerCase().replace(/\.$/, '');
  if (
    host.includes('..') ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ||
    host.includes('/') ||
    host.includes('@') ||
    host.includes(':')
  ) {
    throw new JournalValidationError('action.proposed.host must be a canonical hostname');
  }
  return host;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  field: string,
  choices: T,
): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) {
    throw new JournalValidationError(`${field} is invalid`);
  }
  return value as T[number];
}
