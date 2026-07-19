import { DevicePhoneMobileIcon, PlayIcon, PlusIcon, StopIcon, TrashIcon } from '@heroicons/react/24/outline';
import { useCallback, useEffect, useState } from 'react';

import type { CreateMobileMachineInput, MobileMachine, StoredProxy } from '@lobster/shared-types';

import { mobileMachinesClient, proxiesClient } from '../../api/tauri';
import { EmptyState, useToast } from '../../ui';
import { machineTypeLabel, apiLevelLabel } from './mobileOptions';
import { NewMachineForm } from './NewMachineForm';

const STATUS_LABEL: Record<MobileMachine['status'], string> = {
  stopped: 'Stopped',
  provisioning: 'Provisioning',
  booting: 'Booting',
  running: 'Running',
  stopping: 'Stopping',
  error: 'Error',
};

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Mobile machines workspace — per-profile isolated Android emulators. Provisioning/boot are infra-gated
 * (need a KVM+GPU host); the list/create flow works everywhere via the client (mock in a dev browser).
 */
export function MobileMachinesView(): JSX.Element {
  const toast = useToast();
  const [machines, setMachines] = useState<MobileMachine[]>([]);
  const [proxies, setProxies] = useState<StoredProxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());

  const refresh = useCallback(async () => {
    try {
      setMachines(await mobileMachinesClient.list_machines());
    } catch (e: unknown) {
      toast.error(`Could not load machines: ${errMessage(e)}`);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
    void proxiesClient
      .list_proxies()
      .then(setProxies)
      .catch(() => setProxies([]));
  }, [refresh]);

  function setBusy(id: string, on: boolean): void {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function handleCreate(input: CreateMobileMachineInput): Promise<void> {
    await mobileMachinesClient.create_machine(input);
    setShowForm(false);
    await refresh();
    toast.success(`Created machine “${input.name}”.`);
  }

  async function handleBoot(m: MobileMachine): Promise<void> {
    setBusy(m.id, true);
    try {
      await mobileMachinesClient.boot_machine(m.id);
      await refresh();
      toast.success(`Booting ${m.name}.`);
    } catch (e: unknown) {
      toast.error(`Boot failed: ${errMessage(e)}`);
    } finally {
      setBusy(m.id, false);
    }
  }

  async function handleStop(m: MobileMachine): Promise<void> {
    setBusy(m.id, true);
    try {
      await mobileMachinesClient.stop_machine(m.id);
      await refresh();
      toast.success(`Stopped ${m.name}.`);
    } catch (e: unknown) {
      toast.error(`Stop failed: ${errMessage(e)}`);
    } finally {
      setBusy(m.id, false);
    }
  }

  async function handleDelete(m: MobileMachine): Promise<void> {
    setBusy(m.id, true);
    try {
      await mobileMachinesClient.delete_machine(m.id);
      await refresh();
      toast.success(`Deleted ${m.name}.`);
    } catch (e: unknown) {
      toast.error(`Delete failed: ${errMessage(e)}`);
    } finally {
      setBusy(m.id, false);
    }
  }

  const runningCount = machines.filter((m) => m.status === 'running').length;

  return (
    <section className="page">
      <header className="table-toolbar">
        <div className="toolbar-total">
          <strong>{machines.length}</strong>
          <span>{machines.length === 1 ? 'machine' : 'machines'}</span>
          {runningCount > 0 ? (
            <>
              <span className="toolbar-total__sep" aria-hidden>
                ·
              </span>
              <span className="green-dot" aria-hidden />
              <strong className="toolbar-online">{runningCount}</strong>
              <span>running</span>
            </>
          ) : null}
        </div>
        <div className="toolbar-spacer" style={{ flex: 1 }} />
        <div className="toolbar-actions">
          <button type="button" className="btn btn--primary" onClick={() => setShowForm(true)}>
            <PlusIcon aria-hidden />
            Create machine
          </button>
        </div>
      </header>

      {loading ? (
        <p className="field-hint">Loading machines…</p>
      ) : machines.length === 0 ? (
        <EmptyState
          icon={<DevicePhoneMobileIcon aria-hidden />}
          title="No mobile machines yet"
          description="Create an isolated Android machine — its own device, fingerprint, proxy, and built-in Island isolation."
          action={
            <button type="button" className="btn btn--primary" onClick={() => setShowForm(true)}>
              <PlusIcon aria-hidden />
              Create machine
            </button>
          }
        />
      ) : (
        <div className="tblwrap-scroll" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Machine</th>
                <th>Device</th>
                <th>Status</th>
                <th>Proxy</th>
                <th>Island</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {machines.map((m) => {
                const busy = busyIds.has(m.id);
                const isRunning = m.status === 'running';
                return (
                  <tr key={m.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <DevicePhoneMobileIcon className="table-os-icon" aria-hidden />
                        <strong>{m.name}</strong>
                      </div>
                    </td>
                    <td>
                      {machineTypeLabel(m.config.machineType)}
                      <div className="field-hint">{apiLevelLabel(m.config.apiLevel)}</div>
                    </td>
                    <td>{STATUS_LABEL[m.status]}</td>
                    <td>{m.config.proxyId ? 'Configured' : 'No proxy'}</td>
                    <td>
                      {m.config.island.mode === 'all'
                        ? 'Embedded · all apps'
                        : `Embedded · ${m.config.island.sandboxedApps.length} apps`}
                    </td>
                    <td>
                      <div className="row-actions" style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        {isRunning ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--compact"
                            disabled={busy}
                            onClick={() => void handleStop(m)}
                          >
                            <StopIcon aria-hidden />
                            Stop
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn--secondary btn--compact"
                            disabled={busy}
                            onClick={() => void handleBoot(m)}
                          >
                            <PlayIcon aria-hidden />
                            Boot
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn--ghost btn--compact"
                          disabled={busy || isRunning}
                          aria-label={`Delete ${m.name}`}
                          onClick={() => void handleDelete(m)}
                        >
                          <TrashIcon aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showForm ? (
        <div className="modal-overlay" role="presentation" onMouseDown={(e) => {
          if (e.target === e.currentTarget) setShowForm(false);
        }}>
          <NewMachineForm
            proxies={proxies}
            onCreate={handleCreate}
            onCancel={() => setShowForm(false)}
          />
        </div>
      ) : null}
    </section>
  );
}
