import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';


import type {
  CreateProfileInput,
  EngineKind,
  Profile,
  ProfileOsTarget,
  ProfileTemplate,
  ProfileStatus,
  StoredProxy,
} from '@lobster/shared-types';

import {
  proxiesClient,
  profilesClient,
  templatesClient,
  type LaunchInfo,
  type ProfilePatch,
} from '../../api/tauri';
import { LaunchPanel } from '../automation/LaunchPanel';
import { isOnboarded, markOnboarded, OnboardingModal } from '../onboarding/OnboardingModal';
import { t } from '../../i18n';
import { ActionDialog, Button, EmptyState, Skeleton, useToast } from '../../ui';
import { EditProfileForm } from './EditProfileForm';
import { ENGINE_OPTIONS, OS_OPTIONS, STATUS_META } from './options';
import { ProfileList, type ProfileSortKey, type SortDir } from './ProfileList';
import { TrashModal } from './TrashModal';
import { useProfiles } from './useProfiles';
import { Icon } from '../../ui/Icon';

const NewProfileForm = lazy(() =>
  import('./NewProfileForm').then((module) => ({ default: module.NewProfileForm })),
);

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

type PendingProfileAction =
  | { kind: 'launch'; profile: Profile }
  | { kind: 'password'; profile: Profile }
  | { kind: 'trash'; ids: string[]; label: string }
  | { kind: 'permanent-delete'; id: string; label: string };

function pendingActionCopy(action: PendingProfileAction | null): {
  title: string;
  description: string;
  confirmLabel: string;
} {
  if (!action) return { title: '', description: '', confirmLabel: '' };
  if (action.kind === 'launch') {
    return {
      title: 'Unlock profile',
      description: `Enter the password for “${action.profile.name}” to launch it in Lobium.`,
      confirmLabel: 'Launch profile',
    };
  }
  if (action.kind === 'password') {
    return {
      title: 'Profile password',
      description: action.profile.passwordProtected
        ? 'Enter a new password, or leave the field empty to remove password protection.'
        : 'Enter a password to protect this profile. Leave the field empty to keep it unprotected.',
      confirmLabel: 'Save password',
    };
  }
  if (action.kind === 'permanent-delete') {
    return {
      title: 'Permanently delete profile?',
      description: `${action.label} and its local data will be deleted. This cannot be undone.`,
      confirmLabel: 'Delete permanently',
    };
  }
  return {
    title: 'Move profiles to trash?',
    description: `${action.label} will be removed from the active workspace and can be restored later.`,
    confirmLabel: 'Move to trash',
  };
}

