import { useMemo, useState } from 'react';
import { PaperAirplaneIcon, PlusIcon } from '@heroicons/react/24/solid';

import type { SmsMessage } from '@lobster/shared-types';

import { Button, EmptyState } from '../../ui';
import { formatNumber } from './phoneOptions';
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';

interface Thread {
  peer: string;
  messages: SmsMessage[];
  /** Undefined for a freshly-started conversation with no messages yet. */
  last?: SmsMessage;
}

/** The other party on a message relative to our owned line. */
function peerOf(m: SmsMessage): string {
  return m.direction === 'inbound' ? m.from : m.to;
}

/**
 * SMS threads for the active line: a conversation list on the left, the selected thread + composer on
 * the right. Threads are grouped by the other party and sorted by most-recent activity.
 */
export function Messages({
  line,
  messages,
  onSend,
}: {
  line: string | null;
  messages: SmsMessage[];
  onSend: (to: string, body: string) => Promise<void>;
}): JSX.Element {
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [composingNew, setComposingNew] = useState(false);
  const [newPeer, setNewPeer] = useState('');

  const threads = useMemo<Thread[]>(() => {
    const byPeer = new Map<string, SmsMessage[]>();
    for (const m of messages) {
      const peer = peerOf(m);
      const list = byPeer.get(peer) ?? [];
      list.push(m);
      byPeer.set(peer, list);
    }
    return [...byPeer.entries()]
      .map(([peer, list]) => {
        const sorted = [...list].sort(
          (a, b) => Date.parse(a.dateCreated) - Date.parse(b.dateCreated),
        );
        return { peer, messages: sorted, last: sorted[sorted.length - 1]! };
      })
      .sort((a, b) => Date.parse(b.last.dateCreated) - Date.parse(a.last.dateCreated));
  }, [messages]);

  const activePeer = selectedPeer ?? threads[0]?.peer ?? null;
  const activeThread = threads.find((t) => t.peer === activePeer) ?? null;

  // Show a synthetic thread for a just-started conversation that has no messages yet.
  const displayThreads = useMemo<Thread[]>(() => {
    if (activePeer && !threads.some((t) => t.peer === activePeer)) {
      return [{ peer: activePeer, messages: [] }, ...threads];
    }
    return threads;
  }, [threads, activePeer]);

  async function send(): Promise<void> {
    const to = activePeer;
    const body = draft.trim();
    if (!line || !to || !body || sending) return;
    setSending(true);
    try {
      await onSend(to, body);
      setDraft('');
    } finally {
      setSending(false);
    }
  }

  function startNew(): void {
    const peer = newPeer.trim();
    if (!/^\+?[0-9]{6,15}$/.test(peer.replace(/[^\d+]/g, ''))) return;
    const e164 = peer.startsWith('+') ? peer : `+${peer.replace(/[^\d]/g, '')}`;
    setSelectedPeer(e164);
    setComposingNew(false);
    setNewPeer('');
  }

  if (!line) {
    return (
      <EmptyState
        icon={<ChatBubbleLeftRightIcon width={28} />}
        title="No line selected"
        description="Select or buy a number to send and receive texts."
      />
    );
  }

  return (
    <div className="messages">
      <aside className="messages__threads">
        <div className="messages__threads-head">
          <span>Conversations</span>
          <button
            type="button"
            className="icon-button"
            aria-label="New message"
            onClick={() => setComposingNew((v) => !v)}
          >
            <PlusIcon width={16} />
          </button>
        </div>
        {composingNew ? (
          <div className="messages__new">
            <input
              className="input"
              placeholder="+1 555 010 0000"
              value={newPeer}
              inputMode="tel"
              onChange={(e) => setNewPeer(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && startNew()}
              autoFocus
            />
            <Button variant="secondary" onClick={startNew}>
              Start
            </Button>
          </div>
        ) : null}
        {displayThreads.length === 0 && !composingNew ? (
          <p className="field-hint messages__empty">No conversations yet.</p>
        ) : (
          <ul className="messages__thread-list">
            {displayThreads.map((t) => (
              <li key={t.peer}>
                <button
                  type="button"
                  className={`messages__thread ${t.peer === activePeer ? 'messages__thread--active' : ''}`}
                  onClick={() => setSelectedPeer(t.peer)}
                >
                  <span className="messages__thread-peer">{formatNumber(t.peer)}</span>
                  {t.last ? (
                    <span className="messages__thread-preview">{t.last.body}</span>
                  ) : (
                    <span className="messages__thread-preview field-hint">New conversation</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="messages__conversation">
        {activePeer ? (
          <>
            <header className="messages__conversation-head">{formatNumber(activePeer)}</header>
            <div className="messages__bubbles">
              {(activeThread?.messages ?? []).map((m) => (
                <div
                  key={m.sid}
                  className={`bubble bubble--${m.direction === 'inbound' ? 'in' : 'out'}`}
                >
                  <div className="bubble__body">{m.body}</div>
                  <div className="bubble__meta">
                    {new Date(m.dateCreated).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {m.direction === 'outbound' ? ` · ${m.status}` : ''}
                  </div>
                </div>
              ))}
            </div>
            <div className="messages__composer">
              <textarea
                className="input messages__composer-input"
                placeholder={`Text ${formatNumber(activePeer)}`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={2}
              />
              <Button
                variant="primary"
                leadingIcon={<PaperAirplaneIcon width={16} />}
                onClick={() => void send()}
                disabled={!draft.trim() || sending}
              >
                {sending ? 'Sending…' : 'Send'}
              </Button>
            </div>
          </>
        ) : (
          <EmptyState
            icon={<ChatBubbleLeftRightIcon width={28} />}
            title="No conversation selected"
            description="Pick a conversation or start a new one."
          />
        )}
      </section>
    </div>
  );
}
