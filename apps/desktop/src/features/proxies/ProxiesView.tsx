import {
  ArrowPathIcon,
  ClipboardDocumentIcon,
  PlusIcon,
  ServerStackIcon,
  SignalIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { useEffect, useState } from 'react';

import type {
  CreateStoredProxyInput,
  ProxyConfig,
  ProxySource,
  ProxyTestResult,
  ProxyType,
  StoredProxy,
} from '@lobster/shared-types';

import { proxiesClient } from '../../api/tauri';
import { EmptyState, Skeleton, useToast } from '../../ui';

type ProxyTab = ProxySource;

interface ProxyFormState {
  title: string;
  type: ProxyType;
  host: string;
  port: string;
  login: string;
  password: string;
  rotateUrl: string;
}

const initialProxyForm: ProxyFormState = {
  title: '',
  type: 'socks5',
  host: '',
  port: '',
  login: '',
  password: '',
  rotateUrl: '',
};

function typeLabel(type: ProxyType): string {
  return type.toUpperCase();
}

function endpointLabel(proxy: StoredProxy): string {
  if (proxy.source === 'hive') return 'managed by Lobster';
  return `${proxy.config.host}:${proxy.config.port}`;
}

function locationLabel(proxy: StoredProxy): string {
  return (
    proxy.location ?? (proxy.source === 'hive' ? 'Hive Proxy · pending allocation' : 'Not tested')
  );
}

function timezoneLabel(proxy: StoredProxy): string {
  return proxy.timezone ?? (proxy.source === 'hive' ? 'Auto from exit IP' : 'Not tested');
}

function latencyLabel(proxy: StoredProxy): string {
  return proxy.latencyMs === undefined ? 'Not tested' : `${proxy.latencyMs} ms`;
}

function statusLabel(proxy: StoredProxy, checking: boolean): string {
  if (checking) return 'Testing';
  if (proxy.status === 'ready') return 'Ready';
  if (proxy.status === 'error') return 'Error';
  if (proxy.status === 'testing') return 'Testing';
  return 'Warning';
}

function portNumber(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) return null;
  return value;
}

function resultLocation(result: ProxyTestResult): string | undefined {
  const geo = result.geo;
  if (!geo) return undefined;
  return [geo.countryCode, geo.region, geo.city].filter(Boolean).join(' · ');
}

