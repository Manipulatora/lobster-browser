// Transcript model: each submitted task is one Turn; agent events reduce into it (grouped by step) so
// the panel shows an organized activity feed + a final Markdown answer, never a raw event firehose.
//
// This is deliberately a pure module with no React in it. It owns the event reducer, the encrypted
// history merge and the rules that decide when a retained plaintext body may be retired — the parts
// where a mistake silently destroys someone's conversation — so they can be tested directly.
// The imports carry their extension because `node --test` loads this module as-is, and Node resolves
// no extensions of its own — Vite and tsc (allowImportingTsExtensions) both accept the explicit form.
import { matchThreadHistory, threadExchanges } from './history.ts';
import { redactTranscriptText, type StoredTurn } from './transcript.ts';
import { describeAction, hostOf } from './util.ts';
import type { EncryptedThreadMessage } from './bridge.ts';
import type { AgentEvent, AgentRunSnapshot } from './types.ts';

export interface Step {
  label: string;
  ctx: string;
  /** When the sidecar last touched this step (ISO timestamp), for the rail dot's hover detail. */
  ts?: string;
  /** The action kind behind the step (`navigate`, `click`, …); a thinking step carries none yet. */
  kind?: string;
  /** What the action actually did — the harness's own one-line result, shown beside the dot. */
  outcome?: string;
  thinking: boolean;
  done: boolean;
}
export interface AwaitPrompt {
  prompt: string;
  kind: 'ask' | 'confirm';
  sensitive: boolean;
}
export interface Turn {
  id: number;
  sessionId?: string;
  /** Conversation this turn belongs to, so its answer can be re-read from encrypted memory. */
  threadId?: string;
  /** Stable opaque identity returned by the authenticated encrypted-thread endpoint. */
  turnKey?: string;
  /** Whether this turn owns a row in the local metadata/migration index. */
  localRecord: boolean;
  /** A legacy or availability-fallback body retained until exact encrypted verification succeeds. */
  needsSecureMigration: boolean;
  startedAt?: string;
  task: string;
  status: '' | 'running' | 'done' | 'error' | 'stopped';
  statusText: string;
  steps: Map<number, Step>;
  answer: string;
  /** Why the run failed. Kept apart from `answer` so a failure never renders as a reply. */
  failure: string;
  /** True once any text arrived as a live stream, so the finish handler does not re-animate it. */
  streamed: boolean;
  /** Provider-reported tokens for this turn. Events were already flowing; nothing displayed them. */
  tokensIn: number;
  tokensOut: number;
  /** Prompt tokens served from cache, so a cold cache is visible rather than merely expensive. */
  cachedTokensIn: number;
  /** Set when memory failed mid-run. Surfaced so silent forgetting stops looking like success. */
  memoryWarning: string;
  /** Why a cancel request did not reach the sidecar. The run is still burning tokens until it does. */
  stopError: string;
  await: AwaitPrompt | null;
  inputError: string;
  animateAnswer: boolean;
}

export const blankStep = (): Step => ({ label: '', ctx: '', thinking: false, done: false });

function settleThinking(steps: Map<number, Step>): Map<number, Step> {
  const settled = new Map<number, Step>();
  for (const [number, step] of steps) {
    settled.set(number, step.thinking ? { ...step, thinking: false, done: true } : step);
  }
  return settled;
}

