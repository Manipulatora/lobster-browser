import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDownIcon, MagnifyingGlassIcon, CheckIcon } from '@heroicons/react/24/outline';
import { brandIcon } from './icons';
import { renderMarkdown } from './md';
import { fetchModels, fetchStatus, resumeTask, runTask, sendInput } from './bridge';
import { ALL_EFFORTS, EFFORT_LABEL, FALLBACK_MODELS, brandTitle, mapRoster, store } from './models';
import {
  loadTranscript,
  redactTranscriptText,
  saveTranscript,
  type StoredTurn,
} from './transcript';
import { describeAction, hostOf } from './util';
import type { AgentEvent, AgentRunSnapshot, Effort, Mode, ModelInfo } from './types';

// ---------------------------------------------------------------------------------------------------
// Transcript model: each submitted task is one Turn; agent events reduce into it (grouped by step) so
// the panel shows an organized activity feed + a final Markdown answer, never a raw event firehose.
interface Step {
  label: string;
  ctx: string;
  thinking: boolean;
  done: boolean;
}
interface AwaitPrompt {
  prompt: string;
  kind: 'ask' | 'confirm';
  sensitive: boolean;
}
interface Turn {
  id: number;
  sessionId?: string;
  startedAt?: string;
  task: string;
  status: '' | 'running' | 'done' | 'error' | 'stopped';
  statusText: string;
  steps: Map<number, Step>;
  answer: string;
  await: AwaitPrompt | null;
  inputError: string;
  animateAnswer: boolean;
}

const blankStep = (): Step => ({ label: '', ctx: '', thinking: false, done: false });

function settleThinking(steps: Map<number, Step>): Map<number, Step> {
  const settled = new Map<number, Step>();
  for (const [number, step] of steps) {
    settled.set(number, step.thinking ? { ...step, thinking: false, done: true } : step);
  }
  return settled;
}

function applyEvent(turn: Turn, ev: AgentEvent): Turn {
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
      });
      return { ...turn, steps };
    }
    case 'step.action':
      return upsert(ev.step ?? 0, {
        thinking: false,
        label: describeAction(ev.action),
        done: true,
      });
    case 'step.observation':
      return upsert(ev.step ?? 0, { ctx: ev.title || hostOf(String(ev.url ?? '')) });
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
    case 'run.finished': {
      const ok = ev.status === 'done';
      const answer = ev.result || ev.error || turn.answer;
      return {
        ...turn,
        steps: settleThinking(turn.steps),
        status: ok ? 'done' : ev.status === 'error' ? 'error' : 'stopped',
        statusText: ok ? 'Done' : ev.status === 'error' ? 'Failed' : 'Stopped',
        answer,
        await: null,
        inputError: '',
        animateAnswer: ok && !!answer && (turn.status !== 'done' || turn.answer !== answer),
        ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
      };
    }
    default:
      return turn;
  }
}

function storedToTurn(stored: StoredTurn): Turn {
  return {
    id: stored.id,
    ...(stored.sessionId ? { sessionId: stored.sessionId } : {}),
    ...(stored.startedAt ? { startedAt: stored.startedAt } : {}),
    task: stored.task,
    status: stored.status,
    statusText:
      stored.status === 'done' ? 'Done' : stored.status === 'error' ? 'Failed' : 'Stopped',
    steps: new Map(),
    answer: stored.answer,
    await: null,
    inputError: '',
    animateAnswer: false,
  };
}

function snapshotToTurn(snapshot: AgentRunSnapshot, id: number): Turn {
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
    answer: snapshot.result || snapshot.error || '',
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

function toStoredTurn(turn: Turn): StoredTurn | null {
  if (turn.status !== 'done' && turn.status !== 'error' && turn.status !== 'stopped') return null;
  return {
    id: turn.id,
    ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
    ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
    task: turn.task,
    status: turn.status,
    answer: turn.answer,
  };
}

// ---------------------------------------------------------------------------------------------------
function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = '';
    el.appendChild(renderMarkdown(text));
  }, [text]);
  return <div className="md" ref={ref} />;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

function splitGraphemes(text: string): string[] {
  try {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
      (part) => part.segment,
    );
  } catch {
    return Array.from(text);
  }
}

