import { useEffect, useState } from 'react';

import type {
  CreateProfileInput,
  CreateProfileTemplateInput,
  ProfileOsTarget,
  ProfileTemplate,
  StoredProxy,
} from '@lobster/shared-types';

import { profilesClient, proxiesClient, templatesClient } from '../../api/tauri';
import appIcon from '../../assets/brand/icon.png';
import {
  ActionDialog,
  Button,
  EmptyState,
  Pager,
  Skeleton,
  clampPage,
  pageCountFor,
  pageSlice,
  useErrorModal,
} from '../../ui';
import { OS_OPTIONS } from '../profiles/options';
import { Icon } from '../../ui/Icon';
import { RowMenu } from '../../ui/RowMenu';
import { TemplateDialog } from './TemplateDialog';

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

export function TemplatesView(): JSX.Element {
  const { showError } = useErrorModal();
  const [query, setQuery] = useState('');
  const [templates, setTemplates] = useState<ProfileTemplate[]>([]);
  const [proxies, setProxies] = useState<StoredProxy[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<ProfileTemplate | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProfileTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const rows = templates.filter((template) =>
    [template.name, template.os, presetText(template), proxyTitle(template), ...template.tags]
      .join(' ')
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  // Clamped at render so a shrinking result set (a delete, a narrower search) lands on the new
  // last page in the same frame; the effect below restarts a CHANGED search from page 1.
  const pageCount = pageCountFor(rows.length);
  const currentPage = clampPage(page, pageCount);
  const pageRows = pageSlice(rows, currentPage);

  useEffect(() => {
    setPage(1);
  }, [query]);

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

  // The proxy picker in the template dialog needs real stored proxies to choose from. A failure here
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
  }

  async function handleSave(
    template: ProfileTemplate,
    input: CreateProfileTemplateInput,
  ): Promise<void> {
    const saved = await templatesClient.update_template(template.id, input);
    setTemplates((prev) => prev.map((item) => (item.id === template.id ? saved : item)));
  }

  async function handleDuplicate(template: ProfileTemplate): Promise<void> {
    try {
      const copy = await templatesClient.duplicate_template(template.id);
      setTemplates((prev) => [copy, ...prev]);
    } catch (e: unknown) {
      showError('Template failed to duplicate', e);
    }
  }

  async function handleDelete(template: ProfileTemplate): Promise<void> {
    setDeleting(true);
    try {
      await templatesClient.delete_template(template.id);
      setTemplates((prev) => prev.filter((item) => item.id !== template.id));
      setPendingDelete(null);
    } catch (e: unknown) {
      showError('Template failed to delete', e);
    } finally {
      setDeleting(false);
    }
  }

  /**
   * A proxy that no longer exists, an OS the desktop path refuses, a name collision, a locked
   * profile: every one of these came back from `create_profile` and was dropped on the floor, so the
   * button did nothing and said nothing. Whatever the store refuses, the user is told.
   */
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
    // The template dialog collects no cookies, deliberately: a template may not carry cookie text at
    // all — `template_store` refuses `rawText` so a template can never hand someone else a live
    // session — which leaves the import mode, and a new profile already starts with an empty jar.
    // What arrives here comes from templates created through the local automation API.
    if (template.cookiesImport) input.cookiesImport = template.cookiesImport;
    if (template.extensions) input.extensions = template.extensions;
    try {
      await profilesClient.create_profile(input);
    } catch (e: unknown) {
      showError('Profile failed to create', e);
    }
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
              {pageRows.map((template) => (
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
                    <div className="table-actions">
                      <Button
                        size="sm"
                        leadingIcon={<Icon name="PlayIcon" aria-hidden />}
                        onClick={() => {
                          void handleCreateProfile(template);
                        }}
                      >
                        Create Profile
                      </Button>
                      <RowMenu
                        label={`More actions for ${template.name}`}
                        items={[
                          { label: 'Edit template', onSelect: () => setEditing(template) },
                          {
                            label: 'Duplicate',
                            onSelect: () => {
                              void handleDuplicate(template);
                            },
                          },
                          {
                            label: 'Delete template',
                            danger: true,
                            onSelect: () => setPendingDelete(template),
                          },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {!loading && rows.length > 0 ? (
        <Pager
          page={currentPage}
          pageCount={pageCount}
          onPageChange={setPage}
          label="Template pages"
        />
      ) : null}

      {showCreate ? (
        <TemplateDialog
          proxies={proxies}
          onSubmit={handleCreate}
          onClose={() => setShowCreate(false)}
        />
      ) : null}
      {editing ? (
        <TemplateDialog
          template={editing}
          proxies={proxies}
          onSubmit={(input) => handleSave(editing, input)}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ActionDialog
        open={pendingDelete !== null}
        title="Delete template?"
        description={`Remove “${pendingDelete?.name ?? 'this template'}”. Profiles already created from it are not affected.`}
        confirmLabel="Delete template"
        busy={deleting}
        destructive
        onConfirm={() => {
          if (pendingDelete) void handleDelete(pendingDelete);
        }}
        onClose={() => setPendingDelete(null)}
      />
    </section>
  );
}
