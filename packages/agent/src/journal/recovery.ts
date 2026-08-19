import { isTerminalPhase, type RunJournalState } from './reducer.js';
import type { AppendRunJournalEventV1 } from './schema.js';
import type { RunJournalSnapshot } from './store.js';

export type RunRecoveryProjection =
  | {
      kind: 'terminal';
      status: 'completed' | 'failed' | 'stopped';
      summary: string;
    }
  | {
      kind: 'non_resumable';
      reason: 'sensitive_journal';
    }
  | {
      kind: 'replan';
      reason: 'clean_checkpoint' | 'pending_action_discarded' | 'read_only_dispatch_ambiguous';
      /** Correlation only; never enough information to reconstruct or execute an action. */
      actionId?: string;
    }
  | {
      kind: 'recovery_required';
      reason: 'side_effect_may_have_occurred' | 'outcome_unknown';
      /** Correlation only; the operator must verify live state before resolving it. */
      actionId: string;
    };

/**
 * Classify restart behavior without ever returning a replayable action. Even a read-only action that
 * was being dispatched is discarded and replanned against a new observation.
 */
export function projectRunRecovery(state: RunJournalState): RunRecoveryProjection {
  if (isTerminalPhase(state.phase)) {
    return {
      kind: 'terminal',
      status: state.phase,
      summary: state.terminalSummary ?? '',
    };
  }
  if (state.sensitive) return { kind: 'non_resumable', reason: 'sensitive_journal' };

  if (state.phase === 'dispatching') {
    if (!state.activeAction)
      throw new Error('invalid journal state: dispatching without an action');
    return state.activeAction.effect === 'read'
      ? {
          kind: 'replan',
          reason: 'read_only_dispatch_ambiguous',
          actionId: state.activeAction.actionId,
        }
      : {
          kind: 'recovery_required',
          reason: 'side_effect_may_have_occurred',
          actionId: state.activeAction.actionId,
        };
  }
  if (state.phase === 'recovery_required') {
    if (!state.activeAction) {
      throw new Error('invalid journal state: recovery_required without an action');
    }
    return {
      kind: 'recovery_required',
      reason: 'outcome_unknown',
      actionId: state.activeAction.actionId,
    };
  }
  if (
    state.phase === 'proposed' ||
    state.phase === 'awaiting_approval' ||
    state.phase === 'approved'
  ) {
    return {
      kind: 'replan',
      reason: 'pending_action_discarded',
      ...(state.activeAction === undefined ? {} : { actionId: state.activeAction.actionId }),
    };
  }
  return { kind: 'replan', reason: 'clean_checkpoint' };
}

/** What the operator determined about the interrupted action before closing its journal. */
export type RunRecoveryResolution = 'verified_applied' | 'verified_not_applied' | 'abandoned';

/** The store surface a resolution needs: an authenticated read plus revision-checked appends. */
export interface ResolvableRunJournalStore {
  load(runId: string): Promise<RunJournalSnapshot | null>;
  append(
    runId: string,
    event: AppendRunJournalEventV1,
    expectedRevision: number,
  ): Promise<RunJournalSnapshot>;
}

const RESOLUTION_SUMMARY: Record<RunRecoveryResolution, string> = {
  verified_applied: 'An operator verified the effect had been applied',
  verified_not_applied: 'An operator verified the effect had not been applied',
  abandoned: 'An operator abandoned the interrupted effect without verifying it',
};

/**
 * Close an interrupted journal an operator has reviewed, so the profile can run again.
 *
 * Blocking admission on an unresolved effect is only defensible while a resolution EXISTS. Without one,
 * a single unverifiable dispatch — a CDP timeout, a killed process, a page that stopped answering —
 * disables the agent for that profile forever, which is a worse failure than the one the block prevents.
 *
 * This never replays, reconstructs, or reveals the action: the stored digest is deliberately
 * non-executable and stays that way. It records what the human decided and walks the run to its
 * terminal `stopped` marker through the same reducer transitions a live run would use, so a resolved
 * journal is indistinguishable from any other honestly-closed one.
 */
export async function resolveRunRecovery(
  store: ResolvableRunJournalStore,
  runId: string,
  resolution: RunRecoveryResolution,
): Promise<'resolved' | 'already_terminal'> {
  const loaded = await store.load(runId);
  if (!loaded) throw new Error(`run journal not found: ${runId}`);
  let snapshot = loaded;
  if (isTerminalPhase(snapshot.state.phase)) return 'already_terminal';

  const append = async (event: AppendRunJournalEventV1): Promise<void> => {
    snapshot = await store.append(runId, event, snapshot.journal.revision);
  };
  const actionId = (): string => {
    const active = snapshot.state.activeAction;
    if (!active) throw new Error(`run ${runId} has no action to resolve`);
    return active.actionId;
  };

  if (snapshot.state.phase === 'dispatching') {
    await append({
      type: 'action.observed',
      actionId: actionId(),
      outcome: 'unknown',
      summary: 'The interrupted dispatch was reviewed by an operator',
    });
  }
  if (snapshot.state.phase === 'awaiting_approval') {
    await append({ type: 'approval.resolved', actionId: actionId(), decision: 'rejected' });
  }
  if (snapshot.state.phase === 'recovery_required') {
    await append({
      type: 'recovery.resolved',
      actionId: actionId(),
      resolution,
      summary: RESOLUTION_SUMMARY[resolution],
    });
  }
  if (snapshot.state.phase === 'proposed' || snapshot.state.phase === 'approved') {
    await append({
      type: 'action.cancelled',
      actionId: actionId(),
      summary: 'The pending action was discarded without replay',
    });
  }
  await append({ type: 'run.stopped', summary: 'Interrupted run closed after operator recovery' });
  return 'resolved';
}
