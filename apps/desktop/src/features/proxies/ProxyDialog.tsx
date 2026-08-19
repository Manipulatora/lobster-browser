import { useState } from 'react';

// The vendor formats users paste ("1.2.3.4:8080:user:pass") are parsed by the same code the engine
// parses a proxy with, imported straight from the package so there is one implementation and one
// set of tests for all of them. `@lobster/proxy/parse` is the browser-safe subpath: the package root
// also exports the undici-backed dispatcher, which cannot be bundled for a webview.
import { parseProxy } from '@lobster/proxy/parse';
import type { ProxyConfig, ProxyTestResult, ProxyType, StoredProxy } from '@lobster/shared-types';

import { Button, Modal } from '../../ui';
import { Icon } from '../../ui/Icon';

/** What the dialog collects. The caller turns it into a create or an update. */
export interface ProxyDraft {
  label: string;
  config: ProxyConfig;
  /** Empty clears the stored rotation URL. */
  rotateUrl: string;
}

interface ProxyFormState {
  title: string;
  type: ProxyType;
  host: string;
  port: string;
  login: string;
  password: string;
  rotateUrl: string;
}

const emptyForm: ProxyFormState = {
  title: '',
  type: 'socks5',
  host: '',
  port: '',
  login: '',
  password: '',
  rotateUrl: '',
};

function formFor(proxy: StoredProxy | undefined): ProxyFormState {
  if (!proxy) return emptyForm;
  return {
    title: proxy.label,
    type: proxy.config.type,
    host: proxy.config.host,
    port: String(proxy.config.port),
    login: proxy.config.username ?? '',
    password: proxy.config.password ?? '',
    rotateUrl: proxy.rotateUrl ?? '',
  };
}

function portNumber(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) return null;
  return value;
}

/**
 * Add a proxy, or change every part of one that already exists.
 *
 * Editing used to be a one-field rename dialog, so a proxy whose provider moved it to a new port —
 * or whose password rotated — could only be deleted and typed in again, losing whatever it was
 * attached to. The store has accepted a full config patch all along; this is the form that sends one.
 */