export function applyEvent(turn: Turn, ev: AgentEvent): Turn {
  const upsert = (n: number, patch: Partial<Step>): Turn => {
    const steps = new Map(turn.steps);
    steps.set(n, { ...(steps.get(n) ?? blankStep()), ...patch });
    return { ...turn, steps };
  };
  switch (ev.type) {
    case 'run.started':
      return {
        ...turn,
        status: 'running',
        statusText: 'Working…',
        ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
        ...(ev.ts ? { startedAt: ev.ts } : {}),
      };
    case 'run.needsBrowser':
      return { ...turn, status: 'running', statusText: 'Opening browser…' };
    case 'step.thinking': {
      const steps = settleThinking(turn.steps);
      const number = ev.step ?? 0;
      steps.set(number, {
        ...(steps.get(number) ?? blankStep()),
        thinking: true,
        done: false,
        label: 'Thinking',
        ...(ev.ts ? { ts: ev.ts } : {}),
      });
      return { ...turn, steps };
    }
    case 'step.progress': {
      // The model is still working: say so, and roughly how much it has produced, on the step that
      // is thinking. A step that already settled (its action arrived) keeps its line.
      const number = ev.step ?? 0;
      const prior = turn.steps.get(number);
      if (!prior?.thinking) return turn;
      const chars = typeof ev.chars === 'number' ? ev.chars : 0;
      const verb =
        ev.kind === 'reasoning' ? 'Reasoning' : ev.kind === 'tool' ? 'Deciding' : 'Writing';
      return upsert(number, {
        label: chars >= 1000 ? `${verb}… ${(chars / 1000).toFixed(1)}k` : `${verb}…`,
        ...(ev.ts ? { ts: ev.ts } : {}),
      });
    }
    case 'run.steered': {
      // The user's mid-run message sits in the rail where it landed — between the step it
      // interrupted and the next one — so the run reads as the conversation it was.
      const key = (ev.step ?? 0) + 0.5;
      const prior = turn.steps.get(key);
      const text = typeof ev.text === 'string' ? ev.text.trim() : '';
      if (!text) return turn;
      return upsert(key, {
        kind: 'steer',
        label: prior?.label ? `${prior.label}\n${text}` : text,
        done: true,
        thinking: false,
        ...(ev.ts ? { ts: ev.ts } : {}),
      });
    }
    case 'step.outcome':
      return upsert(ev.step ?? 0, {
        ...(typeof ev.text === 'string' && ev.text ? { outcome: ev.text } : {}),
        ...(ev.ts ? { ts: ev.ts } : {}),
      });
    case 'step.action':
      return upsert(ev.step ?? 0, {
        thinking: false,
        label: describeAction(ev.action),
        done: true,
        ...(ev.ts ? { ts: ev.ts } : {}),
        ...(ev.action?.kind ? { kind: ev.action.kind } : {}),
      });
    case 'step.observation':
      return upsert(ev.step ?? 0, {
        ctx: ev.title || hostOf(String(ev.url ?? '')),
        ...(ev.ts ? { ts: ev.ts } : {}),
      });
    case 'run.needsInput':
      return {
        ...turn,
        steps: settleThinking(turn.steps),
        status: 'running',
        statusText: 'Needs you',
        await: {
          prompt: ev.prompt || 'The agent needs your input.',
          kind: ev.kind === 'confirm' ? 'confirm' : 'ask',
          sensitive: !!ev.sensitive,
        },
        inputError: '',
      };
    case 'usage':
      // These events always flowed; the reducer simply fell through to `default` and discarded them,
      // so the panel could never show what a run cost.
      return {
        ...turn,
        tokensIn: turn.tokensIn + (ev.usage?.tokensIn ?? 0),
        tokensOut: turn.tokensOut + (ev.usage?.tokensOut ?? 0),
        // Cache hits are reported per call by every adapter and were being thrown away. Without this
        // there is no way to tell an expensive run from a cold-cache one.
        cachedTokensIn: turn.cachedTokensIn + (ev.usage?.cachedTokensIn ?? 0),
      };
    case 'answer.delta':
      // Real streaming: the reply grows as the model writes it. `animateAnswer` stays false because
      // the text is ALREADY arriving progressively — replaying it through the typewriter would show
      // the answer twice, at two different speeds.
      return {
        ...turn,
        status: 'running',
        statusText: 'Writing…',
        answer: turn.answer + (ev.text ?? ''),
        streamed: true,
        animateAnswer: false,
      };
    case 'run.finished': {
      const ok = ev.status === 'done';
      // An error is NOT an answer. Keeping them in the same field rendered failures as though the
      // model had replied — Markdown-formatted, indistinguishable from a real response, with nothing
      // to retry from. They are separate fields so the UI can say plainly that something went wrong.
      const answer = ok ? ev.result || turn.answer : turn.answer;
      const failure = ok ? '' : ev.error || ev.result || 'The run ended without a result.';
      return {
        ...turn,
        steps: settleThinking(turn.steps),
        status: ok ? 'done' : ev.status === 'error' ? 'error' : 'stopped',
        statusText: ok ? 'Done' : ev.status === 'error' ? 'Failed' : 'Stopped',
        answer,
        failure,
        await: null,
        inputError: '',
        // The run is over, so whether an earlier cancel request landed is no longer a live question.
        stopError: '',
        animateAnswer:
          !turn.streamed && ok && !!answer && (turn.status !== 'done' || turn.answer !== answer),
        ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
      };
    }
    // Memory is best-effort by design, but a profile that has quietly stopped remembering must not
    // look identical to one that is working. One line, not a modal: the run itself still succeeded.
    case 'memory.degraded':
      return {
        ...turn,
        memoryWarning:
          ev.scope === 'thread'
            ? 'This conversation could not be saved, so the next message may not recall it.'
            : ev.scope === 'run'
              ? 'This run could not be recorded to the profile memory.'
              : 'Some run details could not be saved to the profile memory.',
      };
    default:
      return turn;
  }
}