function AccessibleModalOverlay({
  children,
  onClose,
  locked = false,
}: {
  children: ReactNode;
  onClose: () => void;
  locked?: boolean;
}): JSX.Element {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  const lockedRef = useRef(locked);
  closeRef.current = onClose;
  lockedRef.current = locked;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const root = overlayRef.current;
    const first =
      root?.querySelector<HTMLElement>('[autofocus]') ??
      root?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
    first?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !lockedRef.current) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const firstElement = focusable[0];
      const lastElement = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement?.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement?.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !locked) onClose();
      }}
    >
      {children}
    </div>
  );
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
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [engineFilter, setEngineFilter] = useState<'all' | EngineKind>('all');
  const [osFilter, setOsFilter] = useState<'all' | ProfileOsTarget>('all');
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
  const [pendingAction, setPendingAction] = useState<PendingProfileAction | null>(null);
  const [actionInput, setActionInput] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const toolbarMenuRef = useRef<HTMLDivElement | null>(null);
  const prevCreateSignal = useRef(createProfileSignal);

  // Stable identity so the create/edit modal's font-catalog effect (keyed on this prop) does NOT
  // re-fire on every parent re-render — part of the fix for the flickering create-profile modal.
  const loadFontFamilies = useCallback(
    (os: ProfileOsTarget) => profilesClient.list_font_families(os),
    [],
  );

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

  async function handleCreate(
    input: CreateProfileInput,
    options?: { password?: string },
  ): Promise<void> {
    const profile = await create(input);
    if (options?.password) {
      await setPassword(profile.id, options.password);
    }
    // Refresh proxy list in case create-form added a custom proxy.
    try {
      setAvailableProxies(await proxiesClient.list_proxies());
    } catch {
      /* non-fatal */
    }
    setShowForm(false);
    markOnboarded();
    setShowOnboarding(false);
    toast.success(`Created profile “${input.name}”.`);
  }

  async function handleCreateProxyFromProfile(
    input: Parameters<typeof proxiesClient.create_proxy>[0],
  ): Promise<StoredProxy> {
    const created = await proxiesClient.create_proxy(input);
    setAvailableProxies(await proxiesClient.list_proxies());
    return created;
  }

  async function launchProfile(id: string, password?: string): Promise<void> {
    const target = profiles.find((profile) => profile.id === id);
    setBusy(id, true);
    try {
      const info = await launch(id, password);
      setLaunchInfo((prev) => new Map(prev).set(id, info));
      // Go straight to Lobium; connection details remain an explicit advanced action.
      // Connection details remain available via the profile ⋮ menu while running.
      toast.success(`Launched ${target?.name ?? 'profile'}.`);
    } catch (e: unknown) {
      toast.error(`Launch failed: ${errMessage(e)}`);
    } finally {
      setBusy(id, false);
    }
  }

  async function handleLaunch(id: string): Promise<void> {
    const target = profiles.find((profile) => profile.id === id);
    if (target?.passwordProtected) {
      setActionInput('');
      setPendingAction({ kind: 'launch', profile: target });
      return;
    }
    await launchProfile(id);
  }

  function handleShowConnection(id: string): void {
    const info = launchInfo.get(id);
    const target = profiles.find((profile) => profile.id === id);
    if (!info) {
      toast.error('Profile is not running.');
      return;
    }
    setLaunchPanel({ profileName: target?.name ?? 'Profile', info });
  }

  async function handleExportCookies(id: string): Promise<void> {
    const target = profiles.find((profile) => profile.id === id);
    try {
      const json = await profilesClient.export_profile_cookies(id);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${(target?.name ?? id).replace(/[^a-z0-9._-]+/gi, '_')}-cookies.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success('Live cookies exported locally.');
    } catch (e: unknown) {
      toast.error(`Cookie export failed: ${errMessage(e)}`);
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
    setPendingAction({ kind: 'trash', ids: [id], label });
  }

  async function moveProfilesToTrash(ids: string[]): Promise<void> {
    try {
      for (const id of ids) {
        await moveToTrash(id);
        setLaunchInfo((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      }
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      toast.success(ids.length === 1 ? 'Profile moved to trash.' : 'Profiles moved to trash.');
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
    setPendingAction({ kind: 'permanent-delete', id, label });
  }

  async function permanentlyDeleteProfile(id: string): Promise<void> {
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
    if (!target) return;
    setActionInput('');
    setPendingAction({ kind: 'password', profile: target });
  }

  async function updateProfilePassword(id: string, value: string): Promise<void> {
    try {
      const password = value.trim().length > 0 ? value : null;
      await setPassword(id, password);
      toast.success(password ? 'Password protection enabled.' : 'Password protection removed.');
    } catch (e: unknown) {
      toast.error(`Password update failed: ${errMessage(e)}`);
    }
  }

  async function handleSaveProfile(
    patch: ProfilePatch,
    options?: { password?: string | null },
  ): Promise<void> {
    if (!editingProfile) return;
    setSaving(true);
    try {
      await update(editingProfile.id, patch);
      if (options && 'password' in options) {
        await setPassword(editingProfile.id, options.password ?? null);
      }
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
    if (ids.length === 0) {
      toast.error('No selected desktop Lobium profiles can be launched.');
      return;
    }
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
    setPendingAction({
      kind: 'trash',
      ids,
      label: `${ids.length} selected profiles`,
    });
  }

  async function confirmPendingAction(): Promise<void> {
    const action = pendingAction;
    if (!action) return;
    setActionBusy(true);
    try {
      if (action.kind === 'launch') await launchProfile(action.profile.id, actionInput);
      if (action.kind === 'password') await updateProfilePassword(action.profile.id, actionInput);
      if (action.kind === 'trash') await moveProfilesToTrash(action.ids);
      if (action.kind === 'permanent-delete') await permanentlyDeleteProfile(action.id);
      setPendingAction(null);
      setActionInput('');
    } finally {
      setActionBusy(false);
    }
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
      // Search everything the row can show, not just the name/tags — so searching by ID, OS, status,
      // engine, version, or proxy actually matches (the box previously ignored all of these).
      const text = [
        profile.name,
        profile.id,
        profile.folder,
        profile.notes,
        profile.engine,
        profile.osVersion,
        profile.os,
        OS_OPTIONS.find((option) => option.value === profile.os)?.label,
        STATUS_META[profile.status]?.label,
        profile.proxy?.label,
        profile.proxy ? `${profile.proxy.host}:${profile.proxy.port}` : undefined,
        profile.proxyId,
        ...profile.tags,
      ]
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
        case 'description':
          cmp = (a.notes ?? '').localeCompare(b.notes ?? '');
          break;
        case 'tags':
          cmp = (a.tags[0] ?? '').localeCompare(b.tags[0] ?? '');
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
  const actionCopy = pendingActionCopy(pendingAction);

  return (
    <section className="page profiles-view">
      <header className="table-toolbar">
        <div className="toolbar-total">
          <strong>{profiles.length}</strong>
          <span>{profiles.length === 1 ? 'profile' : 'profiles'}</span>
          {runningCount > 0 && (
            <>
              <span className="toolbar-total__sep" aria-hidden>
                ·
              </span>
              <span className="green-dot" aria-hidden />
              <strong className="toolbar-online">{runningCount}</strong>
              <span>running</span>
            </>
          )}
        </div>
        <div className="toolbar-search">
          <label className="search-field">
            <Icon name="MagnifyingGlassIcon" aria-hidden />
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
              <Icon name="FunnelIcon" aria-hidden />
            </button>
          </label>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="btn btn--primary" onClick={() => setShowForm(true)}>
            <Icon name="PlusIcon" aria-hidden />
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
              <Icon name="EllipsisHorizontalIcon" aria-hidden />
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
                  <Icon name="TrashIcon" aria-hidden />
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
              onChange={(e) => setOsFilter(e.target.value as 'all' | ProfileOsTarget)}
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
            leadingIcon={<Icon name="PlayIcon" aria-hidden />}
            onClick={() => {
              void handleBulkLaunch();
            }}
          >
            Launch
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<Icon name="StopIcon" aria-hidden />}
            onClick={() => {
              void handleBulkStop();
            }}
          >
            Stop
          </Button>
          <Button
            variant="danger"
            size="sm"
            leadingIcon={<Icon name="TrashIcon" aria-hidden />}
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

      <div className="profiles-view__list">
        {loading ? (
          <div className="skeleton-stack" aria-busy="true" aria-label="Loading profiles">
            <Skeleton height={48} />
            <Skeleton height={48} />
            <Skeleton height={48} />
            <Skeleton height={48} />
          </div>
        ) : isEmpty ? (
          <EmptyState
            icon={<Icon name="UserGroupIcon" aria-hidden />}
            title={t('profiles.empty.title')}
            description={t('profiles.empty.desc')}
            action={
              <button type="button" className="btn btn--primary" onClick={() => setShowForm(true)}>
                <Icon name="PlusIcon" aria-hidden />
                Create Profile
              </button>
            }
          />
        ) : (
          <ProfileList
            profiles={filteredProfiles}
            availableProxies={availableProxies}
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
            onShowConnection={handleShowConnection}
            onExportCookies={(id) => {
              void handleExportCookies(id);
            }}
          />
        )}
      </div>

      {showForm ? (
        <AccessibleModalOverlay onClose={() => setShowForm(false)}>
          <Suspense
            fallback={
              <div className="modal modal-loading" role="dialog" aria-label="Loading profile form">
                <p>Loading profile settings…</p>
              </div>
            }
          >
            <NewProfileForm
              proxies={availableProxies}
              templates={availableTemplates}
              onCreate={handleCreate}
              onCreateProxy={handleCreateProxyFromProfile}
              onTestProxy={(config) => proxiesClient.test_proxy(null, config)}
              loadFontFamilies={loadFontFamilies}
              onCancel={() => setShowForm(false)}
            />
          </Suspense>
        </AccessibleModalOverlay>
      ) : null}

      {showTrash ? (
        <AccessibleModalOverlay onClose={() => setShowTrash(false)}>
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
        </AccessibleModalOverlay>
      ) : null}

      {editingProfile ? (
        <AccessibleModalOverlay onClose={() => setEditingProfile(null)} locked={saving}>
          <EditProfileForm
            profile={editingProfile}
            saving={saving}
            onSave={handleSaveProfile}
            onCancel={() => setEditingProfile(null)}
            proxies={availableProxies}
            templates={availableTemplates}
            onCreateProxy={handleCreateProxyFromProfile}
            onTestProxy={(config) => proxiesClient.test_proxy(null, config)}
            loadFontFamilies={loadFontFamilies}
          />
        </AccessibleModalOverlay>
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
      <ActionDialog
        open={pendingAction !== null}
        title={actionCopy.title}
        description={actionCopy.description}
        confirmLabel={actionCopy.confirmLabel}
        busy={actionBusy}
        destructive={pendingAction?.kind === 'trash' || pendingAction?.kind === 'permanent-delete'}
        input={
          pendingAction?.kind === 'launch' || pendingAction?.kind === 'password'
            ? {
                label: pendingAction.kind === 'launch' ? 'Profile password' : 'New password',
                value: actionInput,
                onChange: setActionInput,
                type: 'password',
                required: pendingAction.kind === 'launch',
              }
            : undefined
        }
        onConfirm={() => {
          void confirmPendingAction();
        }}
        onClose={() => {
          setPendingAction(null);
          setActionInput('');
        }}
      />
    </section>
  );
}
