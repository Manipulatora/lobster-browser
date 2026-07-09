import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Icon-only button (square). Provide an `aria-label`. */
  iconOnly?: boolean;
  block?: boolean;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  leadingIcon?: ReactNode;
}

/** The one button primitive. Variants/sizes are token-driven (see components.css). */
export function Button({
  variant = 'secondary',
  size = 'md',
  iconOnly = false,
  block = false,
  loading = false,
  leadingIcon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  const classes = [
    'lb-btn',
    `lb-btn--${variant}`,
    size !== 'md' ? `lb-btn--${size}` : '',
    iconOnly ? 'lb-btn--icon' : '',
    block ? 'lb-btn--block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    // eslint-disable-next-line react/button-has-type
    <button type={type} className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <span className="lb-btn__spinner" aria-hidden /> : leadingIcon}
      {children}
    </button>
  );
}
