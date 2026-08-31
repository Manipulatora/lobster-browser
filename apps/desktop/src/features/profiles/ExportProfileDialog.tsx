import type { Profile } from '@lobster/shared-types';

import { useId, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';

import { profilesClient, type ProfileFileProgress } from '../../api/tauri';
import { Button, Modal } from '../../ui';

interface ExportProfileDialogProps {
  profile: Profile;
  onClose: () => void;
  onDone: () => void;
}

/** A filename the user can find again, without characters Windows refuses. */
function suggestFilename(name: string): string {
  const safe = name
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
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
  // Streamed live from Rust while the export runs, so a multi-gigabyte session directory is a
  // sequence of named steps rather than a spinner of unknowable length.
  const [progress, setProgress] = useState<ProfileFileProgress | null>(null);
  // The id the CANCEL command addresses. Minted per attempt: the Rust cancellation registry is
  // keyed by it and cleared when the operation ends, so reusing one across attempts could cancel
  // the wrong run.
  const [opId, setOpId] = useState<string | null>(null);
  // The finished export stays ON SCREEN rather than closing silently. A file the user cannot find
  // is indistinguishable from an export that never ran, and the omissions matter more than the
  // success — a file believed complete that quietly left out the proxy login is a support ticket a
  // week later.
  const [done, setDone] = useState<{ path: string; omitted: string[] } | null>(null);

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
    // Cancelling the file picker is a normal outcome, not an error to report. It is also how a
    // picker that failed to OPEN reports itself, which is why the failure above is surfaced rather
    // than folded in here.
    if (!destination) return;

    const runId = crypto.randomUUID();
    setBusy(true);
    setOpId(runId);
    setProgress(null);
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
        setProgress,
        runId,
      );
      setDone({ path: destination, omitted: report.omitted ?? [] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Cancelling is an outcome the user chose, not a failure to report — the Rust side unwinds
      // completely ("nothing was left behind"), so the dialog just returns to its form.
      if (!message.includes('CANCELLED')) setError(message);
    } finally {
      setBusy(false);
      setOpId(null);
      setProgress(null);
    }
  }

  // Finished: show WHERE the file went and anything it could not carry, then let the user dismiss.
  if (done) {
    return (
      <Modal
        open
        onClose={() => onDone()}
        title="Profile exported"
        size="md"
        ariaDescribedBy={descriptionId}
        footer={
          <Button variant="primary" onClick={() => onDone()}>
            Done
          </Button>
        }
      >
        <div className="action-dialog">
          <p id={descriptionId} className="action-dialog__description">
            Saved to
          </p>
          <p className="export-done__path">{done.path}</p>
          {done.omitted.length > 0 ? (
            <p className="notice notice--warn" role="status">
              Not included: {done.omitted.join(', ')}.
            </p>
          ) : null}
        </div>
      </Modal>
    );
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
          {/* While the export runs, Cancel cancels THE OPERATION — the Rust side stops at the next
              step boundary and unwinds — rather than the dialog; closing over a still-running
              export would leave it writing with nobody watching. */}
          <Button
            variant="secondary"
            onClick={() => {
              if (busy && opId) void profilesClient.cancel_profile_file_op(opId);
              else onClose();
            }}
          >
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

        <label className="lb-field" htmlFor={passId}>
          <span className="lb-field__label">Password</span>
          <input
            id={passId}
            className="lb-input"
            type="password"
            value={passphrase}
            autoComplete="new-password"
            autoFocus
            onChange={(event) => setPassphrase(event.target.value)}
          />
          {tooShort ? <span className="lb-field__hint">Use at least 8 characters.</span> : null}
        </label>

        <label className="lb-field" htmlFor={confirmId}>
          <span className="lb-field__label">Confirm password</span>
          <input
            id={confirmId}
            className="lb-input"
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(event) => setConfirm(event.target.value)}
          />
          {mismatch ? <span className="lb-field__hint">These do not match.</span> : null}
        </label>

        {/* Exporting must not be a way around the profile's own lock. */}
        {profile.passwordProtected ? (
          <label className="lb-field" htmlFor={profilePassId}>
            <span className="lb-field__label">This profile&apos;s password</span>
            <input
              id={profilePassId}
              className="lb-input"
              type="password"
              value={profilePassword}
              autoComplete="current-password"
              onChange={(event) => setProfilePassword(event.target.value)}
            />
            <span className="lb-field__hint">
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
              <span className="lb-field__hint">
                {' '}
                — leave this off if you are sending the file to someone else
              </span>
            </span>
          </label>
        ) : null}

        {running ? (
          <p className="notice notice--warn">
            <strong>This profile is running.</strong> Open tabs and extension state will come from
            the last complete capture, or be left out. Stop it first for a complete copy.
          </p>
        ) : null}

        {/* The step Rust is on right now, verbatim. Most phases have no meaningful count (0/0);
            the per-artifact ones append theirs. */}
        {busy && progress ? (
          <p className="notice" role="status" aria-live="polite">
            {progress.detail}
            {progress.total > 0 ? ` (${progress.done}/${progress.total})` : ''}
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