function ProgressiveMarkdown({ text, animate }: { text: string; animate: boolean }) {
  const reducedMotion = useReducedMotion();
  const [visible, setVisible] = useState(() => (animate && !reducedMotion ? '' : text));
  const [typing, setTyping] = useState(animate && !reducedMotion);

  useEffect(() => {
    if (!animate || reducedMotion || document.visibilityState === 'hidden') {
      setVisible(text);
      setTyping(false);
      return;
    }
    const parts = splitGraphemes(text);
    if (!parts.length) {
      setVisible('');
      setTyping(false);
      return;
    }
    setVisible('');
    setTyping(true);
    const duration = Math.min(2_600, Math.max(420, parts.length * 22));
    const started = performance.now();
    let frame = 0;
    let lastPaint = started - 50;
    const finish = (): void => {
      cancelAnimationFrame(frame);
      setVisible(text);
      setTyping(false);
    };
    const tick = (now: number): void => {
      const count = Math.min(parts.length, Math.floor(((now - started) / duration) * parts.length));
      if (now - lastPaint >= 50 && count > 0) {
        lastPaint = now;
        setVisible(parts.slice(0, count).join(''));
      }
      if (count >= parts.length) finish();
      else frame = requestAnimationFrame(tick);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') finish();
    };
    document.addEventListener('visibilitychange', onVisibility);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [animate, reducedMotion, text]);

  return (
    <div
      className={`lobee-answer ${typing ? 'is-typing' : ''}`}
      role="status"
      aria-live={typing ? 'off' : 'polite'}
      aria-atomic="true"
      aria-busy={typing}
    >
      <Markdown text={visible} />
      {!visible && typing && <span className="lobee-cursor" aria-hidden="true" />}
    </div>
  );
}

// A bare, boxless, animated status word (shimmer while running; colored when done/failed).
function Status({ turn, hasThinking }: { turn: Turn; hasThinking: boolean }) {
  const cls =
    turn.status === 'running' && !hasThinking && !turn.await
      ? 'lobee-shine'
      : turn.status === 'done'
        ? 'text-green-600'
        : turn.status === 'error'
          ? 'text-red-600'
          : 'text-ink-soft';
  return (
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`text-[12.5px] font-semibold ${cls}`}
    >
      {turn.statusText}
    </span>
  );
}

