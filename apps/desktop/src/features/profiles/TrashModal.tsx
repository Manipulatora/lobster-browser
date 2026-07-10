import type { Profile } from '@lobster/shared-types';
import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';

import lobsterIcon from '../../assets/brand/lobster-icon.png';
import { osLabel } from './options';

interface TrashModalProps {
  profiles: Profile[];
  loading: boolean;
  busyIds: ReadonlySet<string>;
  error: string | null;
  onRefresh: () => void;
  onRestore: (id: string) => void;
  onPermanentlyDelete: (id: string) => void;
  onClose: () => void;
}

function formatDate(value: string | undefined): string {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function TrashModal({
  profiles,
  loading,
  busyIds,
  error,
  onRefresh,
  onRestore,
  onPermanentlyDelete,
  onClose,
}: TrashModalProps): JSX.Element {
  return (
    <div
      className="modal modal--trash"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trash-title"
    >
      <header className="modal-header">
        <div>
          <h2 id="trash-title">Trash</h2>
          <p className="modal-subtitle">{profiles.length} profiles</p>
        </div>
        <div className="modal-header-actions">
          <button
            type="button"
            className="icon-button"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh trash"
            title="Refresh"
          >
            <ArrowPathIcon aria-hidden />
          </button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <XMarkIcon aria-hidden />
          </button>
        </div>
      </header>

      <div className="modal-body">
        {error ? <p className="notice notice--error">{error}</p> : null}
        {loading ? <p className="notice">Loading trash...</p> : null}
        {!loading && profiles.length === 0 ? (
          <div className="empty-state empty-state--compact">
            <h3>Trash is empty</h3>
            <p>Profiles moved to trash will appear here.</p>
          </div>
        ) : null}

        {!loading && profiles.length > 0 ? (
          <div className="trash-list">
            {profiles.map((profile) => {
              const busy = busyIds.has(profile.id);
              return (
                <article className="trash-row" key={profile.id}>
                  <div className="profile-title-cell profile-title-cell--compact">
                    <img className="row-mark" src={lobsterIcon} alt="" aria-hidden />
                    <div className="profile-title-text">
                      <div className="table-title">{profile.name}</div>
                      <div className="table-subtitle">
                        {osLabel(profile.os)} | Trashed {formatDate(profile.trashedAt)}
                      </div>
                    </div>
                  </div>
                  <div className="tag-row tag-row--compact trash-row__tags">
                    {profile.tags.length > 0 ? (
                      profile.tags.map((tag) => (
                        <span key={tag} className="tag">
                          {tag}
                        </span>
                      ))
                    ) : (
                      <span className="muted">No tags</span>
                    )}
                  </div>
                  <div className="trash-row__actions">
                    <button
                      type="button"
                      className="btn btn--outline"
                      disabled={busy}
                      onClick={() => onRestore(profile.id)}
                    >
                      <ArrowUturnLeftIcon aria-hidden />
                      Restore
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger"
                      disabled={busy}
                      onClick={() => onPermanentlyDelete(profile.id)}
                    >
                      <TrashIcon aria-hidden />
                      Delete
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
