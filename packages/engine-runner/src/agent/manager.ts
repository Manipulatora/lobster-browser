import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  AgentEvent,
  AgentRunSnapshot,
  AgentRunStatus,
  AgentStartParams,
  AgentStartResult,
  AgentUsage,
} from '@lobster/shared-types';
import {
  FileMemoryStore,
  projectRunRecovery,
  resolveConfig,
  resolveRunRecovery,
  RunJournalStore,
  runAgent,
} from '@lobster/agent';
import type { AgentAction } from '@lobster/shared-types';
import { LazyBrowserDriver } from './lazy-driver.js';
import { createRunLlmClient } from './managed-llm.js';
import { resolveProfileNetworkRoute } from './bridge-registry.js';
import { createNavigationEgressPreflight } from './navigation-egress.js';

/** How long a run will wait for the desktop core to launch the profile after `run.needsBrowser`. */
const BROWSER_ATTACH_TIMEOUT_MS = 180_000;

/**
 * How long a run will wait for a human to answer an `ask`/`confirm` before giving up.
 *
 * Without this the wait was a bare `new Promise` with no timer: closing the side panel mid-question
 * left the run pending forever, the session never left `running`, and `start()` then rejected every
 * subsequent run on that profile — a permanent wedge that `stop()` could not clear either, because
 * nothing was left to deliver the rejection. Timing out resolves to a truthful terminal state; it is
 * never treated as approval.
 */
const HUMAN_INPUT_TIMEOUT_MS = 10 * 60_000;

/** Process-wide supplement to the durable filesystem lease (covers multiple manager facades). */
const ACTIVE_PROFILE_RUNS = new Set<string>();

/** How the manager reaches a running profile's CDP endpoint (injected so it's decoupled + testable). */
export type ResolveWs = (profileId: string) => Promise<string | undefined>;

interface Session {
  sessionId: string;
  profileId: string;
  threadId?: string;
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
  /** Messages the user sent mid-run, waiting for the loop to take them at its next step. */
  steering: string[];
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
  /** Covers async journal admission/browser attachment before a Session is visible in `sessions`. */
  private readonly startingProfiles = new Set<string>();
  private readonly resolveWs: ResolveWs;
  private readonly emit: (event: AgentEvent) => void;

  /**
   * Is a human actually attached to this profile's UI? Installed by the loopback bridge once it is
   * listening. Consulted ONLY for runs that declare `origin: 'panel'` — the desktop path streams over
   * stdio/Tauri events and has no bridge subscriber, so judging it by this probe would wrongly refuse
   * every desktop `ask`. Absent probe = assume a human is present (the pre-existing behaviour).
   */
  private presenceProbe: ((profileId: string) => boolean) | undefined;

  setPresenceProbe(probe: (profileId: string) => boolean): void {
    this.presenceProbe = probe;
  }

  constructor(deps: { resolveWs: ResolveWs; emit: (event: AgentEvent) => void }) {
    this.resolveWs = deps.resolveWs;
    this.emit = deps.emit;
  }

  async start(params: AgentStartParams): Promise<AgentStartResult> {
    validateStartParams(params);
    if (this.startingProfiles.has(params.profileId)) {
      throw new Error(`profile ${params.profileId} already has an agent starting`);
    }
    this.startingProfiles.add(params.profileId);
    const runKey = `${resolve(params.memoryDir)}\0${params.profileId}`;
    if (ACTIVE_PROFILE_RUNS.has(runKey)) {
      this.startingProfiles.delete(params.profileId);
      throw new Error(`profile ${params.profileId} already has a running agent`);
    }
    ACTIVE_PROFILE_RUNS.add(runKey);
    let releaseLease: (() => Promise<void>) | undefined;
    try {
      releaseLease = await acquireProfileLease(params.memoryDir, params.profileId);
      return await this.startUnlocked(params, async () => {
        try {
          await releaseLease?.();
        } finally {
          ACTIVE_PROFILE_RUNS.delete(runKey);
        }
      });
    } catch (error) {
      try {
        await releaseLease?.();
      } finally {
        ACTIVE_PROFILE_RUNS.delete(runKey);
      }
      throw error;
    } finally {
      this.startingProfiles.delete(params.profileId);
    }
  }

