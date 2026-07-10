import type { Profile } from '@lobster/shared-types';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  EllipsisVerticalIcon,
  LockClosedIcon,
  PlayIcon,
  StopIcon,
} from '@heroicons/react/24/outline';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { LaunchInfo } from '../../api/tauri';
import lobsterIcon from '../../assets/brand/lobster-icon.png';
import { EmptyState } from '../../ui';
import { isAndroidTarget, osLabel } from './options';

export type ProfileSortKey = 'name' | 'updatedAt' | 'status' | 'proxy';
export type SortDir = 'asc' | 'desc';

interface ProfileListProps {
  profiles: Profile[];
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

function proxyLabel(profile: Profile): { title: string; detail: string } {
  if (!profile.proxy) return { title: 'No proxy', detail: 'Set a proxy' };
  return {
    title: profile.proxy.label ?? `${profile.proxy.host}:${profile.proxy.port}`,
    detail: `${profile.proxy.host}:${profile.proxy.port}`,
  };
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
      title={
        androidTarget
          ? 'Launch via ADB on a connected Android device (Lobium APK)'
          : 'Launch'
      }
    >
      <PlayIcon aria-hidden />
    </button>
  );
}

/** Dense profile table with per-profile lifecycle + management actions. */
export function ProfileList({
  profiles,
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
}: ProfileListProps): JSX.Element {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const allSelected = profiles.length > 0 && profiles.every((p) => selectedIds.has(p.id));
  const someSelected = profiles.some((p) => selectedIds.has(p.id));

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
      <table className="data-table profiles-table">
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
            <th>
              <SortHeader
                label="Title"
                active={sortKey === 'name'}
                dir={sortDir}
                onClick={() => onSort('name')}
              />
            </th>
            <th>Description</th>
            <th>
              <SortHeader
                label="Proxy"
                active={sortKey === 'proxy'}
                dir={sortDir}
                onClick={() => onSort('proxy')}
              />
            </th>
            <th>Tags</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => {
            const busy = busyIds.has(profile.id);
            const info = launchInfo.get(profile.id);
            const proxy = proxyLabel(profile);
            const androidTarget = isAndroidTarget(profile.os);
            return (
              <tr key={profile.id} className={selectedIds.has(profile.id) ? 'row--selected' : undefined}>
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
                    <img className="row-mark" src={lobsterIcon} alt="" aria-hidden />
                    <div className="profile-title-text">
                      <div className="table-title">{profile.name}</div>
                      <div className="table-subtitle">
                        {osLabel(profile.os)} · {formatDate(profile.updatedAt)}
                        {profile.passwordProtected ? ' · Password protected' : ''}
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
                  <span className="muted">{profile.notes ?? info?.debuggerAddress ?? ''}</span>
                </td>
                <td>
                  <div className="proxy-cell">
                    <LockClosedIcon aria-hidden />
                    <div>
                      <div>{proxy.title}</div>
                      <div className="table-subtitle">{proxy.detail}</div>
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
