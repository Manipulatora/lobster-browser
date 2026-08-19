import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export interface Command {
  id: string;
  title: string;
  group: string;
  hint?: string;
  icon?: ReactNode;
  keywords?: string;
  run: () => void;
}

/**
 * Global command palette (UI-3). Open with Ctrl/Cmd-K. Fuzzy-ish substring match over title/group/
 * keywords, arrow-key navigation, Enter to run, Esc to close.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setActive(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);

    function trapFocus(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', trapFocus, true);
    return () => {
      document.removeEventListener('keydown', trapFocus, true);
      previouslyFocused.current?.focus();
    };
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    const tokens = q.split(/\s+/);
    return commands.filter((c) => {
      const hay = `${c.title} ${c.group} ${c.keywords ?? ''}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [commands, query]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // The list caps at 46vh and every profile is a command, so arrowing past the fold moved the
  // highlight somewhere the user could not see it. `nearest` scrolls only when it has to, which
  // keeps the list still while the highlight travels within the visible rows.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelectorAll<HTMLElement>('.lb-palette__item')
      [active]?.scrollIntoView({ block: 'nearest' });
  }, [active, open, filtered]);

  if (!open) return null;

  const grouped = new Map<string, Command[]>();
  for (const c of filtered) {
    const arr = grouped.get(c.group) ?? [];
    arr.push(c);
    grouped.set(c.group, arr);
  }
  // Flat order matching render, so arrow keys map to the visible list.
  const flat = filtered;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = flat[active];
      if (cmd) {
        onClose();
        cmd.run();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let index = -1;
  return (
    <div
      className="lb-palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="lb-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          className="lb-palette__input"
          placeholder="Search profiles, actions, pages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Command search"
        />
        <div className="lb-palette__list" ref={listRef} role="listbox" aria-label="Commands">
          {flat.length === 0 ? (
            <div className="lb-palette__group">No matches</div>
          ) : (
            [...grouped.entries()].map(([group, cmds]) => (
              <div key={group}>
                <div className="lb-palette__group">{group}</div>
                {cmds.map((c) => {
                  index += 1;
                  const isActive = index === active;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`lb-palette__item ${isActive ? 'lb-palette__item--active' : ''}`}
                      role="option"
                      aria-selected={isActive}
                      onMouseEnter={() => setActive(flat.indexOf(c))}
                      onClick={() => {
                        onClose();
                        c.run();
                      }}
                    >
                      <span className="lb-palette__icon" aria-hidden>
                        {c.icon}
                      </span>
                      <span className="lb-palette__title">{c.title}</span>
                      {c.hint ? <span className="lb-palette__hint">{c.hint}</span> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