  private async startUnlocked(
    params: AgentStartParams,
    releaseRunLease: () => Promise<void>,
  ): Promise<AgentStartResult> {
    const existing = this.sessions.get(params.profileId);
    if (existing && (existing.status === 'running' || existing.status === 'awaiting_input')) {
      throw new Error(`profile ${params.profileId} already has a running agent`);
    }

    const config = resolveConfig(params.config);
    const llm = createRunLlmClient(params.llm); // throws clearly on unsupported provider / missing key
    const memory = new FileMemoryStore(params.memoryDir, {
      encryptionKey: params.memoryKey as string,
    });
    const journal = new RunJournalStore(join(params.memoryDir, 'journals'), {
      // The journal is another per-profile encrypted record, not another key lifecycle. Native code
      // already provisions this exact 32-byte profile key for memory and never persists it here.
      encryptionKey: params.memoryKey as string,
    });
    await admitUnfinishedRunJournals(journal, params.profileId);

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
      createNavigationEgressPreflight({
        // Read lazily: the first action can launch the profile, which provisions this route while
        // `requestWs` above is pending. Unknown legacy/unprovisioned launches fail closed.
        route: () => resolveProfileNetworkRoute(params.profileId) ?? 'unknown',
        allowPrivateNetwork: config.allowPrivateNetwork === true,
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
      ...(params.threadId ? { threadId: params.threadId } : {}),
      task: params.task,
      status: 'running',
      step: 0,
      usage: { tokensIn: 0, tokensOut: 0 },
      startedAt: new Date().toISOString(),
      abort,
      driver,
      steering: [],
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
        // Nobody is watching: a question would pause the run until the timeout for an answer that can
        // never arrive. Fail immediately and truthfully instead — the user reads a real reason in the
        // transcript rather than finding a run that stalled for ten minutes.
        if (
          params.origin === 'panel' &&
          this.presenceProbe &&
          !this.presenceProbe(params.profileId)
        ) {
          reject(
            new Error(
              `the agent needed a human (${kind}) but the Lobee panel is not open for this profile`,
            ),
          );
          return;
        }
        session.awaitingPrompt = prompt;
        session.awaitingKind = kind;
        session.awaitingSensitive = action?.kind === 'ask' && action.sensitive === true;
        const timer = setTimeout(() => {
          if (session.pendingInput !== entry) return; // already answered
          session.pendingInput = undefined;
          session.awaitingPrompt = undefined;
          session.awaitingKind = undefined;
          session.awaitingSensitive = undefined;
          // Reject, never resolve: resolving would hand the loop a string, and for a `confirm` the
          // only safe reading of "nobody answered" is "not approved" — while for an `ask` an invented
          // answer would be typed into a real field.
          reject(new Error('no one answered the agent within 10 minutes'));
        }, HUMAN_INPUT_TIMEOUT_MS);
        timer.unref?.();
        const entry = {
          resolve: (text: string): void => {
            clearTimeout(timer);
            resolve(text);
          },
          reject: (error: Error): void => {
            clearTimeout(timer);
            reject(error);
          },
        };
        session.pendingInput = entry;
      });

    // Fire-and-forget: tear down CDP on completion but retain the small final snapshot until the next
    // run, so a panel mounted after completion can hydrate its result.
    void runAgent(
      {
        sessionId,
        profileId: params.profileId,
        task: params.task,
        runId: sessionId,
        ...(params.threadId ? { threadId: params.threadId } : {}),
        llmConfig: params.llm,
        config,
      },
      {
        driver,
        llm,
        memory,
        journal,
        emit,
        waitForInput,
        takeSteering: () => session.steering.splice(0),
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
      .finally(async () => {
        try {
          driver.close();
        } finally {
          await releaseRunLease();
        }
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

  /**
   * Queue a mid-run message for the loop. It is NOT an answer to a pending question (that is
   * `sendInput`, which also carries secrets); it is the user changing course while the agent works,
   * and it reaches the model as a trusted user turn at the top of the next step.
   */
  steer(profileId: string, text: string): { delivered: boolean } {
    const session = this.sessions.get(profileId);
    if (!session || (session.status !== 'running' && session.status !== 'awaiting_input')) {
      return { delivered: false };
    }
    session.steering.push(text);
    return { delivered: true };
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
        ...(s.threadId ? { threadId: s.threadId } : {}),
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

async function acquireProfileLease(
  memoryDir: string,
  profileId: string,
): Promise<() => Promise<void>> {
  await mkdir(memoryDir, { recursive: true, mode: 0o700 });
  const path = join(memoryDir, '.lobee-agent.lock');
  const nonce = randomUUID();
  const owner = JSON.stringify({
    version: 1,
    profileId,
    pid: process.pid,
    processStart: await processStartMarker(process.pid),
    nonce,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(owner, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        // Never unlink a successor's lease if an operator/process replaced this file unexpectedly.
        const current = await readFile(path, 'utf8').catch(() => '');
        if (current === owner) await unlink(path).catch(() => {});
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (!isFsCode(error, 'EEXIST')) {
        throw error;
      }
      if (await leaseOwnerMayBeAlive(path)) {
        throw new Error(`profile ${profileId} already has a running agent`);
      }
      // An authenticated run journal still decides whether a dead process crossed an effect boundary;
      // this file only serializes admission. Removing a proven-dead owner's lease never replays work.
      await unlink(path).catch((unlinkError) => {
        if (!isFsCode(unlinkError, 'ENOENT')) throw unlinkError;
      });
    }
  }
  throw new Error(`profile ${profileId} already has a running agent`);
}

async function leaseOwnerMayBeAlive(path: string): Promise<boolean> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    // A concurrently-created or corrupt lease is not safe to delete automatically.
    return true;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true;
  const owner = raw as { pid?: unknown; processStart?: unknown };
  if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return true;
  const pid = owner.pid as number;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return !isFsCode(error, 'ESRCH');
  }
  if (typeof owner.processStart === 'string' && owner.processStart) {
    const current = await processStartMarker(pid);
    if (current && current !== owner.processStart) return false;
  }
  return true;
}

async function processStartMarker(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/);
    return fields[19]; // Linux /proc field 22 (starttime); fields[0] is field 3 after comm.
  } catch {
    return undefined;
  }
}

function isFsCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

/**
 * SELF-HEALING admission. Every journal in the profile's directory is walked to a terminal state and
 * then deleted, so a start can never be refused because of what a PREVIOUS run left behind.
 *
 * This used to throw for three classes of interrupted journal (sensitive, unreconciled navigation,
 * ambiguous write) with instructions to "explicitly resolve or discard this encrypted journal" —
 * but no product surface ever called the resolve endpoints, so the instruction had no in-product
 * exit and one killed sidecar or CDP hiccup disabled the agent for that profile FOREVER. Blocking
 * admission on an unresolved effect is only defensible while resolution exists and is reachable;
 * with a fully autonomous agent the honest resolution is the one an operator would always have
 * picked anyway: abandon the interrupted effect WITHOUT replaying it, warn, and move on.
 *
 * The never-replay property is inherited, not re-implemented: `resolveRunRecovery` walks the journal
 * to `run.stopped` through the same reducer transitions a live run uses (`approval.resolved
 * rejected` for a pending approval, `action.observed unknown` + `recovery.resolved abandoned` for an
 * in-flight dispatch, `action.cancelled` for a proposal), and the stored digest is non-executable by
 * construction — there is nothing in it that COULD be replayed. What is genuinely lost versus the
 * old behavior is the operator's chance to verify a half-finished purchase/upload before the next
 * run; that is exactly the trade the owner chose, and the warn line keeps the discard visible.
 *
 * Terminal journals are deleted rather than skipped: nothing about a finished run persists (the loop
 * deletes its own journal at completion; this sweep also catches residue from older versions and
 * from crashes between the terminal append and the delete). An UNREADABLE journal — corrupt bytes,
 * wrong key, schema violation — is quarantined aside as `.journal.corrupt` instead of thrown, for
 * the same reason the throws went: one bad file must cost a warning, never the profile.
 */
export async function admitUnfinishedRunJournals(
  store: RunJournalStore,
  profileId: string,
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<void> {
  for (const runId of await store.listRunIds()) {
    let snapshot;
    try {
      snapshot = await store.load(runId);
    } catch (error) {
      const quarantined = await store.quarantineUnreadable(runId);
      warn(
        `[lobee] profile ${profileId}: run journal ${runId} could not be read (${error instanceof Error ? error.message : String(error)}); ` +
          (quarantined
            ? `moved it aside as ${runId}.journal.corrupt so it cannot block future runs`
            : 'it became readable again and was left for the next admission pass'),
      );
      continue;
    }
    if (!snapshot) continue; // deleted between listing and loading — nothing to heal
    const projection = projectRunRecovery(snapshot.state);
    if (projection.kind !== 'terminal') {
      // 'abandoned' is the one disposition that is always truthful without a human: we verified
      // nothing, we replay nothing, and the journal records exactly that.
      await resolveRunRecovery(store, runId, 'abandoned');
      const what =
        projection.kind === 'non_resumable'
          ? 'it had handled a credential, upload path, or image payload'
          : projection.kind === 'recovery_required'
            ? 'its last write or consequential action may already have taken effect'
            : 'it was interrupted at a recoverable checkpoint';
      warn(
        `[lobee] profile ${profileId}: auto-closed interrupted run ${runId} without replay (${what}). ` +
          'If that run was mid-purchase, mid-upload, or mid-submit, verify the site state manually.',
      );
    }
    // Now provably terminal (either it already was, or the resolve walk just made it so) — delete
    // the residue. `removeFinished` re-proves terminality under the store's write lock.
    await store.removeFinished(runId);
  }
}

function validateStartParams(params: AgentStartParams): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(params.profileId)) throw new Error('invalid agent profile id');
  // The thread id becomes a filename in the profile's memory dir, so it is constrained here rather
  // than sanitized later — a traversal-shaped id must never reach the store at all.
  if (params.threadId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(params.threadId)) {
    throw new Error('invalid agent thread id');
  }
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
  if (
    params.llm.stepEffort !== undefined &&
    !['low', 'medium', 'high'].includes(params.llm.stepEffort)
  ) {
    throw new Error('invalid LLM step effort');
  }
  if (!['anthropic', 'openai', 'google', 'xai', 'openrouter'].includes(params.llm.provider)) {
    throw new Error('unsupported LLM provider');
  }
}

/** Re-exported for callers that assemble confirm prompts, etc. */
export type { AgentAction };
