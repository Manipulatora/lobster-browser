import { XMarkIcon } from '@heroicons/react/24/outline';
import { useState } from 'react';

import type {
  AndroidApiLevel,
  AndroidMachineType,
  CreateMobileMachineInput,
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
 * Island isolation is BUILT IN to every machine (baked into the OS image), so it is presented as an
 * always-on capability the user configures, never installs.
 */
export function NewMachineForm({ proxies, onCreate, onCancel }: NewMachineFormProps): JSX.Element {
  const [name, setName] = useState('');
  const [machineType, setMachineType] = useState<AndroidMachineType>('pixel_8');
  const [apiLevel, setApiLevel] = useState<AndroidApiLevel>(34);
  const [proxyId, setProxyId] = useState('');
  const [playServices, setPlayServices] = useState(true);
  const [freezeIdleApps, setFreezeIdleApps] = useState(true);
  const [isolated, setIsolated] = useState<ReadonlySet<string>>(
    () => new Set(SUGGESTED_ISOLATED_APPS.map((a) => a.pkg)),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleIsolated(pkg: string): void {
    setIsolated((prev) => {
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
          isolateOnInstall: [...isolated],
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
          <legend>Island isolation · built in</legend>
          <p className="field-hint field--wide">
            Every machine ships with Island already in the OS — no Play install needed. Account-holding
            apps are placed in an isolated, sandboxed space so their data can't leak across apps or to
            the main profile. Choose which apps are isolated automatically on install:
          </p>
          <div className="support-grid">
            {SUGGESTED_ISOLATED_APPS.map((app) => (
              <label key={app.pkg} className="check-row">
                <input
                  type="checkbox"
                  checked={isolated.has(app.pkg)}
                  onChange={() => toggleIsolated(app.pkg)}
                />
                <span>{app.label}</span>
              </label>
            ))}
          </div>
          <label className="check-row check-row--field field--wide">
            <input
              type="checkbox"
              checked={freezeIdleApps}
              onChange={(e) => setFreezeIdleApps(e.target.checked)}
            />
            <span>Freeze isolated apps when idle (stop background activity/tracking)</span>
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
