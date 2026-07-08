import { XMarkIcon } from '@heroicons/react/24/outline';
import { useState } from 'react';

import type { EngineKind, OsFamily, Profile } from '@lobster/shared-types';

import type { ProfilePatch } from '../../api/tauri';
import octiumMainIcon from '../../assets/brand/octium-main-icon.png';
import { ENGINE_OPTIONS, OS_OPTIONS, OS_VERSION_OPTIONS } from './options';

interface EditProfileFormProps {
  profile: Profile;
  saving: boolean;
  onSave: (patch: ProfilePatch) => Promise<void>;
  onCancel: () => void;
  onEditFingerprint?: () => void;
}

interface EditProfileState {
  name: string;
  description: string;
  engine: EngineKind;
  os: OsFamily;
  osVersion: string;
  folder: string;
  tags: string;
}

function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    const tag = part.trim();
    if (tag) seen.add(tag);
  }
  return [...seen];
}

function initState(profile: Profile): EditProfileState {
  return {
    name: profile.name,
    description: profile.notes ?? '',
    engine: profile.engine,
    os: profile.os,
    osVersion: profile.osVersion ?? OS_VERSION_OPTIONS[profile.os][0],
    folder: profile.folder ?? '',
    tags: profile.tags.join(', '),
  };
}

export function EditProfileForm({
  profile,
  saving,
  onSave,
  onCancel,
  onEditFingerprint,
}: EditProfileFormProps): JSX.Element {
  const [form, setForm] = useState<EditProfileState>(() => initState(profile));
  const [error, setError] = useState<string | null>(null);
  const versionOptions = OS_VERSION_OPTIONS[form.os];
  const canSave = form.name.trim().length > 0 && !saving;

  function set<K extends keyof EditProfileState>(key: K, value: EditProfileState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setOs(os: OsFamily): void {
    setForm((prev) => ({ ...prev, os, osVersion: OS_VERSION_OPTIONS[os][0] }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSave) return;

    const patch: ProfilePatch = {
      name: form.name.trim(),
      engine: form.engine,
      os: form.os,
      osVersion: form.osVersion,
      notes: form.description.trim(),
      folder: form.folder.trim(),
      tags: parseTags(form.tags),
    };

    try {
      setError(null);
      await onSave(patch);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <form className="modal" onSubmit={handleSubmit} aria-label="Edit profile">
      <header className="modal-header">
        <div className="modal-title-row">
          <img className="profile-icon-preview" src={octiumMainIcon} alt="" aria-hidden />
          <div>
            <h2>Edit profile</h2>
            <p className="modal-subtitle">{profile.name}</p>
          </div>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onCancel}
          disabled={saving}
          aria-label="Close"
        >
          <XMarkIcon aria-hidden />
        </button>
      </header>

      <div className="modal-body wizard-section">
        <div className="field-grid">
          <label className="field field--wide">
            <span className="field__label">
              <span className="required">*</span> Profile name
            </span>
            <input
              className="input"
              type="text"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              autoFocus
            />
          </label>

          <label className="field field--wide">
            <span className="field__label">Description</span>
            <textarea
              className="input textarea"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field__label">Engine</span>
            <select
              className="input"
              value={form.engine}
              onChange={(e) => set('engine', e.target.value as EngineKind)}
            >
              {ENGINE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">Operating system</span>
            <select
              className="input"
              value={form.os}
              onChange={(e) => setOs(e.target.value as OsFamily)}
            >
              {OS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">OS version</span>
            <select
              className="input"
              value={form.osVersion}
              onChange={(e) => set('osVersion', e.target.value)}
            >
              {versionOptions.map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">Folder</span>
            <input
              className="input"
              type="text"
              value={form.folder}
              onChange={(e) => set('folder', e.target.value)}
            />
          </label>

          <label className="field field--wide">
            <span className="field__label">Tags</span>
            <input
              className="input"
              type="text"
              value={form.tags}
              onChange={(e) => set('tags', e.target.value)}
            />
          </label>
        </div>

        {error ? <p className="notice notice--error">{error}</p> : null}
      </div>

      <footer className="modal-footer modal-footer--split">
        {onEditFingerprint ? (
          <button
            type="button"
            className="btn btn--outline"
            onClick={onEditFingerprint}
            disabled={saving}
          >
            Fingerprint
          </button>
        ) : (
          <span />
        )}
        <div className="modal-footer-actions">
          <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={!canSave}>
            Save
          </button>
        </div>
      </footer>
    </form>
  );
}
