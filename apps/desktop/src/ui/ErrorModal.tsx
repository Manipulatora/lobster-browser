import { createContext, useCallback, useContext, useId, useMemo, useState } from 'react';
import type { JSX, ReactNode } from 'react';

import { Button } from './Button';
import { Modal } from './Modal';

/**
 * The one way a failure is shown to the user.
 *
 * Errors used to be bottom-right toasts carrying `err.message` verbatim, which put engine refusals,
 * SQLite text and stack-adjacent strings in front of someone who wanted to open a browser profile.
 * This replaces all of that with a single small centred modal and ONE sentence, in red, of the fixed
 * shape "{Action} failed to {verb}".
 *
 * The message is deliberately not composed from the underlying error. A caller passes a constant it
 * chose at the call site, so no diagnostic text can reach the UI by accident. The detail is not
 * discarded — it goes to the console, where support and CI can still read it — it is simply not
 * something a customer is made to parse.
 */
interface ErrorModalApi {
  /**
   * @param message A fixed "{Action} failed to {verb}" sentence. Never interpolate an error into it.
   * @param cause   The underlying failure, logged for diagnosis and never rendered.
   */
  showError: (message: string, cause?: unknown) => void;
}

const ErrorModalContext = createContext<ErrorModalApi | null>(null);

export function ErrorModalProvider({ children }: { children: ReactNode }): JSX.Element {
  const [message, setMessage] = useState<string | null>(null);
  const descriptionId = useId();

  const showError = useCallback((next: string, cause?: unknown) => {
    if (cause !== undefined) {
      // Kept out of the UI, kept in the log: losing the reason entirely would make a support
      // conversation impossible.
      console.error(`[lobster] ${next}`, cause);
    }
    setMessage(next);
  }, []);

  const api = useMemo<ErrorModalApi>(() => ({ showError }), [showError]);

  return (
    <ErrorModalContext.Provider value={api}>
      {children}
      <Modal
        open={message !== null}
        onClose={() => setMessage(null)}
        title="Something went wrong"
        size="sm"
        ariaDescribedBy={descriptionId}
        footer={
          <Button variant="primary" onClick={() => setMessage(null)}>
            Close
          </Button>
        }
      >
        <p id={descriptionId} className="error-modal__message" role="alert">
          {message}
        </p>
      </Modal>
    </ErrorModalContext.Provider>
  );
}

export function useErrorModal(): ErrorModalApi {
  const ctx = useContext(ErrorModalContext);
  if (!ctx) throw new Error('useErrorModal must be used within an ErrorModalProvider');
  return ctx;
}
