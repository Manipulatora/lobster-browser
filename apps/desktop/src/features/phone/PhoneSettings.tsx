import { useState } from 'react';

import { Button, Input } from '../../ui';
import { getPhoneConfig, savePhoneConfig, type PhoneConfig } from './phoneApi';

/**
 * First-run connect gate. The Phone feature talks to the backend Twilio broker; the operator enters
 * its public URL + the static access token (PHONE_ACCESS_TOKEN) once. Stored in localStorage — the
 * token is the operator's own and never leaves the machine except as a bearer header to their backend.
 */
export function PhoneSettings({ onSaved }: { onSaved: () => void }): JSX.Element {
  const existing = getPhoneConfig();
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [accessToken, setAccessToken] = useState(existing?.accessToken ?? '');
  const [error, setError] = useState<string | null>(null);

  function save(e: React.FormEvent): void {
    e.preventDefault();
    const url = baseUrl.trim();
    if (!/^https?:\/\//.test(url)) {
      setError('Enter the backend URL (https://…).');
      return;
    }
    if (!accessToken.trim()) {
      setError('Enter the access token.');
      return;
    }
    const config: PhoneConfig = { baseUrl: url, accessToken: accessToken.trim() };
    savePhoneConfig(config);
    onSaved();
  }

  return (
    <div className="phone-connect">
      <form className="phone-connect__card" onSubmit={save}>
        <h2>Connect Phone</h2>
        <p className="field-hint">
          Point the app at your Phone backend (the Twilio broker) and paste its access token. You can
          change these later from the header.
        </p>
        <Input
          label="Backend URL"
          placeholder="https://158-220-91-217.nip.io"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          autoFocus
        />
        <Input
          label="Access token"
          type="password"
          placeholder="PHONE_ACCESS_TOKEN"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
        />
        {error ? (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary">
          Connect
        </Button>
      </form>
    </div>
  );
}
