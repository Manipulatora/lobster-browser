import type { Profile, StoredProxy } from '@lobster/shared-types';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  EllipsisVerticalIcon,
  LockClosedIcon,
  PlayIcon,
  StopIcon,
} from '@heroicons/react/24/outline';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { LaunchInfo } from '../../api/tauri';
import appIcon from '../../assets/brand/icon.png';
import { EmptyState } from '../../ui';
import { isAndroidTarget, osLabel, STATUS_META } from './options';
import { OsIcon, countryFlag } from './OsIcon';

export type ProfileSortKey = 'name' | 'updatedAt' | 'status' | 'proxy' | 'description' | 'tags';
export type SortDir = 'asc' | 'desc';

// Resizable data columns (the leading checkbox is fixed). Widths persist across sessions.
const RESIZABLE_COLUMNS = ['title', 'description', 'proxy', 'tags'] as const;
type ResizableColumn = (typeof RESIZABLE_COLUMNS)[number];
const DEFAULT_COLUMN_WIDTHS: Record<ResizableColumn, number> = {
  title: 320,
  description: 240,
  proxy: 260,
  tags: 180,
};
const COLUMN_WIDTHS_STORAGE_KEY = 'lobster.profiles.columnWidths.v1';
const MIN_COLUMN_WIDTH = 96;

interface ProfileListProps {
  profiles: Profile[];
  /** Stored proxies, so a profile referencing one by id shows its real name/host/country. */
  availableProxies: StoredProxy[];
  /** Ids with an in-flight launch/stop call — their action buttons show a busy state. */
  busyIds: ReadonlySet<string>;
  /** Connection endpoints for profiles launched in this session. */
  launchInfo: ReadonlyMap<string, LaunchInfo>;
  selectedIds: ReadonlySet<string>;
  sortKey: ProfileSortKey;
  sortDir: SortDir;
  onSort: (key: ProfileSortKey) => void;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onLaunch: (id: string) => void;
  onStop: (id: string) => void;
  onClone: (id: string) => void;
  onMoveToTrash: (id: string) => void;
  onEditProfile: (profile: Profile) => void;
  onSetPassword: (id: string) => void;
  /** Explicit CDP / automation details (never auto-shown on launch). */
  onShowConnection: (id: string) => void;
  onExportCookies: (id: string) => void;
}

/** Whether a status means the engine is (or is becoming) live. */
function isLive(status: Profile['status']): boolean {
  return status === 'running' || status === 'launching' || status === 'stopping';
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

interface ResolvedProxy {
  /** Line 1: the user-given proxy name. */
  name: string;
  /** Line 2: host:port. */
  address: string;
  /** 2-letter country code for the flag, when known. */
  countryCode?: string;
  present: boolean;
}

/** A stored `location` is built as "CC · region · city" (see ProxiesView); take the leading country. */
function countryCodeFromLocation(location?: string): string | undefined {
  const first = location?.split(/[·,|/]/)[0]?.trim();
  return first && /^[A-Za-z]{2}$/.test(first) ? first : undefined;
}

function resolveProxy(profile: Profile, stored: StoredProxy[]): ResolvedProxy {
  if (profile.proxy) {
    const { host, port, label } = profile.proxy;
    return {
      name: label ?? `${host}:${port}`,
      address: `${host}:${port}`,
      present: true,
    };
  }
  if (profile.proxyId) {
    const match = stored.find((p) => p.id === profile.proxyId);
    if (match) {
      return {
        name: match.label || `${match.config.host}:${match.config.port}`,
        address: `${match.config.host}:${match.config.port}`,
        countryCode: countryCodeFromLocation(match.location),
        present: true,
      };
    }
    return { name: 'Stored proxy', address: profile.proxyId, present: true };
  }
  return { name: 'No proxy', address: 'Set a proxy', present: false };
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" className="sort-header" onClick={onClick}>
      <span>{label}</span>
      {active ? (
        dir === 'asc' ? (
          <ChevronUpIcon aria-hidden />
        ) : (
          <ChevronDownIcon aria-hidden />
        )
      ) : null}
    </button>
  );
}

function StatusActionButton({
  profile,
  busy,
  androidTarget,
  onLaunch,
  onStop,
}: {
  profile: Profile;
  busy: boolean;
  androidTarget: boolean;
  onLaunch: (id: string) => void;
  onStop: (id: string) => void;
}): JSX.Element {
  if (profile.status === 'stopping' || (busy && profile.status === 'running')) {
    return (
      <button
        type="button"
        className="icon-button icon-button--table status-action status-action--closing"
        disabled
        aria-label={`${profile.name} is closing`}
        title="Closing"
      >
        <span className="status-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
      </button>
    );
  }

  if (profile.status === 'launching' || (busy && !isLive(profile.status))) {
    return (
      <button
        type="button"
        className="icon-button icon-button--table status-action status-action--closing"
        disabled
        aria-label={`${profile.name} is launching`}
        title="Launching"
      >
        <span className="status-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
      </button>
    );
  }

  if (profile.status === 'running') {
    return (
      <button
        type="button"
        className="icon-button icon-button--table"
        onClick={() => onStop(profile.id)}
        disabled={busy}
        aria-label={`Stop ${profile.name}`}
        title="Stop"
      >
        <StopIcon aria-hidden />
      </button>
    );
  }

  return (
    <button
      type="button"
      className="icon-button icon-button--table icon-button--primary"
      onClick={() => onLaunch(profile.id)}
      disabled={busy}
      aria-label={`Launch ${profile.name}`}
      title={androidTarget ? 'Launch (phone-emulated Chrome — no device or APK required)' : 'Launch'}
    >
      <PlayIcon aria-hidden />
    </button>
  );
}

