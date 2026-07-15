import { useId } from 'react';

import { Button } from './Button';
import { Modal } from './Modal';

export interface ActionDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
  destructive?: boolean;
  input?: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    type?: 'text' | 'password';
    placeholder?: string;
    required?: boolean;
  };
}

/** Shared accessible replacement for browser prompt/confirm dialogs. */
export function ActionDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
  busy = false,
  destructive = false,
  input,
}: ActionDialogProps): JSX.Element | null {
  const descriptionId = useId();
  const inputId = useId();
  const confirmDisabled = busy || Boolean(input?.required && input.value.trim().length === 0);

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={title}
      size="sm"
      ariaDescribedBy={descriptionId}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="action-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!confirmDisabled) onConfirm();
        }}
      >
        <p id={descriptionId} className="action-dialog__description">
          {description}
        </p>
        {input ? (
          <label className="field" htmlFor={inputId}>
            <span className="field__label">{input.label}</span>
            <input
              id={inputId}
              className="input"
              type={input.type ?? 'text'}
              value={input.value}
              placeholder={input.placeholder}
              required={input.required}
              autoComplete={input.type === 'password' ? 'current-password' : 'off'}
              autoFocus
              onChange={(event) => input.onChange(event.target.value)}
            />
          </label>
        ) : null}
      </form>
    </Modal>
  );
}

export interface ErrorDialogProps {
  open: boolean;
  title?: string;
  message: string;
  onClose: () => void;
}

/** Blocking error detail for failures that need explicit acknowledgement. */
export function ErrorDialog({
  open,
  title = 'Something went wrong',
  message,
  onClose,
}: ErrorDialogProps): JSX.Element | null {
  const descriptionId = useId();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      ariaDescribedBy={descriptionId}
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <p id={descriptionId} className="action-dialog__description" role="alert">
        {message}
      </p>
    </Modal>
  );
}
