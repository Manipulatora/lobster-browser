import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type {
  AgentEvent,
  AgentRunSnapshot,
  AgentRunStatus,
  AgentStartParams,
  AgentStartResult,
  AgentUsage,
} from '@lobster/shared-types';
import { createLlmClient, FileMemoryStore, resolveConfig, runAgent } from '@lobster/agent';
import type { AgentAction } from '@lobster/shared-types';
import { LazyBrowserDriver } from './lazy-driver.js';

/** How long a run will wait for the desktop core to launch the profile after `run.needsBrowser`. */
const BROWSER_ATTACH_TIMEOUT_MS = 180_000;

/** How the manager reaches a running profile's CDP endpoint (injected so it's decoupled + testable). */
export type ResolveWs = (profileId: string) => Promise<string | undefined>;

interface Session {
  sessionId: string;
  profileId: string;
  task: string;
  status: AgentRunStatus;
  step: number;
  usage: AgentUsage;
  startedAt: string;
  abort: AbortController;
  driver: LazyBrowserDriver;
  // Explicit `| undefined` because exactOptionalPropertyTypes forbids assigning undefined to a bare `?`.
  awaitingPrompt?: string | undefined;
  awaitingKind?: 'ask' | 'confirm' | undefined;
  awaitingSensitive?: boolean | undefined;
  result?: string | undefined;
  error?: string | undefined;
  pendingInput?: { resolve: (text: string) => void; reject: (e: Error) => void } | undefined;
  /** Set while the run waits for the desktop core to launch the profile (`run.needsBrowser` round-trip). */
  pendingBrowser?: { resolve: (ws: string) => void; reject: (e: Error) => void } | undefined;
}

/**
 * Owns the live agent sessions in the sidecar — ONE per profile (one profile, one agent, one memory).
 * `start` is fire-and-forget: it opens a persistent CDP session, wires the driver/LLM/memory, kicks off
 * the loop, and returns immediately (the stdio dispatch loop is sequential and must never block on a
 * whole run). Progress streams out via {@link emit} as {@link AgentEvent}s; the manager also snapshots
 * status/step/usage from those events so `status()` is accurate for the running-agents tray.
 */
export class AgentManager {
  private readonly sessions = new Map<string, Session>();
  private readonly resolveWs: ResolveWs;
  private readonly emit: (event: AgentEvent) => void;

  constructor(deps: { resolveWs: ResolveWs; emit: (event: AgentEvent) => void }) {
    this.resolveWs = deps.resolveWs;
    this.emit = deps.emit;
  }

  async start(params: AgentStartParams): Promise<AgentStartResult> {
    validateStartParams(params);
    const existing = this.sessions.get(params.profileId);
    if (existing && (existing.status === 'running' || existing.status === 'awaiting_input')) {
      throw new Error(`profile ${params.profileId} already has a running agent`);
    }

    const config = resolveConfig(params.config);
    const llm = createLlmClient(params.llm); // throws clearly on unsupported provider / missing key
    const memory = new FileMemoryStore(params.memoryDir, {
      encryptionKey: params.memoryKey as string,
    });

    const sessionId = randomUUID();
    const abort = new AbortController();

    // Lazy browser: the run starts with the browser closed. The first browser ACTION emits
    // `run.needsBrowser` (the desktop core launches the profile and calls `agent.attachBrowser`);
    // a run that never needs the web never opens a browser. If the profile is already running we
    // attach up front and the run behaves exactly as before.
    const driver = new LazyBrowserDriver(
      () =>
        new Promise<string>((resolve, reject) => {
          const session = this.sessions.get(params.profileId);
          if (!session || session.sessionId !== sessionId) {
            reject(new Error('run is no longer active'));
            return;
          }
          const timer = setTimeout(() => {
            if (session.pendingBrowser) {
              session.pendingBrowser = undefined;
              reject(new Error('timed out waiting for the profile browser to launch'));
            }
          }, BROWSER_ATTACH_TIMEOUT_MS);
          timer.unref?.();
          session.pendingBrowser = {
            resolve: (ws) => {
              clearTimeout(timer);
              resolve(ws);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          };
          emit({
            type: 'run.needsBrowser',
            sessionId,
            profileId: params.profileId,
            ts: new Date().toISOString(),
          });
        }),
    );
    // Ask mode is a browser-less chat — never attach a CDP session for it. Attaching up front is
    // wasteful for a chat, and a transient attach failure must not break a run that never touches the
    // browser. Agent mode attaches now if the profile is already running, else lazily on first action.
    if (params.config?.mode !== 'ask') {
      const existingWs = await this.resolveWs(params.profileId);
      if (existingWs) await driver.attachNow(existingWs);
    }
    const session: Session = {
      sessionId,
      profileId: params.profileId,
      task: params.task,
      status: 'running',
      step: 0,
      usage: { tokensIn: 0, tokensOut: 0 },
      startedAt: new Date().toISOString(),
      abort,
      driver,
    };
    this.sessions.set(params.profileId, session);

    // If the browser/tab dies mid-run, abort the run so it unwinds to a clean `stopped`.
    void driver.closed.then(() => abort.abort());

    const emit = (event: AgentEvent): void => {
      this.applyEvent(session, event);
      this.emit(event);
    };
    const waitForInput = (
      prompt: string,
      kind: 'ask' | 'confirm',
      action?: AgentAction,
    ): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        session.awaitingPrompt = prompt;
        session.awaitingKind = kind;
        session.awaitingSensitive = action?.kind === 'ask' && action.sensitive === true;
        session.pendingInput = { resolve, reject };
      });

