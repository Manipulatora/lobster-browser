import { Icon } from '../../ui/Icon';

/** One folder as the rail shows it: the label and how many profiles carry it. */
export interface FolderEntry {
  name: string;
  count: number;
}

/**
 * The folder rail across the top of the profiles list: All, then every folder with its count, then
 * the way to make a new one — and, while a folder is selected, the rename/remove affordances for it.
 *
 * A horizontal rail rather than a side column because `.page.profiles-view` is pinned to the
 * viewport with the table pane as its only scroller: a second vertical rail would fight the table
 * for width on the narrow windows the shell already special-cases, while one more slim band above
 * the list (like `.filter-bar`) costs height the pinned layout has to spare.
 *
 * Folders are nothing but string labels on profiles (`Profile.folder`), so the rail is DERIVED —
 * there is no folder entity to fetch, and an empty folder can only exist as UI state (see
 * `draftFolders` in ProfilesView).
 */
export function FolderBar({
  folders,
  totalCount,
  active,
  onSelect,
  onCreate,
  onRename,
  onRemove,
}: {
  folders: FolderEntry[];
  /** Count behind "All" — every profile, foldered or not. */
  totalCount: number;
  /** The selected folder name, or null for All. */
  active: string | null;
  onSelect: (folder: string | null) => void;
  onCreate: () => void;
  onRename: (folder: string) => void;
  onRemove: (folder: string) => void;
}): JSX.Element {
  return (
    <div className="folder-bar" aria-label="Profile folders">
      <button
        type="button"
        className={active === null ? 'folder-tab folder-tab--active' : 'folder-tab'}
        aria-pressed={active === null}
        onClick={() => onSelect(null)}
      >
        <span className="folder-tab__name">All</span>
        <span className="folder-tab__count">{totalCount}</span>
      </button>
      {folders.map((folder) => (
        <button
          key={folder.name}
          type="button"
          className={active === folder.name ? 'folder-tab folder-tab--active' : 'folder-tab'}
          aria-pressed={active === folder.name}
          title={folder.name}
          onClick={() => onSelect(folder.name)}
        >
          <span className="folder-tab__name">{folder.name}</span>
          <span className="folder-tab__count">{folder.count}</span>
        </button>
      ))}
      <button type="button" className="folder-tab folder-tab--new" onClick={onCreate}>
        <Icon name="PlusIcon" aria-hidden />
        <span>New folder</span>
      </button>
      {active !== null ? (
        // Manage controls appear only for the SELECTED folder: a pencil and a bin on every tab
        // would triple the rail's control count for actions that are rare next to switching.
        <span className="folder-bar__manage">
          <button
            type="button"
            className="icon-button icon-button--table"
            aria-label={`Rename folder ${active}`}
            title="Rename folder"
            onClick={() => onRename(active)}
          >
            <Icon name="PencilIcon" aria-hidden />
          </button>
          <button
            type="button"
            className="icon-button icon-button--table"
            aria-label={`Remove folder ${active}`}
            title="Remove folder — its profiles stay, just unfiled"
            onClick={() => onRemove(active)}
          >
            <Icon name="TrashIcon" aria-hidden />
          </button>
        </span>
      ) : null}
    </div>
  );
}
