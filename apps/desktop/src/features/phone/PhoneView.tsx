import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Cog6ToothIcon,
  PhoneArrowUpRightIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';

import type { OwnedNumber, SmsMessage } from '@lobster/shared-types';

import { Badge, Button, EmptyState, Spinner, useToast } from '../../ui';
import { BuyNumberModal } from './BuyNumberModal';
import { CallOverlay } from './CallOverlay';
import { Dialer } from './Dialer';
import { Messages } from './Messages';
import { PhoneSettings } from './PhoneSettings';
import { clearPhoneConfig, getPhoneConfig, phoneClient, subscribePhoneEvents } from './phoneApi';
import { formatNumber } from './phoneOptions';
import { useVoiceDevice } from './useVoiceDevice';
import './phone.css';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const STATUS_TONE = {
  ready: 'success',
  initializing: 'warning',
  offline: 'neutral',
  error: 'danger',
} as const;

/**
 * Phone workspace: buy/hold numbers, place & receive real calls (Twilio Voice SDK), and send/receive
 * SMS in real time (SSE). Talks only to the backend Twilio broker; the desktop never holds Twilio
 * credentials. Shows the connect gate until a backend URL + token are configured.
 */
export function PhoneView(): JSX.Element {
  const toast = useToast();
  const voice = useVoiceDevice();

  const [configured, setConfigured] = useState(() => Boolean(getPhoneConfig()));
  const [owned, setOwned] = useState<OwnedNumber[]>([]);
  const [loadingNumbers, setLoadingNumbers] = useState(false);
  const [activeLine, setActiveLine] = useState<string | null>(null);
  const [messagesByLine, setMessagesByLine] = useState<Record<string, SmsMessage[]>>({});
  const [tab, setTab] = useState<'dialer' | 'messages'>('dialer');
  const [showBuy, setShowBuy] = useState(false);

  const loadOwned = useCallback(async () => {
    setLoadingNumbers(true);
    try {
      const list = await phoneClient.listOwned();
      setOwned(list);
      setActiveLine((cur) => cur ?? list[0]?.phoneNumber ?? null);
    } catch (e) {
      toast.error('Could not load numbers', errText(e));
    } finally {
      setLoadingNumbers(false);
    }
  }, [toast]);

  const loadMessages = useCallback(
    async (line: string) => {
      try {
        const msgs = await phoneClient.history(line);
        setMessagesByLine((m) => ({ ...m, [line]: msgs }));
      } catch (e) {
        toast.error('Could not load messages', errText(e));
      }
    },
    [toast],
  );

  useEffect(() => {
    if (configured) void loadOwned();
  }, [configured, loadOwned]);

  useEffect(() => {
    if (configured && activeLine && !messagesByLine[activeLine]) void loadMessages(activeLine);
  }, [configured, activeLine, messagesByLine, loadMessages]);

  // Real-time inbound SMS + delivery status.
  useEffect(() => {
    if (!configured) return;
    let unsubscribe = (): void => {};
    try {
      unsubscribe = subscribePhoneEvents((event) => {
        if (event.type === 'sms.inbound') {
          const m = event.message;
          setMessagesByLine((prev) => {
            const list = prev[m.to] ?? [];
            if (list.some((x) => x.sid === m.sid)) return prev;
            return { ...prev, [m.to]: [...list, m] };
          });
          toast.info(`SMS from ${formatNumber(m.from)}`, m.body);
        } else if (event.type === 'sms.status') {
          setMessagesByLine((prev) => {
            const next: Record<string, SmsMessage[]> = {};
            for (const [line, list] of Object.entries(prev)) {
              next[line] = list.map((x) =>
                x.sid === event.sid ? { ...x, status: event.status } : x,
              );
            }
            return next;
          });
        } else if (event.type === 'number.updated') {
          void loadOwned();
        }
      });
    } catch {
      /* not configured yet */
    }
    return () => unsubscribe();
  }, [configured, toast, loadOwned]);

  const startCall = useCallback(
    async (to: string) => {
      if (!activeLine) {
        toast.error('No line', 'Select or buy a number first.');
        return;
      }
      try {
        await voice.startCall(to, activeLine);
      } catch (e) {
        toast.error('Call failed', errText(e));
      }
    },
    [activeLine, voice, toast],
  );

  const sendSms = useCallback(
    async (to: string, body: string) => {
      if (!activeLine) return;
      try {
        const sent = await phoneClient.sendSms(activeLine, to, body);
        setMessagesByLine((prev) => ({
          ...prev,
          [activeLine]: [...(prev[activeLine] ?? []), sent],
        }));
      } catch (e) {
        toast.error('Send failed', errText(e));
      }
    },
    [activeLine, toast],
  );

  const release = useCallback(
    async (n: OwnedNumber) => {
      if (!window.confirm(`Release ${formatNumber(n.phoneNumber)}? This cannot be undone.`)) return;
      try {
        await phoneClient.releaseNumber(n.sid);
        setOwned((list) => list.filter((x) => x.sid !== n.sid));
        setActiveLine((cur) => (cur === n.phoneNumber ? null : cur));
        toast.success('Number released', formatNumber(n.phoneNumber));
      } catch (e) {
        toast.error('Release failed', errText(e));
      }
    },
    [toast],
  );

  const messages = useMemo(
    () => (activeLine ? (messagesByLine[activeLine] ?? []) : []),
    [activeLine, messagesByLine],
  );

  if (!configured) {
    return (
      <PhoneSettings
        onSaved={() => {
          setConfigured(true);
          void voice.init();
        }}
      />
    );
  }

  const callDisabled = !activeLine || voice.call !== null || voice.status !== 'ready';

  return (
    <div className="phone-view">
      <header className="phone-view__header">
        <div className="phone-view__title">
          <h1>Phone</h1>
          <Badge tone={STATUS_TONE[voice.status]}>
            {voice.status === 'ready' ? 'Ready' : voice.status}
          </Badge>
        </div>
        <div className="phone-view__header-actions">
          <Button variant="primary" leadingIcon={<PlusIcon width={16} />} onClick={() => setShowBuy(true)}>
            Buy number
          </Button>
          <button
            type="button"
            className="icon-button"
            aria-label="Backend settings"
            onClick={() => {
              clearPhoneConfig();
              setConfigured(false);
            }}
          >
            <Cog6ToothIcon width={18} />
          </button>
        </div>
      </header>

      <div className="phone-view__body">
        <aside className="phone-view__rail">
          <div className="phone-view__rail-head">Your numbers</div>
          {loadingNumbers ? (
            <div className="phone-view__rail-loading">
              <Spinner /> Loading…
            </div>
          ) : owned.length === 0 ? (
            <div className="phone-view__rail-empty">
              <p className="field-hint">No numbers yet.</p>
              <Button variant="secondary" onClick={() => setShowBuy(true)}>
                Buy your first number
              </Button>
            </div>
          ) : (
            <ul className="phone-view__numbers">
              {owned.map((n) => (
                <li key={n.sid}>
                  <button
                    type="button"
                    className={`phone-number ${n.phoneNumber === activeLine ? 'phone-number--active' : ''}`}
                    onClick={() => setActiveLine(n.phoneNumber)}
                  >
                    <span className="phone-number__num">{formatNumber(n.phoneNumber)}</span>
                    <span className="phone-number__caps">
                      {[n.capabilities.voice && 'Voice', n.capabilities.sms && 'SMS']
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-button icon-button--danger"
                    aria-label={`Release ${n.phoneNumber}`}
                    onClick={() => void release(n)}
                  >
                    <TrashIcon width={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <main className="phone-view__main">
          {activeLine ? (
            <>
              <div className="phone-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'dialer'}
                  className={`phone-tab ${tab === 'dialer' ? 'phone-tab--active' : ''}`}
                  onClick={() => setTab('dialer')}
                >
                  Dialer
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'messages'}
                  className={`phone-tab ${tab === 'messages' ? 'phone-tab--active' : ''}`}
                  onClick={() => setTab('messages')}
                >
                  Messages
                </button>
                <span className="phone-tabs__line">
                  Line: <strong>{formatNumber(activeLine)}</strong>
                </span>
              </div>
              {tab === 'dialer' ? (
                <Dialer disabled={callDisabled} onCall={(to) => void startCall(to)} />
              ) : (
                <Messages line={activeLine} messages={messages} onSend={sendSms} />
              )}
            </>
          ) : (
            <EmptyState
              icon={<PhoneArrowUpRightIcon width={28} />}
              title="No line selected"
              description="Buy a number or select one to start calling and texting."
              action={
                <Button variant="primary" onClick={() => setShowBuy(true)}>
                  Buy number
                </Button>
              }
            />
          )}
        </main>
      </div>

      {voice.error ? <p className="phone-view__error notice notice--error">{voice.error}</p> : null}

      {voice.call ? (
        <CallOverlay
          call={voice.call}
          onAnswer={voice.answer}
          onHangup={voice.hangup}
          onToggleMute={voice.toggleMute}
        />
      ) : null}

      <BuyNumberModal
        open={showBuy}
        onClose={() => setShowBuy(false)}
        onPurchased={(n) => {
          setOwned((list) => [n, ...list]);
          setActiveLine(n.phoneNumber);
          setShowBuy(false);
          toast.success('Number purchased', formatNumber(n.phoneNumber));
        }}
      />
    </div>
  );
}
