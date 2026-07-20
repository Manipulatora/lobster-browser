import { useState } from 'react';
import { PhoneIcon } from '@heroicons/react/24/solid';

import { Button } from '../../ui';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;

/**
 * Keypad + number entry. Dials `to` from the active line. Disabled when there's no active line or a
 * call is already up.
 */
export function Dialer({
  disabled,
  onCall,
}: {
  disabled: boolean;
  onCall: (to: string) => void;
}): JSX.Element {
  const [value, setValue] = useState('');

  const press = (k: string): void => setValue((v) => v + k);
  const backspace = (): void => setValue((v) => v.slice(0, -1));

  const normalized = value.trim();
  const canCall = !disabled && /^\+?[0-9]{3,15}$/.test(normalized.replace(/[^\d+]/g, ''));

  function call(): void {
    if (!canCall) return;
    const e164 = normalized.startsWith('+') ? normalized : `+${normalized.replace(/[^\d]/g, '')}`;
    onCall(e164);
    setValue('');
  }

  return (
    <div className="dialer">
      <input
        className="dialer__display"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="+1 555 010 0000"
        inputMode="tel"
        aria-label="Phone number"
      />
      <div className="dialer__keys">
        {KEYS.map((k) => (
          <button key={k} type="button" className="dialer__key" onClick={() => press(k)}>
            {k}
          </button>
        ))}
      </div>
      <div className="dialer__actions">
        <Button variant="ghost" onClick={backspace} disabled={!value}>
          ⌫
        </Button>
        <Button
          variant="primary"
          leadingIcon={<PhoneIcon aria-hidden width={18} />}
          onClick={call}
          disabled={!canCall}
        >
          Call
        </Button>
      </div>
    </div>
  );
}
