/**
 * @lobster/agent — the per-profile web agent core.
 *
 * Engine-agnostic: the agent perceives (text-first DOM), decides one action per step via a
 * provider-agnostic LLM, and acts through an injected {@link BrowserDriver}. The sidecar supplies a
 * concrete driver over the first-party leak-free CDP client + humanized input, and a per-profile
 * memory store. Nothing here touches CDP, the network, or the filesystem except through injected deps
 * (the FileMemoryStore is the one batteries-included impl, kept dependency-free for the bundle).
 */

export type { BrowserConfigCommand, BrowserDriver, BrowserTab, Point } from './driver.js';
export {
  assessBrowserConfig,
  assessUiSettingsIntent,
  normalizeBrowserPermission,
  normalizeBrowserPermissionOrigin,
  normalizeCookieDomain,
} from './browser-config-guard.js';
export type { ConfigAssessment } from './browser-config-guard.js';
export type {
  PageMeta,
  PerceivedElement,
  RawPerception,
  Observation,
  StepRecord,
} from './types.js';

export { perceive } from './perception/perceive.js';
export { renderObservation, sameElements } from './perception/serialize.js';
export { EXTRACT_SCRIPT, MAX_ELEMENTS, MAX_NAME } from './perception/extract-script.js';

export {
  ACT_TOOL,
  buildActionReference,
  NAMED_KEYS,
  normalizeActionKey,
  parseAction,
} from './actions.js';
export type { RawActionInput, ParseActionResult } from './actions.js';
export { executeAction } from './executor.js';
export type { ExecOutcome, ExecOptions, Sleep } from './executor.js';

export { buildSystemPrompt, buildStepPrompt } from './prompt.js';
export { BUILTIN_SKILLS, formatSkills, selectSkills } from './skills.js';
export type { BuiltinSkill } from './skills.js';

export { createLlmClient, AnthropicClient, listModels } from './llm/index.js';
export type {
  LlmClient,
  LlmRequest,
  LlmResult,
  LlmTool,
  LlmToolCall,
  ListModelsConfig,
} from './llm/index.js';

export { FileMemoryStore } from './memory/index.js';
export type { MemoryStore, FactRecord, MemorySettings, RunRecord } from './memory/index.js';

// Narrow production recovery surface. Journal crypto/schema internals remain package-private; the
// sidecar only needs the authenticated store and the non-replayable recovery projection.
export { projectRunRecovery, resolveRunRecovery, RunJournalStore } from './journal/index.js';
export type { RunJournalSnapshot, RunRecoveryResolution } from './journal/index.js';

export { runAgent, resolveConfig } from './loop.js';
export type { AgentRunDeps, AgentRunParams } from './loop.js';
export {
  actionCommitIntent,
  actionRisk,
  assessCurrentPage,
  commitIntentGatesUnattended,
  isTextEntryElement,
  normalizeAllowedDomains,
} from './policy.js';
export type { ActionRisk, CommitIntent } from './policy.js';
