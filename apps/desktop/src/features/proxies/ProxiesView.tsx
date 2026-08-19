import { useEffect, useState } from 'react';

import type {
  CreateStoredProxyInput,
  ProxyConfig,
  ProxyTestResult,
  ProxyType,
  StoredProxy,
} from '@lobster/shared-types';

import { proxiesClient } from '../../api/tauri';
import { ActionDialog, Button, EmptyState, Modal, Skeleton, useToast } from '../../ui';
import { Icon } from '../../ui/Icon';

interface ProxyFormState {
  title: string;
  type: ProxyType;
  host: string;
  port: string;
  login: string;
  password: string;
  rotateUrl: string;
}

type PendingProxyAction =
  | { kind: 'rename'; proxy: StoredProxy }
  | { kind: 'rotate'; proxy: StoredProxy }
  | { kind: 'delete'; proxy: StoredProxy };

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
  if (proxy.source === 'hive') return 'Managed endpoint';
  return `${proxy.config.host}:${proxy.config.port}`;
}

function locationLabel(proxy: StoredProxy): string {
  return proxy.location ?? 'Not tested';
}

function timezoneLabel(proxy: StoredProxy): string {
  return proxy.timezone ?? 'Not tested';
}

function latencyLabel(proxy: StoredProxy): string {
  return proxy.latencyMs === undefined ? 'Not tested' : `${proxy.latencyMs} ms`;
}

/**
 * NOT TESTED IS NOT A WARNING. Anything that was not `ready`, `error` or `testing` used to fall
 * through to an amber "Warning", so a proxy added thirty seconds ago and never checked announced
 * itself as degraded while every other cell in its own row read "Not tested". Amber is reserved for
 * a proxy that answered badly; a proxy nobody has asked yet gets the neutral pill.
 */
function statusLabel(proxy: StoredProxy, checking: boolean): { label: string; tone: string } {
  if (checking || proxy.status === 'testing') return { label: 'Testing', tone: 'testing' };
  if (proxy.status === 'ready') return { label: 'Ready', tone: 'ready' };
  if (proxy.status === 'error') return { label: 'Error', tone: 'error' };
  if (!proxy.lastCheckedAt) return { label: 'Not tested', tone: 'idle' };
  return { label: 'Warning', tone: 'warning' };
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
  onAdd,
  onCheck,
  onClose,
}: {
  onAdd: (input: CreateStoredProxyInput) => Promise<void>;
  onCheck: (config: ProxyConfig) => Promise<ProxyTestResult>;
  onClose: () => void;
}): JSX.Element {
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
      source: 'mine',
      label: form.title.trim(),
      config,
    };
    const rotateUrl = form.rotateUrl.trim();
    if (rotateUrl) input.rotateUrl = rotateUrl;
    return input;
  }

  async function pasteProxy(): Promise<void> {
    try {
      const raw = (await navigator.clipboard.readText()).trim();
      if (!raw) {
        setMessage('The clipboard is empty.');
        return;
      }
      const normalized = raw.includes('://') ? raw : `socks5://${raw}`;
      const parsed = new URL(normalized);
      if (!parsed.hostname || !parsed.port) throw new Error('Missing host or port');
      setForm((previous) => ({
        ...previous,
        type:
          parsed.protocol === 'http:' ? 'http' : parsed.protocol === 'https:' ? 'https' : 'socks5',
        host: parsed.hostname,
        port: parsed.port,
        login: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        title: previous.title || parsed.hostname,
      }));
      setMessage('Proxy details pasted.');
    } catch {
      setMessage('Could not read a proxy URL from the clipboard.');
    }
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
    <Modal
      open
      onClose={submitting ? () => undefined : onClose}
      title="Add proxy"
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
              form="add-proxy-form"
              variant="primary"
              disabled={!canSubmit || submitting}
            >
              {submitting ? 'Adding…' : 'Add proxy'}
            </Button>
          </div>
        </>
      }
    >
      <form
        id="add-proxy-form"
        className="proxy-form-body"
        onSubmit={handleSubmit}
        aria-label="Proxy details"
      >
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
            <select
              className="lb-select"
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
              title="Paste a full proxy URL"
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
              onChange={(e) => set('login', e.target.value)}
            />
          </label>
          <label className="lb-field">
            <span className="lb-field__label">Password</span>
            <input
              className="lb-input"
              type="password"
              value={form.password}
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

