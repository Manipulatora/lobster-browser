import { useState } from 'react';

import { Button, Modal } from '../../ui';

/** The picker's "make a new folder" sentinel — same pattern as the proxy picker's custom value. */
const NEW_FOLDER_VALUE = '__new__';

/**
 * Assign one profile — or a selection of them — to a folder. Offered from the row's ⋮ menu and the
 * bulk bar, because the alternative (opening the full profile editor per profile) does not scale to
 * "file these twelve".
 *
 * A dedicated small dialog rather than another `ActionDialog` case because the choice is a SELECT
 * (existing folder / new folder / no folder) and ActionDialog's input slot is a text field —
 * retyping a folder name you can see on the rail is how "Shopping" and "shopping" become two
 * folders.
 */
export function MoveToFolderDialog({
  label,
  folders,
  currentFolder,
  onMove,
  onClose,
}: {
  /** What is being moved, already phrased ("“Acme US”", "3 profiles"). */
  label: string;
  /** Existing folder names, as derived from the loaded profiles (plus drafts). */
  folders: string[];
  /** Preselected when a single profile is being moved; undefined for mixed/bulk targets. */
  currentFolder?: string;
  /** `''` files the target under no folder. Rejections surface as this dialog's own error. */
  onMove: (folder: string) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const [choice, setChoice] = useState<string>(() =>
    currentFolder && folders.includes(currentFolder) ? currentFolder : '',
  );
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const creating = choice === NEW_FOLDER_VALUE;
  const targetFolder = creating ? newName.trim() : choice;
  const canMove = !busy && (!creating || targetFolder.length > 0);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canMove) return;
    setBusy(true);
    setError(null);
    try {
      await onMove(targetFolder);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      title="Move to folder"
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="move-to-folder-form" variant="primary" disabled={!canMove}>
            {busy ? 'Moving…' : 'Move'}
          </Button>
        </>
      }
    >
      <form id="move-to-folder-form" className="folder-move-form" onSubmit={handleSubmit}>
        <p className="folder-move-form__what">Choose a folder for {label}.</p>
        <label className="lb-field">
          <span className="lb-field__label">Folder</span>
          <select
            className="lb-select"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            autoFocus
          >
            <option value="">No folder</option>
            {folders.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            <option value={NEW_FOLDER_VALUE}>New folder…</option>
          </select>
        </label>
        {creating ? (
          <label className="lb-field">
            <span className="lb-field__label">
              New folder name<span className="lb-field__required">*</span>
            </span>
            <input
              className="lb-input"
              type="text"
              value={newName}
              maxLength={240}
              placeholder="Enter folder name"
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
          </label>
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
