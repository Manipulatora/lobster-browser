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

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // Focus after paint.
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

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
      <div className="lb-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          className="lb-palette__input"
          placeholder="Search profiles, actions, pages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Command search"
        />
        <div className="lb-palette__list" ref={listRef}>
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
                      onMouseEnter={() => setActive(flat.indexOf(c))}
                      onClick={() => {
                        onClose();
                        c.run();
                      }}
                    >
                      {c.icon}
                      <span>{c.title}</span>
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