export function ProxiesView(): JSX.Element {
  const toast = useToast();
  const [showAddProxy, setShowAddProxy] = useState(false);
  const [rows, setRows] = useState<StoredProxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkingIds, setCheckingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingAction, setPendingAction] = useState<PendingProxyAction | null>(null);
  const [actionInput, setActionInput] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      setRows(await proxiesClient.list_proxies('mine'));
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
    setRows((prev) => [created, ...prev]);
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

  async function renameProxy(proxy: StoredProxy, value: string): Promise<void> {
    const label = value.trim();
    if (!label || label === proxy.label) return;
    try {
      const updated = await proxiesClient.update_proxy(proxy.id, { label });
      setRows((previous) => previous.map((item) => (item.id === proxy.id ? updated : item)));
      toast.success('Proxy updated.');
    } catch (e: unknown) {
      toast.error(`Proxy update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleRotateProxy(proxy: StoredProxy): Promise<void> {
    setPendingAction({ kind: 'rotate', proxy });
  }

  async function rotateProxy(proxy: StoredProxy): Promise<void> {
    try {
      await proxiesClient.rotate_proxy(proxy.id);
      toast.success('Proxy rotation requested.');
      await handleCheckProxy(proxy);
    } catch (e: unknown) {
      toast.error(`Proxy rotation failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleDeleteProxy(proxy: StoredProxy): Promise<void> {
    setPendingAction({ kind: 'delete', proxy });
  }

  async function deleteProxy(proxy: StoredProxy): Promise<void> {
    try {
      await proxiesClient.delete_proxy(proxy.id);
      setRows((previous) => previous.filter((item) => item.id !== proxy.id));
      toast.success('Proxy deleted.');
    } catch (e: unknown) {
      toast.error(`Proxy delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function handleRenameProxy(proxy: StoredProxy): void {
    setActionInput(proxy.label);
    setPendingAction({ kind: 'rename', proxy });
  }

  async function confirmProxyAction(): Promise<void> {
    const action = pendingAction;
    if (!action) return;
    setActionBusy(true);
    try {
      if (action.kind === 'rename') await renameProxy(action.proxy, actionInput);
      if (action.kind === 'rotate') await rotateProxy(action.proxy);
      if (action.kind === 'delete') await deleteProxy(action.proxy);
      setPendingAction(null);
      setActionInput('');
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <section className="page">
      <header className="table-toolbar table-toolbar--simple">
        <div className="toolbar-total">
          <strong>{rows.length}</strong>
          <span>{rows.length === 1 ? 'proxy' : 'proxies'}</span>
        </div>
        <Button
          variant="primary"
          leadingIcon={<Icon name="PlusIcon" aria-hidden />}
          onClick={() => setShowAddProxy(true)}
        >
          Add Proxy
        </Button>
      </header>

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
          icon={<Icon name="ServerStackIcon" aria-hidden />}
          title="No proxies yet"
          action={
            <Button
              variant="primary"
              leadingIcon={<Icon name="PlusIcon" aria-hidden />}
              onClick={() => setShowAddProxy(true)}
            >
              Add Proxy
            </Button>
          }
        />
      ) : null}

      {!loading && rows.length > 0 ? (
        <div className="data-panel">
          {/* Eight columns of short, known-shape values. Left to `table-layout: auto` the browser
              gives width to whichever row happens to have the longest string, so one long hostname
              squeezed Location into a three-line wrap. Fixed widths keep the row one line tall. */}
          <table className="data-table proxies-table">
            <thead>
              <tr>
                <th>Proxy</th>
                <th>Type</th>
                <th>Endpoint</th>
                <th>Location</th>
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
                    {/* host:port is one token to a reader and must not break across lines; it wrapped
                        as "us-" / "east.proxy.local:9443", which reads as two different addresses.
                        Nowrap comes from the table rule; `title` gives back the full value when the
                        column is too narrow for it. */}
                    <td title={endpointLabel(proxy)}>{endpointLabel(proxy)}</td>
                    {/* LOCATION AND TIMEZONE ARE ONE FACT — where this proxy comes out — and they
                        were two columns. Eight columns do not fit 976px without something wrapping
                        to three lines or being clipped, and the fix is not narrower columns but
                        fewer. Stacked here in the same title/subtitle pattern the Proxy column
                        already uses. */}
                    <td>
                      <div className="table-title">{locationLabel(proxy)}</div>
                      <div className="table-subtitle">{timezoneLabel(proxy)}</div>
                    </td>
                    <td>{checking ? 'Checking...' : latencyLabel(proxy)}</td>
                    <td>
                      <span className={`status status--${status.tone}`}>
                        <span className="status__dot" aria-hidden />
                        {status.label}
                      </span>
                    </td>
                    <td>
                      <div className="proxy-row-actions">
                        <Button
                          size="sm"
                          onClick={() => void handleCheckProxy(proxy)}
                          disabled={checking}
                        >
                          Check
                        </Button>
                        {proxy.rotateUrl ? (
                          <Button
                            size="sm"
                            leadingIcon={<Icon name="ArrowPathIcon" aria-hidden />}
                            onClick={() => void handleRotateProxy(proxy)}
                            disabled={checking}
                          >
                            Rotate
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleRenameProxy(proxy)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="lb-btn--danger-hover"
                          onClick={() => void handleDeleteProxy(proxy)}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {showAddProxy ? (
        <AddProxyModal
          onAdd={handleAddProxy}
          onCheck={(config) => proxiesClient.test_proxy(null, config)}
          onClose={() => setShowAddProxy(false)}
        />
      ) : null}
      <ActionDialog
        open={pendingAction !== null}
        title={
          pendingAction?.kind === 'rename'
            ? 'Rename proxy'
            : pendingAction?.kind === 'rotate'
              ? 'Rotate proxy?'
              : 'Delete proxy?'
        }
        description={
          pendingAction?.kind === 'rename'
            ? 'Choose a clear label for this stored proxy.'
            : pendingAction?.kind === 'rotate'
              ? `Request a new exit IP for “${pendingAction.proxy.label}”, then test the connection.`
              : `Remove “${pendingAction?.proxy.label ?? 'this proxy'}” from Lobster Browser. Profiles using it may require a replacement.`
        }
        confirmLabel={
          pendingAction?.kind === 'rename'
            ? 'Save name'
            : pendingAction?.kind === 'rotate'
              ? 'Rotate proxy'
              : 'Delete proxy'
        }
        busy={actionBusy}
        destructive={pendingAction?.kind === 'delete'}
        input={
          pendingAction?.kind === 'rename'
            ? {
                label: 'Proxy name',
                value: actionInput,
                onChange: setActionInput,
                required: true,
              }
            : undefined
        }
        onConfirm={() => {
          void confirmProxyAction();
        }}
        onClose={() => {
          setPendingAction(null);
          setActionInput('');
        }}
      />
    </section>
  );
}
