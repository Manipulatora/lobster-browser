import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';


export type ToastTone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
}

interface ToastApi {
  push: (tone: ToastTone, title: string, message?: string) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

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
      setToasts((list) => [...list, { id, tone, title, ...(message ? { message } : {}) }]);
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
        {toasts.map((t) => (
          <div key={t.id} className={`lb-toast lb-toast--${t.tone}`} role="status">
            <div className="lb-toast__body">
              <div className="lb-toast__title">{t.title}</div>
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
