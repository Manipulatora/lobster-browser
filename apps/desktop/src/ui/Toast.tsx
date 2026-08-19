import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export type ToastTone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
  /** How many identical notifications this card stands for. */
  repeats?: number;
}

interface ToastApi {
  push: (tone: ToastTone, title: string, message?: string) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * At most this many notifications on screen at once. A bulk action over a multi-select emits one
 * call per item, and an uncapped stack filled the window with a column of identical cards — and read
 * every one of them out to a screen reader.
 */
const MAX_VISIBLE = 4;

/** App-wide toast provider. Wrap the app once; call `useToast()` anywhere. */
export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, title: string, message?: string) => {
      const id = nextId.current++;
      setToasts((list) => {
        // A repeat of the message already on screen counts up in place instead of stacking a
        // duplicate: "Profile stopped. (3)" says what happened without three cards saying it.
        const last = list[list.length - 1];
        if (last && last.tone === tone && last.title === title && last.message === message) {
          return [...list.slice(0, -1), { ...last, repeats: (last.repeats ?? 1) + 1 }];
        }
        return [...list, { id, tone, title, ...(message ? { message } : {}) }].slice(-MAX_VISIBLE);
      });
      // Auto-dismiss; errors linger a little longer.
      window.setTimeout(() => remove(id), tone === 'error' ? 6500 : 4000);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (t, m) => push('success', t, m),
      error: (t, m) => push('error', t, m),
      info: (t, m) => push('info', t, m),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="lb-toast-region" role="region" aria-label="Notifications" aria-live="polite">
        {/* The live region is the container. Giving each card `role="status"` as well nests a second
            polite region inside the first, and assistive tech reads every notification twice. */}
        {toasts.map((t) => (
          <div key={t.id} className={`lb-toast lb-toast--${t.tone}`}>
            <div className="lb-toast__body">
              <div className="lb-toast__title">
                {t.title}
                {t.repeats && t.repeats > 1 ? (
                  <span className="lb-toast__count"> ({t.repeats})</span>
                ) : null}
              </div>
              {t.message ? <div className="lb-toast__msg">{t.message}</div> : null}
            </div>
            <button
              type="button"
              className="lb-toast__close"
              aria-label="Dismiss notification"
              onClick={() => remove(t.id)}
            >
              <Icon name="XMarkIcon" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
