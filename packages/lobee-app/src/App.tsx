import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { ChevronDownIcon, MagnifyingGlassIcon, CheckIcon } from '@heroicons/react/24/outline';
import { brandIcon } from './icons';
import { canSwitchThread, findSnapshotForThread, resumeFailureEvent } from './history';
import { renderMarkdown, stableBlockBoundary } from './md';
import {
  fetchEntitlement,
  fetchModels,
  fetchStatus,
  fetchThread,
  getBridge,
  resumeTask,
  runTask,
  sendInput,
  stopRun,
} from './bridge';
import {
  ALL_EFFORTS,
  EFFORT_LABEL,
  FALLBACK_MODELS,
  brandTitle,
  mapRoster,
  newThreadId,
  parseAllowedDomains,
  store,
} from './models';
import { loadTranscript, saveTranscript, type StoredTurn } from './transcript';
import {
  applyEvent,
  mergeStoredMetadata,
  recentThreads,
  snapshotToTurn,
  storedToTurn,
  toStoredTurn,
  turnsFromThread,
  type ThreadSummary,
  type Turn,
} from './turns';
import { chatTimestamp } from './util';
import type { AgentEntitlement, AgentEvent, Effort, Mode, ModelInfo } from './types';

// ---------------------------------------------------------------------------------------------------
/**
 * Rendered Markdown, rebuilt only where the source can still change.
 *
 * A streamed answer grows by a token at a time. Re-parsing the whole reply and replacing every node on
 * each one is quadratic on long answers, and — far more visible — it wipes the user's text selection
 * and re-creates every code block's Copy button, so "Copied" vanishes the instant it appears. Blocks
 * before the last blank line can no longer be reparsed by appended text, so their DOM is kept and only
 * the trailing block is rebuilt.
 */
function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const settled = useRef({ prefix: '', nodes: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const boundary = stableBlockBoundary(text);
    const prefix = text.slice(0, boundary);
    if (settled.current.prefix !== prefix) {
      el.textContent = '';
      el.appendChild(renderMarkdown(prefix));
      settled.current = { prefix, nodes: el.childNodes.length };
    } else {
      while (el.childNodes.length > settled.current.nodes) el.removeChild(el.lastChild!);
    }
    el.appendChild(renderMarkdown(text.slice(boundary)));
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

function ProgressiveMarkdown({
  text,
  animate,
  streaming,
}: {
  text: string;
  animate: boolean;
  streaming: boolean;
}) {
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

  // The region is atomic, so ANY mutation re-announces the whole answer from the top. While the reply
  // is still arriving that is once per token — hundreds of interrupted re-readings that also starve
  // the "Needs you" status and the error alerts out of the live-region queue. Announce once, when the
  // text has stopped moving.
  const live = typing || streaming;
  return (
    <div
      className={`lobee-answer ${typing ? 'is-typing' : ''}`}
      role="status"
      aria-live={live ? 'off' : 'polite'}
      aria-atomic="true"
      aria-busy={live}
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
  canRetry,
  onReply,
  onRegenerate,
  onStop,
}: {
  turn: Turn;
  canRetry: boolean;
  onReply: (t: Turn, text: string) => Promise<boolean>;
  onRegenerate: (t: Turn) => void;
  onStop: () => void;
}) {
  const steps = [...turn.steps.entries()].sort((a, b) => a[0] - b[0]);
  const hasThinking = steps.some(([, step]) => step.thinking);
  return (
    <div className="flex flex-col gap-2" aria-busy={turn.status === 'running'}>
      <div className="self-end max-w-[92%] break-words rounded-[var(--radius-lg)_var(--radius-lg)_var(--radius-sm)_var(--radius-lg)] border border-violet-100 bg-violet-50 px-3 py-2 font-medium text-ink">
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
      {turn.answer && (
        <ProgressiveMarkdown
          text={turn.answer}
          animate={turn.animateAnswer}
          streaming={turn.status === 'running'}
        />
      )}
      {turn.failure && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-900"
        >
          <span aria-hidden="true" className="mt-px shrink-0 font-semibold">
            !
          </span>
          <span className="min-w-0 break-words">{turn.failure}</span>
        </div>
      )}
      {turn.stopError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-900"
        >
          <span aria-hidden="true" className="mt-px shrink-0 font-semibold">
            !
          </span>
          <span className="min-w-0 break-words">{turn.stopError}</span>
          <button
            type="button"
            onClick={onStop}
            className="ml-auto shrink-0 font-semibold text-rose-900 underline"
          >
            Stop again
          </button>
        </div>
      )}
      {turn.memoryWarning && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
          <span aria-hidden="true" className="mt-px shrink-0 font-semibold">
            !
          </span>
          <span className="min-w-0 break-words">{turn.memoryWarning}</span>
        </div>
      )}
      {turn.status !== 'running' && turn.status !== '' && !turn.animateAnswer && (
        <div className="flex items-center gap-1 text-[11.5px] text-ink-soft">
          {turn.answer && (
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(turn.answer)}
              className="rounded-lg px-2 py-1 transition-colors hover:bg-violet-50 hover:text-violet-700"
            >
              Copy
            </button>
          )}
          <button
            type="button"
            onClick={() => onRegenerate(turn)}
            disabled={!canRetry}
            title={canRetry ? 'Run this message again' : 'Available once the current run finishes'}
            className="rounded-lg px-2 py-1 transition-colors hover:bg-violet-50 hover:text-violet-700 disabled:pointer-events-none disabled:opacity-40"
          >
            Retry
          </button>
          {(turn.tokensIn > 0 || turn.tokensOut > 0) && (
            <span className="ml-auto tabular-nums" title="Tokens in / out for this message">
              {turn.tokensIn.toLocaleString()} in · {turn.tokensOut.toLocaleString()} out
            </span>
          )}
        </div>
      )}
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
// It hands its own element back on toggle so the panel can return focus here when the popover closes;
// without that, dismissing a menu leaves focus on <body> and a keyboard user restarts from the top.
function Trigger({
  open,
  controls,
  haspopup = 'menu',
  disabled = false,
  onToggle,
  children,
}: {
  open: boolean;
  controls: string;
  haspopup?: 'menu' | 'dialog';
  disabled?: boolean;
  onToggle: (trigger: HTMLButtonElement) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e.currentTarget);
      }}
      aria-haspopup={haspopup}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      className={`inline-flex h-6 max-w-full items-center gap-1 rounded-md px-1.5 text-[11.5px] font-semibold text-ink-soft transition-colors hover:bg-violet-50 hover:text-ink disabled:pointer-events-none disabled:opacity-40 ${open ? 'bg-violet-50 text-ink' : ''}`}
    >
      {children}
      <ChevronDownIcon className="h-3 w-3 shrink-0 opacity-70" />
    </button>
  );
}

