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
 * Per-profile agent memory. Every method is scoped to ONE profile's directory; there is no API to
 * reach another profile's memory, so cross-profile isolation is structural (see AgentStartParams.memoryDir).
 * The default implementation is file-backed (no native deps) — a SQLite impl can replace it behind this
 * interface without touching callers.
 */
export interface MemoryStore {
  /** Build the compact "what this profile knows" block for the system prompt (facts for `domain` + skills). */
  loadContext(domain?: string, task?: string): Promise<string>;
  /**
   * Build bounded chronological context from recent successful chat/agent turns. Legacy records,
   * unsuccessful runs, and credential-like turns are deliberately excluded.
   */
  loadConversationContext(): Promise<string>;
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
