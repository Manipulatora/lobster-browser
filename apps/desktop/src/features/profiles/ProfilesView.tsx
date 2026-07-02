import { useState } from 'react';

import type { CreateProfileInput, Profile } from '@lobster/shared-types';

import { isDesktopRuntime, type LaunchInfo, type ProfilePatch } from '../../api/tauri';
import { FingerprintEditor } from '../fingerprint/FingerprintEditor';
import { NewProfileForm } from './NewProfileForm';
import { ProfileList } from './ProfileList';
import { useProfiles } from './useProfiles';

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The Profiles workspace: list of profiles with create / clone / delete / launch / stop
 * actions, and a modal fingerprint editor. Backed by {@link useProfiles} (real Tauri commands
 * in the desktop shell, an in-memory mock in a dev browser).
 */
export function ProfilesView(): JSX.Element {
  const { profiles, loading, error, create, clone, update, remove, launch, stop } = useProfiles();

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [launchInfo, setLaunchInfo] = useState<ReadonlyMap<string, LaunchInfo>>(() => new Map());
  const [banner, setBanner] = useState<string | null>(null);

  function setBusy(id: string, on: boolean): void {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function handleCreate(input: CreateProfileInput): Promise<void> {
    await create(input);
    setShowForm(false);
    setBanner(`Created profile “${input.name}”.`);
  }

  async function handleLaunch(id: string): Promise<void> {
    setBusy(id, true);
    setBanner(null);
    try {
      const info = await launch(id);
      setLaunchInfo((prev) => new Map(prev).set(id, info));
      setBanner(`Launched. Connect over CDP at ${info.debuggerAddress}.`);
    } catch (e: unknown) {
      setBanner(`Launch failed: ${errMessage(e)}`);
    } finally {
      setBusy(id, false);
    }
  }

  async function handleStop(id: string): Promise<void> {
    setBusy(id, true);
    setBanner(null);
    try {
      await stop(id);
      setLaunchInfo((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    } catch (e: unknown) {
      setBanner(`Stop failed: ${errMessage(e)}`);
    } finally {
      setBusy(id, false);
    }
  }

  async function handleClone(id: string): Promise<void> {
    try {
      await clone(id);
      setBanner('Profile cloned with a fresh fingerprint seed.');
    } catch (e: unknown) {
      setBanner(`Clone failed: ${errMessage(e)}`);
    }
  }

  async function handleDelete(id: string): Promise<void> {
    const target = profiles.find((p) => p.id === id);
    const label = target ? `“${target.name}”` : 'this profile';
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    try {
      await remove(id);
      setLaunchInfo((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setBanner('Profile deleted.');
    } catch (e: unknown) {
      setBanner(`Delete failed: ${errMessage(e)}`);
    }
  }

  async function handleSaveFingerprint(patch: ProfilePatch): Promise<void> {
    if (!editing) return;
    setSaving(true);
    try {
      await update(editing.id, patch);
      setEditing(null);
      setBanner('Fingerprint overrides saved.');
    } finally {
      setSaving(false);
    }
  }

  const isEmpty = !loading && profiles.length === 0;

  return (
    <div className="profiles-view">
      <div className="view-toolbar">
        <div className="view-toolbar__meta">
          <span className="count">
            {profiles.length} profile{profiles.length === 1 ? '' : 's'}
          </span>
          {!isDesktopRuntime() ? (
            <span className="pill pill--muted">mock data (browser dev)</span>
          ) : null}
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Close' : '+ New profile'}
        </button>
      </div>

      {banner ? (
        <p className="notice notice--info" role="status">
          {banner}
        </p>
      ) : null}

      {error ? <p className="notice notice--error">Could not load profiles: {error}</p> : null}

      {showForm ? (
        <NewProfileForm onCreate={handleCreate} onCancel={() => setShowForm(false)} />
      ) : null}

      {loading ? (
        <p className="notice">Loading profiles…</p>
      ) : isEmpty ? (
        <div className="empty-state card">
          <h3>No profiles yet</h3>
          <p>Create your first anti-detect profile to get started.</p>
          <button type="button" className="btn btn--primary" onClick={() => setShowForm(true)}>
            + New profile
          </button>
        </div>
      ) : (
        <ProfileList
          profiles={profiles}
          busyIds={busyIds}
          launchInfo={launchInfo}
          onLaunch={handleLaunch}
          onStop={handleStop}
          onClone={handleClone}
          onDelete={handleDelete}
          onEditFingerprint={setEditing}
        />
      )}

      {editing ? (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !saving) setEditing(null);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-label="Edit fingerprint">
            <header className="modal-header">
              <div>
                <h2>Fingerprint</h2>
                <p className="modal-subtitle">{editing.name}</p>
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setEditing(null)}
                disabled={saving}
                aria-label="Close"
              >
                ✕
              </button>
            </header>
            <div className="modal-body">
              <FingerprintEditor
                profile={editing}
                onSave={handleSaveFingerprint}
                onClose={() => setEditing(null)}
                saving={saving}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
