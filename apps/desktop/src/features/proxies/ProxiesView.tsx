import { useEffect, useState } from 'react';

import type { ProxyConfig, ProxyTestResult, ProxyType, StoredProxy } from '@lobster/shared-types';

import { proxiesClient } from '../../api/tauri';
import { ActionDialog, Button, EmptyState, Skeleton, useErrorModal } from '../../ui';
import { Icon } from '../../ui/Icon';
import { RowMenu } from '../../ui/RowMenu';
import type { RowMenuItem } from '../../ui/RowMenu';
import { ImportProxiesDialog } from './ImportProxiesDialog';
import { ProxyDialog } from './ProxyDialog';
import type { ProxyDraft } from './ProxyDialog';

type PendingProxyAction =
  { kind: 'rotate'; proxy: StoredProxy } | { kind: 'delete'; proxy: StoredProxy };

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

/** Everything the last check learned about where this proxy comes out, for the cell that shows it. */
function exitDetail(proxy: StoredProxy): string | undefined {
  const parts = [proxy.location, proxy.timezone, proxy.asn].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * NOT TESTED IS NOT A WARNING. Anything that was not `ready`, `error` or `testing` used to fall
 * through to an amber "Warning", so a proxy added thirty seconds ago and never checked announced
 * itself as degraded while every other cell in its own row read "Not tested". Amber is reserved for
 * a proxy that answered badly; a proxy nobody has asked yet gets the neutral pill.
 *
 * And what "answered badly" MEANS is worth naming in the row rather than leaving to a hover: an exit
 * IP in a hosting range is the difference between a profile that passes for a household and one that
 * announces itself as a server, which is the whole business this product is in.
 */
function statusLabel(
  proxy: StoredProxy,
  checking: boolean,
): { label: string; tone: string; detail?: string } {
  if (checking || proxy.status === 'testing') return { label: 'Testing', tone: 'testing' };
  if (proxy.status === 'error') {
    const detail = proxy.lastError;
    return detail ? { label: 'Error', tone: 'error', detail } : { label: 'Error', tone: 'error' };
  }
  if (proxy.status === 'warning') {
    return proxy.isDatacenter
      ? {
          label: 'Datacenter',
          tone: 'warning',
          detail: `The exit IP is in a hosting range${proxy.asn ? ` (${proxy.asn})` : ''}.`,
        }
      : { label: 'Warning', tone: 'warning' };
  }
  if (proxy.status === 'ready') {
    return proxy.asn
      ? { label: 'Ready', tone: 'ready', detail: proxy.asn }
      : { label: 'Ready', tone: 'ready' };
  }
  return { label: 'Not tested', tone: 'idle' };
}

function resultLocation(result: ProxyTestResult): string | undefined {
  const geo = result.geo;
  if (!geo) return undefined;
  return [geo.countryCode, geo.region, geo.city].filter(Boolean).join(' · ');
}

export function ProxiesView(): JSX.Element {
  const { showError } = useErrorModal();
  const [showAddProxy, setShowAddProxy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editing, setEditing] = useState<StoredProxy | null>(null);
  const [rows, setRows] = useState<StoredProxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkingIds, setCheckingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingAction, setPendingAction] = useState<PendingProxyAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  // EVERY SOURCE, not just `mine`. Hive proxies are selectable in the template and profile pickers,
  // so a screen that hides them offers no way to see — let alone manage — a proxy the rest of the
  // app is already binding profiles to.
  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      setRows(await proxiesClient.list_proxies());
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

  async function handleAddProxy(draft: ProxyDraft): Promise<void> {
    const created = await proxiesClient.create_proxy({
      source: 'mine',
      label: draft.label,
      config: draft.config,
      ...(draft.rotateUrl ? { rotateUrl: draft.rotateUrl } : {}),
    });
    setRows((prev) => [created, ...prev]);
  }

  async function handleSaveProxy(proxy: StoredProxy, draft: ProxyDraft): Promise<void> {
    const updated = await proxiesClient.update_proxy(proxy.id, {
      label: draft.label,
      config: draft.config,
      // Sent even when empty: that is how the store is told to drop a rotation URL.
      rotateUrl: draft.rotateUrl,
    });
    setRows((prev) => prev.map((item) => (item.id === proxy.id ? updated : item)));
  }

  async function handleImportProxies(
    configs: ProxyConfig[],
  ): Promise<Array<{ label: string; error: string }>> {
    const created: StoredProxy[] = [];
    const failures: Array<{ label: string; error: string }> = [];
    for (const config of configs) {
      const label = `${config.host}:${config.port}`;
      try {
        created.push(
          await proxiesClient.create_proxy({
            source: 'mine',
            label,
            config: { ...config, label },
          }),
        );
      } catch (e: unknown) {
        failures.push({ label, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (created.length > 0) {
      setRows((prev) => [...[...created].reverse(), ...prev]);
    }
    if (failures.length > 0) {
      showError('Proxy import failed to complete');
    }
    return failures;
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
          const datacenter = result.geo?.isDatacenter === true;
          const updated: StoredProxy = {
            ...item,
            status: result.ok ? (datacenter ? 'warning' : 'ready') : 'error',
            lastCheckedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          if (result.latencyMs !== undefined) updated.latencyMs = result.latencyMs;
          if (location) updated.location = location;
          if (result.geo?.timezone) updated.timezone = result.geo.timezone;
          if (result.geo?.asn) updated.asn = result.geo.asn;
          if (result.geo) updated.isDatacenter = datacenter;
          if (result.error) updated.lastError = result.error;
          else delete updated.lastError;
          return updated;
        }),
      );
      if (result.ok) {
      } else {
        showError('Proxy failed to connect', result.error);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setRows((prev) =>
        prev.map((item) =>
          item.id === proxy.id ? { ...item, status: 'error', lastError: message } : item,
        ),
      );
      showError('Proxy failed to connect', message);
    } finally {
      setChecking(proxy.id, false);
    }
  }

  async function rotateProxy(proxy: StoredProxy): Promise<void> {
    try {
      await proxiesClient.rotate_proxy(proxy.id);
      await handleCheckProxy(proxy);
    } catch (e: unknown) {
      showError('Proxy failed to rotate', e);
    }
  }

  async function deleteProxy(proxy: StoredProxy): Promise<void> {
    try {
      await proxiesClient.delete_proxy(proxy.id);
      setRows((previous) => previous.filter((item) => item.id !== proxy.id));
    } catch (e: unknown) {
      showError('Proxy failed to delete', e);
    }
  }

  async function confirmProxyAction(): Promise<void> {
    const action = pendingAction;
    if (!action) return;
    setActionBusy(true);
    try {
      if (action.kind === 'rotate') await rotateProxy(action.proxy);
      if (action.kind === 'delete') await deleteProxy(action.proxy);
      setPendingAction(null);
    } finally {
      setActionBusy(false);
    }
  }

  function rowActions(proxy: StoredProxy): RowMenuItem[] {
    const items: RowMenuItem[] = [];
    if (proxy.rotateUrl) {
      items.push({
        label: 'Rotate IP',
        onSelect: () => setPendingAction({ kind: 'rotate', proxy }),
      });
    }
    items.push({
      label: 'Edit proxy',
      onSelect: () => setEditing(proxy),
      disabled: proxy.source === 'hive',
      ...(proxy.source === 'hive'
        ? { title: 'Hive proxies are managed for you and cannot be edited here.' }
        : {}),
    });
    items.push({
      label: 'Delete proxy',
      danger: true,
      onSelect: () => setPendingAction({ kind: 'delete', proxy }),
    });
    return items;
  }

  return (
    <section className="page">
      <header className="table-toolbar table-toolbar--simple">
        <div className="toolbar-total">
          <strong>{rows.length}</strong>
          <span>{rows.length === 1 ? 'proxy' : 'proxies'}</span>
        </div>
        <div className="toolbar-actions">
          <Button
            leadingIcon={<Icon name="ArrowDownTrayIcon" aria-hidden />}
            onClick={() => setShowImport(true)}
          >
            Import
          </Button>
          <Button
            variant="primary"
            leadingIcon={<Icon name="PlusIcon" aria-hidden />}
            onClick={() => setShowAddProxy(true)}
          >
            Add Proxy
          </Button>
        </div>
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
          {/* Seven columns of short, known-shape values. Left to `table-layout: auto` the browser
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
                      <div className="table-title">
                        {proxy.label}
                        {proxy.source === 'hive' ? <span className="tag">Hive</span> : null}
                      </div>
                      {proxy.unreadableSecrets?.length ? (
                        <div className="table-subtitle text-danger">
                          Credentials unreadable on this machine
                        </div>
                      ) : proxy.lastError ? (
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
                    <td title={exitDetail(proxy)}>
                      <div className="table-title">{locationLabel(proxy)}</div>
                      <div className="table-subtitle">{timezoneLabel(proxy)}</div>
                    </td>
                    <td>{latencyLabel(proxy)}</td>
                    <td>
                      <span className={`status status--${status.tone}`} title={status.detail}>
                        <span className="status__dot" aria-hidden />
                        {status.label}
                      </span>
                    </td>
                    <td>
                      <div className="table-actions">
                        <Button
                          size="sm"
                          onClick={() => void handleCheckProxy(proxy)}
                          disabled={checking}
                        >
                          Check
                        </Button>
                        <RowMenu
                          label={`More actions for ${proxy.label}`}
                          items={rowActions(proxy)}
                        />
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
        <ProxyDialog
          onSubmit={handleAddProxy}
          onCheck={(config) => proxiesClient.test_proxy(null, config)}
          onClose={() => setShowAddProxy(false)}
        />
      ) : null}
      {editing ? (
        <ProxyDialog
          proxy={editing}
          onSubmit={(draft) => handleSaveProxy(editing, draft)}
          // A null id tests the form's own values rather than the stored ones, so a change can be
          // checked before it is saved.
          onCheck={(config) => proxiesClient.test_proxy(null, config)}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {showImport ? (
        <ImportProxiesDialog onImport={handleImportProxies} onClose={() => setShowImport(false)} />
      ) : null}
      <ActionDialog
        open={pendingAction !== null}
        title={pendingAction?.kind === 'rotate' ? 'Rotate proxy?' : 'Delete proxy?'}
        description={
          pendingAction?.kind === 'rotate'
            ? `Request a new exit IP for “${pendingAction.proxy.label}”, then test the connection.`
            : `Remove “${pendingAction?.proxy.label ?? 'this proxy'}” from Lobster Browser. Profiles using it may require a replacement.`
        }
        confirmLabel={pendingAction?.kind === 'rotate' ? 'Rotate proxy' : 'Delete proxy'}
        busy={actionBusy}
        destructive={pendingAction?.kind === 'delete'}
        onConfirm={() => {
          void confirmProxyAction();
        }}
        onClose={() => setPendingAction(null)}
      />
    </section>
  );
}
