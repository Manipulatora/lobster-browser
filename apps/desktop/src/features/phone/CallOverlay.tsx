import { useEffect, useState } from 'react';
import { PhoneIcon, PhoneXMarkIcon } from '@heroicons/react/24/solid';
import { MicrophoneIcon } from '@heroicons/react/24/outline';

import type { ActiveCall } from './useVoiceDevice';
import { formatDuration, formatNumber } from './phoneOptions';

/**
 * The floating call panel. Shows an incoming ringer (accept/reject) or the active-call controls
 * (running timer, mute, hang up). Rendered whenever there is a live call, over any tab.
 */
export function CallOverlay({
  call,
  onAnswer,
  onHangup,
  onToggleMute,
}: {
  call: ActiveCall;
  onAnswer: () => void;
  onHangup: () => void;
  onToggleMute: () => void;
}): JSX.Element {
  const elapsed = useElapsed(call.state === 'active' ? call.startedAt : undefined);
  const ringingIn = call.direction === 'inbound' && call.state === 'ringing';

  return (
    <div className="call-overlay" role="dialog" aria-label="Call">
      <div className="call-overlay__peer">
        <div className="call-overlay__avatar" aria-hidden>
          {formatNumber(call.peer).replace(/\D/g, '').slice(-2) || '#'}
        </div>
        <div>
          <div className="call-overlay__number">{formatNumber(call.peer)}</div>
          <div className="call-overlay__status">
            {ringingIn
              ? `Incoming${call.line ? ` · ${formatNumber(call.line)}` : ''}`
              : call.state === 'ringing'
                ? 'Calling…'
                : elapsed}
          </div>
        </div>
      </div>

      <div className="call-overlay__controls">
        {call.state === 'active' ? (
          <button
            type="button"
            className={`call-btn ${call.muted ? 'call-btn--active' : ''}`}
            onClick={onToggleMute}
            aria-pressed={call.muted}
            aria-label={call.muted ? 'Unmute' : 'Mute'}
          >
            <MicrophoneIcon width={20} aria-hidden />
          </button>
        ) : null}

        {ringingIn ? (
          <button
            type="button"
            className="call-btn call-btn--answer"
            onClick={onAnswer}
            aria-label="Answer"
          >
            <PhoneIcon width={20} aria-hidden />
          </button>
        ) : null}

        <button
          type="button"
          className="call-btn call-btn--hangup"
          onClick={onHangup}
          aria-label={ringingIn ? 'Reject' : 'Hang up'}
        >
          <PhoneXMarkIcon width={20} aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** Live m:ss timer since `startedAt`. */
function useElapsed(startedAt?: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  return startedAt ? formatDuration(now - startedAt) : '0:00';
}
