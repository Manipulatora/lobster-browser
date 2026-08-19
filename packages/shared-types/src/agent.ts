/**
 * Agent — the per-profile web-automation agent contract.
 *
 * ONE profile → ONE agent → ONE memory. An agent drives the profile's REAL, visible Lobium window
 * (Mode A) through the sidecar's first-party leak-free CDP client (never `Runtime.enable` /
 * `Page.enable`), so the anti-detect surface is untouched while the agent runs. This file is the wire
 * vocabulary shared by the sidecar (which runs the loop), the Rust core (which brokers + injects the
 * key), and the desktop UI (which renders the live step stream) — mirroring how `phone.ts` / `ipc.ts`
 * pin the other cross-process contracts.
 *
 * Memory lives on the USER's machine (per-profile dir), never the server. LLM access is currently
 * BYOK and client-direct to an approved provider host. The contract reserves managed mode, but the
 * implementation fails it closed until an authenticated, metered backend proxy exists.
 */

/** Direct BYOK providers the agent can call. */
export type AgentLlmProvider = 'anthropic' | 'openai' | 'google' | 'xai' | 'openrouter';

/**
 * How one run reaches a model. BYOK (an `apiKey` present, `managed` false) goes client-direct from the
 * sidecar to the provider. `managed` routes through the backend `agent/llm` proxy instead: the server
 * holds the OpenRouter key, authenticates with a Bearer token, allowlists models and meters usage, so no
 * provider credential ever reaches the sidecar. This is what the Lobee side panel uses.
 */
export interface AgentLlmConfig {
  provider: AgentLlmProvider;
  /** Provider model id, e.g. `claude-opus-4-8` or an OpenRouter slug. */
  model: string;
  /** BYOK secret, injected from the native encrypted credential store for the duration of a run. */
  apiKey?: string;
  /** Optional provider URL override; it must still match that provider's official HTTPS host. */
  baseUrl?: string;
  /** Route through the authenticated, metered backend proxy rather than a direct provider key. */
  managed?: boolean;
  /**
   * A cheaper model for routine navigation steps; the primary `model` handles planning / recovery.
   * Optional token-cost lever (§ token efficiency) — omit to use `model` for every step.
   */
  stepModel?: string;
  /**
   * Reasoning effort. Sent to OpenRouter as the unified `reasoning: { effort }` param: passed through
   * natively for OpenAI reasoning models and normalized to a thinking budget for Anthropic. Omit to use
   * the provider default.
   */
  effort?: 'low' | 'medium' | 'high';
}

/**
 * Deep browser-config operations, in three families:
 *   - LIVE (over leak-free CDP, applied instantly, no relaunch): clear one site's cookies, clear all
 *     cookies, site-data / cache, per-site permissions, and download behavior.
 *   - PREF (`set_pref` / `get_pref`): read or write one Chromium preference through the browser's own
 *     settings API, semantically and instantly. This is the precise path — no page is shown, no control
 *     is clicked — and it is restricted to a curated allow-list of keys with closed value domains.
 *   - UI (the chrome://settings fallback): open a vetted settings page so the agent can operate the
 *     real control with humanized input; Chromium applies the change live. `open_settings` is the
 *     general long-tail entry; `set_theme` / `set_privacy` / `set_content_default` are shortcuts to the
 *     appearance / privacy / content pages. Fingerprint- and proxy-identity pages are hard-blocked.
 */
export type BrowserConfigOp =
  | 'clear_cookies'
  | 'clear_all_cookies'
  | 'clear_site_data'
  | 'clear_cache'
  | 'set_permission'
  | 'set_downloads'
  | 'set_pref'
  | 'get_pref'
  | 'open_settings'
  | 'set_theme'
  | 'set_privacy'
  | 'set_content_default';

