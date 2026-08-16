import type { SVGProps } from 'react';
import { ICON_PATHS, type IconName } from './icons';

export type { IconName };

/**
 * Material Symbols (Outlined), rendered from the official path data in `icons.tsx`.
 *
 * Drop-in for the Heroicons components this replaced: same `className` convention, same default of
 * inheriting the surrounding colour via `fill="currentColor"`, so no call site needed restyling.
 *
 * Sized in `em` rather than a fixed pixel box. Heroicons shipped 24x24 SVGs whose size call sites
 * controlled with `w-4 h-4`-style classes; here the glyph tracks the text size it sits next to,
 * which is what almost every usage actually wanted.
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Optical size, in em relative to the parent font-size. */
  size?: number | string;
  /** Accessible label. Omit for icons that only decorate adjacent text. */
  title?: string;
}

export function Icon({ name, size = '1.25em', title, ...rest }: IconProps) {
  const entry = ICON_PATHS[name];
  // A missing name is a programming error, not a runtime condition worth a fallback glyph: a silent
  // blank square is how a broken icon reaches production unnoticed.
  if (!entry) {
    throw new Error(`Icon: unknown name "${String(name)}"`);
  }
  const [viewBox, d] = entry;
  return (
    <svg
      viewBox={viewBox}
      width={size}
      height={size}
      fill="currentColor"
      // Decorative unless it was given a title - otherwise every icon is announced twice, once for
      // itself and once for the label beside it.
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  );
}
