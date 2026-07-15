import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Accessible label when there is no visible title. */
  ariaLabel?: string;
  /** Id of explanatory text inside the dialog. */
  ariaDescribedBy?: string;
}

/**
 * Accessible modal dialog: overlay click + ESC to close, focus moves in on open and is restored on
 * close, and focus is trapped within the dialog while open. Token-styled (components.css).
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  ariaLabel,
  ariaDescribedBy,
}: ModalProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const generatedTitleId = useId();

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    // Focus the first focusable element (or the dialog itself).
    const focusable = dialog?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (focusable ?? dialog)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialog) {
        const nodes = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => el.offsetParent !== null);
        if (nodes.length === 0) return;
        const first = nodes[0]!;
        const last = nodes[nodes.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="lb-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`lb-modal lb-modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title ? undefined : ariaLabel}
        aria-labelledby={title ? generatedTitleId : undefined}
        aria-describedby={ariaDescribedBy}
        tabIndex={-1}
      >
        {title ? (
          <div className="lb-modal__header">
            <h2 id={generatedTitleId} className="lb-modal__title">
              {title}
            </h2>
            <button
              type="button"
              className="lb-btn lb-btn--ghost lb-btn--icon lb-btn--sm"
              aria-label="Close"
              onClick={onClose}
            >
              <XMarkIcon aria-hidden />
            </button>
          </div>
        ) : null}
        <div className="lb-modal__body">{children}</div>
        {footer ? <div className="lb-modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