const menuCls =
  'absolute z-20 max-h-[340px] overflow-y-auto rounded-xl border border-line-strong bg-white p-1.5 shadow-[0_12px_34px_-12px_rgba(28,23,34,0.24)]';
/** Composer menus open upwards; the composer is the last thing above the window edge. */
const upward = 'bottom-[calc(100%+8px)]';

/** Roving focus over a menu's options, so a picker can be driven entirely from the keyboard. */
function moveMenuFocus(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not([disabled])'),
  ];
  if (!items.length) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const last = items.length - 1;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? last
        : event.key === 'ArrowDown'
          ? at < 0
            ? 0
            : (at + 1) % items.length
          : at < 0
            ? last
            : (at + last) % items.length;
  items[next]?.focus();
}

/**
 * The floating half of a dropdown.
 *
 * Escape and outside clicks are the panel's job (it also owns focus return). This part carries the
 * menu semantics assistive tech needs, arrow-key navigation, and dismissal when focus genuinely
 * leaves for another control.
 */
function Popover({
  id,
  role,
  label,
  className,
  triggerRef,
  onDismiss,
  children,
}: {
  id: string;
  role: 'menu' | 'dialog';
  label: string;
  className: string;
  triggerRef: { current: HTMLButtonElement | null };
  onDismiss: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Opening a menu moves focus into it, which is the only way a keyboard user can reach the options
  // at all. A popover that autofocuses its own search field has already claimed focus by this point.
  useEffect(() => {
    const el = ref.current;
    if (!el || el.contains(document.activeElement)) return;
    el.querySelector<HTMLElement>('[role="menuitemradio"]:not([disabled]), button, input')?.focus();
  }, []);
  return (
    <div
      ref={ref}
      id={id}
      role={role}
      aria-label={label}
      className={className}
      onClick={(event) => event.stopPropagation()}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        // Only when focus actually landed on another control. A click on the popover's own padding
        // reports no relatedTarget, and dismissing on that would fight the pointer; a click on the
        // trigger is its own toggle and must not be closed twice.
        if (!next || event.currentTarget.contains(next) || triggerRef.current === next) return;
        onDismiss();
      }}
      onKeyDown={role === 'menu' ? moveMenuFocus : undefined}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
export function App() {
  const [mode, setMode] = useState<Mode>('agent');
  const [model, setModel] = useState('anthropic/claude-opus-4.8');
  const [effort, setEffort] = useState<Effort>('medium');
  const [autonomy, setAutonomy] = useState<'auto' | 'confirm'>('confirm');
  const [allowedDomainsText, setAllowedDomainsText] = useState('');
  const [tokenBudget, setTokenBudget] = useState<number | null>(100_000);
  const [models, setModels] = useState<ModelInfo[]>(FALLBACK_MODELS);
  /** True once the sidecar's own roster has replaced the offline fallback list. */
  const [rosterLive, setRosterLive] = useState(false);
  /** null while the first bridge.json read is still in flight. */
  const [bridgeReady, setBridgeReady] = useState<boolean | null>(null);
  /**
   * What this account may do with Lobee. `null` means unknown — the panel opened before the app
   * pushed an answer, or the service is restarting — and must keep the composer usable, because
   * refusing on a question we never got an answer to is the same lie as offering what is refused.
   */
  const [entitlement, setEntitlement] = useState<AgentEntitlement | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [switchingThread, setSwitchingThread] = useState(false);
  const switchingThreadRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  /**
   * How much of the conversation is settled.
   *
   * 'ready' is the only state that may write to local storage — a transient bridge failure must never
   * be allowed to retire a retained plaintext body. 'unavailable' is nonetheless a settled state: the
   * turn ids are final, so the composer stays usable and the run path can report the real reason
   * instead of the panel presenting a permanently dead textarea.
   */
  const [transcriptState, setTranscriptState] = useState<'loading' | 'ready' | 'unavailable'>(
    'loading',
  );
  const transcriptReady = transcriptState === 'ready';
  const [historyError, setHistoryError] = useState('');
  const [historyRetry, setHistoryRetry] = useState(0);
  /** Bumped to re-ask what the account may do — after a reconnect, and after any refused run. */
  const [entitlementRetry, setEntitlementRetry] = useState(0);
  const [menu, setMenu] = useState<'chats' | 'mode' | 'model' | 'effort' | 'policy' | null>(null);
  const [query, setQuery] = useState('');
  /** Conversation the composer writes into; hydrated from storage, replaced by "New chat". */
  const [threadId, setThreadId] = useState('');
  /** Conversations the local index can still reach, rebuilt each time the chat list is opened. */
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadPreviews, setThreadPreviews] = useState<Record<string, string>>({});
  // Both mount effects may read storage concurrently. Reusing one fallback prevents them from minting
  // two conversation ids and making the first submitted turn impossible to hydrate later.
  const initialThreadId = useRef(newThreadId());
  /** Rows owned by other chats, retained so New chat never destroys an unverified legacy migration. */
  const retainedOtherThreads = useRef<StoredTurn[]>([]);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);

  const closeMenu = useCallback((restoreFocus = true) => {
    setMenu(null);
    if (restoreFocus) menuTriggerRef.current?.focus();
  }, []);
  const openMenu = useCallback(
    (name: 'chats' | 'mode' | 'model' | 'effort' | 'policy', trigger: HTMLButtonElement) => {
      menuTriggerRef.current = trigger;
      setMenu((current) => (current === name ? null : name));
    },
    [],
  );

  /** Hand the conversation currently on screen to the local index before leaving it. */
  const retainCurrentRows = useCallback(async () => {
    const currentRows = turns.map(toStoredTurn).filter((turn): turn is StoredTurn => turn !== null);
    retainedOtherThreads.current = [...retainedOtherThreads.current, ...currentRows];
    await saveTranscript(retainedOtherThreads.current);
  }, [turns]);

  /**
   * Begin a fresh conversation. The old thread stays on disk — this mints a new id rather than
   * deleting anything, so "New chat" means "start clean", never "destroy what I had". Per-domain
   * learned facts are profile-scoped and deliberately survive: they are knowledge, not conversation.
   */
  const startNewChat = useCallback(async () => {
    if (busyRef.current || switchingThreadRef.current) return;
    switchingThreadRef.current = true;
    setSwitchingThread(true);
    try {
      const id = newThreadId();
      await retainCurrentRows();
      // The submit path observes switchingThreadRef synchronously. Rechecking the live run bit here
      // also protects against a non-composer source attaching a run while storage was pending.
      if (busyRef.current) return;
      store.set({ threadId: id });
      setThreadId(id);
      setTurns([]);
    } finally {
      switchingThreadRef.current = false;
      setSwitchingThread(false);
    }
  }, [retainCurrentRows]);

  /** Reopen an earlier conversation, re-reading its bodies from encrypted memory. */
  const openThread = useCallback(
    async (id: string) => {
      closeMenu();
      if (!canSwitchThread(busyRef.current, switchingThreadRef.current, id, threadId)) return;
      switchingThreadRef.current = true;
      setSwitchingThread(true);
      try {
        // The reload re-reads the index from storage, so the rows on screen have to be in it first.
        await retainCurrentRows();
        if (busyRef.current) return;
        store.set({ threadId: id });
        setThreadId(id);
        setTurns([]);
        setHistoryRetry((value) => value + 1);
      } finally {
        switchingThreadRef.current = false;
        setSwitchingThread(false);
      }
    },
    [closeMenu, retainCurrentRows, threadId],
  );

  /**
   * Label the conversations in the list with their opening message.
   *
   * Tasks are not kept locally once their encrypted counterpart is verified, so the only honest label
   * comes from the thread store itself. A thread that cannot be read keeps its neutral placeholder
   * rather than the list inventing a title for it.
   */
  const loadThreadPreviews = useCallback(
    async (list: readonly ThreadSummary[], known: Record<string, string>) => {
      for (const summary of list.slice(0, 8)) {
        if (known[summary.id]) continue;
        const loaded = await fetchThread(summary.id);
        if (!loaded.ok) continue;
        const first = loaded.messages.find((message) => message.role === 'user');
        if (!first?.content) continue;
        setThreadPreviews((current) => ({ ...current, [summary.id]: first.content.slice(0, 140) }));
      }
    },
    [],
  );

  const openChats = useCallback(
    async (trigger: HTMLButtonElement) => {
      if (busyRef.current || switchingThreadRef.current) return;
      if (menu === 'chats') {
        closeMenu();
        return;
      }
      const list = recentThreads(await loadTranscript(), threadId);
      // Do not open stale navigation over a run that began while storage was being read.
      if (busyRef.current || switchingThreadRef.current) return;
      setThreads(list);
      openMenu('chats', trigger);
      void loadThreadPreviews(list, threadPreviews);
    },
    [closeMenu, loadThreadPreviews, menu, openMenu, threadId, threadPreviews],
  );

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const nextId = useRef(1);

  const current = useMemo(() => models.find((m) => m.id === model), [models, model]);
  const currentSelectable = Boolean(current?.available && (mode === 'ask' || current.agentCapable));
  // Every fallback model is marked unavailable on purpose, so before the live roster lands nothing is
  // selectable. Disabling the composer on that would make "the sidecar is unreachable" indistinguishable
  // from "this model cannot do Agent mode", and the run path — which reports the real reason — could
  // never be entered at all. Only a roster the sidecar actually answered with may close the composer.
  const composerReady = currentSelectable || !rosterLive;
  const efforts = current?.efforts ?? ALL_EFFORTS;
  const allowedDomains = useMemo(
    () => parseAllowedDomains(allowedDomainsText),
    [allowedDomainsText],
  );

  // Load persisted settings + sync the live roster on mount.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const p = await store.get();
      if (!alive) return;
      setMode(p.mode === 'ask' ? 'ask' : 'agent');
      setModel(p.model);
      setEffort(ALL_EFFORTS.includes(p.effort) ? p.effort : 'medium');
      setAutonomy(p.autonomy);
      setAllowedDomainsText(p.allowedDomains.join(', '));
      setTokenBudget(p.tokenBudget);
      // First ever open (or storage cleared) starts a conversation rather than running thread-less,
      // which would silently disable memory.
      const resolvedThread = p.threadId || initialThreadId.current;
      if (!p.threadId) store.set({ threadId: resolvedThread });
      setThreadId(resolvedThread);
      const bridge = await getBridge();
      if (!alive) return;
      setBridgeReady(bridge !== null);
      const res = await fetchModels();
      if (!alive || !res?.models?.length) return;
      const roster = mapRoster(res.models as Array<Record<string, unknown>>);
      setModels(roster);
      setRosterLive(true);
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

  // What this account may do with Lobee, re-asked whenever the answer could have changed: the bridge
  // came up, the app pushed a new credential, or a run was refused. A `null` answer (service
  // restarting, no bridge) deliberately leaves the previous one standing rather than locking a panel
  // on a question that was never answered.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const answer = await fetchEntitlement();
      if (alive && answer) setEntitlement(answer);
    })();
    return () => {
      alive = false;
    };
  }, [entitlementRetry, bridgeReady]);

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

  // Close menus on outside click, and on Escape from anywhere — including from the trigger itself,
  // which is where focus still is when a menu is opened from the keyboard.
  useEffect(() => {
    if (!menu) return;
    const onClick = (): void => closeMenu(false);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMenu();
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menu, closeMenu]);

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
    if (ev.type !== 'run.finished') return;
    busyRef.current = false;
    setBusy(false);
    // A run can also die because the wallet emptied or the package lapsed WHILE it was running. The
    // sidecar records that refusal, so re-asking here is what turns "something failed" into the one
    // screen that says what to do about it.
    if (ev.status === 'error') setEntitlementRetry((value) => value + 1);
  }, []);

  // Restore capped terminal history, then reconcile the sidecar's retained latest snapshot. Running
  // sessions are reattached to the replayable event stream so closing/reopening the panel is harmless.
  useEffect(() => {
    let alive = true;
    setTranscriptState('loading');
    void (async () => {
      const [stored, snapshots, preferences] = await Promise.all([
        loadTranscript(),
        fetchStatus(),
        store.get(),
      ]);
      if (!alive) return;
      const resolvedThread = preferences.threadId || initialThreadId.current;
      if (!preferences.threadId) store.set({ threadId: resolvedThread });
      setThreadId(resolvedThread);

      // Builds before the encrypted-history handoff omitted `threadId` from every local row even
      // though their runs were already written to the current encrypted thread. Associate those rows
      // with the persisted conversation once, then let the encrypted copy supply their bodies.
      const resolvedRows = stored.map((row) =>
        row.threadId ? row : { ...row, threadId: resolvedThread },
      );
      retainedOtherThreads.current = resolvedRows.filter((row) => row.threadId !== resolvedThread);
      const indexed = resolvedRows
        .map(storedToTurn)
        .filter((turn) => turn.threadId === resolvedThread);
      const loadedThread = await fetchThread(resolvedThread);
      if (!alive) return;
      if (!loadedThread.ok) {
        // Keep legacy bodies exactly as loaded and, crucially, never reach 'ready' so the persistence
        // effect cannot erase/migrate anything based on a transient bridge failure. The ids are final
        // either way, so a new turn appended from here still gets one that cannot collide.
        nextId.current = Math.max(0, ...indexed.map((turn) => turn.id)) + 1;
        setTurns(indexed);
        setHistoryError(loadedThread.error);
        setTranscriptState('unavailable');
        return;
      }
      setHistoryError('');

      let hydrated = mergeStoredMetadata(
        turnsFromThread(loadedThread.messages, resolvedThread),
        indexed,
      ).map((turn, index) => ({ ...turn, id: index + 1 }));

      // A retained snapshot belongs to exactly one conversation. A terminal snapshot from a previous
      // chat must not reappear after New chat, and a running old-thread run must never attach here.
      const snapshot = findSnapshotForThread(snapshots, resolvedThread);
      let live: { id: number; sessionId: string } | null = null;
      if (snapshot) {
        let existing = hydrated.findIndex((turn) => turn.sessionId === snapshot.sessionId);
        // A terminal run is appended to encrypted memory before its finish event. On a fresh panel
        // that turn has no local session metadata yet, so match the newest identical exchange instead
        // of rendering a duplicate snapshot beside it.
        if (existing < 0 && snapshot.status !== 'running' && snapshot.status !== 'awaiting_input') {
          const status =
            snapshot.status === 'done' ? 'done' : snapshot.status === 'error' ? 'error' : 'stopped';
          const response =
            status === 'done'
              ? snapshot.result || ''
              : snapshot.error || snapshot.result || 'The run ended without a result.';
          const candidates = hydrated.flatMap((turn, index) =>
            turn.threadId === resolvedThread &&
            turn.task === snapshot.task &&
            turn.status === status &&
            (status === 'done' ? turn.answer : turn.failure) === response
              ? [index]
              : [],
          );
          if (candidates.length === 1) existing = candidates[0]!;
        }
        const id =
          existing >= 0
            ? hydrated[existing]!.id
            : Math.max(0, ...hydrated.map((turn) => turn.id)) + 1;
        const reconciled = snapshotToTurn(snapshot, id, snapshot.threadId!);
        if (existing >= 0) {
          const prior = hydrated[existing]!;
          hydrated[existing] = {
            ...reconciled,
            threadId: prior.threadId || snapshot.threadId,
            ...(prior.turnKey ? { turnKey: prior.turnKey } : {}),
            answer: reconciled.answer || prior.answer,
            failure: reconciled.failure || prior.failure,
            steps: prior.steps.size ? prior.steps : reconciled.steps,
            tokensIn: prior.tokensIn,
            tokensOut: prior.tokensOut,
            cachedTokensIn: prior.cachedTokensIn,
          };
        } else {
          hydrated.push(reconciled);
        }
        if (snapshot.status === 'running' || snapshot.status === 'awaiting_input') {
          live = { id, sessionId: snapshot.sessionId };
        }
      }
      nextId.current = Math.max(0, ...hydrated.map((turn) => turn.id)) + 1;
      setTurns(hydrated);
      setTranscriptState('ready');
      if (live) {
        busyRef.current = true;
        setBusy(true);
        const currentLive = live;
        void resumeTask(currentLive.sessionId, {
          onEvent: (event) => patchTurn(currentLive.id, event),
        }).then((attached) => {
          if (!alive) return;
          const failure = resumeFailureEvent(attached);
          if (!failure) return;
          setBridgeReady(false);
          patchTurn(currentLive.id, failure);
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [patchTurn, historyRetry]);

  useEffect(() => {
    if (!transcriptReady) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const loaded = await fetchThread(threadId);
        if (cancelled) return;
        if (!loaded.ok) {
          // Do not discard the only copy of a newly-finished turn until its encrypted counterpart is
          // verified. The existing migration format keeps a bounded, redacted fallback body; a later
          // successful fetch clears it through exact/stable-id matching.
          const fallback = turns
            .map(toStoredTurn)
            .filter((turn): turn is StoredTurn => turn !== null);
          await saveTranscript([...retainedOtherThreads.current, ...fallback]);
          if (cancelled) return;
          setHistoryError(loaded.error);
          // A history read can fail while the current run is still producing events. Keep the
          // persistence effect armed until that run reaches a terminal state; otherwise its final
          // fallback is never written. Once terminal, stop writing until Retry has re-established the
          // encrypted source of truth.
          if (!turns.some((turn) => turn.status === 'running')) setTranscriptState('unavailable');
          return;
        }
        const local = turns.filter(
          (turn) =>
            turn.localRecord &&
            (turn.status === 'done' || turn.status === 'error' || turn.status === 'stopped'),
        );
        const secured = mergeStoredMetadata(turnsFromThread(loaded.messages, threadId), local);
        const terminal = secured
          .map(toStoredTurn)
          .filter((turn): turn is StoredTurn => turn !== null);
        await saveTranscript([...retainedOtherThreads.current, ...terminal]);
        if (cancelled) return;

        setHistoryError('');
        // Persisting the body-less metadata is only half of the migration. Reflect the exact matches
        // in memory as well, or New chat can serialize the stale `needsSecureMigration` turn and
        // reintroduce plaintext that was already verified in encrypted storage.
        const verified = new Map<number, Turn>();
        for (const candidate of secured) {
          if (
            candidate.localRecord &&
            !candidate.needsSecureMigration &&
            local.some((turn) => turn.id === candidate.id && turn.needsSecureMigration)
          ) {
            verified.set(candidate.id, candidate);
          }
        }
        if (verified.size) {
          setTurns((current) => {
            let changed = false;
            const next = current.map((turn) => {
              const exact = verified.get(turn.id);
              if (
                !exact ||
                !turn.needsSecureMigration ||
                turn.threadId !== threadId ||
                (turn.status !== 'done' && turn.status !== 'error' && turn.status !== 'stopped')
              ) {
                return turn;
              }
              changed = true;
              return {
                ...turn,
                needsSecureMigration: false,
                ...(exact.turnKey ? { turnKey: exact.turnKey } : {}),
              };
            });
            return changed ? next : current;
          });
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [transcriptReady, threadId, turns]);

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

  /** Put a suggested or previous message in the composer without sending it. */
  const fillComposer = useCallback(
    (text: string) => {
      const el = inputRef.current;
      if (!el) return;
      el.value = text;
      autogrow();
      el.focus();
    },
    [autogrow],
  );

  /** This account is known not to be allowed to run Lobee at all — see {@link AgentLocked}. */
  const locked = entitlement !== null && !entitlement.entitled;

  /** Whether a new message can be sent right now — the one condition Retry and the composer share. */
  const canSubmit =
    transcriptState !== 'loading' && composerReady && !busy && !switchingThread && !locked;

  const submit = useCallback(async () => {
    const el = inputRef.current;
    const task = (el?.value ?? '').trim();
    if (!task || !canSubmit || busyRef.current || switchingThreadRef.current) return;
    if (!allowedDomains.ok) {
      setMenu('policy');
      return;
    }
    if (el) {
      el.value = '';
      autogrow();
    }
    const id = nextId.current++;
    const turn: Turn = {
      id,
      threadId,
      localRecord: true,
      // Cleared only after mergeStoredMetadata verifies the encrypted thread copy.
      needsSecureMigration: true,
      task,
      startedAt: new Date().toISOString(),
      status: 'running',
      statusText: 'Working…',
      steps: new Map(),
      answer: '',
      failure: '',
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
    setTurns((prev) => [...prev, turn]);
    busyRef.current = true;
    setBusy(true);
    const start = await runTask(
      task,
      {
        mode,
        model,
        effort: efforts.length ? effort : undefined,
        threadId,
        autonomy,
        allowedDomains: allowedDomains.domains,
        tokenBudget,
      },
      {
        onEvent: (ev) => patchTurn(id, ev),
        onRefusal: setEntitlement,
      },
    );
    if (start === 'unavailable') {
      reportNoBridge(id, patchTurn); // no sidecar bridge — say so rather than invent a reply
    } else if (start === 'failed' && el && !el.value.trim()) {
      // Preserve the exact prompt for a one-click retry after a real transport/model startup failure.
      fillComposer(task);
    }
  }, [
    canSubmit,
    mode,
    model,
    effort,
    efforts,
    threadId,
    autonomy,
    allowedDomains,
    tokenBudget,
    autogrow,
    fillComposer,
    patchTurn,
  ]);

  /**
   * Run a past message again. It re-submits through the ordinary path rather than replaying anything,
   * so the retry is a real new turn: it lands in the thread, gets its own steps, and can be stopped.
   */
  const regenerate = useCallback(
    (turn: Turn) => {
      if (!canSubmit || busyRef.current || switchingThreadRef.current) return;
      fillComposer(turn.task);
      void submit();
    },
    [canSubmit, fillComposer, submit],
  );

  /**
   * Cancel the run in progress.
   *
   * A stop that never reached the sidecar leaves the run browsing and burning tokens, so the request
   * is awaited and its failure is shown on the turn itself. Until it is answered the status says so,
   * which is also what keeps a user from clicking Stop five more times.
   */
  const requestStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    setTurns((prev) =>
      prev.map((turn) =>
        turn.status === 'running' ? { ...turn, statusText: 'Stopping…', stopError: '' } : turn,
      ),
    );
    // An accepted stop stays pending until the run's own terminal event arrives; clicking again
    // cannot make it land sooner. A rejected one hands the control straight back.
    if (await stopRun()) return;
    setStopping(false);
    setTurns((prev) =>
      prev.map((turn) =>
        turn.status === 'running'
          ? {
              ...turn,
              statusText: 'Working…',
              stopError: 'The agent service did not accept the stop, so this run is still going.',
            }
          : turn,
      ),
    );
  }, [stopping]);

  // The next run gets a live Stop button, whichever way this one ended.
  useEffect(() => {
    if (!busy) setStopping(false);
  }, [busy]);

  /** Re-read bridge.json, for a panel that opened before its profile's agent service was ready. */
  const reconnect = useCallback(async () => {
    setBridgeReady(null);
    const bridge = await getBridge(true);
    setBridgeReady(bridge !== null);
    setHistoryRetry((value) => value + 1);
    setEntitlementRetry((value) => value + 1);
  }, []);

  const visibleTurns = turns.filter((turn) => turn.task || turn.status === 'running');
  const modelLabel = current?.label ?? model;

  return (
    <div className="flex h-screen flex-col bg-white">
      <header className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <img src="./icons/lobee-48.png" alt="" className="h-4 w-4 shrink-0 rounded-sm" />
          <span className="text-[0.8125rem] font-medium text-ink">Lobee</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {/* Conversations. "New chat" only mints a new id, which is only true from the user's side
              while something can still open the previous one. */}
          <div className="relative">
            <Trigger
              open={menu === 'chats'}
              controls="lobee-chats-menu"
              disabled={busy || switchingThread}
              onToggle={(trigger) => void openChats(trigger)}
            >
              <span>Chats</span>
            </Trigger>
            {menu === 'chats' && (
              <Popover
                id="lobee-chats-menu"
                role="menu"
                label="Conversations"
                className={`${menuCls} right-0 top-[calc(100%+8px)] w-[248px]`}
                triggerRef={menuTriggerRef}
                onDismiss={() => closeMenu(false)}
              >
                {threads.length === 0 && (
                  <div className="px-2 py-3 text-[12px] text-ink-soft">No conversations yet.</div>
                )}
                {threads.map((thread) => {
                  const isCurrent = thread.id === threadId;
                  return (
                    <button
                      key={thread.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isCurrent}
                      onClick={() => void openThread(thread.id)}
                      className="flex w-full flex-col gap-px rounded-lg px-2.5 py-2 text-left hover:bg-violet-50"
                    >
                      <span
                        className={`w-full truncate text-[12.5px] ${isCurrent ? 'font-semibold text-violet-700' : 'text-ink'}`}
                      >
                        {threadPreviews[thread.id] ||
                          (isCurrent ? 'This conversation' : 'Untitled')}
                      </span>
                      <span className="text-[11px] text-ink-soft">
                        {[
                          isCurrent ? 'Current' : chatTimestamp(thread.at),
                          thread.turns === 1 ? '1 message' : `${thread.turns} messages`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </button>
                  );
                })}
              </Popover>
            )}
          </div>
          {busy ? (
            // The sidecar has always exposed POST /stop and the bridge has always had stopRun(); the
            // panel simply never called it, so a long agent run could not be cancelled from the UI.
            <button
              type="button"
              onClick={() => void requestStop()}
              disabled={stopping}
              title={stopping ? 'Waiting for the agent service' : 'Stop the current run'}
              className="rounded-lg border border-rose-200 px-2 py-1 text-[0.75rem] text-rose-700 transition-colors hover:bg-rose-50 disabled:pointer-events-none disabled:opacity-50"
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void startNewChat()}
              disabled={turns.length === 0 || !transcriptReady || switchingThread}
              title="Start a new conversation"
              className="rounded-lg px-2 py-1 text-[0.75rem] text-ink-soft transition-colors hover:bg-violet-50 hover:text-violet-700 disabled:pointer-events-none disabled:opacity-40"
            >
              New chat
            </button>
          )}
        </div>
      </header>
      <main
        ref={streamRef}
        className="flex-1 overflow-y-auto px-3.5 pb-2 pt-4"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
        }}
      >
        <div ref={contentRef} role="log" aria-live="off" className="flex flex-col gap-2.5">
          {bridgeReady === false ? (
            <Notice
              headline="Not connected to this profile"
              detail={NO_BRIDGE_REASON}
              action="Try again"
              onAction={() => void reconnect()}
            />
          ) : (
            historyError && (
              <Notice
                headline="Earlier messages could not be loaded"
                // The captured reason is the only thing that separates "the service isn't running"
                // from "the token rotated" from "a 500", for the user and for support alike.
                detail={`${asSentence(historyError)} Nothing was deleted — reconnecting brings them back.`}
                action="Retry"
                onAction={() => setHistoryRetry((value) => value + 1)}
              />
            )
          )}
          {visibleTurns.map((turn) => (
            <TurnView
              key={turn.id}
              turn={turn}
              canRetry={canSubmit}
              onReply={onReply}
              onRegenerate={regenerate}
              onStop={() => void requestStop()}
            />
          ))}
          {visibleTurns.length === 0 &&
            transcriptState !== 'loading' &&
            bridgeReady !== false &&
            !locked && <EmptyState mode={mode} modelLabel={modelLabel} onPick={fillComposer} />}
        </div>
      </main>

      {locked && entitlement ? (
        <AgentLocked
          entitlement={entitlement}
          onRecheck={() => setEntitlementRetry((value) => value + 1)}
        />
      ) : (
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
            disabled={transcriptState === 'loading' || !composerReady}
            rows={1}
            placeholder={
              transcriptState === 'loading'
                ? 'Loading conversation…'
                : composerReady
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
                controls="lobee-mode-menu"
                onToggle={(trigger) => openMenu('mode', trigger)}
              >
                <span>{mode === 'ask' ? 'Ask' : 'Agent'}</span>
              </Trigger>
              {menu === 'mode' && (
                <Popover
                  id="lobee-mode-menu"
                  role="menu"
                  label="Mode"
                  className={`${menuCls} ${upward} left-0 w-[200px]`}
                  triggerRef={menuTriggerRef}
                  onDismiss={() => closeMenu(false)}
                >
                  {(
                    [
                      ['agent', 'Agent', 'Web tasks + browser control'],
                      ['ask', 'Ask', 'Chat only, no browser'],
                    ] as const
                  ).map(([val, name, hint]) => (
                    <button
                      key={val}
                      type="button"
                      role="menuitemradio"
                      aria-checked={mode === val}
                      className="flex w-full flex-col gap-px rounded-lg px-2.5 py-2 text-left hover:bg-violet-50"
                      onClick={() => {
                        setMode(val);
                        store.set({ mode: val });
                        closeMenu();
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
                </Popover>
              )}
            </div>

            {/* Model */}
            <div className="relative min-w-0">
              <Trigger
                open={menu === 'model'}
                controls="lobee-model-menu"
                onToggle={(trigger) => openMenu('model', trigger)}
              >
                <span className="inline-flex shrink-0">
                  {brandIcon(current?.brand ?? '', 'h-3.5 w-3.5')}
                </span>
                <span className="min-w-0 max-w-[150px] truncate">{current?.label ?? 'Model'}</span>
              </Trigger>
              {menu === 'model' && (
                <Popover
                  id="lobee-model-menu"
                  role="menu"
                  label="Model"
                  className={`${menuCls} ${upward} left-0 w-[260px]`}
                  triggerRef={menuTriggerRef}
                  onDismiss={() => closeMenu(false)}
                >
                  <ModelMenu
                    models={models}
                    mode={mode}
                    selected={model}
                    query={query}
                    setQuery={setQuery}
                    onPick={(id) => {
                      setModel(id);
                      store.set({ model: id });
                      setQuery('');
                      closeMenu();
                    }}
                  />
                </Popover>
              )}
            </div>

            {/* Run policy */}
            <div className="relative ml-auto min-w-0">
              <Trigger
                open={menu === 'policy'}
                controls="lobee-policy-menu"
                haspopup="dialog"
                onToggle={(trigger) => openMenu('policy', trigger)}
              >
                <span>{autonomy === 'confirm' ? 'Review' : 'Auto'}</span>
              </Trigger>
              {menu === 'policy' && (
                <Popover
                  id="lobee-policy-menu"
                  role="dialog"
                  label="Run policy"
                  className={`${menuCls} ${upward} right-0 w-[280px] p-3`}
                  triggerRef={menuTriggerRef}
                  onDismiss={() => closeMenu(false)}
                >
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-ink-soft">
                    Run policy
                  </div>
                  <div
                    role="radiogroup"
                    aria-label="Run policy"
                    className="grid grid-cols-2 gap-1 rounded-lg bg-violet-50 p-1"
                  >
                    {(
                      [
                        ['confirm', 'Review changes'],
                        ['auto', 'Run automatically'],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={autonomy === value}
                        className={`rounded-md px-2 py-1.5 text-[11.5px] font-semibold ${
                          autonomy === value
                            ? 'bg-white text-violet-700 shadow-sm'
                            : 'text-ink-soft hover:text-ink'
                        }`}
                        onClick={() => {
                          setAutonomy(value);
                          store.set({ autonomy: value });
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[10.5px] leading-4 text-ink-soft">
                    Review pauses before every browser change. Critical actions always ask in either
                    mode.
                  </p>

                  <label className="mt-3 block text-[11.5px] font-semibold text-ink">
                    Allowed domains
                    <input
                      type="text"
                      value={allowedDomainsText}
                      placeholder="Any domain (unrestricted)"
                      onChange={(event) => setAllowedDomainsText(event.target.value)}
                      onBlur={(event) => {
                        const result = parseAllowedDomains(event.target.value);
                        if (!result.ok) return;
                        setAllowedDomainsText(result.domains.join(', '));
                        store.set({ allowedDomains: result.domains });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.preventDefault();
                      }}
                      className="mt-1 w-full rounded-lg border border-line-strong bg-white px-2.5 py-2 text-[12px] font-normal outline-none focus:border-violet-600"
                    />
                  </label>
                  <p className="mt-1 text-[10.5px] leading-4 text-ink-soft">
                    Comma-separated. Empty means unrestricted browsing.
                  </p>
                  {!allowedDomains.ok && (
                    <p role="alert" className="mt-1 text-[10.5px] leading-4 text-red-600">
                      {allowedDomains.error}
                    </p>
                  )}

                  <label className="mt-3 block text-[11.5px] font-semibold text-ink">
                    Token budget
                    <select
                      value={tokenBudget ?? ''}
                      onChange={(event) => {
                        const value = event.target.value ? Number(event.target.value) : null;
                        setTokenBudget(value);
                        store.set({ tokenBudget: value });
                      }}
                      className="mt-1 w-full rounded-lg border border-line-strong bg-white px-2.5 py-2 text-[12px] font-normal outline-none focus:border-violet-600"
                    >
                      <option value="25000">25,000 tokens</option>
                      <option value="50000">50,000 tokens</option>
                      <option value="100000">100,000 tokens</option>
                      <option value="250000">250,000 tokens</option>
                      <option value="">Unlimited</option>
                    </select>
                  </label>
                </Popover>
              )}
            </div>

            {/* Effort (hidden for non-reasoning models) */}
            {efforts.length > 0 && (
              <div className="relative min-w-0">
                <Trigger
                  open={menu === 'effort'}
                  controls="lobee-effort-menu"
                  onToggle={(trigger) => openMenu('effort', trigger)}
                >
                  <span>{EFFORT_LABEL[effort]}</span>
                </Trigger>
                {menu === 'effort' && (
                  <Popover
                    id="lobee-effort-menu"
                    role="menu"
                    label="Reasoning effort"
                    className={`${menuCls} ${upward} right-0 min-w-[130px]`}
                    triggerRef={menuTriggerRef}
                    onDismiss={() => closeMenu(false)}
                  >
                    {ALL_EFFORTS.filter((e) => efforts.includes(e)).map((e) => (
                      <button
                        key={e}
                        type="button"
                        role="menuitemradio"
                        aria-checked={effort === e}
                        className="flex w-full rounded-lg px-2.5 py-2 text-left hover:bg-violet-50"
                        onClick={() => {
                          setEffort(e);
                          store.set({ effort: e });
                          closeMenu();
                        }}
                      >
                        <span
                          className={`text-[13px] font-semibold ${effort === e ? 'text-violet-700' : 'text-ink'}`}
                        >
                          {EFFORT_LABEL[e]}
                        </span>
                      </button>
                    ))}
                  </Popover>
                )}
              </div>
            )}
          </div>
        </form>
      )}
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
    <>
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
                  role="menuitemradio"
                  aria-checked={sel}
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
    </>
  );
}

/** Bridge messages are fragments ('bridge not configured for this profile'); make one read as prose. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const opened = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(opened) ? opened : `${opened}.`;
}

/** A standing condition the user can act on: what happened, why, and the one control that retries. */
function Notice({
  headline,
  detail,
  action,
  onAction,
}: {
  headline: string;
  detail: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-900"
    >
      <span className="font-semibold">{headline}</span>
      <span className="min-w-0 break-words">{detail}</span>
      <button type="button" className="font-semibold text-violet-700 underline" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

/** Display name for a tier id. Unknown ids read as themselves rather than as a wrong package name. */
function tierLabel(tier: string | undefined): string {
  if (!tier) return 'your current package';
  const known: Record<string, string> = {
    free: 'Free',
    light: 'Light',
    plus: 'Plus',
    pro: 'Pro',
    max: 'Max',
  };
  return known[tier] ?? tier;
}

/**
 * What the panel shows when this account cannot run Lobee.
 *
 * IT REPLACES THE COMPOSER RATHER THAN FAILING AFTER ONE. A free or Light account used to get the
 * whole agent UI, type a task, watch it start, and read a provider error — the refusal arrived after
 * the effort, in the one form that cannot be acted on. Here the reason is the first thing on screen,
 * it names the package the account is actually on, and it distinguishes the two states that look
 * identical in a generic error and need opposite responses: a package that does not include the
 * agent (upgrade) and a wallet with nothing in it (top up).
 *
 * NO LINK TO THE WEBSITE, DELIBERATELY. This page lives inside an anti-detect profile: opening the
 * billing page here would put a first-party visit to a Lobster domain on that profile's proxy IP and
 * fingerprint, tying a disguised identity to the account paying for it. Billing belongs in the
 * Lobster app, and it is the app the user is told to go to.
 *
 * ONE OF THESE SCREENS IS NOT ABOUT THE ACCOUNT AT ALL. `provider_unavailable` means the operator's
 * model provider refused the SERVER's credential, or the operator's own balance is empty. It used to
 * arrive here as `insufficient_credit` — the provider's 402 was passed through verbatim and read as
 * the customer's — so the panel showed "Your Credit has run out" and pointed at a top-up for a
 * balance nothing had touched. It gets its own screen, it apologises, and it asks for nothing.
 */
function AgentLocked({
  entitlement,
  onRecheck,
}: {
  entitlement: AgentEntitlement;
  onRecheck: () => void;
}) {
  const minimum = tierLabel(entitlement.minimumTier ?? 'plus');
  const included = (entitlement.requiredTiers ?? ['plus', 'pro', 'max']).map(tierLabel).join(', ');
  const screen =
    entitlement.code === 'provider_unavailable'
      ? {
          headline: 'Lobee is temporarily unavailable',
          detail:
            'This is on our side, not yours — nothing was charged and your Credit is untouched. It usually clears on its own; try again shortly.',
          action: 'Try again',
        }
      : entitlement.code === 'insufficient_credit'
        ? {
            headline: 'Your Credit has run out',
            detail: `Agent time is charged against your Credit balance. Top up in the Lobster app, under Account → Billing, and Lobee picks up where it left off.`,
            action: 'Check again',
          }
        : entitlement.code === 'signed_out'
          ? {
              headline: 'Sign in to use Lobee',
              detail:
                'Lobee runs on your Lobster account. Sign in from the Lobster app, then reopen this panel.',
              action: 'Check again',
            }
          : entitlement.code === 'plan_required'
            ? {
                headline: `Lobee is included with ${minimum}`,
                detail: `Your team is on ${tierLabel(entitlement.tier)}. ${included} include the agent — upgrade in the Lobster app, under Account → Billing, to run tasks in this profile.`,
                action: 'Check again',
              }
            : {
                headline: 'Lobee is not connected yet',
                detail:
                  entitlement.message ||
                  'The Lobster app has not authorised this profile for the agent yet. This usually clears within a moment of signing in.',
                action: 'Try again',
              };

  return (
    <div
      role="status"
      className="m-3 mt-2 flex flex-col items-start gap-2 rounded-2xl border border-violet-200 bg-violet-50 px-3.5 py-3"
    >
      <div className="flex items-center gap-2">
        <img src="./icons/lobee-48.png" alt="" className="h-5 w-5 rounded-md" />
        <span className="text-[13px] font-semibold text-ink">{screen.headline}</span>
      </div>
      <p className="text-[12.5px] leading-5 text-ink-soft">{screen.detail}</p>
      <button
        type="button"
        onClick={onRecheck}
        className="text-[12px] font-semibold text-violet-700 underline"
      >
        {screen.action}
      </button>
    </div>
  );
}

const EXAMPLES: Record<Mode, string[]> = {
  agent: [
    'Open the pricing page on this site and summarise the plans',
    'Find my most recent order and tell me where it shipped',
    'Fill in this form with my details, but stop before submitting',
  ],
  ask: [
    'Explain what a browser fingerprint is, in plain terms',
    'Draft a short, polite follow-up about an unpaid invoice',
    'Compare storing sessions in cookies versus local storage',
  ],
};

/**
 * What the panel shows before anything has been said in it.
 *
 * This is the state most users see most often, and an empty white rectangle cannot be told apart from
 * a broken one. The examples are tappable because the hardest part of a first run is knowing what a
 * request to this thing even looks like.
 */
function EmptyState({
  mode,
  modelLabel,
  onPick,
}: {
  mode: Mode;
  modelLabel: string;
  onPick: (text: string) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-1 py-8 text-center">
      <img src="./icons/lobee-48.png" alt="" className="h-10 w-10 rounded-xl" />
      <div className="flex flex-col gap-1">
        <span className="text-[14px] font-semibold text-ink">
          {mode === 'agent' ? 'Agent' : 'Ask'} · {modelLabel}
        </span>
        <span className="text-[12.5px] leading-5 text-ink-soft">
          {mode === 'agent'
            ? 'Give Lobee a web task and it browses, clicks and types in this profile, showing every step here.'
            : 'Ask anything. Ask mode answers in this panel and never touches the page.'}
        </span>
      </div>
      <div className="flex w-full flex-col gap-1.5 pt-1">
        {EXAMPLES[mode].map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => onPick(example)}
            className="rounded-xl border border-line px-3 py-2 text-left text-[12.5px] text-ink transition-colors hover:border-violet-200 hover:bg-violet-50"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The panel opened without a sidecar bridge (standalone file://, or a profile that was never
 * provisioned for Lobee).
 *
 * A run in this state used to replay a scripted "answer" — invented content, delivered as
 * run.finished with status 'done', claiming in Agent mode to have navigated and clicked. It was
 * indistinguishable from a real reply and was persisted into the transcript like one. A demo fixture
 * is not worth a product that can silently fabricate answers, so one true sentence is what the panel
 * shows standing and what a run reports.
 */
const NO_BRIDGE_REASON =
  'Lobee is not connected to this profile\u2019s agent service. Open the panel from a Lobster profile window and try again.';

function reportNoBridge(id: number, patch: (id: number, ev: AgentEvent) => void): void {
  patch(id, {
    type: 'run.finished',
    status: 'error',
    error: `Nothing was run. ${NO_BRIDGE_REASON}`,
  });
}
