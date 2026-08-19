// Complete journal module surface for internal tests. The package root deliberately re-exports only
// the small runtime subset consumed by engine-runner.
export { EncryptedJournalFile, JournalStorageError } from './encrypted-file.js';
export {
  JournalTransitionError,
  isTerminalPhase,
  reduceRunJournal,
  type NonExecutableActionDigest,
  type RunJournalPhase,
  type RunJournalState,
} from './reducer.js';
export {
  projectRunRecovery,
  resolveRunRecovery,
  type ResolvableRunJournalStore,
  type RunRecoveryProjection,
  type RunRecoveryResolution,
} from './recovery.js';
export {
  JournalValidationError,
  MAX_JOURNAL_BYTES,
  MAX_JOURNAL_EVENTS,
  RUN_JOURNAL_VERSION,
  assertJournalRunId,
  parseRunJournalV1,
  type AppendRunJournalEventV1,
  type JournalActionEffect,
  type JournalRunMode,
  type JournalSensitiveReason,
  type JournalTerminalStatus,
  type RunJournalEventV1,
  type RunJournalV1,
} from './schema.js';
export { scrubJournalText, type ScrubbedJournalText } from './scrub.js';
export {
  JournalRevisionConflictError,
  RunJournalNotFoundError,
  RunJournalStore,
  type CreateRunJournalInput,
  type PruneFinishedResult,
  type RunJournalSnapshot,
} from './store.js';