function TurnView({
  turn,
  onReply,
}: {
  turn: Turn;
  onReply: (t: Turn, text: string) => Promise<boolean>;
}) {
  const steps = [...turn.steps.entries()].sort((a, b) => a[0] - b[0]);
  const hasThinking = steps.some(([, step]) => step.thinking);
  return (
    <div className="flex flex-col gap-2" aria-busy={turn.status === 'running'}>
      <div className="self-end max-w-[92%] rounded-[14px_14px_4px_14px] border border-violet-100 bg-violet-50 px-3 py-2 font-medium text-ink">
        {turn.task}
      </div>
      <div className="flex flex-col gap-1 px-0.5">
        <Status turn={turn} hasThinking={hasThinking} />
        {steps.length > 0 && (
          <div className="flex flex-col gap-[3px] pl-2.5">
            {steps.map(([n, s]) => (
              <div key={n} className="flex items-baseline gap-1.5 text-[12.5px] text-ink-soft">
                <span className={s.thinking ? 'lobee-shine' : 'text-ink'}>{s.label || '…'}</span>
                {s.ctx && (
                  <span className="min-w-0 truncate text-[11.5px] text-ink-soft">{s.ctx}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {turn.await && <AwaitBox turn={turn} onReply={onReply} />}
      {turn.answer && <ProgressiveMarkdown text={turn.answer} animate={turn.animateAnswer} />}
    </div>
  );
}

function AwaitBox({
  turn,
  onReply,
}: {
  turn: Turn;
  onReply: (t: Turn, text: string) => Promise<boolean>;
}) {
  const [val, setVal] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const a = turn.await!;
  const submit = async (text: string): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    const delivered = await onReply(turn, text);
    if (!delivered) setSubmitting(false);
  };
  if (a.kind === 'confirm') {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2.5">
        <div className="text-[13px] font-medium">{a.prompt}</div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-lg border border-violet-600 bg-violet-600 px-3.5 py-1.5 font-semibold text-white"
            disabled={submitting}
            onClick={() => void submit('approve')}
          >
            Approve
          </button>
          <button
            type="button"
            className="rounded-lg border border-line-strong bg-white px-3.5 py-1.5 font-semibold text-ink"
            disabled={submitting}
            onClick={() => void submit('reject')}
          >
            Reject
          </button>
        </div>
        {turn.inputError && (
          <div role="alert" className="text-[12px] text-red-600">
            {turn.inputError}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2.5">
      <div className="text-[13px] font-medium">{a.prompt}</div>
      <input
        autoFocus
        type={a.sensitive ? 'password' : 'text'}
        value={val}
        placeholder={a.sensitive ? 'Sensitive — sent straight to the field' : 'Your answer…'}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && val && !submitting) void submit(a.sensitive ? val : val.trim());
        }}
        className="w-full rounded-lg border border-line-strong bg-white px-2.5 py-2 outline-none focus:border-violet-600"
      />
      {turn.inputError && (
        <div role="alert" className="text-[12px] text-red-600">
          {turn.inputError}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// A raw dropdown trigger (no box — text + chevron), sharing one-open-at-a-time via the parent.
function Trigger({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-expanded={open}
      className={`inline-flex h-6 max-w-full items-center gap-1 rounded-md px-1.5 text-[11.5px] font-semibold text-ink-soft transition-colors hover:bg-violet-50 hover:text-ink ${open ? 'bg-violet-50 text-ink' : ''}`}
    >
      {children}
      <ChevronDownIcon className="h-3 w-3 shrink-0 opacity-70" />
    </button>
  );
}

const menuCls =
  'absolute bottom-[calc(100%+8px)] z-20 max-h-[340px] overflow-y-auto rounded-xl border border-line-strong bg-white p-1.5 shadow-[0_12px_34px_-12px_rgba(28,20,60,0.32)]';

// ---------------------------------------------------------------------------------------------------
export function App() {
  const [mode, setMode] = useState<Mode>('agent');
  const [model, setModel] = useState('anthropic/claude-opus-4.8');
  const [effort, setEffort] = useState<Effort>('medium');
  const [models, setModels] = useState<ModelInfo[]>(FALLBACK_MODELS);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [transcriptReady, setTranscriptReady] = useState(false);
  const [menu, setMenu] = useState<'mode' | 'model' | 'effort' | null>(null);
  const [query, setQuery] = useState('');

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const nextId = useRef(1);

  const current = useMemo(() => models.find((m) => m.id === model), [models, model]);
  const currentSelectable = Boolean(current?.available && (mode === 'ask' || current.agentCapable));
  const efforts = current?.efforts ?? ALL_EFFORTS;

  // Load persisted settings + sync the live roster on mount.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const p = await store.get();
      if (!alive) return;
      setMode(p.mode === 'ask' ? 'ask' : 'agent');
      setModel(p.model);
      setEffort(ALL_EFFORTS.includes(p.effort) ? p.effort : 'medium');
      const res = await fetchModels();
      if (!alive || !res?.models?.length) return;
      const roster = mapRoster(res.models as Array<Record<string, unknown>>);
      setModels(roster);
      setModel((cur) => {
        const m = roster.find((x) => x.id === cur);
        if (m && m.available) return cur;
        const first = roster.find((x) => x.available) ?? roster[0];
        if (first) {
          store.set({ model: first.id });
          return first.id;
        }
        return cur;
      });
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Ask can use any live text-chat model; Agent mode requires forced structured tool calls. If a
  // mode switch makes the current model incompatible, choose a genuinely compatible model instead
  // of sending a request that the provider must reject.
  useEffect(() => {
    const selected = models.find((item) => item.id === model);
    if (selected?.available && (mode === 'ask' || selected.agentCapable)) return;
    const replacement = models.find(
      (item) => item.available && (mode === 'ask' || item.agentCapable),
    );
    if (!replacement || replacement.id === model) return;
    setModel(replacement.id);
    store.set({ model: replacement.id });
  }, [mode, model, models]);

  // Keep effort valid for the selected model.
  useEffect(() => {
    if (efforts.length && !efforts.includes(effort)) {
      const e = efforts.includes('medium') ? 'medium' : efforts[0]!;
      setEffort(e);
      store.set({ effort: e });
    }
  }, [efforts, effort]);

  // Follow new content only while the user is already at the bottom. ResizeObserver also follows the
  // progressive answer reveal without forcing a React update for every visual chunk.
  useEffect(() => {
    if (!pinnedRef.current) return;
    const frame = requestAnimationFrame(() => {
      const stream = streamRef.current;
      if (stream) stream.scrollTop = stream.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [turns]);
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const stream = streamRef.current;
      if (stream && pinnedRef.current) stream.scrollTop = stream.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // Close menus on outside click.
  useEffect(() => {
    if (!menu) return;
    const h = () => setMenu(null);
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, [menu]);

  const autogrow = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(38, Math.min(el.scrollHeight, 168))}px`;
    el.style.overflowY = el.scrollHeight > 168 ? 'auto' : 'hidden';
  }, []);
  useEffect(autogrow, [autogrow]);

  const patchTurn = useCallback((id: number, ev: AgentEvent) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? applyEvent(t, ev) : t)));
    if (ev.type === 'run.finished') setBusy(false);
  }, []);

  // Restore capped terminal history, then reconcile the sidecar's retained latest snapshot. Running
  // sessions are reattached to the replayable event stream so closing/reopening the panel is harmless.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [stored, snapshots] = await Promise.all([loadTranscript(), fetchStatus()]);
      if (!alive) return;
      const hydrated = stored.map(storedToTurn);
      const snapshot = snapshots?.[0];
      let live: { id: number; sessionId: string } | null = null;
      if (snapshot) {
        const existing = hydrated.findIndex((turn) => turn.sessionId === snapshot.sessionId);
        const id =
          existing >= 0
            ? hydrated[existing]!.id
            : Math.max(0, ...hydrated.map((turn) => turn.id)) + 1;
        const reconciled = snapshotToTurn(snapshot, id);
        if (existing >= 0) {
          const prior = hydrated[existing]!;
          hydrated[existing] = { ...reconciled, answer: reconciled.answer || prior.answer };
        } else {
          hydrated.push(reconciled);
        }
        if (snapshot.status === 'running' || snapshot.status === 'awaiting_input') {
          live = { id, sessionId: snapshot.sessionId };
        }
      }
      nextId.current = Math.max(0, ...hydrated.map((turn) => turn.id)) + 1;
      setTurns(hydrated);
      setTranscriptReady(true);
      if (live) {
        setBusy(true);
        const currentLive = live;
        void resumeTask(currentLive.sessionId, {
          onEvent: (event) => patchTurn(currentLive.id, event),
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [patchTurn]);

  useEffect(() => {
    if (!transcriptReady) return;
    const timer = setTimeout(() => {
      const terminal = turns.map(toStoredTurn).filter((turn): turn is StoredTurn => turn !== null);
      void saveTranscript(terminal);
    }, 200);
    return () => clearTimeout(timer);
  }, [transcriptReady, turns]);

  const onReply = useCallback(async (turn: Turn, text: string): Promise<boolean> => {
    try {
      await sendInput(text);
      setTurns((prev) =>
        prev.map((item) => {
          if (item.id !== turn.id) return item;
          if (item.status === 'done' || item.status === 'error' || item.status === 'stopped') {
            return { ...item, await: null, inputError: '' };
          }
          return {
            ...item,
            await: null,
            inputError: '',
            statusText: 'Working…',
            status: 'running',
          };
        }),
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTurns((prev) =>
        prev.map((item) => {
          if (item.id !== turn.id) return item;
          if (item.status === 'done' || item.status === 'error' || item.status === 'stopped') {
            return item;
          }
          return { ...item, inputError: message, statusText: 'Needs you', status: 'running' };
        }),
      );
      return false;
    }
  }, []);

  const submit = useCallback(async () => {
    const el = inputRef.current;
    const task = (el?.value ?? '').trim();
    if (!task || busy || !transcriptReady || !currentSelectable) return;
    if (el) {
      el.value = '';
      autogrow();
    }
    const id = nextId.current++;
    const turn: Turn = {
      id,
      task,
      startedAt: new Date().toISOString(),
      status: 'running',
      statusText: 'Working…',
      steps: new Map(),
      answer: '',
      await: null,
      inputError: '',
      animateAnswer: false,
    };
    setTurns((prev) => [...prev, turn]);
    setBusy(true);
    const start = await runTask(
      task,
      { mode, model, effort: efforts.length ? effort : undefined },
      {
        onEvent: (ev) => patchTurn(id, ev),
      },
    );
    if (start === 'unavailable') {
      mockRun(id, task, mode, patchTurn); // standalone (file://) fallback
    } else if (start === 'failed' && el && !el.value.trim()) {
      // Preserve the exact prompt for a one-click retry after a real transport/model startup failure.
      el.value = task;
      autogrow();
      el.focus();
    }
  }, [busy, transcriptReady, currentSelectable, mode, model, effort, efforts, autogrow, patchTurn]);

  return (
    <div className="flex h-screen flex-col bg-white">
      <main
        ref={streamRef}
        className="flex-1 overflow-y-auto px-3.5 pb-2 pt-4"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
        }}
      >
        <div ref={contentRef} role="log" aria-live="off" className="flex flex-col gap-2.5">
          {turns.map((t) => (
            <TurnView key={t.id} turn={t} onReply={onReply} />
          ))}
        </div>
      </main>

      <form
        className="m-3 mt-2 rounded-2xl border border-violet-600 bg-white transition-shadow focus-within:shadow-[0_0_0_3px_var(--color-violet-100)]"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={inputRef}
          aria-label="Message Lobee"
          disabled={!transcriptReady || !currentSelectable}
          rows={1}
          placeholder={
            !transcriptReady
              ? 'Loading conversation…'
              : currentSelectable
                ? 'Message Lobee…'
                : mode === 'agent'
                  ? 'No Agent-compatible model is available'
                  : 'No chat model is available'
          }
          onInput={autogrow}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          className="block max-h-[168px] min-h-[38px] w-full resize-none border-0 bg-transparent px-3 pb-1 pt-2.5 text-ink outline-none placeholder:text-ink-soft"
        />
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          {/* Mode */}
          <div className="relative min-w-0">
            <Trigger
              open={menu === 'mode'}
              onToggle={() => setMenu(menu === 'mode' ? null : 'mode')}
            >
              <span>{mode === 'ask' ? 'Ask' : 'Agent'}</span>
            </Trigger>
            {menu === 'mode' && (
              <div className={`${menuCls} left-0 w-[200px]`} onClick={(e) => e.stopPropagation()}>
                {(
                  [
                    ['agent', 'Agent', 'Web tasks + browser control'],
                    ['ask', 'Ask', 'Chat only, no browser'],
                  ] as const
                ).map(([val, name, hint]) => (
                  <button
                    key={val}
                    type="button"
                    className="flex w-full flex-col gap-px rounded-lg px-2.5 py-2 text-left hover:bg-violet-50"
                    onClick={() => {
                      setMode(val);
                      store.set({ mode: val });
                      setMenu(null);
                    }}
                  >
                    <span
                      className={`text-[13px] font-semibold ${mode === val ? 'text-violet-700' : 'text-ink'}`}
                    >
                      {name}
                    </span>
                    <span className="text-[11px] text-ink-soft">{hint}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Model */}
          <div className="relative min-w-0">
            <Trigger
              open={menu === 'model'}
              onToggle={() => setMenu(menu === 'model' ? null : 'model')}
            >
              <span className="inline-flex shrink-0">
                {brandIcon(current?.brand ?? '', 'h-3.5 w-3.5')}
              </span>
              <span className="min-w-0 max-w-[150px] truncate">{current?.label ?? 'Model'}</span>
            </Trigger>
            {menu === 'model' && (
              <ModelMenu
                models={models}
                mode={mode}
                selected={model}
                query={query}
                setQuery={setQuery}
                onPick={(id) => {
                  setModel(id);
                  store.set({ model: id });
                  setMenu(null);
                  setQuery('');
                }}
              />
            )}
          </div>

          {/* Effort (hidden for non-reasoning models) */}
          {efforts.length > 0 && (
            <div className="relative ml-auto min-w-0">
              <Trigger
                open={menu === 'effort'}
                onToggle={() => setMenu(menu === 'effort' ? null : 'effort')}
              >
                <span>{EFFORT_LABEL[effort]}</span>
              </Trigger>
              {menu === 'effort' && (
                <div
                  className={`${menuCls} right-0 min-w-[130px]`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {ALL_EFFORTS.filter((e) => efforts.includes(e)).map((e) => (
                    <button
                      key={e}
                      type="button"
                      className="flex w-full rounded-lg px-2.5 py-2 text-left hover:bg-violet-50"
                      onClick={() => {
                        setEffort(e);
                        store.set({ effort: e });
                        setMenu(null);
                      }}
                    >
                      <span
                        className={`text-[13px] font-semibold ${effort === e ? 'text-violet-700' : 'text-ink'}`}
                      >
                        {EFFORT_LABEL[e]}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </form>
    </div>
  );
}

function ModelMenu({
  models,
  mode,
  selected,
  query,
  setQuery,
  onPick,
}: {
  models: ModelInfo[];
  mode: Mode;
  selected: string;
  query: string;
  setQuery: (q: string) => void;
  onPick: (id: string) => void;
}) {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? models.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
    : models;
  const brands: string[] = [];
  for (const m of filtered) if (!brands.includes(m.brand)) brands.push(m.brand);
  return (
    <div className={`${menuCls} left-0 w-[260px]`} onClick={(e) => e.stopPropagation()}>
      <div className="sticky top-0 -m-1.5 mb-1 flex items-center gap-1.5 border-b border-line bg-white px-2 py-1.5">
        <MagnifyingGlassIcon className="h-3.5 w-3.5 text-ink-soft" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models…"
          className="w-full bg-transparent text-[13px] outline-none placeholder:text-ink-soft"
        />
      </div>
      {filtered.length === 0 && (
        <div className="px-2 py-3 text-[12px] text-ink-soft">No models match.</div>
      )}
      {brands.map((brand) => (
        <div key={brand}>
          <div className="px-2 pb-1 pt-2 text-[10.5px] font-bold uppercase tracking-wider text-ink-soft">
            {brandTitle(brand)}
          </div>
          {filtered
            .filter((m) => m.brand === brand)
            .map((m) => {
              const sel = m.id === selected;
              const usable = m.available && (mode === 'ask' || m.agentCapable);
              return (
                <button
                  key={m.id}
                  type="button"
                  disabled={!usable}
                  title={
                    !m.available
                      ? 'Currently unavailable'
                      : !m.agentCapable && mode === 'agent'
                        ? 'Ask mode only — this model cannot call browser tools'
                        : undefined
                  }
                  onClick={() => usable && onPick(m.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13px] ${usable ? 'hover:bg-violet-50' : 'cursor-default opacity-40'}`}
                >
                  <span className="inline-flex shrink-0">{brandIcon(m.brand, 'h-4 w-4')}</span>
                  <span className={`min-w-0 flex-1 truncate ${sel ? 'font-semibold' : ''}`}>
                    {m.label}
                  </span>
                  {m.available && !m.agentCapable && mode === 'agent' && (
                    <span className="shrink-0 text-[10px] font-semibold text-ink-soft">
                      Ask only
                    </span>
                  )}
                  <span
                    className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${sel ? 'border-violet-600 bg-violet-600 text-white' : 'border-line-strong'}`}
                  >
                    {sel && <CheckIcon className="h-2.5 w-2.5" />}
                  </span>
                </button>
              );
            })}
        </div>
      ))}
    </div>
  );
}

// Standalone (file://) fallback: exercises the reducer + renderer with a scripted event sequence.
function mockRun(
  id: number,
  task: string,
  mode: Mode,
  patch: (id: number, ev: AgentEvent) => void,
) {
  const md =
    `Here's a quick summary of **${task.slice(0, 60)}**:\n\n` +
    `## What I found\n- First key point\n- A second detail, with \`inline code\`\n- A [reference link](https://example.com)\n\n` +
    `> Wire up the sidecar bridge and this becomes a real answer from your selected model.`;
  const seq: AgentEvent[] =
    mode === 'ask'
      ? [
          { type: 'run.started' },
          { type: 'step.thinking', step: 1 },
          { type: 'run.finished', status: 'done', result: md },
        ]
      : [
          { type: 'run.started' },
          { type: 'run.needsBrowser' },
          { type: 'step.thinking', step: 1 },
          { type: 'step.observation', step: 1, url: 'https://example.com', title: 'Example' },
          {
            type: 'step.action',
            step: 1,
            action: { kind: 'navigate', url: 'https://example.com' },
          },
          { type: 'step.thinking', step: 2 },
          {
            type: 'step.action',
            step: 2,
            action: { kind: 'click', id: 3, note: 'Opened the first result' },
          },
          { type: 'run.finished', status: 'done', result: md },
        ];
  let i = 0;
  const tick = () => {
    if (i >= seq.length) return;
    patch(id, seq[i++]!);
    setTimeout(tick, 420);
  };
  tick();
}