    // Fire-and-forget: tear down CDP on completion but retain the small final snapshot until the next
    // run, so a panel mounted after completion can hydrate its result.
    void runAgent(
      {
        sessionId,
        profileId: params.profileId,
        task: params.task,
        runId: sessionId,
        llmConfig: params.llm,
        config,
      },
      {
        driver,
        llm,
        memory,
        emit,
        waitForInput,
        signal: abort.signal,
        now: () => new Date().toISOString(),
      },
    )
      .catch((error: unknown) => {
        // Defensive containment: runAgent reports ordinary failures itself, but an unexpected emit/
        // host exception must not leave a permanently "running" snapshot.
        if (session.status === 'running' || session.status === 'awaiting_input') {
          const event: AgentEvent = {
            type: 'run.finished',
            sessionId,
            profileId: params.profileId,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            usage: { ...session.usage },
            ts: new Date().toISOString(),
          };
          this.applyEvent(session, event);
          this.emit(event);
        }
      })
      .finally(() => {
        driver.close();
      });

    return { sessionId, profileId: params.profileId };
  }

  /**
   * The desktop core's reply to `run.needsBrowser`: the profile is now running (we re-resolve its
   * CDP endpoint ourselves), or the launch failed and the waiting run gets the error.
   */
  async attachBrowser(profileId: string, error?: string): Promise<{ attached: boolean }> {
    const session = this.sessions.get(profileId);
    const pending = session?.pendingBrowser;
    if (!session || !pending) return { attached: false };
    session.pendingBrowser = undefined;
    // Even a reported launch failure attaches if a browser is actually reachable (e.g. it was
    // already running and the redundant launch errored) — the run only fails when there is truly
    // no browser to drive.
    const ws = await this.resolveWs(profileId);
    if (ws) {
      pending.resolve(ws);
      return { attached: true };
    }
    pending.reject(
      new Error(
        error
          ? `could not launch the profile for the agent: ${error}`
          : 'the profile launched but exposed no automation endpoint',
      ),
    );
    return { attached: false };
  }

  stop(profileId: string): { stopped: boolean } {
    const session = this.sessions.get(profileId);
    if (!session || (session.status !== 'running' && session.status !== 'awaiting_input')) {
      return { stopped: false };
    }
    session.abort.abort();
    session.pendingInput?.reject(new Error('run stopped'));
    session.pendingInput = undefined;
    session.pendingBrowser?.reject(new Error('run stopped'));
    session.pendingBrowser = undefined;
    session.awaitingPrompt = undefined;
    session.awaitingKind = undefined;
    session.awaitingSensitive = undefined;
    return { stopped: true };
  }

  sendInput(profileId: string, text: string): { delivered: boolean } {
    const session = this.sessions.get(profileId);
    if (!session || !session.pendingInput) return { delivered: false };
    const pending = session.pendingInput;
    session.pendingInput = undefined;
    session.awaitingPrompt = undefined;
    session.awaitingKind = undefined;
    session.awaitingSensitive = undefined;
    session.status = 'running';
    pending.resolve(text);
    return { delivered: true };
  }

  status(profileId?: string): { runs: AgentRunSnapshot[] } {
    const runs: AgentRunSnapshot[] = [];
    for (const s of this.sessions.values()) {
      if (profileId && s.profileId !== profileId) continue;
      if (!profileId && s.status !== 'running' && s.status !== 'awaiting_input') continue;
      runs.push({
        sessionId: s.sessionId,
        profileId: s.profileId,
        task: s.task,
        status: s.status,
        step: s.step,
        startedAt: s.startedAt,
        usage: { ...s.usage },
        ...(s.awaitingPrompt ? { awaitingPrompt: s.awaitingPrompt } : {}),
        ...(s.awaitingKind ? { awaitingKind: s.awaitingKind } : {}),
        ...(s.awaitingSensitive !== undefined ? { awaitingSensitive: s.awaitingSensitive } : {}),
        ...(s.result ? { result: s.result } : {}),
        ...(s.error ? { error: s.error } : {}),
      });
    }
    return { runs };
  }

  /** Fold a streamed event into the session snapshot so `status()` stays current. */
  private applyEvent(session: Session, event: AgentEvent): void {
    switch (event.type) {
      case 'step.thinking':
      case 'step.action':
      case 'step.observation':
        session.step = event.step;
        session.status = 'running';
        break;
      case 'run.needsInput':
        session.status = 'awaiting_input';
        session.awaitingPrompt = event.prompt;
        session.awaitingKind = event.kind;
        session.awaitingSensitive = event.sensitive;
        break;
      case 'usage':
        session.usage.tokensIn += event.usage.tokensIn;
        session.usage.tokensOut += event.usage.tokensOut;
        break;
      case 'run.finished':
        session.status = event.status;
        session.usage = event.usage;
        session.awaitingPrompt = undefined;
        session.awaitingKind = undefined;
        session.awaitingSensitive = undefined;
        session.result = event.result;
        session.error = event.error;
        session.pendingBrowser?.reject(new Error('run finished'));
        session.pendingBrowser = undefined;
        break;
      default:
        break;
    }
  }
}

