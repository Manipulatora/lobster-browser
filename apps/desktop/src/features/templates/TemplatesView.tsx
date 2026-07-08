import {
  LockClosedIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  SparklesIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { useEffect, useState } from 'react';

import type {
  CreateProfileInput,
  CreateProfileTemplateInput,
  EngineKind,
  OsFamily,
  ProfileTemplate,
} from '@lobster/shared-types';

import { profilesClient, templatesClient } from '../../api/tauri';
import octiumMainIcon from '../../assets/brand/octium-main-icon.png';
import { ENGINE_OPTIONS, OS_OPTIONS, OS_VERSION_OPTIONS } from '../profiles/options';

interface TemplateFormState {
  name: string;
  engine: EngineKind;
  os: OsFamily;
  osVersion: string;
  preset: string;
  proxy: string;
  tags: string;
}

const initialForm: TemplateFormState = {
  name: '',
  engine: 'chromium',
  os: 'windows',
  osVersion: OS_VERSION_OPTIONS.windows[0],
  preset: 'User Agent, Extensions',
  proxy: '',
  tags: '',
};

function parseTags(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parsePreset(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function osName(value: OsFamily): string {
  return OS_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

function presetText(template: ProfileTemplate): string {
  return template.presetParameters.length > 0
    ? template.presetParameters.join(', ')
    : 'Fingerprint';
}

function proxyTitle(template: ProfileTemplate): string {
  return template.proxyLabel ?? 'No proxy';
}

function proxyDetail(template: ProfileTemplate): string {
  return template.proxyDetail ?? 'Template default';
}

function CreateTemplateModal({
  onCreate,
  onClose,
}: {
  onCreate: (input: CreateProfileTemplateInput) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const [form, setForm] = useState<TemplateFormState>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = form.name.trim().length > 0 && !submitting;

  function set<K extends keyof TemplateFormState>(key: K, value: TemplateFormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    const input: CreateProfileTemplateInput = {
      name: form.name.trim(),
      engine: form.engine,
      os: form.os,
      osVersion: form.osVersion,
      presetParameters: parsePreset(form.preset),
      tags: parseTags(form.tags),
    };
    const proxy = form.proxy.trim();
    if (proxy) {
      input.proxyLabel = proxy;
      input.proxyDetail = proxy;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onCreate(input);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="modal modal--template" onSubmit={handleSubmit} aria-label="Create template">
        <header className="modal-header">
          <h2>Create Template</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <XMarkIcon aria-hidden />
          </button>
        </header>
        <div className="modal-body">
          <div className="field-grid">
            <label className="field field--wide">
              <span className="field__label">Title</span>
              <input
                className="input"
                type="text"
                value={form.name}
                placeholder="Template name"
                onChange={(e) => set('name', e.target.value)}
                autoFocus
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
              <span className="field__label">OS</span>
              <select
                className="input"
                value={form.os}
                onChange={(e) => {
                  const os = e.target.value as OsFamily;
                  setForm((prev) => ({ ...prev, os, osVersion: OS_VERSION_OPTIONS[os][0] }));
                }}
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
                {OS_VERSION_OPTIONS[form.os].map((version) => (
                  <option key={version} value={version}>
                    {version}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field--wide">
              <span className="field__label">Preset parameters</span>
              <input
                className="input"
                type="text"
                value={form.preset}
                onChange={(e) => set('preset', e.target.value)}
              />
            </label>
            <label className="field field--wide">
              <span className="field__label">Proxy</span>
              <input
                className="input"
                type="text"
                value={form.proxy}
                placeholder="Proxy label or endpoint"
                onChange={(e) => set('proxy', e.target.value)}
              />
            </label>
            <label className="field field--wide">
              <span className="field__label">Tags</span>
              <input
                className="input"
                type="text"
                value={form.tags}
                placeholder="comma separated"
                onChange={(e) => set('tags', e.target.value)}
              />
            </label>
          </div>
          {error ? <p className="notice notice--error">{error}</p> : null}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
            Confirm
          </button>
        </footer>
      </form>
    </div>
  );
}

export function TemplatesView(): JSX.Element {
  const [query, setQuery] = useState('');
  const [templates, setTemplates] = useState<ProfileTemplate[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = templates.filter((template) =>
    [template.name, template.os, presetText(template), proxyTitle(template), ...template.tags]
      .join(' ')
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      setTemplates(await templatesClient.list_templates());
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleCreate(input: CreateProfileTemplateInput): Promise<void> {
    const created = await templatesClient.create_template(input);
    setTemplates((prev) => [created, ...prev]);
    setNotice(`Created template "${created.name}".`);
  }

  async function handleCreateProfile(template: ProfileTemplate): Promise<void> {
    const input: CreateProfileInput = {
      name: `${template.name} profile`,
      engine: template.engine,
      os: template.os,
      tags: [...template.tags],
      templateId: template.id,
    };
    if (template.osVersion) input.osVersion = template.osVersion;
    if (template.proxyId) input.proxyId = template.proxyId;
    if (template.fingerprintOverrides) input.fingerprintOverrides = template.fingerprintOverrides;
    if (template.cookiesImport) input.cookiesImport = template.cookiesImport;
    if (template.extensions) input.extensions = template.extensions;
    await profilesClient.create_profile(input);
    setNotice(`Created profile from "${template.name}".`);
  }

  return (
    <section className="page">
      <header className="table-toolbar">
        <div className="toolbar-total">
          <span>Total:</span>
          <strong>{rows.length} / 100</strong>
        </div>
        <label className="search-field search-field--templates">
          <MagnifyingGlassIcon aria-hidden />
          <input
            type="search"
            value={query}
            placeholder="Search templates"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button type="button" className="btn btn--primary" onClick={() => setShowCreate(true)}>
          <SparklesIcon aria-hidden />
          Create Template
        </button>
      </header>

      {notice ? <p className="notice notice--info">{notice}</p> : null}
      {error ? <p className="notice notice--error">Could not load templates: {error}</p> : null}
      {loading ? <p className="notice">Loading templates...</p> : null}

      <div className="data-panel">
        <table className="data-table templates-table">
          <thead>
            <tr>
              <th className="check-cell">
                <input type="checkbox" aria-label="Select all templates" />
              </th>
              <th>Title</th>
              <th>OS</th>
              <th>Preset parameters</th>
              <th>Proxy</th>
              <th>Tags</th>
              <th>Password</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((template) => (
              <tr key={template.id}>
                <td className="check-cell">
                  <input type="checkbox" aria-label={`Select ${template.name}`} />
                </td>
                <td>
                  <div className="profile-title-cell profile-title-cell--compact">
                    <img className="row-mark" src={octiumMainIcon} alt="" aria-hidden />
                    <div className="table-title">{template.name}</div>
                  </div>
                </td>
                <td>
                  <span className="os-glyph" title={template.osVersion ?? osName(template.os)}>
                    ⊞
                  </span>
                </td>
                <td className="muted">{presetText(template)}</td>
                <td>
                  <div className="proxy-cell">
                    <span className="proxy-refresh">C</span>
                    <div>
                      <div>{proxyTitle(template)}</div>
                      <div className="table-subtitle">{proxyDetail(template)}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="tag-row tag-row--compact">
                    {template.tags.map((tag) => (
                      <span key={tag} className="tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  <LockClosedIcon className="table-lock" aria-hidden />
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn--outline btn--compact"
                    onClick={() => {
                      void handleCreateProfile(template);
                    }}
                  >
                    <PlayIcon aria-hidden />
                    Create Profile
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="pagination">
        <button type="button" className="pagination-arrow" aria-label="Previous page">
          ‹
        </button>
        <button type="button" className="pagination-page">
          1
        </button>
        <button type="button" className="pagination-arrow" aria-label="Next page">
          ›
        </button>
        <select className="pagination-size" defaultValue="10">
          <option value="10">10 / page</option>
          <option value="25">25 / page</option>
        </select>
      </footer>

      {showCreate ? (
        <CreateTemplateModal onCreate={handleCreate} onClose={() => setShowCreate(false)} />
      ) : null}
    </section>
  );
}