/** One selectable model for the Lobee picker, synced from the live OpenRouter catalog by the backend. */
export interface AgentModelInfo {
  /** OpenRouter model id (the value sent to the API), e.g. `anthropic/claude-opus-4.8`. */
  id: string;
  label: string;
  /** Provider slug (`openai` | `anthropic` | …) for the brand icon. */
  brand: string;
  /** Curated model, used only for ordering and a nicer display label when present in the live roster. */
  featured: boolean;
  /** Present in the live OpenRouter catalog right now. */
  available: boolean;
  /**
   * Supports the structured tool contract required by Agent mode. Models without this capability stay
   * selectable in Ask mode, but must not be used for browser automation.
   */
  agentCapable: boolean;
  /** Supports reasoning — gates whether the effort toggle applies. */
  reasoning: boolean;
  /** Effort levels the model accepts (empty when it can't reason). */
  efforts: Array<'low' | 'medium' | 'high'>;
  contextLength?: number;
}

/** Response of the managed `GET /agent/llm/models` sync endpoint. */
export interface AgentModelsResult {
  updatedAt: string;
  /** True when served from a stale cache because the live fetch failed. */
  stale: boolean;
  models: AgentModelInfo[];
}

/** Per-run behavior knobs. Safe, bounded defaults are applied by the loop when a field is omitted. */
export interface AgentConfig {
  /**
   * `agent` (default) = the full perceive→act loop with the browser + tools. `ask` = a single chat
   * completion, no browser and no actions — the model answers from its own knowledge in Markdown.
   */
  mode?: 'ask' | 'agent';
  /** Hard ceiling on agent steps; the run stops with status `budget` if hit. Default 40. */
  maxSteps: number;
  /**
   * `auto` acts within the fence without pausing to check its progress; `confirm` pauses for human
   * approval before EVERY mutating action. Default `auto`.
   *
   * In BOTH modes, actions classified consequential — irreversible or externally visible (uploads,
   * purchases, sends, deletions, account creation, permission changes, data erasure) — emit a
   * `run.needsInput` of kind `confirm` and wait. `auto` is "do not check in on progress", not
   * "nothing consequential can happen".
   */
  autonomy: 'auto' | 'confirm';
  /**
   * Site/domain allowlist (a navigation/anti-runaway fence). Public and multi-tenant suffixes are
   * rejected; each entry may be a registrable domain or an intentionally narrower host scope. When
   * set, the agent may not navigate or remain outside these domains. Empty/omitted = no fence.
   */
  allowedDomains?: string[];
  /**
   * Conservative per-run token guardrail. Each request reserves its current input and caps output to
   * the remaining allowance; provider-reported overage is quarantined before action dispatch. This is
   * not exact billing enforcement because provider metering/tokenizers can differ. Omit for no cap.
   */
  tokenBudget?: number;
  /** URL to open before the first step. Omit to act on the page the profile already shows. */
  startUrl?: string;
  /**
   * Allow a screenshot to be sent to the model when the text element-tree is ambiguous (canvas /
   * custom widgets). Default false — text-first is the token-efficient path; vision is opt-in fallback.
   */
  visionFallback?: boolean;
  /** Private/loopback/link-local destinations are blocked by default (SSRF guard). */
  allowPrivateNetwork?: boolean;
  /** What to do when a page action would leave the current registrable domain. Default `confirm`. */
  crossDomainNavigation?: 'allow' | 'confirm' | 'deny';
  /** Absolute roots the agent may select files from for an upload. Empty/omitted disables uploads. */
  allowedUploadRoots?: string[];
}

/**
 * The action space the model emits — ONE per step, as a structured tool call, so both the prompt and
 * the reply stay tiny. `id` indexes an element from the latest observation's numbered tree.
 */
