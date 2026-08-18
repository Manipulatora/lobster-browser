import type { Profile } from '@lobster/shared-types';

import { useId, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';

import { profilesClient, type ProfileExportReport } from '../../api/tauri';
import { Button, Modal } from '../../ui';

interface ExportProfileDialogProps {
  profile: Profile;
  onClose: () => void;
  onDone: (report: ProfileExportReport) => void;
}

/** A filename the user can find again, without characters Windows refuses. */
function suggestFilename(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  return `${safe || 'profile'}.lobprofile`;
}

/**
 * Export one profile to a single encrypted file.
 *
 * Uses {@link Modal} rather than `ActionDialog`, which takes exactly one input — this needs two
 * passwords, a checkbox and a conditional warning.
 */
export function ExportProfileDialog({
  profile,
  onClose,
  onDone,
}: ExportProfileDialogProps): JSX.Element {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [profilePassword, setProfilePassword] = useState('');
  const [includeProxyCredentials, setIncludeProxyCredentials] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passId = useId();
  const confirmId = useId();
  const profilePassId = useId();
  const descriptionId = useId();

  const running = profile.status === 'running';
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  // Short enough to type, long enough that Argon2id makes an offline run genuinely expensive.
  const tooShort = passphrase.length > 0 && passphrase.length < 8;
  const ready =
    passphrase.length >= 8 &&
    confirm === passphrase &&
    (!profile.passwordProtected || profilePassword.length > 0);

  async function handleExport(): Promise<void> {
    setError(null);
    let destination: string | null = null;
    try {
      destination = await save({
        title: 'Export profile',
        defaultPath: suggestFilename(profile.name),
        filters: [{ name: 'Lobster profile', extensions: ['lobprofile'] }],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    // Cancelling the file picker is a normal outcome, not an error to report.
    if (!destination) return;

    setBusy(true);
    try {
      const report = await profilesClient.export_profile_file(
        profile.id,
        destination,
        passphrase,
        profile.passwordProtected ? profilePassword : null,
        {
          includeProxyCredentials,
          // A running browser is still writing; `live` says so in the manifest rather than
          // pretending the capture was coherent.
          capture: running ? 'live' : 'quiesced',
        },
      );
      onDone(report);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      title={`Export “${profile.name}”`}
      size="md"
      ariaDescribedBy={descriptionId}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleExport()}
            loading={busy}
            disabled={!ready || busy}
          >
            Choose location and export
          </Button>
        </>
      }
    >
      <form
        className="action-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !busy) void handleExport();
        }}
      >
        <p id={descriptionId} className="action-dialog__description">
          This file contains the profile&apos;s fingerprint, cookies, logins and site data. Anyone
          with the file and its password can sign in as this profile.
        </p>

        <label className="field" htmlFor={passId}>
          <span className="field__label">Password</span>
          <input
            id={passId}
            className="input"
            type="password"
            value={passphrase}
            autoComplete="new-password"
            autoFocus
            onChange={(event) => setPassphrase(event.target.value)}
          />
          {tooShort ? <span className="field__hint">Use at least 8 characters.</span> : null}
        </label>

        <label className="field" htmlFor={confirmId}>
          <span className="field__label">Confirm password</span>
          <input
            id={confirmId}
            className="input"
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(event) => setConfirm(event.target.value)}
          />
          {mismatch ? <span className="field__hint">These do not match.</span> : null}
        </label>

        {/* Exporting must not be a way around the profile's own lock. */}
        {profile.passwordProtected ? (
          <label className="field" htmlFor={profilePassId}>
            <span className="field__label">This profile&apos;s password</span>
            <input
              id={profilePassId}
              className="input"
              type="password"
              value={profilePassword}
              autoComplete="current-password"
              onChange={(event) => setProfilePassword(event.target.value)}
            />
            <span className="field__hint">
              Required because this profile is locked. The copy stays locked with the same password.
            </span>
          </label>
        ) : null}

        {profile.proxy || profile.proxyId ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={includeProxyCredentials}
              onChange={(event) => setIncludeProxyCredentials(event.target.checked)}
            />
            <span>
              Include the proxy username and password
              <span className="field__hint"> — leave this off if you are sending the file to someone else</span>
            </span>
          </label>
        ) : null}

        {running ? (
          <p className="notice notice--warn">
            <strong>This profile is running.</strong> Open tabs and extension state will come from
            the last complete capture, or be left out. Stop it first for a complete copy.
          </p>
        ) : null}

        {error ? (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