export function storedToTurn(stored: StoredTurn): Turn {
  return {
    id: stored.id,
    ...(stored.sessionId ? { sessionId: stored.sessionId } : {}),
    ...(stored.startedAt ? { startedAt: stored.startedAt } : {}),
    ...(stored.turnKey ? { turnKey: stored.turnKey } : {}),
    localRecord: true,
    needsSecureMigration: stored.needsSecureMigration === true,
    task: stored.task ?? '',
    status: stored.status,
    statusText:
      stored.status === 'done' ? 'Done' : stored.status === 'error' ? 'Failed' : 'Stopped',
    steps: new Map(
      (stored.steps ?? []).map((step, index) => [
        index,
        { label: step.label, ctx: step.ctx, thinking: false, done: true },
      ]),
    ),
    // Bodies are no longer persisted locally; they are hydrated from encrypted memory. A transcript
    // written by an older panel may still carry one, so use it if present rather than blanking history.
    answer: stored.status === 'done' ? (stored.answer ?? '') : '',
    failure: stored.status === 'done' ? '' : (stored.answer ?? ''),
    threadId: stored.threadId ?? '',
    streamed: false,
    tokensIn: stored.tokensIn ?? 0,
    cachedTokensIn: 0,
    memoryWarning: '',
    stopError: '',
    tokensOut: stored.tokensOut ?? 0,
    await: null,
    inputError: '',
    animateAnswer: false,
  };
}

export function snapshotToTurn(snapshot: AgentRunSnapshot, id: number, threadId: string): Turn {
  return {
    id,
    sessionId: snapshot.sessionId,
    startedAt: snapshot.startedAt,
    task: redactTranscriptText(snapshot.task),
    status: snapshot.status === 'awaiting_input' ? 'running' : snapshot.status,
    statusText:
      snapshot.status === 'awaiting_input'
        ? 'Needs you'
        : snapshot.status === 'running'
          ? 'Working…'
          : snapshot.status === 'done'
            ? 'Done'
            : snapshot.status === 'error'
              ? 'Failed'
              : 'Stopped',
    steps: new Map(),
    answer:
      snapshot.status === 'error' || snapshot.status === 'stopped' ? '' : snapshot.result || '',
    failure:
      snapshot.status === 'error' || snapshot.status === 'stopped'
        ? snapshot.error || snapshot.result || ''
        : '',
    threadId,
    localRecord: true,
    // Keep the locally-redacted body only until an exact encrypted thread counterpart is observed.
    // Startup rejection or thread-write degradation can otherwise leave a permanent body-less row.
    needsSecureMigration: true,
    streamed: false,
    tokensIn: 0,
    tokensOut: 0,
    cachedTokensIn: 0,
    memoryWarning: '',
    stopError: '',
    await:
      snapshot.status === 'awaiting_input' && snapshot.awaitingPrompt
        ? {
            prompt: snapshot.awaitingPrompt,
            kind: snapshot.awaitingKind ?? 'ask',
            sensitive: snapshot.awaitingSensitive === true,
          }
        : null,
    inputError: '',
    animateAnswer: false,
  };
}

