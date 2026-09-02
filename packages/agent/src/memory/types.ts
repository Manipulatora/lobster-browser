import type { AgentUsage } from '@lobster/shared-types';
import type { BuiltinSkill } from '../skills.js';
import type { StepRecord } from '../types.js';

/** A durable, per-domain learning ("cookie-accept selector", "session persists"). */
export interface FactRecord {
  /** Registrable domain or host the fact applies to. */
  domain: string;
  key: string;
  value: string;
  confidence?: number;
  updatedAt: string;
}

/** Per-profile persisted preferences (last-used model/provider/autonomy). */
export interface MemorySettings {
  provider?: string;
  model?: string;
  autonomy?: 'auto' | 'confirm';
}

/** A finished (or in-flight) run's persisted record. */
export interface RunRecord {
  id: string;
  /** Optional for backward compatibility: records written before chat memory did not carry a mode. */
  mode?: 'ask' | 'agent';
  /** Model used for this run, for diagnostics and future conversation migration. */
  model?: string;
  task: string;
  /** True when task/output redaction detected credential-like material; never inject this run. */
  sensitive?: boolean;
  status: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  usage?: AgentUsage;
  steps: StepRecord[];
}

/**
 * One turn in a conversation thread.
 *
 * `compaction` is a real, first-class entry rather than a destructive rewrite: when a thread outgrows
 * its budget the older turns collapse into a summary the user can SEE, instead of silently vanishing.
 * That visibility is the point — the previous design dropped turns with no trace, so the model answered
 * from a history that quietly disagreed with what was on screen.
 */
export interface ThreadMessage {
  role: 'user' | 'assistant' | 'compaction';
  content: string;
  ts: string;
  /**
   * Outcome of the run that produced an assistant turn. Failed and stopped turns are RETAINED (the
   * follow-up is usually "try again, but…", which is unanswerable without them) and labelled, so the
   * model can tell an answer apart from an attempt.
   */
  status?: 'done' | 'error' | 'stopped';
  /** True when the stored text was clipped to fit the per-message bound. */
  clipped?: boolean;
}

/** A conversation thread: the unit "New chat" creates and the panel shows. */
export interface ThreadRecord {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messages: ThreadMessage[];
}

/** A thread as listed in the panel's history, without its body. */
export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

/**
 * Per-profile agent memory SEAM — kept as an interface even though the shipped implementation
 * (`FileMemoryStore`) deliberately persists NOTHING. The product decision is that no thread, fact,
 * skill, or run record survives a task; the interface survives because the loop and the sidecar are
 * written against it, and because a future opt-in store would slot back in here without touching
 * callers. Every read below is therefore contractually allowed to answer with emptiness, and every
 * write with a silent drop — callers must already tolerate both (memory has always been
 * best-effort, never a hard dependency of a run).
 */
export interface MemoryStore {
  /** Read one thread's turns, oldest first. The shipped store always answers empty. */
  loadThread(threadId: string): Promise<ThreadMessage[]>;
  /** Record a completed exchange. The shipped store drops it — nothing conversational persists. */
  appendThreadTurn(
    threadId: string,
    turn: { user: string; assistant: string; status: 'done' | 'error' | 'stopped' },
  ): Promise<void>;
  /** Threads for this profile, newest first. The shipped store always answers empty. */
  listThreads(limit?: number): Promise<ThreadSummary[]>;
  /** Compact "what this profile knows" prompt block. The shipped store always answers ''. */
  loadContext(domain?: string, task?: string): Promise<string>;
  /** Begin a run; returns the run id used by subsequent step/finish calls. */
  startRun(
    runId: string,
    task: string,
    startedAt: string,
    metadata?: { mode?: 'ask' | 'agent'; model?: string },
  ): Promise<void>;
  /** Append one terse step to the run. */
  appendStep(runId: string, step: StepRecord): Promise<void>;
  /** Finalize the run with an outcome summary + usage, and promote any durable learnings. */
  finishRun(
    runId: string,
    outcome: { status: string; summary: string; usage: AgentUsage; endedAt: string },
  ): Promise<void>;
  /** Record a durable per-domain fact (upserted by domain+key). */
  rememberFact(fact: Omit<FactRecord, 'updatedAt'> & { updatedAt?: string }): Promise<void>;
  /** Save a learned skill from a successful run. */
  learnSkill(skill: BuiltinSkill): Promise<void>;
  getSettings(): Promise<MemorySettings>;
  setSettings(settings: MemorySettings): Promise<void>;
}
