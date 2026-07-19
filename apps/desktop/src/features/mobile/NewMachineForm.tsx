import { XMarkIcon } from '@heroicons/react/24/outline';
import { useState } from 'react';

import type {
  AndroidApiLevel,
  AndroidMachineType,
  CreateMobileMachineInput,
  IslandSandboxMode,
  StoredProxy,
} from '@lobster/shared-types';

import { API_LEVEL_OPTIONS, MACHINE_TYPE_OPTIONS, SUGGESTED_ISOLATED_APPS } from './mobileOptions';

interface NewMachineFormProps {
  proxies: StoredProxy[];
  onCreate: (input: CreateMobileMachineInput) => Promise<void>;
  onCancel: () => void;
}

/**
 * Create an Android machine: device class + Android version + fingerprint (auto-seeded) + proxy.
 * Island sandboxing is EMBEDDED IN THE OS (the Lobium Android framework), so it is presented as an
 * always-on capability the user shapes — never installs. In the default `all` mode every app the
 * machine ever installs runs in its own sandbox; `selected` narrows that to specific packages.
 */
export function NewMachineForm({ proxies, onCreate, onCancel }: NewMachineFormProps): JSX.Element {
  const [name, setName] = useState('');
  const [machineType, setMachineType] = useState<AndroidMachineType>('pixel_8');
  const [apiLevel, setApiLevel] = useState<AndroidApiLevel>(34);
  const [proxyId, setProxyId] = useState('');
  const [playServices, setPlayServices] = useState(true);
  const [sandboxMode, setSandboxMode] = useState<IslandSandboxMode>('all');
  const [perApp, setPerApp] = useState(true);
  const [freezeIdleApps, setFreezeIdleApps] = useState(true);
  const [sandboxed, setSandboxed] = useState<ReadonlySet<string>>(
    () => new Set(SUGGESTED_ISOLATED_APPS.map((a) => a.pkg)),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleSandboxed(pkg: string): void {
    setSandboxed((prev) => {
      const next = new Set(prev);
      if (next.has(pkg)) next.delete(pkg);
      else next.add(pkg);
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    if (!name.trim()) {
      setError('Enter a machine name.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        machineType,
        apiLevel,
        playServices,
        ...(proxyId ? { proxyId } : {}),
        island: {
          mode: sandboxMode,
          sandboxedApps: sandboxMode === 'selected' ? [...sandboxed] : [],
          isolation: perApp ? 'per-app' : 'shared',
          freezeIdleApps,
        },
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <form
      className="wizard modal"
      onSubmit={handleSubmit}
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-machine-title"
      noValidate
    >
      <header className="modal-header">
        <h2 id="new-machine-title">New mobile machine</h2>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="Close">
          <XMarkIcon aria-hidden />
        </button>
      </header>

      <div className="modal-body wizard-body">
        <div className="field-grid">
          <label className="field field--wide">
            <span className="field__label">
              <span className="required">*</span> Machine name
            </span>
            <input
              className="input"
              type="text"
              value={name}
              maxLength={120}
              placeholder="e.g. Marketing phone 1"
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>

          <label className="field">
            <span className="field__label">Device</span>
            <select
              className="input"
              value={machineType}
              onChange={(e) => setMachineType(e.target.value as AndroidMachineType)}
            >
              {MACHINE_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">Android version</span>
            <select
              className="input"
              value={apiLevel}
              onChange={(e) => setApiLevel(Number(e.target.value) as AndroidApiLevel)}
            >
              {API_LEVEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field field--wide">
            <span className="field__label">Proxy</span>
            <select className="input" value={proxyId} onChange={(e) => setProxyId(e.target.value)}>
              <option value="">No proxy</option>
              {proxies.map((proxy) => (
                <option key={proxy.id} value={proxy.id}>
                  {proxy.label} · {proxy.config.host}:{proxy.config.port}
                </option>
              ))}
            </select>
            <span className="field-hint">
              The machine's fingerprint (build.prop, GPU, sensors, IMEI/serial) is auto-generated from a
              unique per-machine seed and kept coherent with the proxy geo.
            </span>
          </label>

          <label className="check-row check-row--field field--wide">
            <input
              type="checkbox"
              checked={playServices}
              onChange={(e) => setPlayServices(e.target.checked)}
            />
            <span>Include Google Play (install apps from the Play Store)</span>
          </label>
        </div>

        <fieldset className="fp-inline-group">
          <legend>Island sandbox · embedded in the OS</legend>
          <p className="field-hint field--wide">
            Sandboxing is part of the machine's operating system — there is nothing to install. When an
            app is installed, the OS drops it into an isolated Android profile of its own, so its
            accounts, cookies and storage can't be correlated with other apps or the main space.
          </p>
          <div className="radio-group field--wide" role="radiogroup" aria-label="What gets sandboxed">
            <label className="check-row">
              <input
                type="radio"
                name="sandbox-mode"
                checked={sandboxMode === 'all'}
                onChange={() => setSandboxMode('all')}
              />
              <span>Sandbox every app on install (default)</span>
            </label>
            <label className="check-row">
              <input
                type="radio"
                name="sandbox-mode"
                checked={sandboxMode === 'selected'}
                onChange={() => setSandboxMode('selected')}
              />
              <span>Only sandbox selected apps</span>
            </label>
          </div>
          {sandboxMode === 'selected' ? (
            <div className="support-grid">
              {SUGGESTED_ISOLATED_APPS.map((app) => (
                <label key={app.pkg} className="check-row">
                  <input
                    type="checkbox"
                    checked={sandboxed.has(app.pkg)}
                    onChange={() => toggleSandboxed(app.pkg)}
                  />
                  <span>{app.label}</span>
                </label>
              ))}
            </div>
          ) : null}
          <label className="check-row check-row--field field--wide">
            <input type="checkbox" checked={perApp} onChange={(e) => setPerApp(e.target.checked)} />
            <span>One isolated profile per app (strongest — apps can't see each other)</span>
          </label>
          <label className="check-row check-row--field field--wide">
            <input
              type="checkbox"
              checked={freezeIdleApps}
              onChange={(e) => setFreezeIdleApps(e.target.checked)}
            />
            <span>Freeze sandboxed apps when idle (stop background activity/tracking)</span>
          </label>
        </fieldset>

        {error ? (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <footer className="modal-footer">
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create machine'}
        </button>
      </footer>
    </form>
  );
}
