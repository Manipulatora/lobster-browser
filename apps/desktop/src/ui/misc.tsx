import { useState } from 'react';
import type { ReactNode } from 'react';

import { Button } from './Button';
import { Icon } from './Icon';

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
/**
 * An empty state is an icon, a fact, and the way out of it.
 *
 * THERE IS DELIBERATELY NO `description`. Every one that existed restated the title in a longer
 * sentence ("Trash is empty" / "Profiles you move to trash appear here") or explained the product
 * to someone already inside it ("Create your first browser profile to get a coherent, isolated
 * identity"). It is the natural home for filler, so the slot is gone rather than left empty for
 * the next person to fill.
 */
export function EmptyState({
  icon,
  title,
  action,
}: {
  icon: ReactNode;
  title: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="lb-empty">
      <div className="lb-empty__icon">{icon}</div>
      <div className="lb-empty__title">{title}</div>
      {action}
    </div>
  );
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
        leadingIcon={
          copied ? <Icon name="CheckIcon" aria-hidden /> : <Icon name="ClipboardIcon" aria-hidden />
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <code>{code}</code>
    </pre>
  );
}
