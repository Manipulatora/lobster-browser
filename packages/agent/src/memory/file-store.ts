import { Buffer } from 'node:buffer';
import type { AgentUsage } from '@lobster/shared-types';
import type { BuiltinSkill } from '../skills.js';
import type { StepRecord } from '../types.js';
import type {
  FactRecord,
  MemorySettings,
  MemoryStore,
  ThreadMessage,
  ThreadSummary,
} from './types.js';

/**
 * The no-persistence memory store.
 *
 * This class used to be ~900 lines of AES-256-GCM-authenticated per-profile files: conversation
 * threads, per-domain facts, learned skills, and run/step records, plus a one-way plaintext
 * migration window and structural thread compaction. All of it is gone — deliberately, as a product
 * decision, not as a simplification pass:
 *
 * - NOTHING about an agent task may survive it. No threads, no facts, no skills, no run records.
 *   Every run starts from a clean context with zero bleed from previous tasks, and the only place a
 *   task's content ever lives is the panel transcript the user watched happen.
 * - Removing the write paths removes an entire attack surface with them. Facts and skills were
 *   model-authored while reading pages the agent does not control; storing them meant page-derived
 *   text could steer FUTURE runs, which is why their read paths needed fencing, sanitizing,
 *   staleness labelling, and a migration window that had to be provably one-way. A store that
 *   persists nothing needs none of that machinery, and no bug in it can leak or replay anything.
 *
 * WHY THE CLASS SURVIVES AT ALL: the sidecar (`AgentManager`, the bridge's `/thread` route) and the
 * agent loop are written against the `MemoryStore` interface, and keeping that seam stable means the
 * change is one file, not a cross-package cascade. Reads answer with honest emptiness; writes accept
 * their input and drop it. The constructor still validates the profile key so a mis-provisioned
 * caller fails loudly HERE — at the same point it always did — instead of appearing to work while
 * silently differing from the encrypted-journal store that still uses the same key for real.
 *
 * Files written by earlier versions (threads/, runs/, memory.json, the migration marker) are left
 * untouched on disk and simply never read again: deleting user data on an automated upgrade path is
 * a bigger decision than never consulting it, and belongs to the desktop core if the owner wants it.
 */
export class FileMemoryStore implements MemoryStore {
  constructor(
    memoryDir: string,
    opts: {
      encryptionKey: string;
      /** Accepted for wire/API compatibility; meaningless now that nothing is ever read. */
      allowLegacyPlaintext?: boolean;
    },
  ) {
    // The directory is accepted (and ignored) so every existing construction site keeps compiling
    // and the interface keeps making sense for a future store that persists again.
    void memoryDir;
    const key = Buffer.from(opts.encryptionKey, 'base64');
    if (key.length !== 32) {
      throw new Error('agent memory encryption key must be 32 bytes (base64 encoded)');
    }
  }

  /** Every thread is empty: conversations are never persisted, so there is nothing to load. */
  async loadThread(_threadId: string): Promise<ThreadMessage[]> {
    return [];
  }

  /**
   * Strict used to mean "distinguish missing from corrupt so the panel can trust an empty answer as
   * authorization to retire its plaintext fallback". With no storage there is nothing to corrupt;
   * empty IS the truth, for every thread id, and callers may rely on it.
   */
  async loadThreadStrict(_threadId: string): Promise<ThreadMessage[]> {
    return [];
  }

  /** Accepted and dropped: no turn of any conversation becomes durable state. */
  async appendThreadTurn(
    _threadId: string,
    _turn: { user: string; assistant: string; status: 'done' | 'error' | 'stopped' },
  ): Promise<void> {}

  async listThreads(_limit?: number): Promise<ThreadSummary[]> {
    return [];
  }

  /** No facts, no learned skills, no context block. Built-in skills reach the prompt from code. */
  async loadContext(_domain?: string, _task?: string): Promise<string> {
    return '';
  }

  /**
   * Run/step/finish records were persistence-only even before (nothing ever read them back into a
   * prompt), so dropping them loses no capability — the loop still calls these, and the events it
   * emits alongside remain the live progress feed the panel renders.
   */
  async startRun(
    _runId: string,
    _task: string,
    _startedAt: string,
    _metadata?: { mode?: 'ask' | 'agent'; model?: string },
  ): Promise<void> {}

  async appendStep(_runId: string, _step: StepRecord): Promise<void> {}

  async finishRun(
    _runId: string,
    _outcome: { status: string; summary: string; usage: AgentUsage; endedAt: string },
  ): Promise<void> {}

  /**
   * The `remember`/`learn` actions were removed from the action set; these are kept as inert
   * interface members so the seam stays whole. They intentionally do NOT throw: a caller holding an
   * old model output must degrade to "nothing saved", never to a failed run.
   */
  async rememberFact(
    _fact: Omit<FactRecord, 'updatedAt'> & { updatedAt?: string },
  ): Promise<void> {}

  async learnSkill(_skill: BuiltinSkill): Promise<void> {}

  async getSettings(): Promise<MemorySettings> {
    return {};
  }

  async setSettings(_settings: MemorySettings): Promise<void> {}
}