export type AgentAction =
  | {
      kind: 'click';
      id: number;
      button?: 'left' | 'right';
      count?: 1 | 2;
      note?: string;
    }
  /** Vision fallback for inaccessible cross-origin frames/canvas; CSS viewport coordinates. */
  | {
      kind: 'click_at';
      x: number;
      y: number;
      button?: 'left' | 'right';
      count?: 1 | 2;
      note?: string;
    }
  | { kind: 'hover'; id: number; note?: string }
  /** Type into element `id`; `submit` presses Enter after; `clear` selects existing text first. */
  | { kind: 'type'; id: number; text: string; submit?: boolean; clear?: boolean; note?: string }
  | {
      kind: 'type_at';
      x: number;
      y: number;
      text: string;
      submit?: boolean;
      clear?: boolean;
      note?: string;
    }
  | { kind: 'select'; id: number; values: string[]; note?: string }
  | { kind: 'key'; key: string; note?: string }
  | { kind: 'scroll'; direction: 'up' | 'down'; amount?: number; id?: number; note?: string }
  | { kind: 'drag'; fromId: number; toId: number; note?: string }
  | { kind: 'upload'; id: number; paths: string[]; note?: string }
  | { kind: 'navigate'; url: string; note?: string }
  | { kind: 'back'; note?: string }
  | {
      kind: 'tab';
      operation: 'list' | 'new' | 'switch' | 'close';
      /**
       * Positional index from the last `tab list`. FRAGILE: the list is re-enumerated on every call,
       * so any tab opening or closing in between shifts every index. Prefer `tabId`.
       */
      index?: number;
      /** Stable target id from `tab list`, unaffected by other tabs opening or closing. */
      tabId?: string;
      url?: string;
      note?: string;
    }
  | { kind: 'wait'; ms?: number; note?: string }
  /** Pull requested info out of the current page into the run result (no page mutation). */
  | { kind: 'extract'; description: string; note?: string }
  /**
   * Add rows to the run's dataset — the scraping primitive.
   *
   * `extract` returns prose the model must re-type into its final answer, which is where scraped
   * values get transcribed wrong and where earlier pages fall out of a bounded text ledger. `collect`
   * instead accumulates STRUCTURED rows the harness owns: they are deduplicated, survive pagination,
   * and are returned verbatim at the end, so a hundred-row scrape is not limited by what fits in a
   * summary.
   */
  | {
      kind: 'collect';
      /** Column names, given once on the first call and reused for the rest of the run. */
      columns?: string[];
      /** Rows to append; each is a map of column name → cell value. */
      rows: Array<Record<string, string>>;
      note?: string;
    }
  /** Persist a durable per-domain fact to this profile's memory (agent-authored learning). */
  | { kind: 'remember'; factKey: string; factValue: string; note?: string }
  /**
   * Propose a reusable PROCEDURE for this site, saved to the profile's encrypted memory and offered on
   * later runs against the same host. Distinct from `remember`, which stores a fact: a skill is the
   * sequence of steps that worked. The harness sets the domain from the page actually visited — the
   * model cannot scope a skill to a site it did not operate on — and a skill is never derived from
   * instructions found on a page.
   */
  | { kind: 'learn'; skillName: string; skillTrigger: string; skillSteps: string; note?: string }
  /**
   * Deep browser-configuration control (Agent mode). Runs against the browser via leak-free CDP /
   * profile preferences — never the page — so it adds no anti-detect tell. Fingerprint-identity and
   * proxy settings are hard-blocked by the config guard. `op` selects the operation; the other fields
   * are its arguments.
   */
  | {
      kind: 'browser_config';
      op: BrowserConfigOp;
      /** Registrable domain (clear_cookies) or a site permission's origin/target. */
      domain?: string;
      origin?: string;
      /** Permissions-API name for set_permission (e.g. `geolocation`, `notifications`, `camera`). */
      permission?: string;
      setting?: 'granted' | 'denied' | 'prompt';
      /** Download handling for set_downloads. */
      behavior?: 'allow' | 'deny' | 'default';
      /** Chromium preference key for set_pref / get_pref, e.g. `download.prompt_for_download`. */
      pref?: string;
      /** Generic value for pref-backed ops (theme, privacy toggles, content defaults, set_pref). */
      value?: string;
      /** The new value for a list-valued preference, e.g. the startup pages. */
      values?: string[];
      note?: string;
    }
  /** Ask the human without disclosing the reply to the model when `sensitive` + `targetId` are set. */
  | {
      kind: 'ask';
      question: string;
      sensitive?: boolean;
      targetId?: number;
      targetX?: number;
      targetY?: number;
    }
  /** Request a visual observation for canvas/image/custom-widget situations. */
  | { kind: 'screenshot'; description?: string }
  /** Terminal: the task is complete (or provably impossible). */
  | { kind: 'done'; success: boolean; summary: string };

