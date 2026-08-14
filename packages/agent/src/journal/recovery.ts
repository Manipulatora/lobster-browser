import { isTerminalPhase, type RunJournalState } from './reducer.js';

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
