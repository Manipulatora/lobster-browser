import { useEffect, useMemo, useRef, useState } from 'react';
import {
  EllipsisHorizontalIcon,
  FunnelIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  PlusIcon,
  StopIcon,
  TrashIcon,
  UserGroupIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';

import type {
  CreateProfileInput,
  EngineKind,
  OsFamily,
  Profile,
  ProfileTemplate,
  ProfileStatus,
  StoredProxy,
} from '@lobster/shared-types';

import {
  proxiesClient,
  templatesClient,
  type LaunchInfo,
  type ProfilePatch,
} from '../../api/tauri';
import { LaunchPanel } from '../automation/LaunchPanel';
import { FingerprintEditor } from '../fingerprint/FingerprintEditor';
import {
  isOnboarded,
  markOnboarded,
  OnboardingModal,
} from '../onboarding/OnboardingModal';
import { t } from '../../i18n';
import { Button, EmptyState, Skeleton, useToast } from '../../ui';
import { EditProfileForm } from './EditProfileForm';
import { NewProfileForm } from './NewProfileForm';
import { ENGINE_OPTIONS, OS_OPTIONS, STATUS_META } from './options';
import { ProfileList, type ProfileSortKey, type SortDir } from './ProfileList';
import { TrashModal } from './TrashModal';
import { useProfiles } from './useProfiles';

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isLive(status: Profile['status']): boolean {
  return status === 'running' || status === 'launching' || status === 'stopping';
}

function proxySortKey(profile: Profile): string {
  if (!profile.proxy) return '';
  return profile.proxy.label ?? `${profile.proxy.host}:${profile.proxy.port}`;
}

/**
 * The Profiles workspace: list of profiles with create / clone / delete / launch / stop
 * actions, and a modal fingerprint editor. Backed by {@link useProfiles} (real Tauri commands
 * in the desktop shell, an in-memory mock in a dev browser).
 */
export function ProfilesView({
  createProfileSignal = 0,
}: {
  createProfileSignal?: number;
} = {}): JSX.Element {
  const toast = useToast();
  const {
    profiles,
    loading,
    error,
    create,
    clone,
    update,
    moveToTrash,
    listTrash,
    restore,
    permanentlyDelete,
    setPassword,
    launch,
    stop,
  } = useProfiles();

  const [showForm, setShowForm] = useState(false);
  const [showToolbarMenu, setShowToolbarMenu] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [engineFilter, setEngineFilter] = useState<'all' | EngineKind>('all');
  const [osFilter, setOsFilter] = useState<'all' | OsFamily>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | ProfileStatus>('all');
  const [proxyFilter, setProxyFilter] = useState<'all' | 'with' | 'without'>('all');
  const [tagFilter, setTagFilter] = useState('');
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [trashProfiles, setTrashProfiles] = useState<Profile[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [trashBusyIds, setTrashBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [launchInfo, setLaunchInfo] = useState<ReadonlyMap<string, LaunchInfo>>(() => new Map());
  const [availableProxies, setAvailableProxies] = useState<StoredProxy[]>([]);
  const [availableTemplates, setAvailableTemplates] = useState<ProfileTemplate[]>([]);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [sortKey, setSortKey] = useState<ProfileSortKey>('updatedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [launchPanel, setLaunchPanel] = useState<{
    profileName: string;
    info: LaunchInfo;
  } | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const toolbarMenuRef = useRef<HTMLDivElement | null>(null);
  const prevCreateSignal = useRef(createProfileSignal);

  useEffect(() => {
    if (createProfileSignal > prevCreateSignal.current) {
      setShowForm(true);
    }
    prevCreateSignal.current = createProfileSignal;
  }, [createProfileSignal]);

  useEffect(() => {
    if (!loading && profiles.length === 0 && !isOnboarded()) {
      setShowOnboarding(true);
    }
  }, [loading, profiles.length]);

  useEffect(() => {
    let cancelled = false;
    async function loadCatalogs(): Promise<void> {
      try {
        const [proxyList, templateList] = await Promise.all([
          proxiesClient.list_proxies(),
          templatesClient.list_templates(),
        ]);
        if (!cancelled) {
          setAvailableProxies(proxyList);
          setAvailableTemplates(templateList);
        }
      } catch {
        if (!cancelled) {
          setAvailableProxies([]);
          setAvailableTemplates([]);
        }
      }
    }
    void loadCatalogs();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!showToolbarMenu) return undefined;

    function closeIfOutside(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && toolbarMenuRef.current?.contains(target)) return;
      setShowToolbarMenu(false);
    }

    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setShowToolbarMenu(false);
    }

    document.addEventListener('pointerdown', closeIfOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [showToolbarMenu]);

  function setBusy(id: string, on: boolean): void {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function setTrashBusy(id: string, on: boolean): void {
    setTrashBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function refreshTrash(): Promise<void> {
    setTrashLoading(true);
    setTrashError(null);
    try {
      const list = await listTrash();
      setTrashProfiles(list);
    } catch (e: unknown) {
      setTrashError(`Could not load trash: ${errMessage(e)}`);
    } finally {
      setTrashLoading(false);
    }
  }

  async function handleOpenTrash(): Promise<void> {
    setShowToolbarMenu(false);
    setShowTrash(true);
    await refreshTrash();
  }

  async function handleCreate(input: CreateProfileInput): Promise<void> {
    await create(input);
    setShowForm(false);
    markOnboarded();
    setShowOnboarding(false);
    toast.success(`Created profile “${input.name}”.`);
  }

  async function handleLaunch(id: string): Promise<void> {
    const target = profiles.find((profile) => profile.id === id);
    let password: string | undefined;
    if (target?.passwordProtected) {
      const value = window.prompt('Enter this profile password to launch.');
      if (value === null) return;
      password = value;
    }
    setBusy(id, true);
    try {
      const info = await launch(id, password);
      setLaunchInfo((prev) => new Map(prev).set(id, info));
      setLaunchPanel({ profileName: target?.name ?? 'Profile', info });
      toast.success(`Launched. Connect over CDP at ${info.debuggerAddress}.`);
    } catch (e: unknown) {
      toast.error(`Launch failed: ${errMessage(e)}`);
    } finally {
      setBusy(id, false);
    }
  }

  async function handleStop(id: string): Promise<void> {
    setBusy(id, true);
    try {
      await stop(id);
      setLaunchInfo((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      if (launchPanel && profiles.find((p) => p.id === id)?.name === launchPanel.profileName) {
        setLaunchPanel(null);
      }
      toast.success('Profile stopped.');
    } catch (e: unknown) {
      toast.error(`Stop failed: ${errMessage(e)}`);
    } finally {
      setBusy(id, false);
    }
  }

  async function handleClone(id: string): Promise<void> {
    try {
      await clone(id);
      toast.success('Profile cloned with a fresh fingerprint seed.');
    } catch (e: unknown) {
      toast.error(`Clone failed: ${errMessage(e)}`);
    }
  }

  async function handleMoveToTrash(id: string): Promise<void> {
    const target = profiles.find((p) => p.id === id);
    const label = target ? `“${target.name}”` : 'this profile';
    if (!window.confirm(`Move ${label} to trash?`)) return;
    try {
      await moveToTrash(id);
      setLaunchInfo((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast.success('Profile moved to trash.');
    } catch (e: unknown) {
      toast.error(`Move to trash failed: ${errMessage(e)}`);
    }
  }

  async function handleRestore(id: string): Promise<void> {
    setTrashBusy(id, true);
    setTrashError(null);
    try {
      await restore(id);
      setTrashProfiles((prev) => prev.filter((profile) => profile.id !== id));
      toast.success('Profile restored.');
    } catch (e: unknown) {
      setTrashError(`Restore failed: ${errMessage(e)}`);
    } finally {
      setTrashBusy(id, false);
    }
  }

  async function handlePermanentDelete(id: string): Promise<void> {
    const target = trashProfiles.find((profile) => profile.id === id);
    const label = target ? `“${target.name}”` : 'this profile';
    if (!window.confirm(`Permanently delete ${label}? This cannot be undone.`)) return;
    setTrashBusy(id, true);
    setTrashError(null);
    try {
      await permanentlyDelete(id);
      setTrashProfiles((prev) => prev.filter((profile) => profile.id !== id));
      toast.success('Profile permanently deleted.');
    } catch (e: unknown) {
      setTrashError(`Permanent delete failed: ${errMessage(e)}`);
    } finally {
      setTrashBusy(id, false);
    }
  }

  async function handleSetPassword(id: string): Promise<void> {
    const target = profiles.find((profile) => profile.id === id);
    const action = target?.passwordProtected
      ? 'Enter a new password, or leave blank to remove password protection.'
      : 'Enter a password for this profile. Leave blank to keep it unprotected.';
    const value = window.prompt(action);
    if (value === null) return;
    try {
      const password = value.trim().length > 0 ? value : null;
      await setPassword(id, password);
      toast.success(password ? 'Password protection enabled.' : 'Password protection removed.');
    } catch (e: unknown) {
      toast.error(`Password update failed: ${errMessage(e)}`);
    }
  }

  async function handleSaveFingerprint(patch: ProfilePatch): Promise<void> {
    if (!editing) return;
    setSaving(true);
    try {
      await update(editing.id, patch);
      setEditing(null);
      toast.success('Fingerprint overrides saved.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveProfile(patch: ProfilePatch): Promise<void> {
    if (!editingProfile) return;
    setSaving(true);
    try {
      await update(editingProfile.id, patch);
      setEditingProfile(null);
      toast.success('Profile saved.');
    } finally {
      setSaving(false);
    }
  }

  async function handleBulkLaunch(): Promise<void> {
    const ids = [...selectedIds].filter((id) => {
      const p = profiles.find((x) => x.id === id);
      return p && !isLive(p.status);
    });
    for (const id of ids) {
      await handleLaunch(id);
    }
  }

  async function handleBulkStop(): Promise<void> {
    const ids = [...selectedIds].filter((id) => {
      const p = profiles.find((x) => x.id === id);
      return p && isLive(p.status);
    });
    for (const id of ids) {
      await handleStop(id);
    }
  }

  async function handleBulkTrash(): Promise<void> {
    const ids = [...selectedIds].filter((id) => {
      const p = profiles.find((x) => x.id === id);
      return p && !isLive(p.status);
    });
    if (ids.length === 0) {
      toast.info('Stop running profiles before moving them to trash.');
      return;
    }
    if (!window.confirm(`Move ${ids.length} profile(s) to trash?`)) return;
    for (const id of ids) {
      try {
        await moveToTrash(id);
        setLaunchInfo((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      } catch (e: unknown) {
        toast.error(`Move to trash failed: ${errMessage(e)}`);
        return;
      }
    }
    setSelectedIds(new Set());
    toast.success('Profile moved to trash.');
  }

  function handleSort(key: ProfileSortKey): void {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' || key === 'proxy' ? 'asc' : 'desc');
    }
  }

  const isEmpty = !loading && profiles.length === 0;
  const filtersActive =
    engineFilter !== 'all' ||
    osFilter !== 'all' ||
    statusFilter !== 'all' ||
    proxyFilter !== 'all' ||
    tagFilter.trim().length > 0;

  const filteredProfiles = useMemo(() => {
    const list = profiles.filter((profile) => {
      const needle = query.trim().toLowerCase();
      const text = [profile.name, profile.folder, profile.notes, ...profile.tags]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (needle !== '' && !text.includes(needle)) return false;
      if (engineFilter !== 'all' && profile.engine !== engineFilter) return false;
      if (osFilter !== 'all' && profile.os !== osFilter) return false;
      if (statusFilter !== 'all' && profile.status !== statusFilter) return false;
      if (proxyFilter === 'with' && !profile.proxy && !profile.proxyId) return false;
      if (proxyFilter === 'without' && (profile.proxy || profile.proxyId)) return false;
      const tagNeedle = tagFilter.trim().toLowerCase();
      if (tagNeedle && !profile.tags.some((tag) => tag.toLowerCase().includes(tagNeedle))) {
        return false;
      }
      return true;
    });

    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'status':
          cmp = a.status.localeCompare(b.status);
          break;
        case 'proxy':
          cmp = proxySortKey(a).localeCompare(proxySortKey(b));
          break;
        case 'updatedAt':
        default:
          cmp = a.updatedAt.localeCompare(b.updatedAt);
          break;
      }
      return cmp * dir;
    });
    return list;
  }, [
    profiles,
    query,
    engineFilter,
    osFilter,
    statusFilter,
    proxyFilter,
    tagFilter,
    sortKey,
    sortDir,
  ]);

  const runningCount = profiles.filter((profile) => profile.status === 'running').length;
  const selectedCount = selectedIds.size;

  return (
    <section className="page profiles-view">
      <header className="table-toolbar">
        <div className="toolbar-total">
          <span>Total:</span>
          <strong>{profiles.length}</strong>
          <span className="green-dot" aria-hidden />
          <strong className="toolbar-online">{runningCount}</strong>
        </div>
        <div className="toolbar-search">
          <label className="search-field">
            <MagnifyingGlassIcon aria-hidden />
            <input
              type="search"
              value={query}
              placeholder="Search by name or ID"
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="button"
              className={
                filtersActive
                  ? 'search-filter-button search-filter-button--active'
                  : 'search-filter-button'
              }
              aria-label="Filters"
              aria-expanded={showFilters}
              onClick={() => setShowFilters((current) => !current)}
            >
              <FunnelIcon aria-hidden />
            </button>
          </label>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="btn btn--primary" onClick={() => setShowForm(true)}>
            <PlusIcon aria-hidden />
            Create Profile
          </button>
          <div className="toolbar-menu" ref={toolbarMenuRef}>
            <button
              type="button"
              className="btn btn--primary btn--square"
              aria-label="More actions"
              aria-expanded={showToolbarMenu}
              onClick={() => setShowToolbarMenu((current) => !current)}
            >
              <EllipsisHorizontalIcon aria-hidden />
            </button>
            {showToolbarMenu ? (
              <div className="action-menu toolbar-action-menu" role="menu">
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    void handleOpenTrash();
                  }}
                >
                  <TrashIcon aria-hidden />
                  Trash
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {showFilters ? (
        <div className="filter-bar" aria-label="Profile filters">
          <label className="field">
            <span className="field__label">Engine</span>
            <select
              className="input"
              value={engineFilter}
              onChange={(e) => setEngineFilter(e.target.value as 'all' | EngineKind)}
            >
              <option value="all">All engines</option>
              {ENGINE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">OS</span>
            <select
              className="input"
              value={osFilter}
              onChange={(e) => setOsFilter(e.target.value as 'all' | OsFamily)}
            >
              <option value="all">All OS</option>
              {OS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Status</span>
            <select
              className="input"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | ProfileStatus)}
            >
              <option value="all">All statuses</option>
              {Object.entries(STATUS_META).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Proxy</span>
            <select
              className="input"
              value={proxyFilter}
              onChange={(e) => setProxyFilter(e.target.value as typeof proxyFilter)}
            >
              <option value="all">All proxy states</option>
              <option value="with">With proxy</option>
              <option value="without">Without proxy</option>
            </select>
          </label>
          <label className="field">
            <span className="field__label">Tag</span>
            <input
              className="input"
              type="text"
              value={tagFilter}
              placeholder="Filter tags"
              onChange={(e) => setTagFilter(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn--ghost filter-reset"
            onClick={() => {
              setEngineFilter('all');
              setOsFilter('all');
              setStatusFilter('all');
              setProxyFilter('all');
              setTagFilter('');
            }}
            disabled={!filtersActive}
          >
            Reset
          </button>
        </div>
      ) : null}

      {selectedCount > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Bulk profile actions">
          <span>
            <strong>{selectedCount}</strong> selected
          </span>
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<PlayIcon aria-hidden />}
            onClick={() => {
              void handleBulkLaunch();
            }}
          >
            Launch
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<StopIcon aria-hidden />}
            onClick={() => {
              void handleBulkStop();
            }}
          >
            Stop
          </Button>
          <Button
            variant="danger"
            size="sm"
            leadingIcon={<TrashIcon aria-hidden />}
            onClick={() => {
              void handleBulkTrash();
            }}
          >
            Move to trash
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      {error ? <p className="notice notice--error">Could not load profiles: {error}</p> : null}

      {loading ? (
        <div className="skeleton-stack" aria-busy="true" aria-label="Loading profiles">
          <Skeleton height={48} />
          <Skeleton height={48} />
          <Skeleton height={48} />
          <Skeleton height={48} />
        </div>
      ) : isEmpty ? (
        <EmptyState
          icon={<UserGroupIcon aria-hidden />}
          title={t('profiles.empty.title')}
          description={t('profiles.empty.desc')}
          action={
            <button type="button" className="btn btn--primary" onClick={() => setShowForm(true)}>
              <PlusIcon aria-hidden />
              Create Profile
            </button>
          }
        />
      ) : (
        <ProfileList
          profiles={filteredProfiles}
          busyIds={busyIds}
          launchInfo={launchInfo}
          selectedIds={selectedIds}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
          onToggleSelect={(id) => {
            setSelectedIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          }}
          onToggleSelectAll={() => {
            const ids = filteredProfiles.map((p) => p.id);
            const allOn = ids.length > 0 && ids.every((id) => selectedIds.has(id));
            setSelectedIds(allOn ? new Set() : new Set(ids));
          }}
          onLaunch={handleLaunch}
          onStop={handleStop}
          onClone={handleClone}
          onMoveToTrash={handleMoveToTrash}
          onEditProfile={setEditingProfile}
          onSetPassword={handleSetPassword}
        />
      )}

      {showForm ? (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowForm(false);
          }}
        >
          <NewProfileForm
            proxies={availableProxies}
            templates={availableTemplates}
            onCreate={handleCreate}
            onCancel={() => setShowForm(false)}
          />
        </div>
      ) : null}

      {showTrash ? (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowTrash(false);
          }}
        >
          <TrashModal
            profiles={trashProfiles}
            loading={trashLoading}
            busyIds={trashBusyIds}
            error={trashError}
            onRefresh={() => {
              void refreshTrash();
            }}
            onRestore={(id) => {
              void handleRestore(id);
            }}
            onPermanentlyDelete={(id) => {
              void handlePermanentDelete(id);
            }}
            onClose={() => setShowTrash(false)}
          />
        </div>
      ) : null}

      {editingProfile ? (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !saving) setEditingProfile(null);
          }}
        >
          <EditProfileForm
            profile={editingProfile}
            saving={saving}
            onSave={handleSaveProfile}
            onCancel={() => setEditingProfile(null)}
            onEditFingerprint={() => {
              setEditing(editingProfile);
              setEditingProfile(null);
            }}
          />
        </div>
      ) : null}

      {editing ? (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !saving) setEditing(null);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-label="Edit fingerprint">
            <header className="modal-header">
              <div>
                <h2>Fingerprint</h2>
                <p className="modal-subtitle">{editing.name}</p>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setEditing(null)}
                disabled={saving}
                aria-label="Close"
              >
                <XMarkIcon aria-hidden />
              </button>
            </header>
            <div className="modal-body">
              <FingerprintEditor
                profile={editing}
                onSave={handleSaveFingerprint}
                onClose={() => setEditing(null)}
                saving={saving}
              />
            </div>
          </div>
        </div>
      ) : null}

      <LaunchPanel
        open={launchPanel !== null}
        onClose={() => setLaunchPanel(null)}
        profileName={launchPanel?.profileName ?? ''}
        info={launchPanel?.info ?? null}
      />

      <OnboardingModal
        open={showOnboarding}
        onSkip={() => {
          markOnboarded();
          setShowOnboarding(false);
        }}
        onGetStarted={() => {
          markOnboarded();
          setShowOnboarding(false);
          setShowForm(true);
        }}
      />
    </section>
  );
}