export function ProxyDialog({
  proxy,
  onSubmit,
  onCheck,
  onClose,
}: {
  /** Absent when adding. */
  proxy?: StoredProxy;
  onSubmit: (draft: ProxyDraft) => Promise<void>;
  onCheck: (config: ProxyConfig) => Promise<ProxyTestResult>;
  onClose: () => void;
}): JSX.Element {
  const [form, setForm] = useState<ProxyFormState>(() => formFor(proxy));
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const editing = proxy !== undefined;
  const parsedPort = portNumber(form.port.trim());
  const canSubmit =
    form.title.trim().length > 0 && form.host.trim().length > 0 && parsedPort !== null;

  function set<K extends keyof ProxyFormState>(key: K, value: ProxyFormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function buildConfig(): ProxyConfig | null {
    if (!canSubmit || parsedPort === null) return null;
    // An existing proxy keeps its id: the store matches the config id against the row it is saving.
    const id = proxy?.config.id ?? `px_${crypto.randomUUID().replaceAll('-', '')}`;
    const config: ProxyConfig = {
      id,
      type: form.type,
      host: form.host.trim(),
      port: parsedPort,
      label: form.title.trim(),
    };
    const username = form.login.trim();
    if (username) config.username = username;
    // A password without a username is refused by the store, and is meaningless anyway.
    if (username && form.password) config.password = form.password;
    return config;
  }

  async function pasteProxy(): Promise<void> {
    try {
      const raw = (await navigator.clipboard.readText()).trim();
      if (!raw) {
        setMessage('The clipboard is empty.');
        return;
      }
      const parsed = parseProxy(raw);
      setForm((previous) => ({
        ...previous,
        type: parsed.type,
        host: parsed.host,
        port: String(parsed.port),
        login: parsed.username ?? '',
        password: parsed.password ?? '',
        title: previous.title || parsed.host,
      }));
      setMessage('Proxy details pasted.');
    } catch (e: unknown) {
      setMessage(
        `Could not read a proxy from the clipboard: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const config = buildConfig();
    if (!config) {
      setMessage('Enter a title, host, and valid port.');
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      await onSubmit({ label: form.title.trim(), config, rotateUrl: form.rotateUrl.trim() });
      onClose();
    } catch (e: unknown) {
      setMessage(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  async function handleCheck(): Promise<void> {
    const config = buildConfig();
    if (!config) {
      setMessage('Enter a title, host, and valid port.');
      return;
    }
    setChecking(true);
    setMessage('Checking proxy...');
    try {
      const result = await onCheck(config);
      setMessage(
        result.ok
          ? `Proxy OK · ${result.latencyMs ?? 0} ms · ${result.geo?.timezone ?? 'geo unavailable'}`
          : `Proxy failed: ${result.error ?? 'Unknown error'}`,
      );
    } catch (e: unknown) {
      setMessage(`Proxy failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setChecking(false);
    }
  }

  return (
    <Modal
      open
      onClose={submitting ? () => undefined : onClose}
      title={editing ? 'Edit proxy' : 'Add proxy'}
      size="md"
      footer={
        <>
          <Button
            leadingIcon={<Icon name="ArrowPathIcon" aria-hidden />}
            onClick={() => {
              void handleCheck();
            }}
            disabled={checking || !canSubmit}
          >
            {checking ? 'Checking…' : 'Check proxy'}
          </Button>
          <div className="lb-modal__footer-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              form="proxy-form"
              variant="primary"
              disabled={!canSubmit || submitting}
            >
              {submitting ? 'Saving…' : editing ? 'Save proxy' : 'Add proxy'}
            </Button>
          </div>
        </>
      }
    >
      <form
        id="proxy-form"
        className="proxy-form-body"
        onSubmit={handleSubmit}
        aria-label="Proxy details"
      >
        {proxy?.unreadableSecrets?.length ? (
          <p className="notice notice--error" role="alert">
            This machine cannot decrypt this proxy&rsquo;s credentials, so they are not shown.
            Saving replaces them — enter them again, or restore this machine&rsquo;s secrets key
            first.
          </p>
        ) : null}

        <label className="lb-field lb-field--wide">
          <span className="lb-field__label">
            Title<span className="lb-field__required">*</span>
          </span>
          <input
            className="lb-input"
            type="text"
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            autoFocus
          />
        </label>

        <div className="lb-field lb-field--wide">
          <span className="lb-field__label">
            Proxy<span className="lb-field__required">*</span>
          </span>
          <div className="proxy-input-row">
            {/* The visible "Proxy" text above is a span shared by four controls, so it names none of
                them to a screen reader; each carries its own label instead. */}
            <select
              className="lb-select"
              aria-label="Protocol"
              value={form.type}
              onChange={(e) => set('type', e.target.value as ProxyType)}
            >
              <option value="socks5">SOCKS5</option>
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
            </select>
            <input
              className="lb-input"
              type="text"
              value={form.host}
              aria-label="Host"
              placeholder="Enter IP or domain"
              onChange={(e) => set('host', e.target.value)}
            />
            <input
              className="lb-input"
              type="text"
              value={form.port}
              aria-label="Port"
              placeholder="Port"
              onChange={(e) => set('port', e.target.value)}
            />
            <button
              type="button"
              className="proxy-mini-button"
              aria-label="Paste proxy URL"
              title="Paste host:port:user:pass or a full proxy URL"
              onClick={() => {
                void pasteProxy();
              }}
            >
              <Icon name="ClipboardDocumentIcon" aria-hidden />
            </button>
          </div>
        </div>

        <div className="lb-field-grid">
          <label className="lb-field">
            <span className="lb-field__label">Login</span>
            <input
              className="lb-input"
              type="text"
              value={form.login}
              autoComplete="off"
              onChange={(e) => set('login', e.target.value)}
            />
          </label>
          <label className="lb-field">
            <span className="lb-field__label">Password</span>
            <input
              className="lb-input"
              type="password"
              value={form.password}
              autoComplete="off"
              onChange={(e) => set('password', e.target.value)}
            />
          </label>
        </div>

        <label className="lb-field lb-field--wide">
          <span className="lb-field__label">URL for IP Change</span>
          <input
            className="lb-input"
            type="url"
            value={form.rotateUrl}
            placeholder="https://provider.example/rotate"
            onChange={(e) => set('rotateUrl', e.target.value)}
          />
        </label>

        {message ? (
          <p className="notice" role="status">
            {message}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
