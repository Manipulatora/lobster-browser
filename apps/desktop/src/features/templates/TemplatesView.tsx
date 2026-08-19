import { useEffect, useState } from 'react';

import type {
  CreateProfileInput,
  CreateProfileTemplateInput,
  EngineKind,
  ProfileOsTarget,
  ProfileTemplate,
  StoredProxy,
} from '@lobster/shared-types';

import { profilesClient, proxiesClient, templatesClient } from '../../api/tauri';
import appIcon from '../../assets/brand/icon.png';
import { Button, EmptyState, Modal, Skeleton, useToast } from '../../ui';
import { ENGINE_OPTIONS, OS_OPTIONS, OS_VERSION_OPTIONS } from '../profiles/options';
import { Icon } from '../../ui/Icon';

interface TemplateFormState {
  name: string;
  engine: EngineKind;
  os: ProfileOsTarget;
  osVersion: string;
  /** Id of a stored proxy, or '' for none. */
  proxyId: string;
  tags: string;
}

const initialForm: TemplateFormState = {
  name: '',
  engine: 'lobium',
  os: 'windows',
  osVersion: OS_VERSION_OPTIONS.windows[0],
  proxyId: '',
  tags: '',
};

function parseTags(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function proxyEndpoint(proxy: StoredProxy): string {
  if (proxy.source === 'hive') return 'Managed endpoint';
  return `${proxy.config.host}:${proxy.config.port}`;
}

function osName(value: ProfileOsTarget): string {
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
  proxies,
  onCreate,
  onClose,
}: {
  proxies: readonly StoredProxy[];
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
      tags: parseTags(form.tags),
    };
    // A REAL PROXY, NOT A LABEL. This field used to be free text that became `proxyLabel` and
    // nothing else, so a profile created from the template carried no proxy at all while the
    // template row cheerfully displayed one. Only an id the profile creator can act on is stored;
    // the label and endpoint beside it are display copy derived from that same proxy.
    const proxy = proxies.find((item) => item.id === form.proxyId);
    if (proxy) {
      input.proxyId = proxy.id;
      input.proxyLabel = proxy.label;
      input.proxyDetail = proxyEndpoint(proxy);
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
    <Modal
      open
      onClose={submitting ? () => undefined : onClose}
      title="Create template"
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="create-template-form" variant="primary" disabled={!canSubmit}>
            {submitting ? 'Creating…' : 'Create template'}
          </Button>
        </>
      }
    >
      <form id="create-template-form" onSubmit={handleSubmit} aria-label="Template details">
        <div className="lb-field-grid">
          <label className="lb-field lb-field--wide">
            <span className="lb-field__label">Title</span>
            <input
              className="lb-input"
              type="text"
              value={form.name}
              placeholder="Enter template name"
              onChange={(e) => set('name', e.target.value)}
              autoFocus
            />
          </label>
          <div className="lb-field-triple lb-field--wide">
            <label className="lb-field">
              <span className="lb-field__label">Engine</span>
              <select
                className="lb-select"
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
            <label className="lb-field">
              <span className="lb-field__label">OS</span>
              <select
                className="lb-select"
                value={form.os}
                onChange={(e) => {
                  const os = e.target.value as ProfileOsTarget;
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
            <label className="lb-field">
              <span className="lb-field__label">OS version</span>
              <select
                className="lb-select"
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
          </div>
          <label className="lb-field lb-field--wide">
            <span className="lb-field__label">Proxy</span>
            <select
              className="lb-select"
              value={form.proxyId}
              onChange={(e) => set('proxyId', e.target.value)}
            >
              <option value="">No proxy</option>
              {proxies.map((proxy) => (
                <option key={proxy.id} value={proxy.id}>
                  {proxy.label} · {proxyEndpoint(proxy)}
                </option>
              ))}
            </select>
            {proxies.length === 0 ? (
              <span className="lb-field__hint">
                Add a proxy on the Proxies page to attach one to this template.
              </span>
            ) : null}
          </label>
          <label className="lb-field lb-field--wide">
            <span className="lb-field__label">Tags</span>
            <input
              className="lb-input"
              type="text"
              value={form.tags}
              placeholder="Separate tags with commas"
              onChange={(e) => set('tags', e.target.value)}
            />
          </label>
        </div>
        {error ? (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

export function TemplatesView(): JSX.Element {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [templates, setTemplates] = useState<ProfileTemplate[]>([]);
  const [proxies, setProxies] = useState<StoredProxy[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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

  // The proxy picker in the create dialog needs real stored proxies to choose from. A failure here
  // is not worth reporting: the dialog degrades to "No proxy" and says where proxies come from.
  useEffect(() => {
    let cancelled = false;
    void proxiesClient
      .list_proxies()
      .then((list) => {
        if (!cancelled) setProxies(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate(input: CreateProfileTemplateInput): Promise<void> {
    const created = await templatesClient.create_template(input);
    setTemplates((prev) => [created, ...prev]);
    toast.success(`Created template “${created.name}”.`);
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
    toast.success(`Created profile from “${template.name}”.`);
  }

  return (
    <section className="page">
      <header className="table-toolbar">
        <div className="toolbar-total">
          <strong>{rows.length}</strong>
          <span>{rows.length === 1 ? 'template' : 'templates'}</span>
        </div>
        <label className="search-field search-field--templates">
          <Icon name="MagnifyingGlassIcon" aria-hidden />
          <input
            type="search"
            value={query}
            placeholder="Search templates"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Button
          variant="primary"
          leadingIcon={<Icon name="PlusIcon" aria-hidden />}
          onClick={() => setShowCreate(true)}
        >
          Create Template
        </Button>
      </header>

      {error ? <p className="notice notice--error">Could not load templates: {error}</p> : null}
      {loading ? (
        <div className="skeleton-stack" aria-busy="true" aria-label="Loading templates">
          <Skeleton height={40} />
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
      ) : null}

      {!loading && rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="DocumentDuplicateIcon" aria-hidden />}
          title={query.trim() ? 'No matching templates' : 'No templates yet'}
          action={
            query.trim() ? undefined : (
              <Button
                variant="primary"
                leadingIcon={<Icon name="SparklesIcon" aria-hidden />}
                onClick={() => setShowCreate(true)}
              >
                Create Template
              </Button>
            )
          }
        />
      ) : null}

      {!loading && rows.length > 0 ? (
        <div className="data-panel">
          <table className="data-table templates-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>OS</th>
                <th>Preset parameters</th>
                <th>Proxy</th>
                <th>Tags</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((template) => (
                <tr key={template.id}>
                  <td>
                    <div className="profile-title-cell profile-title-cell--compact">
                      <img className="row-mark" src={appIcon} alt="" aria-hidden />
                      <div className="table-title">{template.name}</div>
                    </div>
                  </td>
                  <td>{template.osVersion ?? osName(template.os)}</td>
                  <td className="muted">{presetText(template)}</td>
                  <td>
                    <div className="proxy-cell">
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
                    <Button
                      size="sm"
                      leadingIcon={<Icon name="PlayIcon" aria-hidden />}
                      onClick={() => {
                        void handleCreateProfile(template);
                      }}
                    >
                      Create Profile
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {showCreate ? (
        <CreateTemplateModal
          proxies={proxies}
          onCreate={handleCreate}
          onClose={() => setShowCreate(false)}
        />
      ) : null}
    </section>
  );
}
