import type { Profile } from '@lobster/shared-types';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  EllipsisVerticalIcon,
  LockClosedIcon,
  PlayIcon,
  StopIcon,
} from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';

import type { LaunchInfo } from '../../api/tauri';
import octiumMainIcon from '../../assets/brand/octium-main-icon.png';
import { Badge, EmptyState, type BadgeTone } from '../../ui';
import { osLabel, STATUS_META } from './options';

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

function statusTone(status: Profile['status']): BadgeTone {
  switch (status) {
    case 'running':
      return 'success';
    case 'launching':
    case 'stopping':
      return 'warning';
    case 'error':
      return 'danger';
    default:
      return 'neutral';
  }
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
}: ProfileListProps): JSX.Element {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const allSelected = profiles.length > 0 && profiles.every((p) => selectedIds.has(p.id));
  const someSelected = profiles.some((p) => selectedIds.has(p.id));

  useEffect(() => {
    if (openMenuId === null) return undefined;

    function closeIfOutside(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setOpenMenuId(null);
    }

    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpenMenuId(null);
    }

    document.addEventListener('pointerdown', closeIfOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside);
      document.removeEventListener('keydown', closeOnEscape);
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
            <th>
              <SortHeader
                label="Status"
                active={sortKey === 'status'}
                dir={sortDir}
                onClick={() => onSort('status')}
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
            const live = isLive(profile.status);
            const info = launchInfo.get(profile.id);
            const proxy = proxyLabel(profile);
            const meta = STATUS_META[profile.status];
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
                    <img className="row-mark" src={octiumMainIcon} alt="" aria-hidden />
                    <div className="profile-title-text">
                      <div className="table-title">{profile.name}</div>
                      <div className="table-subtitle">
                        {osLabel(profile.os)} · {formatDate(profile.updatedAt)}
                        {profile.passwordProtected ? ' · Password protected' : ''}
                      </div>
                    </div>
                    <div className="table-actions">
                      {live ? (
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
                      ) : (
                        <button
                          type="button"
                          className="icon-button icon-button--table icon-button--primary"
                          onClick={() => onLaunch(profile.id)}
                          disabled={busy}
                          aria-label={`Launch ${profile.name}`}
                          title="Launch"
                        >
                          <PlayIcon aria-hidden />
                        </button>
                      )}
                      <div className="row-menu" ref={openMenuId === profile.id ? menuRef : null}>
                        <button
                          type="button"
                          className="icon-button icon-button--table"
                          aria-label={`More actions for ${profile.name}`}
                          aria-expanded={openMenuId === profile.id}
                          title="More"
                          onClick={() =>
                            setOpenMenuId((current) => (current === profile.id ? null : profile.id))
                          }
                        >
                          <EllipsisVerticalIcon aria-hidden />
                        </button>
                        {openMenuId === profile.id ? (
                          <div className="action-menu" role="menu">
                            <button
                              type="button"
                              className="menu-item"
                              role="menuitem"
                              onClick={() => {
                                setOpenMenuId(null);
                                onEditProfile(profile);
                              }}
                            >
                              Edit profile
                            </button>
                            <button
                              type="button"
                              className="menu-item"
                              role="menuitem"
                              onClick={() => {
                                setOpenMenuId(null);
                                onClone(profile.id);
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
                                onSetPassword(profile.id);
                              }}
                            >
                              Set/remove pwd
                            </button>
                            <button
                              type="button"
                              className="menu-item menu-item--danger"
                              role="menuitem"
                              disabled={live}
                              title={live ? 'Stop before moving to trash' : undefined}
                              onClick={() => {
                                setOpenMenuId(null);
                                onMoveToTrash(profile.id);
                              }}
                            >
                              Move to trash
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <Badge tone={statusTone(profile.status)} dot>
                    {meta.label}
                  </Badge>
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
    </div>
  );
}
