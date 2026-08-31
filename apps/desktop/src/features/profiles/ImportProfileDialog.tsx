import { useId, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';

import {
  profilesClient,
  type ProfileFileProgress,
  type ProfileImportPreview,
  type ProfileImportReport,
} from '../../api/tauri';
import { Button, Modal } from '../../ui';

interface ImportProfileDialogProps {
  onClose: () => void;
  onImported: (report: ProfileImportReport) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

/**
 * Import a `.lobprofile`.
 *
 * Three steps in one dialog: pick the file, read its PLAINTEXT header and show what it contains,
 * then ask for the passphrase. Describing the file before asking for a password is the whole reason
 * the header is not encrypted — otherwise the user is typing a password for a file they cannot
 * identify.
 */
export function ImportProfileDialog({
  onClose,
  onImported,
}: ImportProfileDialogProps): JSX.Element {
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProfileImportPreview | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Streamed live from Rust while the import runs: unlock, ledger adoption and restore are each a
  // named step rather than one long unexplained wait.
  const [progress, setProgress] = useState<ProfileFileProgress | null>(null);
  // The id the CANCEL command addresses. Minted per attempt — the Rust cancellation registry is
  // keyed by it and cleared when the operation ends, so a reused id could cancel the wrong run.
  const [opId, setOpId] = useState<string | null>(null);

  const passId = useId();
  const descriptionId = useId();

  async function pickFile(): Promise<void> {
    setError(null);
    let picked: string | string[] | null = null;
    try {
      picked = await openFileDialog({
        title: 'Import profile',
        multiple: false,
        filters: [{ name: 'Lobster profile', extensions: ['lobprofile'] }],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!picked || Array.isArray(picked)) return;

    setBusy(true);
    try {
      const info = await profilesClient.inspect_profile_file(picked);
      setPath(picked);
      setPreview(info);
    } catch (err) {
      setPath(null);
      setPreview(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runImport(): Promise<void> {
    if (!path || !preview) return;
    setError(null);
    const runId = crypto.randomUUID();
    setBusy(true);
    setOpId(runId);
    setProgress(null);
    try {
      const report = await profilesClient.import_profile_file(
        path,
        passphrase,
        null,
        setProgress,
        runId,
      );
      onImported(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The Rust side tags the overwhelmingly common failure so the dialog can say the useful
      // thing rather than surfacing an AEAD error. Cancelling is the user's own outcome, not a
      // failure — the operation unwinds completely, so the dialog just returns to its form.
      if (!message.includes('CANCELLED')) {
        setError(
          message.includes('WRONG_PASSPHRASE') ? 'That password does not open this file.' : message,
        );
      }
    } finally {
      setBusy(false);
      setOpId(null);
      setProgress(null);
    }
  }

  const ready = Boolean(path && preview && passphrase.length > 0);

  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      title="Import profile"
      size="md"
      ariaDescribedBy={descriptionId}
      footer={
        <>
          {/* While the import runs, Cancel cancels THE OPERATION — Rust stops at the next step
              boundary and removes the row and directory it created — rather than the dialog;
              closing over a still-running import would leave it restoring with nobody watching. */}
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
            onClick={() => void runImport()}
            loading={busy}
            disabled={!ready || busy}
          >
            Import
          </Button>
        </>
      }
    >
      <form
        className="action-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !busy) void runImport();
        }}
      >
        <p id={descriptionId} className="action-dialog__description">
          Choose a <code>.lobprofile</code> file. Its fingerprint, cookies and logins are restored
          exactly, so the imported copy launches as the same device.
        </p>

        <div className="import-picker">
          <Button variant="secondary" onClick={() => void pickFile()} disabled={busy}>
            {path ? 'Choose a different file' : 'Choose file…'}
          </Button>
          {path ? (
            <span className="import-picker__path cell-ellipsis" title={path}>
              {path}
            </span>
          ) : null}
        </div>

        {preview ? (
          <div className="import-preview">
            <div className="import-preview__name">{preview.profileName}</div>
            <div className="import-preview__meta">
              {preview.os}
              {preview.osVersion ? ` ${preview.osVersion}` : ''} · {preview.engine} · exported{' '}
              {formatDate(preview.exportedAt)} · {preview.artifacts.length} item
              {preview.artifacts.length === 1 ? '' : 's'} · {formatBytes(preview.bytes)}
            </div>
            {preview.alreadyPresent ? (
              <p className="notice notice--warn">
                This profile is already on this machine. Running both copies at once from the same
                machine is the fastest way to link the two accounts.
              </p>
            ) : null}
            {preview.nameCollision ? (
              <p className="notice">
                A profile named “{preview.profileName}” already exists, so the copy will be renamed.
              </p>
            ) : null}
            {preview.hasProxyCredentials ? (
              <p className="notice">This file carries the proxy username and password.</p>
            ) : preview.hasProxy ? (
              <p className="notice">
                This file has proxy settings but no credentials — add them after importing.
              </p>
            ) : null}
            {preview.passwordProtected ? (
              <p className="notice">
                The imported profile stays locked with the password it had when it was exported.
              </p>
            ) : null}
          </div>
        ) : null}

        {preview ? (
          <label className="lb-field" htmlFor={passId}>
            <span className="lb-field__label">File password</span>
            <input
              id={passId}
              className="lb-input"
              type="password"
              value={passphrase}
              autoComplete="current-password"
              autoFocus
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>
        ) : null}

        {/* The step Rust is on right now, verbatim. Most phases carry no meaningful count (0/0);
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