function validateStartParams(params: AgentStartParams): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(params.profileId)) throw new Error('invalid agent profile id');
  if (typeof params.task !== 'string' || !params.task.trim() || params.task.length > 20_000) {
    throw new Error('agent task must be 1..20000 characters');
  }
  if (typeof params.memoryDir !== 'string' || !isAbsolute(params.memoryDir)) {
    throw new Error('agent memory directory must be absolute');
  }
  if (
    !params.memoryKey ||
    !/^[A-Za-z0-9+/]{43}=$/.test(params.memoryKey) ||
    Buffer.from(params.memoryKey, 'base64').length !== 32
  ) {
    throw new Error('a valid encrypted-memory key is required');
  }
  if (
    !params.llm ||
    typeof params.llm.model !== 'string' ||
    !params.llm.model ||
    params.llm.model.length > 300
  ) {
    throw new Error('a valid LLM model is required');
  }
  if (
    params.llm.apiKey !== undefined &&
    (typeof params.llm.apiKey !== 'string' || params.llm.apiKey.length > 20_000)
  ) {
    throw new Error('LLM API key exceeds its allowed bound');
  }
  if (
    params.llm.stepModel !== undefined &&
    (typeof params.llm.stepModel !== 'string' ||
      !params.llm.stepModel ||
      params.llm.stepModel.length > 300)
  ) {
    throw new Error('invalid LLM step model');
  }
  if (!['anthropic', 'openai', 'google', 'xai', 'openrouter'].includes(params.llm.provider)) {
    throw new Error('unsupported LLM provider');
  }
}

/** Re-exported for callers that assemble confirm prompts, etc. */
export type { AgentAction };