export function toStoredTurn(turn: Turn): StoredTurn | null {
  if (
    !turn.localRecord ||
    (turn.status !== 'done' && turn.status !== 'error' && turn.status !== 'stopped')
  )
    return null;
  return {
    id: turn.id,
    ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
    ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
    status: turn.status,
    // Normally not persisted: task, answer/failure, and page-derived steps live in the encrypted store.
    // An explicitly marked availability/migration fallback below is the bounded exception.
    ...(turn.threadId ? { threadId: turn.threadId } : {}),
    ...(turn.turnKey ? { turnKey: turn.turnKey } : {}),
    ...(turn.needsSecureMigration
      ? {
          task: turn.task,
          answer: turn.status === 'done' ? turn.answer : turn.failure,
          needsSecureMigration: true,
          ...(turn.steps.size
            ? {
                steps: [...turn.steps.entries()]
                  .sort((left, right) => left[0] - right[0])
                  .map(([, step]) => ({ label: step.label, ctx: step.ctx })),
              }
            : {}),
        }
      : {}),
    ...(turn.tokensIn ? { tokensIn: turn.tokensIn } : {}),
    ...(turn.tokensOut ? { tokensOut: turn.tokensOut } : {}),
  };
}

/** Reconstruct terminal turns from the encrypted thread, which is the source of truth for bodies. */
export function turnsFromThread(
  messages: readonly EncryptedThreadMessage[],
  threadId: string,
): Turn[] {
  return threadExchanges(messages).map((exchange, index) => {
    const { status } = exchange;
    return {
      id: index + 1,
      threadId,
      ...(exchange.startedAt ? { startedAt: exchange.startedAt } : {}),
      ...(exchange.turnId ? { turnKey: exchange.turnId } : {}),
      localRecord: false,
      needsSecureMigration: false,
      task: exchange.task,
      status,
      statusText: status === 'done' ? 'Done' : status === 'error' ? 'Failed' : 'Stopped',
      steps: new Map(),
      answer: status === 'done' ? exchange.response : '',
      failure: status === 'done' ? '' : exchange.response,
      streamed: false,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokensIn: 0,
      memoryWarning: '',
      stopError: '',
      await: null,
      inputError: '',
      animateAnswer: false,
    };
  });
}

/** Overlay local metadata only when a stable id or complete legacy body verifies the exact turn. */
export function mergeStoredMetadata(encrypted: Turn[], stored: Turn[]): Turn[] {
  const result = matchThreadHistory(
    encrypted.map((turn) => ({
      ...(turn.turnKey ? { turnId: turn.turnKey } : {}),
      task: turn.task,
      response: turn.status === 'done' ? turn.answer : turn.failure,
      status: turn.status as 'done' | 'error' | 'stopped',
    })),
    stored.map((turn) => ({
      ...(turn.turnKey ? { turnId: turn.turnKey } : {}),
      ...(turn.task
        ? {
            task: turn.task,
            response: turn.status === 'done' ? turn.answer : turn.failure,
          }
        : {}),
      status: turn.status as 'done' | 'error' | 'stopped',
    })),
  );
  const matchedByExchange = new Map(
    result.matches.map(({ exchangeIndex, metadataIndex }) => [exchangeIndex, metadataIndex]),
  );
  const merged = encrypted.map((body, exchangeIndex) => {
    const metadataIndex = matchedByExchange.get(exchangeIndex);
    if (metadataIndex === undefined) return body;
    const metadata = stored[metadataIndex]!;
    return {
      ...body,
      id: metadata.id,
      localRecord: true,
      // Exact content or an opaque stable id verified that the encrypted copy exists. Only now may a
      // legacy/availability plaintext body be retired from local storage.
      needsSecureMigration: false,
      ...(metadata.sessionId ? { sessionId: metadata.sessionId } : {}),
      ...(metadata.startedAt ? { startedAt: metadata.startedAt } : {}),
      tokensIn: metadata.tokensIn,
      tokensOut: metadata.tokensOut,
      cachedTokensIn: metadata.cachedTokensIn,
      memoryWarning: metadata.memoryWarning,
      // A legacy row may still carry the activity trail for this one in-memory migration. Never save
      // it again; toStoredTurn intentionally emits no step content.
      steps: metadata.steps.size ? metadata.steps : body.steps,
    };
  });
  // Fail closed: body-less or ambiguous metadata is kept as its own local row. It is never shifted
  // onto a neighboring encrypted turn merely because counts happen to line up.
  return [...merged, ...result.unmatchedMetadataIndices.map((index) => stored[index]!)];
}
