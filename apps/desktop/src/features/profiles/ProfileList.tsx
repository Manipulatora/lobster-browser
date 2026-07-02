import type { Profile } from '@lobster/shared-types';

import type { LaunchInfo } from '../../api/tauri';
import { engineLabel, osLabel, STATUS_META } from './options';

interface ProfileListProps {
  profiles: Profile[];
  /** Ids with an in-flight launch/stop call — their action buttons show a busy state. */
  busyIds: ReadonlySet<string>;
  /** Connection endpoints for profiles launched in this session. */
  launchInfo: ReadonlyMap<string, LaunchInfo>;
  onLaunch: (id: string) => void;
  onStop: (id: string) => void;
  onClone: (id: string) => void;
  onDelete: (id: string) => void;
  onEditFingerprint: (profile: Profile) => void;
}

/** Whether a status means the engine is (or is becoming) live. */
function isLive(status: Profile['status']): boolean {
  return status === 'running' || status === 'launching' || status === 'stopping';
}

/** Responsive grid of profile cards with per-profile lifecycle + management actions. */
export function ProfileList({
  profiles,
  busyIds,
  launchInfo,
  onLaunch,
  onStop,
  onClone,
  onDelete,
  onEditFingerprint,
}: ProfileListProps): JSX.Element {
  return (
    <div className="profiles-grid">
      {profiles.map((profile) => {
        const status = STATUS_META[profile.status];
        const busy = busyIds.has(profile.id);
        const live = isLive(profile.status);
        const info = launchInfo.get(profile.id);
        return (
          <article key={profile.id} className="card profile-card">
            <header className="profile-card__head">
              <h3 className="profile-card__name" title={profile.name}>
                {profile.name}
              </h3>
              <span className={`status status--${status.tone}`}>
                <span className="status__dot" aria-hidden />
                {status.label}
              </span>
            </header>

            <div className="badge-row">
              <span className="badge badge--engine">{engineLabel(profile.engine)}</span>
              <span className="badge">{osLabel(profile.os)}</span>
              {profile.folder ? (
                <span className="badge badge--muted">📁 {profile.folder}</span>
              ) : null}
            </div>

            {profile.tags.length > 0 ? (
              <div className="tag-row">
                {profile.tags.map((tag) => (
                  <span key={tag} className="tag">
                    {tag}
                  </span>
                ))}
              </div>
            ) : (
              <p className="profile-card__muted">No tags</p>
            )}

            {info ? (
              <dl className="conn-info">
                <div>
                  <dt>ws</dt>
                  <dd>
                    <code>{info.ws}</code>
                  </dd>
                </div>
                <div>
                  <dt>debuggerAddress</dt>
                  <dd>
                    <code>{info.debuggerAddress}</code>
                  </dd>
                </div>
              </dl>
            ) : null}

            <footer className="profile-card__actions">
              {live ? (
                <button
                  type="button"
                  className="btn btn--sm btn--warn"
                  onClick={() => onStop(profile.id)}
                  disabled={busy}
                >
                  {busy ? '…' : 'Stop'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  onClick={() => onLaunch(profile.id)}
                  disabled={busy}
                >
                  {busy ? '…' : 'Launch'}
                </button>
              )}
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => onEditFingerprint(profile)}
              >
                Fingerprint
              </button>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => onClone(profile.id)}
              >
                Clone
              </button>
              <button
                type="button"
                className="btn btn--sm btn--danger-ghost"
                onClick={() => onDelete(profile.id)}
                disabled={live}
                title={live ? 'Stop the profile before deleting' : 'Delete profile'}
              >
                Delete
              </button>
            </footer>
          </article>
        );
      })}
    </div>
  );
}
