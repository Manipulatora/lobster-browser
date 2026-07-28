import { useState } from 'react';
import type { ReactNode } from 'react';
import { CheckIcon, ClipboardIcon } from '@heroicons/react/24/outline';
import { Button } from './Button';

/** Loading spinner. */
export function Spinner({ size = 16 }: { size?: number }): JSX.Element {
  return <span className="lb-spinner" style={{ width: size, height: size }} aria-hidden />;
}

/** Rectangular shimmer placeholder for loading content. */
export function Skeleton({
  width = '100%',
  height = 14,
  radius,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
}): JSX.Element {
  return (
    <span
      className="lb-skeleton"
      style={{
        display: 'block',
        width,
        height,
        ...(radius !== undefined ? { borderRadius: radius } : {}),
      }}
      aria-hidden
    />
  );
}

/** Centered empty/zero state with an icon, title, description, and optional action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="lb-empty">
      <div className="lb-empty__icon">{icon}</div>
      <div className="lb-empty__title">{title}</div>
      {description ? <p className="lb-empty__desc">{description}</p> : null}
      {action}
    </div>
  );
}

/** Simple hover/focus tooltip. */
export function Tooltip({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <span className="lb-tooltip">
      {children}
      <span className="lb-tooltip__bubble" role="tooltip">
        {label}
      </span>
    </span>
  );
}

/** Keyboard key chip. */
export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return <kbd className="lb-kbd">{children}</kbd>;
}

/** A code block with a copy-to-clipboard button (used by the automation panel). */
export function CodeBlock({ code, label }: { code: string; label?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      /* clipboard unavailable (non-secure context) — ignore */
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <pre className="lb-code" aria-label={label}>
      <Button
        className="lb-code__copy"
        variant="secondary"
        size="sm"
        onClick={copy}
        leadingIcon={copied ? <CheckIcon aria-hidden /> : <ClipboardIcon aria-hidden />}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <code>{code}</code>
    </pre>
  );
}
