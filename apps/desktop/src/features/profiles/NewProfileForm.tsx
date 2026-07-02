import { useState } from 'react';

import type { CreateProfileInput, EngineKind, OsFamily } from '@lobster/shared-types';

import { ENGINE_OPTIONS, OS_OPTIONS } from './options';

interface NewProfileFormProps {
  onCreate: (input: CreateProfileInput) => Promise<void>;
  onCancel: () => void;
}

/** Split a comma/newline separated tag string into a clean, de-duplicated list. */
function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    const tag = part.trim();
    if (tag) seen.add(tag);
  }
  return [...seen];
}

/** Create-profile form: name, engine, OS, and optional tags/folder. */
export function NewProfileForm({ onCreate, onCancel }: NewProfileFormProps): JSX.Element {
  const [name, setName] = useState('');
  const [engine, setEngine] = useState<EngineKind>('chromium');
  const [os, setOs] = useState<OsFamily>('windows');
  const [tags, setTags] = useState('');
  const [folder, setFolder] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && !submitting;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    const input: CreateProfileInput = {
      name: name.trim(),
      engine,
      os,
      tags: parseTags(tags),
    };
    const folderValue = folder.trim();
    if (folderValue) input.folder = folderValue;

    setSubmitting(true);
    setError(null);
    try {
      await onCreate(input);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <div className="form-header">
        <h3>New profile</h3>
      </div>

      <div className="field-grid">
        <label className="field field--wide">
          <span className="field__label">Name</span>
          <input
            className="input"
            type="text"
            value={name}
            placeholder="e.g. US Retail — Chrome"
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>

        <label className="field">
          <span className="field__label">Engine</span>
          <select
            className="input"
            value={engine}
            onChange={(e) => setEngine(e.target.value as EngineKind)}
          >
            {ENGINE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Operating system</span>
          <select className="input" value={os} onChange={(e) => setOs(e.target.value as OsFamily)}>
            {OS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Folder (optional)</span>
          <input
            className="input"
            type="text"
            value={folder}
            placeholder="e.g. Shopping"
            onChange={(e) => setFolder(e.target.value)}
          />
        </label>

        <label className="field field--wide">
          <span className="field__label">Tags (optional)</span>
          <input
            className="input"
            type="text"
            value={tags}
            placeholder="comma separated, e.g. retail, us"
            onChange={(e) => setTags(e.target.value)}
          />
        </label>
      </div>

      {error ? <p className="notice notice--error">{error}</p> : null}

      <div className="form-actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
          {submitting ? 'Creating…' : 'Create profile'}
        </button>
      </div>
    </form>
  );
}