/** Dense profile table with per-profile lifecycle + management actions. */
export function ProfileList({
  profiles,
  availableProxies,
  busyIds,
  launchInfo,
  selectedIds,
  sortKey,
  sortDir,
  onSort,
  onToggleSelect,
  onToggleSelectAll,
  onLaunch,
  onStop,
  onClone,
  onMoveToTrash,
  onEditProfile,
  onSetPassword,
  onShowConnection,
  onExportCookies,
}: ProfileListProps): JSX.Element {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const allSelected = profiles.length > 0 && profiles.every((p) => selectedIds.has(p.id));
  const someSelected = profiles.some((p) => selectedIds.has(p.id));

  // Per-column widths (draggable, persisted). table-layout:fixed honors these + enables text ellipsis.
  const [columnWidths, setColumnWidths] = useState<Record<ResizableColumn, number>>(() => {
    try {
      const saved = localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY);
      if (saved) return { ...DEFAULT_COLUMN_WIDTHS, ...(JSON.parse(saved) as Partial<Record<ResizableColumn, number>>) };
    } catch {
      // ignore malformed storage
    }
    return DEFAULT_COLUMN_WIDTHS;
  });
  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(columnWidths));
    } catch {
      // storage unavailable — widths simply won't persist
    }
  }, [columnWidths]);

  const startResize = useCallback(
    (column: ResizableColumn, event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = columnWidths[column];
      const onMove = (moveEvent: MouseEvent) => {
        const next = Math.max(MIN_COLUMN_WIDTH, startWidth + (moveEvent.clientX - startX));
        setColumnWidths((current) => ({ ...current, [column]: next }));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
      };
      document.body.style.cursor = 'col-resize';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [columnWidths],
  );

  useLayoutEffect(() => {
    if (!openMenuId) {
      setMenuPos(null);
      return;
    }
    const trigger = triggerRefs.current.get(openMenuId);
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuWidth = 178;
    setMenuPos({
      top: rect.bottom + 6,
      left: Math.max(8, rect.right - menuWidth),
    });
  }, [openMenuId]);

  useEffect(() => {
    if (openMenuId === null) return undefined;

    function closeIfOutside(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      const trigger = openMenuId ? triggerRefs.current.get(openMenuId) : null;
      if (trigger && target instanceof Node && trigger.contains(target)) return;
      setOpenMenuId(null);
    }

    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpenMenuId(null);
    }

    function closeOnScroll(): void {
      setOpenMenuId(null);
    }

    document.addEventListener('pointerdown', closeIfOutside);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', closeOnScroll);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('resize', closeOnScroll);
    };
  }, [openMenuId]);

  if (profiles.length === 0) {
    return (
      <EmptyState
        icon={<LockClosedIcon aria-hidden />}
        title="No matching profiles"
        description="Adjust the current filters to see more profiles."
      />
    );
  }

  const openProfile = openMenuId ? profiles.find((p) => p.id === openMenuId) : undefined;
  const openLive = openProfile ? isLive(openProfile.status) : false;
  const openHasConnection = openProfile ? launchInfo.has(openProfile.id) : false;

  return (
    <div className="data-panel">
      <table className="data-table profiles-table profiles-table--fixed">
        <colgroup>
          <col style={{ width: 40 }} />
          <col style={{ width: columnWidths.title }} />
          <col style={{ width: columnWidths.description }} />
          <col style={{ width: columnWidths.proxy }} />
          <col style={{ width: columnWidths.tags }} />
        </colgroup>
        <thead>
          <tr>
            <th className="check-cell">
              <input
                type="checkbox"
                aria-label="Select all profiles"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected && !allSelected;
                }}
                onChange={onToggleSelectAll}
              />
            </th>
            <th className="th--resizable">
              <SortHeader
                label="Title"
                active={sortKey === 'name'}
                dir={sortDir}
                onClick={() => onSort('name')}
              />
              <span className="col-resize" onMouseDown={(e) => startResize('title', e)} aria-hidden />
            </th>
            <th className="th--resizable">
              <SortHeader
                label="Description"
                active={sortKey === 'description'}
                dir={sortDir}
                onClick={() => onSort('description')}
              />
              <span
                className="col-resize"
                onMouseDown={(e) => startResize('description', e)}
                aria-hidden
              />
            </th>
            <th className="th--resizable">
              <SortHeader
                label="Proxy"
                active={sortKey === 'proxy'}
                dir={sortDir}
                onClick={() => onSort('proxy')}
              />
              <span className="col-resize" onMouseDown={(e) => startResize('proxy', e)} aria-hidden />
            </th>
            <th className="th--resizable">
              <SortHeader
                label="Tags"
                active={sortKey === 'tags'}
                dir={sortDir}
                onClick={() => onSort('tags')}
              />
              <span className="col-resize" onMouseDown={(e) => startResize('tags', e)} aria-hidden />
            </th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => {
            const busy = busyIds.has(profile.id);
            const info = launchInfo.get(profile.id);
            const proxy = resolveProxy(profile, availableProxies);
            const description = profile.notes ?? info?.debuggerAddress ?? '';
            const androidTarget = isAndroidTarget(profile.os);
            return (
              <tr
                key={profile.id}
                className={selectedIds.has(profile.id) ? 'row--selected' : undefined}
              >
                <td className="check-cell">
                  <input
                    type="checkbox"
                    aria-label={`Select ${profile.name}`}
                    checked={selectedIds.has(profile.id)}
                    onChange={() => onToggleSelect(profile.id)}
                  />
                </td>
                <td>
                  <div className="profile-title-cell">
                    <img className="row-mark" src={appIcon} alt="" aria-hidden />
                    <div className="profile-title-text">
                      <div className="table-title cell-ellipsis" title={profile.name}>
                        {profile.name}
                      </div>
                      <div className="table-subtitle">
                        <OsIcon os={profile.os} className="table-os-icon" />
                        <span title={osLabel(profile.os)}>{STATUS_META[profile.status].label}</span> ·{' '}
                        {formatDate(profile.updatedAt)}
                        {profile.passwordProtected ? ' · 🔒' : ''}
                      </div>
                    </div>
                    <div className="table-actions">
                      <StatusActionButton
                        profile={profile}
                        busy={busy}
                        androidTarget={androidTarget}
                        onLaunch={onLaunch}
                        onStop={onStop}
                      />
                      <div className="row-menu">
                        <button
                          type="button"
                          className="icon-button icon-button--table"
                          aria-label={`More actions for ${profile.name}`}
                          aria-expanded={openMenuId === profile.id}
                          title="More"
                          ref={(el) => {
                            if (el) triggerRefs.current.set(profile.id, el);
                            else triggerRefs.current.delete(profile.id);
                          }}
                          onClick={() =>
                            setOpenMenuId((current) => (current === profile.id ? null : profile.id))
                          }
                        >
                          <EllipsisVerticalIcon aria-hidden />
                        </button>
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <span className="muted cell-ellipsis" title={description || undefined}>
                    {description || '—'}
                  </span>
                </td>
                <td>
                  <div className={`proxy-cell${proxy.present ? '' : ' proxy-cell--empty'}`}>
                    <LockClosedIcon aria-hidden />
                    <div className="proxy-cell__text">
                      <div className="proxy-cell__name cell-ellipsis" title={proxy.name}>
                        {proxy.name}
                      </div>
                      <div className="table-subtitle proxy-cell__addr">
                        <span className="cell-ellipsis" title={proxy.address}>
                          {proxy.address}
                        </span>
                        {proxy.countryCode ? (
                          <span className="proxy-flag" title={proxy.countryCode}>
                            {countryFlag(proxy.countryCode)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  {profile.tags.length > 0 ? (
                    <div className="tag-row tag-row--compact">
                      {profile.tags.map((tag) => (
                        <span key={tag} className="tag">
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="muted">None</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {openMenuId && openProfile && menuPos
        ? createPortal(
            <div
              className="action-menu action-menu--portal"
              role="menu"
              ref={menuRef}
              style={{ top: menuPos.top, left: menuPos.left }}
            >
              <button
                type="button"
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setOpenMenuId(null);
                  onEditProfile(openProfile);
                }}
              >
                Edit profile
              </button>
              {openLive && openHasConnection ? (
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setOpenMenuId(null);
                    onShowConnection(openProfile.id);
                  }}
                >
                  Connection details
                </button>
              ) : null}
              {openProfile.status === 'running' ? (
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setOpenMenuId(null);
                    onExportCookies(openProfile.id);
                  }}
                >
                  Export live cookies
                </button>
              ) : null}
              <button
                type="button"
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setOpenMenuId(null);
                  onClone(openProfile.id);
                }}
              >
                Clone
              </button>
              <button
                type="button"
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setOpenMenuId(null);
                  onSetPassword(openProfile.id);
                }}
              >
                Set/remove pwd
              </button>
              <button
                type="button"
                className="menu-item menu-item--danger"
                role="menuitem"
                disabled={openLive}
                title={openLive ? 'Stop before moving to trash' : undefined}
                onClick={() => {
                  setOpenMenuId(null);
                  onMoveToTrash(openProfile.id);
                }}
              >
                Move to trash
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
