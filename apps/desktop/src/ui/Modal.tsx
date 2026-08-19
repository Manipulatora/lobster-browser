import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Full-bleed strip between the header and the body — a tab strip, a step rail. It sits outside
   * `.lb-modal__body` so its own border reaches both edges of the dialog rather than stopping at the
   * body's padding.
   */
  subheader?: ReactNode;
  /** Controls that belong to the dialog itself (Refresh, Help), placed before Close in the header. */
  headerActions?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Accessible label when there is no visible title. */
  ariaLabel?: string;
  /** Id of explanatory text inside the dialog. */
  ariaDescribedBy?: string;
}

/**
 * The last element focused outside any dialog — what a dialog should hand focus back to.
 *
 * Tracked at module scope, not per instance, because instance state does not survive a remount and
 * a Modal is remounted routinely: StrictMode mounts, unmounts and remounts every component in
 * development. A remounted dialog starts with an empty ref, so an instance-local answer restores
 * nothing and focus silently falls to <body>.
 */
let lastFocusOutsideDialog: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (e) => {
      const target = e.target as HTMLElement | null;
      if (target && !target.closest('[role="dialog"]')) lastFocusOutsideDialog = target;
    },
    true,
  );
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
  subheader,
  headerActions,
  size = 'md',
  ariaLabel,
  ariaDescribedBy,
}: ModalProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const generatedTitleId = useId();

  // `onClose` is read through a ref so the effect below does not depend on it.
  //
  // Callers pass an inline arrow (`onClose={() => { … }}`), which is a new function identity on
  // every parent render. With `onClose` in the dependency array the whole effect tore down and
  // re-ran on EVERY KEYSTROKE in a dialog whose input is bound to parent state — re-running the
  // focus move below each time, and running its cleanup, which yanked focus out of the dialog.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // WHO TO GIVE FOCUS BACK TO, read during render on the closed->open edge because every later
  // phase is too late: React applies the dialog's `autoFocus` during commit, so from a layout or
  // passive effect `document.activeElement` is already an element INSIDE the dialog. Recording that
  // is why restoring focus used to do nothing — it aimed at the node being unmounted, and focus fell
  // to <body> after every dialog closed. Anything inside a dialog is never the opener, so fall back
  // to the last focus seen outside one, which is also all a remount has left to go on.
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    const active = document.activeElement as HTMLElement | null;
    previouslyFocused.current =
      active && !active.closest('[role="dialog"]') ? active : lastFocusOutsideDialog;
  }
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;

    // DO NOT STEAL FOCUS THAT IS ALREADY INSIDE THE DIALOG.
    //
    // This is what made the profile password prompt impossible to type into. React applies
    // `autoFocus` by calling `.focus()` during commitMount — a LAYOUT-phase effect — so by the time
    // this passive effect runs, the password input is already focused. The unconditional
    // `querySelector(...)` below then moved focus to the FIRST match in DOM order, and `button`
    // leads that selector list, so focus landed on the header Close button before the user could
    // type a character. Enter or Space then activated Close, whose handler clears the field —
    // exactly the "it only accepted it for a very short time" symptom.
    //
    // Note the fix is NOT to query `[autofocus]`: React 18 never writes that attribute to the DOM
    // on the client (it is emitted only in SSR output), so such a selector matches nothing.
    // Checking `contains(document.activeElement)` works regardless of how focus got there.
    if (!dialog?.contains(document.activeElement)) {
      // Inputs first. When nothing is auto-focused, the field a dialog exists to collect is a
      // better landing place than its Close button.
      //
      // This is TWO queries on purpose. A single comma-separated selector returns the first match
      // in DOCUMENT order, not in selector order, and the header Close button precedes every field
      // in the markup — so the one-selector form always landed on Close and typing went nowhere.
      const focusable =
        dialog?.querySelector<HTMLElement>(
          'input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
        ) ?? dialog?.querySelector<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])');
      (focusable ?? dialog)?.focus();
    }

    // Whether focus was inside the dialog, sampled while it is still mounted. The cleanup below
    // cannot ask this question itself: it is passive, so React has already detached the dialog by
    // the time it runs and `document.activeElement` has fallen back to <body>.
    let focusWasInside = dialog?.contains(document.activeElement) ?? false;
    const onFocusIn = (e: FocusEvent) => {
      focusWasInside = dialog?.contains(e.target as Node) ?? false;
    };
    document.addEventListener('focusin', onFocusIn, true);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
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
      document.removeEventListener('focusin', onFocusIn, true);
      // Only restore focus if the dialog still held it when it closed; otherwise this fights
      // whatever the app deliberately focused next.
      if (focusWasInside) {
        previouslyFocused.current?.focus?.();
      }
    };
    // `onClose` deliberately absent: it is read through onCloseRef. See the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
            <div className="lb-modal__header-actions">
              {headerActions}
              <button
                type="button"
                className="lb-btn lb-btn--ghost lb-btn--icon lb-btn--sm"
                aria-label="Close"
                onClick={onClose}
              >
                <Icon name="XMarkIcon" aria-hidden />
              </button>
            </div>
          </div>
        ) : null}
        {subheader}
        <div className="lb-modal__body">{children}</div>
        {footer ? <div className="lb-modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