function AddProxyModal({
  initialTab,
  onAdd,
  onCheck,
  onClose,
}: {
  initialTab: ProxyTab;
  onAdd: (input: CreateStoredProxyInput) => Promise<void>;
  onCheck: (config: ProxyConfig) => Promise<ProxyTestResult>;
  onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<ProxyTab>(initialTab);
  const [form, setForm] = useState<ProxyFormState>(initialProxyForm);
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const parsedPort = portNumber(form.port.trim());
  const canSubmit =
    form.title.trim().length > 0 && form.host.trim().length > 0 && parsedPort !== null;

  function set<K extends keyof ProxyFormState>(key: K, value: ProxyFormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function buildConfig(): ProxyConfig | null {
    if (!canSubmit || parsedPort === null) return null;
    const id = `px_${crypto.randomUUID().replaceAll('-', '')}`;
    const config: ProxyConfig = {
      id,
      type: form.type,
      host: form.host.trim(),
      port: parsedPort,
      label: form.title.trim(),
    };
    const username = form.login.trim();
    if (username) config.username = username;
    if (form.password) config.password = form.password;
    return config;
  }

  function buildInput(): CreateStoredProxyInput | null {
    const config = buildConfig();
    if (!config) return null;
    const input: CreateStoredProxyInput = {
      source: tab,
      label: form.title.trim(),
      config,
    };
    const rotateUrl = form.rotateUrl.trim();
    if (rotateUrl) input.rotateUrl = rotateUrl;
    if (tab === 'hive') {
      input.location = 'Hive Proxy · pending allocation';
      input.timezone = 'Auto from exit IP';
    }
    return input;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const input = buildInput();
    if (!input) {
      setMessage('Enter a title, host, and valid port.');
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      await onAdd(input);
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
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="modal modal--proxy" onSubmit={handleSubmit} aria-label="New proxy">
        <header className="modal-header">
          <h2>New proxy</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <XMarkIcon aria-hidden />
          </button>
        </header>

        <div className="wizard-steps">
          <button
            type="button"
            className={tab === 'mine' ? 'wizard-step wizard-step--active' : 'wizard-step'}
            onClick={() => setTab('mine')}
          >
            My proxies
          </button>
          <button
            type="button"
            className={tab === 'hive' ? 'wizard-step wizard-step--active' : 'wizard-step'}
            onClick={() => setTab('hive')}
          >
            Hive Proxy
          </button>
        </div>

        <div className="modal-body proxy-form-body">
          <label className="field field--wide">
            <span className="field__label">
              <span className="required">*</span> Title
            </span>
            <input
              className="input"
              type="text"
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              autoFocus
            />
          </label>

          <div className="field field--wide">
            <span className="field__label">
              <span className="required">*</span> Proxy
            </span>
            <div className="proxy-input-row">
              <select
                className="input"
                value={form.type}
                onChange={(e) => set('type', e.target.value as ProxyType)}
              >
                <option value="socks5">SOCKS5</option>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
              </select>
              <input
                className="input"
                type="text"
                value={form.host}
                placeholder="Enter IP or domain"
                onChange={(e) => set('host', e.target.value)}
              />
              <button type="button" className="proxy-mini-button" aria-label="Paste proxy">
                <ClipboardDocumentIcon aria-hidden />
              </button>
              <input
                className="input"
                type="text"
                value={form.port}
                aria-label="Port"
                onChange={(e) => set('port', e.target.value)}
              />
            </div>
          </div>

          <div className="field-grid">
            <label className="field">
              <span className="field__label">Login</span>
              <input
                className="input"
                type="text"
                value={form.login}
                onChange={(e) => set('login', e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">Password</span>
              <input
                className="input"
                type="password"
                value={form.password}
                onChange={(e) => set('password', e.target.value)}
              />
            </label>
          </div>

          <label className="field field--wide">
            <span className="field__label">URL for IP Change</span>
            <input
              className="input"
              type="url"
              value={form.rotateUrl}
              onChange={(e) => set('rotateUrl', e.target.value)}
            />
          </label>

          <button
            type="button"
            className="btn btn--outline modal-check-button"
            onClick={() => {
              void handleCheck();
            }}
            disabled={checking || !canSubmit}
          >
            <ArrowPathIcon aria-hidden />
            {checking ? 'Checking...' : 'Check Proxy'}
          </button>

          {message ? <p className="notice">{message}</p> : null}
        </div>

        <footer className="modal-footer">
          <button type="button" className="btn btn--ghost btn--disabled" disabled>
            <ClipboardDocumentIcon aria-hidden />
            Copy proxy
          </button>
          <div className="modal-footer-actions">
            <button type="button" className="btn btn--secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={!canSubmit || submitting}>
              Confirm
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

export function ProxiesView(): JSX.Element {
  const toast = useToast();
  const [tab, setTab] = useState<ProxyTab>('mine');
  const [showAddProxy, setShowAddProxy] = useState(false);
  const [rows, setRows] = useState<StoredProxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkingIds, setCheckingIds] = useState<ReadonlySet<string>>(() => new Set());

  async function refresh(source: ProxyTab): Promise<void> {
    setLoading(true);
    try {
      setRows(await proxiesClient.list_proxies(source));
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh(tab);
  }, [tab]);

  function setChecking(id: string, on: boolean): void {
    setCheckingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function handleAddProxy(input: CreateStoredProxyInput): Promise<void> {
    const created = await proxiesClient.create_proxy(input);
    if (created.source === tab) setRows((prev) => [created, ...prev]);
    else setTab(created.source);
    toast.success('Proxy added.');
  }

  async function handleCheckProxy(proxy: StoredProxy): Promise<void> {
    setChecking(proxy.id, true);
    setRows((prev) =>
      prev.map((item) => (item.id === proxy.id ? { ...item, status: 'testing' } : item)),
    );
    try {
      const result = await proxiesClient.test_proxy(proxy.id, proxy.config);
      const location = resultLocation(result);
      setRows((prev) =>
        prev.map((item) => {
          if (item.id !== proxy.id) return item;
          const updated: StoredProxy = {
            ...item,
            status: result.ok ? 'ready' : 'error',
            lastCheckedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          if (result.latencyMs !== undefined) updated.latencyMs = result.latencyMs;
          if (location) updated.location = location;
          if (result.geo?.timezone) updated.timezone = result.geo.timezone;
          if (result.error) updated.lastError = result.error;
          else delete updated.lastError;
          return updated;
        }),
      );
      if (result.ok) {
        toast.success(`Proxy OK · ${result.latencyMs ?? 0} ms`);
      } else {
        toast.error(`Proxy failed: ${result.error ?? 'Unknown error'}`);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setRows((prev) =>
        prev.map((item) =>
          item.id === proxy.id ? { ...item, status: 'error', lastError: message } : item,
        ),
      );
      toast.error(`Proxy failed: ${message}`);
    } finally {
      setChecking(proxy.id, false);
    }
  }

  return (
    <section className="page">
      <header className="table-toolbar table-toolbar--simple">
        <div className="toolbar-total">
          <span>Total:</span>
          <strong>{rows.length}</strong>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setShowAddProxy(true)}>
          <PlusIcon aria-hidden />
          Add Proxy
        </button>
      </header>

      <div className="subtabs" role="tablist" aria-label="Proxy categories">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'mine'}
          className={tab === 'mine' ? 'subtab subtab--active' : 'subtab'}
          onClick={() => setTab('mine')}
        >
          My Proxies
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'hive'}
          className={tab === 'hive' ? 'subtab subtab--active' : 'subtab'}
          onClick={() => setTab('hive')}
        >
          Hive Proxy
        </button>
      </div>

      {error ? <p className="notice notice--error">Could not load proxies: {error}</p> : null}
      {loading ? (
        <div className="skeleton-stack" aria-busy="true" aria-label="Loading proxies">
          <Skeleton height={40} />
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
      ) : null}

      {!loading && rows.length === 0 ? (
        <EmptyState
          icon={<ServerStackIcon aria-hidden />}
          title={tab === 'hive' ? 'No Hive proxies yet' : 'No proxies yet'}
          description={
            tab === 'hive'
              ? 'Hive Proxy allocations will appear here once provisioned.'
              : 'Add a SOCKS5 or HTTP(S) proxy to assign it to profiles.'
          }
          action={
            <button type="button" className="btn btn--primary" onClick={() => setShowAddProxy(true)}>
              <PlusIcon aria-hidden />
              Add Proxy
            </button>
          }
        />
      ) : null}

      {!loading && rows.length > 0 ? (
        <div className="data-panel">
          <table className="data-table">
            <thead>
              <tr>
                <th>Proxy</th>
                <th>Type</th>
                <th>Endpoint</th>
                <th>Location</th>
                <th>Timezone</th>
                <th>Latency</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((proxy) => {
                const checking = checkingIds.has(proxy.id);
                const status = statusLabel(proxy, checking);
                return (
                  <tr key={proxy.id}>
                    <td>
                      <div className="table-title">{proxy.label}</div>
                      {proxy.lastError ? (
                        <div className="table-subtitle">{proxy.lastError}</div>
                      ) : null}
                    </td>
                    <td>{typeLabel(proxy.config.type)}</td>
                    <td>{endpointLabel(proxy)}</td>
                    <td>{locationLabel(proxy)}</td>
                    <td>{timezoneLabel(proxy)}</td>
                    <td>{checking ? 'Checking...' : latencyLabel(proxy)}</td>
                    <td>
                      <span className={`status status--${status.toLowerCase()}`}>
                        <span className="status__dot" aria-hidden />
                        {status}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--outline btn--compact"
                        onClick={() => {
                          void handleCheckProxy(proxy);
                        }}
                        disabled={checking}
                      >
                        <ArrowPathIcon aria-hidden />
                        Check
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="info-strip">
        <SignalIcon aria-hidden />
        <span>
          Proxy tests resolve exit IP, latency, timezone, and datacenter warnings through the Rust
          IPC path.
        </span>
      </div>

      {showAddProxy ? (
        <AddProxyModal
          initialTab={tab}
          onAdd={handleAddProxy}
          onCheck={(config) => proxiesClient.test_proxy(null, config)}
          onClose={() => setShowAddProxy(false)}
        />
      ) : null}
    </section>
  );
}
