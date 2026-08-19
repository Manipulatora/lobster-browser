import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from './Icon';

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  /** Rendered in the danger colour and placed last by convention. */
  danger?: boolean;
  disabled?: boolean;
  /** Why the item is unavailable, when it is. */
  title?: string;
}

const MENU_WIDTH = 178;

/**
 * The trailing "⋮" of a table row: one control that holds every action beyond the primary one.
 *
 * A row of text buttons is what a table can least afford. Five of them ("Check · Rotate · Edit ·
 * Delete") need more width than the column has, so the group paints outside the table and the panel
 * grows a horizontal scrollbar — and the count is not fixed, because a proxy with a rotation URL
 * carries one more control than one without. A menu is a constant width whatever it holds.
 *
 * PORTALLED, because `.data-panel` scrolls: a menu positioned inside the row is clipped by the
 * panel's overflow on the last rows of a long table, and while open it drags the panel's scroll
 * width sideways.
 */
export function RowMenu({
  label,
  items,
}: {
  /** Accessible name for the trigger; name the row it belongs to. */
  label: string;
  items: RowMenuItem[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ top: rect.bottom + 6, left: Math.max(8, rect.right - MENU_WIDTH) });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    function closeIfOutside(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }

    function close(): void {
      setOpen(false);
    }

    document.addEventListener('pointerdown', closeIfOutside);
    document.addEventListener('keydown', closeOnEscape);
    // The menu is fixed-positioned against a rect measured once, so anything that moves the row
    // underneath it has to dismiss it rather than leave it floating over unrelated content.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <div className="row-menu">
      <button
        type="button"
        ref={triggerRef}
        className="icon-button icon-button--table"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        title="More"
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="EllipsisVerticalIcon" aria-hidden />
      </button>
      {open && position
        ? createPortal(
            <div
              className="action-menu action-menu--portal"
              role="menu"
              ref={menuRef}
              style={{ top: position.top, left: position.left }}
            >
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className={item.danger ? 'menu-item menu-item--danger' : 'menu-item'}
                  role="menuitem"
                  disabled={item.disabled}
                  title={item.title}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
