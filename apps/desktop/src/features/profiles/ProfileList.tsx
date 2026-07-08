import type { Profile } from '@lobster/shared-types';
import {
  EllipsisVerticalIcon,
  LockClosedIcon,
  PlayIcon,
  StopIcon,
} from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';

import type { LaunchInfo } from '../../api/tauri';
import octiumMainIcon from '../../assets/brand/octium-main-icon.png';
import { osLabel } from './options';

interface ProfileListProps {
  profiles: Profile[];
  /** Ids with an in-flight launch/stop call — their action buttons show a busy state. */
  busyIds: ReadonlySet<string>;
  /** Connection endpoints for profiles launched in this session. */
  launchInfo: ReadonlyMap<string, LaunchInfo>;
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

/** Dense profile table with per-profile lifecycle + management actions. */
export function ProfileList({
  profiles,
  busyIds,
  launchInfo,
  onLaunch,
  onStop,
  onClone,
  onMoveToTrash,
  onEditProfile,
  onSetPassword,
}: ProfileListProps): JSX.Element {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

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
      <div className="empty-state empty-state--compact">
        <h3>No matching profiles</h3>
        <p>Adjust the current filters to see more profiles.</p>
      </div>
    );
  }

  return (
    <div className="data-panel">
      <table className="data-table profiles-table">
        <thead>
          <tr>
            <th className="check-cell">
              <input type="checkbox" aria-label="Select all profiles" />
            </th>
            <th>Title</th>
            <th>Description</th>
            <th>Proxy</th>
            <th>Tags</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => {
            const busy = busyIds.has(profile.id);
            const live = isLive(profile.status);
            const info = launchInfo.get(profile.id);
            const proxy = proxyLabel(profile);
            return (
              <tr key={profile.id}>
                <td className="check-cell">
                  <input type="checkbox" aria-label={`Select ${profile.name}`} />
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
