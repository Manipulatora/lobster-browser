import { useState } from 'react';

import type {
  BrowserExtensionRef,
  CreateProfileTemplateInput,
  EngineKind,
  FingerprintOverrides,
  PersonaMode,
  ProfileOsTarget,
  ProfileTemplate,
  StoredProxy,
} from '@lobster/shared-types';

import { Button, Modal } from '../../ui';
import { PERSONA_MODE_OPTIONS } from '../profiles/fingerprintCatalog';
import { ENGINE_OPTIONS, OS_OPTIONS, OS_VERSION_OPTIONS } from '../profiles/options';
import { chromeWebStoreExtensionId } from '../profiles/profileDraft';

interface TemplateFormState {
  name: string;
  engine: EngineKind;
  os: ProfileOsTarget;
  osVersion: string;
  /** Id of a stored proxy, or '' for none. */
  proxyId: string;
  tags: string;
  languageMode: PersonaMode;
  timezoneMode: PersonaMode;
  geolocationMode: PersonaMode;
  extensions: BrowserExtensionRef[];
}

/**
 * A template may pin a persona to the proxy's exit IP or to this machine, but not to a typed-in
 * value: "Manual" needs a locale, a timezone and a lat/lng that only the profile editor collects,
 * and a template that claimed to pin them while carrying none would produce profiles that quietly
 * fall back to the default.
 */
const TEMPLATE_PERSONA_OPTIONS = PERSONA_MODE_OPTIONS.filter((option) => option.value !== 'manual');

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

function personaMode(
  overrides: FingerprintOverrides | undefined,
  key: keyof FingerprintOverrides,
): PersonaMode {
  const value = overrides?.[key];
  return value === 'real' || value === 'based_ip' ? value : 'based_ip';
}

function formFor(template: ProfileTemplate | undefined): TemplateFormState {
  if (!template) {
    return {
      name: '',
      engine: 'lobium',
      os: 'windows',
      osVersion: OS_VERSION_OPTIONS.windows[0],
      proxyId: '',
      tags: '',
      languageMode: 'based_ip',
      timezoneMode: 'based_ip',
      geolocationMode: 'based_ip',
      extensions: [],
    };
  }
  return {
    name: template.name,
    engine: template.engine,
    os: template.os,
    osVersion: template.osVersion ?? OS_VERSION_OPTIONS[template.os][0],
    proxyId: template.proxyId ?? '',
    tags: template.tags.join(', '),
    languageMode: personaMode(template.fingerprintOverrides, 'languageMode'),
    timezoneMode: personaMode(template.fingerprintOverrides, 'timezoneMode'),
    geolocationMode: personaMode(template.fingerprintOverrides, 'geolocationMode'),
    extensions: template.extensions ? [...template.extensions] : [],
  };
}

/**
 * What this template presets, as the list the table column shows.
 *
 * DERIVED, never typed. The field was free-form and the dialog never filled it, so every row read
 * the same word regardless of what the template actually carried. Computing it from the saved values
 * is the only version of the column that cannot lie.
 */
function presetParameters(form: TemplateFormState): string[] {
  const presets = ['Fingerprint'];
  if (form.extensions.length > 0) presets.push(`Extensions (${form.extensions.length})`);
  return presets;
}

export function TemplateDialog({
  template,
  proxies,
  onSubmit,
  onClose,
}: {
  /** Absent when creating. */
  template?: ProfileTemplate;
  proxies: readonly StoredProxy[];
  onSubmit: (input: CreateProfileTemplateInput) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const [form, setForm] = useState<TemplateFormState>(() => formFor(template));
  const [extensionValue, setExtensionValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = template !== undefined;
  const canSubmit = form.name.trim().length > 0 && !submitting;

  function set<K extends keyof TemplateFormState>(key: K, value: TemplateFormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function addExtension(): void {
    const value = extensionValue.trim();
    // STORE IDS ONLY, unlike the profile editor, which also takes a local unpacked directory. A
    // template is meant to be reused — an absolute path from one machine is not something the next
    // profile created from it can install.
    const id = chromeWebStoreExtensionId(value);
    if (!id) {
      setError('Enter a valid Chrome Web Store ID or official HTTPS detail URL.');
      return;
    }
    if (form.extensions.some((item) => item.id === id)) {
      setError('That extension is already in this template.');
      return;
    }
    setForm((prev) => ({
      ...prev,
      extensions: [
        ...prev.extensions,
        {
          source: 'chrome_web_store',
          enabled: true,
          id,
          ...(value.startsWith('https://') ? { url: value } : {}),
          installState: 'pending',
        },
      ],
    }));
    setExtensionValue('');
    setError(null);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    // Everything the template pins, every time: a save replaces the stored row, and the fields the
    // dialog owns are the fields it sends.
    const input: CreateProfileTemplateInput = {
      name: form.name.trim(),
      engine: form.engine,
      os: form.os,
      osVersion: form.osVersion,
      tags: parseTags(form.tags),
      presetParameters: presetParameters(form),
      fingerprintOverrides: {
        ...template?.fingerprintOverrides,
        languageMode: form.languageMode,
        timezoneMode: form.timezoneMode,
        geolocationMode: form.geolocationMode,
      },
    };
    if (form.extensions.length > 0) input.extensions = form.extensions;
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
      await onSubmit(input);
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
      title={editing ? 'Edit template' : 'Create template'}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="template-form" variant="primary" disabled={!canSubmit}>
            {submitting ? 'Saving…' : editing ? 'Save template' : 'Create template'}
          </Button>
        </>
      }
    >
      <form id="template-form" onSubmit={handleSubmit} aria-label="Template details">
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
          <div className="lb-field-triple lb-field--wide">
            <label className="lb-field">
              <span className="lb-field__label">Language</span>
              <select
                className="lb-select"
                value={form.languageMode}
                onChange={(e) => set('languageMode', e.target.value as PersonaMode)}
              >
                {TEMPLATE_PERSONA_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="lb-field">
              <span className="lb-field__label">Timezone</span>
              <select
                className="lb-select"
                value={form.timezoneMode}
                onChange={(e) => set('timezoneMode', e.target.value as PersonaMode)}
              >
                {TEMPLATE_PERSONA_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="lb-field">
              <span className="lb-field__label">Geolocation</span>
              <select
                className="lb-select"
                value={form.geolocationMode}
                onChange={(e) => set('geolocationMode', e.target.value as PersonaMode)}
              >
                {TEMPLATE_PERSONA_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="lb-field lb-field--wide">
            <span className="lb-field__label">Extensions</span>
            <div className="template-extension-row">
              <input
                className="lb-input"
                type="text"
                value={extensionValue}
                aria-label="Chrome Web Store extension"
                placeholder="abcdefghijklmnopabcdefghijklmnop"
                onChange={(e) => setExtensionValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addExtension();
                  }
                }}
              />
              <Button onClick={addExtension}>Add extension</Button>
            </div>
            {form.extensions.length > 0 ? (
              <ul className="template-extension-list">
                {form.extensions.map((extension) => (
                  <li key={extension.id}>
                    <span className="template-extension-id">{extension.id}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove extension ${extension.id}`}
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          extensions: prev.extensions.filter((item) => item.id !== extension.id),
                        }))
                      }
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
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
