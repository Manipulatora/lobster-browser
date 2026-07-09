import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

export function Badge({
  tone = 'neutral',
  dot = false,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <span className={`lb-badge lb-badge--${tone}`}>
      {dot ? <span className="lb-badge__dot" aria-hidden /> : null}
      {children}
    </span>
  );
}