/** Lifecycle status of one agent run. */
export type AgentRunStatus = 'running' | 'awaiting_input' | 'done' | 'error' | 'stopped';

/** Token/cost accounting for a run (or a single step). */
export interface AgentUsage {
  tokensIn: number;
  tokensOut: number;
  /** Provider-reported cache reads, when available — the prompt-caching saving is observable here. */
  cachedTokensIn?: number;
  costUsd?: number;
}

/**
 * Real-time events the sidecar streams for a run (sidecar → Rust broadcast → Tauri `agent-event`).
 * Every event carries `sessionId` + `profileId` so the UI can route to the right profile's panel; the
 * per-profile isolation guarantee means an event NEVER references another profile's data.
 */
export type AgentEvent =
  | { type: 'run.started'; sessionId: string; profileId: string; task: string; ts: string }
  /** The model call for this step began (UI shows a "thinking" state). */
  | { type: 'step.thinking'; sessionId: string; profileId: string; step: number; ts: string }
  /** The model chose an action for this step. */
  | {
      type: 'step.action';
      sessionId: string;
      profileId: string;
      step: number;
      action: AgentAction;
      ts: string;
    }
  /** The page after the action: a terse human-readable summary + where we are. */
  | {
      type: 'step.observation';
      sessionId: string;
      profileId: string;
      step: number;
      url: string;
      title: string;
      summary: string;
      elementCount: number;
      ts: string;
    }
  /** The run paused: it needs a human (an `ask`, a `confirm`, or a required BYOK/login handoff). */
  | {
      type: 'run.needsInput';
      sessionId: string;
      profileId: string;
      kind: 'ask' | 'confirm';
      prompt: string;
      /** For `confirm`, the action awaiting approval. */
      action?: AgentAction;
      /** UI should mask the reply; it will not be put in model history. */
      sensitive?: boolean;
      ts: string;
    }
  /**
   * The agent decided the task needs the web and the profile's browser is not open. The desktop core
   * reacts by launching the profile, then calls `agent.attachBrowser`; the run resumes when the
   * browser is attached. A run that never needs the web never emits this (and no browser opens).
   */
  | { type: 'run.needsBrowser'; sessionId: string; profileId: string; ts: string }
  /**
   * A fragment of the assistant's reply, as the model produces it. The panel appends these so an
   * answer appears while it is being written; a run that finishes without ever emitting one simply
   * renders its result at the end, so this is additive and never required.
   */
  | { type: 'answer.delta'; sessionId: string; profileId: string; text: string; ts: string }
  | { type: 'usage'; sessionId: string; profileId: string; usage: AgentUsage; ts: string }
  | {
      type: 'run.finished';
      sessionId: string;
      profileId: string;
      status: Exclude<AgentRunStatus, 'running' | 'awaiting_input'>;
      /** Free-text outcome (the `done.summary`, extracted data, or an error message). */
      result?: string;
      error?: string;
      usage: AgentUsage;
      ts: string;
    }
  /**
   * A memory operation failed and the run continued without it.
   *
   * Memory is deliberately best-effort — a broken or rotated store must never stop the agent doing the
   * user's task — but "best effort" silently became "no effort" in the UI: these degradations were only
   * ever emitted as generic `log` events, which the panel drops on its `default` branch. A profile that
   * had quietly stopped remembering anything looked pixel-identical to one that was working. This is a
   * DISTINCT event rather than surfacing raw `log`, so the panel renders exactly this class of problem
   * and not arbitrary internal warnings.
   */
  | {
      type: 'memory.degraded';
      sessionId: string;
      profileId: string;
      /** Which operation degraded — `run` (record), `thread` (conversation), or `step`. */
      scope: 'run' | 'thread' | 'step';
      /** Safe, human-readable reason. Never carries page-derived or secret material. */
      reason: string;
      ts: string;
    }
  | {
      type: 'log';
      sessionId: string;
      profileId: string;
      level: 'debug' | 'info' | 'warn' | 'error';
      message: string;
      ts: string;
    };

