import {
  JournalValidationError,
  type JournalActionEffect,
  type JournalRunMode,
  type JournalTerminalStatus,
  type RunJournalEventV1,
  type RunJournalV1,
} from './schema.js';

export type RunJournalPhase =
  | 'running'
  | 'proposed'
  | 'awaiting_approval'
  | 'approved'
  | 'dispatching'
  | 'recovery_required'
  | JournalTerminalStatus;

/**
 * This digest is intentionally incapable of being sent to a driver. It contains no action arguments,
 * DOM references, coordinates, values, script, or upload path. Recovery must always ask the live
 * agent to observe and plan again.
 */
export interface NonExecutableActionDigest {
  actionId: string;
  actionKind: string;
  effect: JournalActionEffect;
  summary: string;
  host?: string;
}

export interface RunJournalState {
  runId: string;
  task: string;
  mode: JournalRunMode;
  model?: string;
  revision: number;
  phase: RunJournalPhase;
  sensitive: boolean;
  activeAction?: NonExecutableActionDigest;
  terminalStatus?: JournalTerminalStatus;
  terminalSummary?: string;
}

export class JournalTransitionError extends JournalValidationError {
  constructor(message: string) {
    super(`illegal transition: ${message}`);
    this.name = 'JournalTransitionError';
  }
}

/** Replay and validate the complete event stream. No mutable state is trusted from disk. */
export function reduceRunJournal(journal: RunJournalV1): RunJournalState {
  const first = journal.events[0];
  if (!first || first.type !== 'run.started') {
    throw new JournalTransitionError('journal does not begin with run.started');
  }
  let state: RunJournalState = {
    runId: journal.runId,
    task: first.task,
    mode: first.mode,
    ...(first.model === undefined ? {} : { model: first.model }),
    revision: 1,
    phase: 'running',
    sensitive: journal.sensitive,
  };
  const seenActionIds = new Set<string>();

  for (const event of journal.events.slice(1)) {
    state = applyEvent(state, event, seenActionIds);
  }
  if (state.revision !== journal.revision) {
    throw new JournalTransitionError('reducer revision does not match the document');
  }
  if (journal.events.some((event) => event.type === 'run.sensitive') && !journal.sensitive) {
    throw new JournalTransitionError('run.sensitive event requires the document sensitive flag');
  }
  return state;
}

function applyEvent(
  state: RunJournalState,
  event: RunJournalEventV1,
  seenActionIds: Set<string>,
): RunJournalState {
  if (isTerminalPhase(state.phase)) {
    throw new JournalTransitionError(`${event.type} follows terminal state ${state.phase}`);
  }
  if (event.type === 'run.started') {
    throw new JournalTransitionError('run.started may only be the first event');
  }

  const base = { ...state, revision: event.seq };
  switch (event.type) {
    case 'run.sensitive':
      return { ...base, sensitive: true };

    case 'action.proposed':
      requirePhase(state, event.type, ['running']);
      if (seenActionIds.has(event.actionId)) {
        throw new JournalTransitionError(`action id ${event.actionId} was reused`);
      }
      seenActionIds.add(event.actionId);
      return {
        ...base,
        phase: 'proposed',
        activeAction: {
          actionId: event.actionId,
          actionKind: event.actionKind,
          effect: event.effect,
          summary: event.summary,
          ...(event.host === undefined ? {} : { host: event.host }),
        },
      };

    case 'approval.requested':
      requirePhase(state, event.type, ['proposed']);
      requireAction(state, event.actionId, event.type);
      return { ...base, phase: 'awaiting_approval' };

    case 'approval.resolved':
      requirePhase(state, event.type, ['awaiting_approval']);
      requireAction(state, event.actionId, event.type);
      if (event.decision === 'approved') return { ...base, phase: 'approved' };
      // Rejection of "stay on this unexpected destination" means the already-observed drift still
      // has to be rolled back. Keep that reconciliation action live so the same durable digest can
      // cross a dispatch boundary for the verified restoration.
      return state.activeAction?.actionKind === 'navigation_reconcile'
        ? { ...base, phase: 'proposed' }
        : withoutAction({ ...base, phase: 'running' });

    case 'action.dispatching':
      requirePhase(state, event.type, ['proposed', 'approved']);
      requireAction(state, event.actionId, event.type);
      return { ...base, phase: 'dispatching' };

    case 'action.observed':
      requirePhase(state, event.type, ['dispatching']);
      requireAction(state, event.actionId, event.type);
      return event.outcome === 'unknown'
        ? { ...base, phase: 'recovery_required' }
        : withoutAction({ ...base, phase: 'running' });

    case 'action.cancelled':
      requirePhase(state, event.type, ['proposed', 'approved']);
      requireAction(state, event.actionId, event.type);
      return withoutAction({ ...base, phase: 'running' });

    case 'recovery.resolved':
      requirePhase(state, event.type, ['recovery_required']);
      requireAction(state, event.actionId, event.type);
      return withoutAction({ ...base, phase: 'running' });

    case 'run.completed':
      requirePhase(state, event.type, ['running']);
      return withoutAction({
        ...base,
        phase: 'completed',
        terminalStatus: 'completed',
        terminalSummary: event.summary,
      });

    case 'run.failed':
    case 'run.stopped': {
      // An in-flight or explicitly unknown side effect must be reconciled before it can be hidden
      // behind a terminal marker.
      if (state.activeAction?.actionKind === 'navigation_reconcile') {
        throw new JournalTransitionError(
          `${event.type} cannot hide unresolved unexpected navigation`,
        );
      }
      requirePhase(state, event.type, ['running', 'proposed', 'awaiting_approval', 'approved']);
      const terminalStatus = event.type === 'run.failed' ? 'failed' : 'stopped';
      return withoutAction({
        ...base,
        phase: terminalStatus,
        terminalStatus,
        terminalSummary: event.summary,
      });
    }
  }
}

function requirePhase(
  state: RunJournalState,
  eventType: string,
  phases: readonly RunJournalPhase[],
): void {
  if (!phases.includes(state.phase)) {
    throw new JournalTransitionError(`${eventType} is not valid while ${state.phase}`);
  }
}

function requireAction(state: RunJournalState, actionId: string, eventType: string): void {
  if (!state.activeAction || state.activeAction.actionId !== actionId) {
    throw new JournalTransitionError(`${eventType} does not match the active action`);
  }
}

function withoutAction(state: RunJournalState): RunJournalState {
  const { activeAction: _activeAction, ...rest } = state;
  return rest;
}

export function isTerminalPhase(phase: RunJournalPhase): phase is JournalTerminalStatus {
  return phase === 'completed' || phase === 'failed' || phase === 'stopped';
}
