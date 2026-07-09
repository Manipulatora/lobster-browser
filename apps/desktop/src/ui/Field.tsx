import { useId } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

interface FieldShellProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: (id: string) => ReactNode;
}

/** Label + hint/error wrapper. Wires the control's id to the label for accessibility. */
export function Field({ label, hint, error, children }: FieldShellProps): JSX.Element {
  const id = useId();
  return (
    <div className="lb-field">
      {label ? (
        <label className="lb-field__label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      {children(id)}
      {error ? (
        <span className="lb-field__error">{error}</span>
      ) : hint ? (
        <span className="lb-field__hint">{hint}</span>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}
export function Input({ label, hint, error, className, ...rest }: InputProps): JSX.Element {
  const cls = ['lb-input', error ? 'lb-input--invalid' : '', className ?? ''].filter(Boolean).join(' ');
  if (!label && !hint && !error) return <input className={cls} {...rest} />;
  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => <input id={id} className={cls} {...rest} />}
    </Field>
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}
export function Select({ label, hint, error, className, children, ...rest }: SelectProps): JSX.Element {
  const cls = ['lb-select', error ? 'lb-select--invalid' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  if (!label && !hint && !error) {
    return (
      <select className={cls} {...rest}>
        {children}
      </select>
    );
  }
  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => (
        <select id={id} className={cls} {...rest}>
          {children}
        </select>
      )}
    </Field>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}
export function Textarea({ label, hint, error, className, ...rest }: TextareaProps): JSX.Element {
  const cls = ['lb-textarea', className ?? ''].filter(Boolean).join(' ');
  if (!label && !hint && !error) return <textarea className={cls} {...rest} />;
  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => <textarea id={id} className={cls} {...rest} />}
    </Field>
  );
}