/**
 * `agent.start` — begin a run on a profile. The profile does NOT need to be launched: the run starts
 * with the browser closed, and if (and only if) the agent takes a browser action, it emits
 * `run.needsBrowser` and waits for the desktop core to launch the profile + `agent.attachBrowser`.
 */
export interface AgentStartParams {
  profileId: string;
  /**
   * Which surface started this run. `panel` runs stream to the in-browser side panel over the loopback
   * bridge, so the sidecar can tell whether a human is still attached and refuse to pause for input
   * nobody can give. Omitted (or `desktop`) keeps the previous behaviour of assuming a human is there.
   */
  origin?: 'panel' | 'desktop';
  /** Natural-language task, e.g. "log into example.com and download the latest invoice". */
  task: string;
  /**
   * The conversation this run belongs to. The sidecar loads that thread's prior turns as real
   * assistant/user messages and appends this exchange when the run ends — this is what makes a
   * follow-up ("do that again for the other site") resolvable. A new id starts a fresh conversation;
   * omitting it runs with no history at all.
   */
  threadId?: string;
  /**
   * Absolute per-profile agent memory directory (`<userDataDir>/agent`). The Rust core owns the
   * profiles dir and passes it; the sidecar resolves memory ONLY from here, so one profile can never
   * read another's memory (isolation is structural, not a runtime check).
   */
  memoryDir: string;
  /** Internal desktop→sidecar key for encrypted local memory; never persisted in run/event data. */
  memoryKey?: string;
  llm: AgentLlmConfig;
  config?: Partial<AgentConfig>;
}

/** `agent.start` returns immediately (fire-and-forget); progress arrives as {@link AgentEvent}s. */
export interface AgentStartResult {
  sessionId: string;
  profileId: string;
}

/** `agent.stop` — abort a run (idempotent; unknown/finished profiles resolve `{ stopped: false }`). */
export interface AgentStopParams {
  profileId: string;
}
export interface AgentStopResult {
  stopped: boolean;
}

/**
 * `agent.attachBrowser` — the desktop core's reply to `run.needsBrowser`: the profile was launched
 * (the sidecar re-resolves its CDP endpoint itself), or the launch failed with `error`.
 */
export interface AgentAttachBrowserParams {
  profileId: string;
  /** When set, the launch failed and the waiting run finishes with this error. */
  error?: string;
}
export interface AgentAttachBrowserResult {
  attached: boolean;
}

/** `agent.sendInput` — answer an `awaiting_input` run (human reply to an `ask`, or a confirm verdict). */
export interface AgentSendInputParams {
  profileId: string;
  /** For an `ask`: the human's answer. For a `confirm`: `"approve"` or `"reject"`. */
  text: string;
}
export interface AgentSendInputResult {
  delivered: boolean;
}

/** A snapshot of one run for `agent.status` / the running-agents tray. */
export interface AgentRunSnapshot {
  sessionId: string;
  profileId: string;
  /** Conversation that owns this run. Required for panel reopen/reconciliation isolation. */
  threadId?: string;
  task: string;
  status: AgentRunStatus;
  step: number;
  startedAt: string;
  usage: AgentUsage;
  /** Present when `status === 'awaiting_input'`. */
  awaitingPrompt?: string;
  awaitingKind?: 'ask' | 'confirm';
  awaitingSensitive?: boolean;
  result?: string;
  error?: string;
}

export interface AgentStatusParams {
  profileId?: string;
}
export interface AgentStatusResult {
  runs: AgentRunSnapshot[];
}

/**
 * `agent.listModels` — validate a BYOK key and list the chat models it can use (BYOK only; managed
 * mode uses a curated list client-side). `apiKey` may be omitted to reuse the stored key.
 */
export interface AgentListModelsParams {
  provider: AgentLlmProvider;
  apiKey?: string;
}
export interface AgentListModelsResult {
  models: string[];
}
