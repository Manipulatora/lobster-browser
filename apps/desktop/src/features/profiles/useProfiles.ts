import { useCallback, useEffect, useState } from 'react';

import type { CreateProfileInput, Profile } from '@lobster/shared-types';

import { profilesClient, type LaunchInfo, type ProfilePatch } from '../../api/tauri';

/** Data + mutation surface the Profiles view binds to. Every mutation refreshes the list. */
export interface UseProfiles {
  profiles: Profile[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (input: CreateProfileInput) => Promise<Profile>;
  clone: (id: string) => Promise<void>;
  update: (id: string, patch: ProfilePatch) => Promise<Profile>;
  moveToTrash: (id: string) => Promise<void>;
  listTrash: () => Promise<Profile[]>;
  restore: (id: string) => Promise<void>;
  permanentlyDelete: (id: string) => Promise<void>;
  setPassword: (id: string, password: string | null) => Promise<void>;
  launch: (id: string, password?: string) => Promise<LaunchInfo>;
  stop: (id: string) => Promise<void>;
}

/**
 * Owns the profile list and wraps the {@link profilesClient} calls. Mutations propagate their
 * errors (so callers can keep a form open / surface a toast) while `refresh` captures load
 * failures into `error` for the empty/error state.
 */
export function useProfiles(): UseProfiles {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await profilesClient.list_profiles();
      setProfiles(list);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Poll so a browser window the user closes is reflected quickly. The sidecar drops the profile from
    // its running-set the instant the process exits, and list_profiles runs the reconcile that flips the
    // DB status back to idle — which restores the Run button. This is a QUIET poll (no loading flip, no
    // error surfacing) so it never flickers the UI; the mount refresh + mutations own real errors.
    //
    // Critically, it BAILS OUT when the list is unchanged: returning the previous array reference makes
    // React skip the re-render entirely. Without this, the 2s poll re-rendered the whole Profiles view —
    // including an OPEN create/edit modal — every 2 seconds, which re-fired the modal's font-catalog
    // effect and flickered its controls (the "blipping" that interrupted typing/selection).
    const timer = setInterval(() => {
      profilesClient
        .list_profiles()
        .then((list) =>
          setProfiles((prev) =>
            JSON.stringify(prev) === JSON.stringify(list) ? prev : list,
          ),
        )
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  const create = useCallback(
    async (input: CreateProfileInput) => {
      const profile = await profilesClient.create_profile(input);
      await refresh();
      return profile;
    },
    [refresh],
  );

  const clone = useCallback(
    async (id: string) => {
      const src = await profilesClient.get_profile(id);
      // New seed (a clone must NOT reuse the source fingerprint), but carry over the user's
      // config so the copy is a useful starting point.
      const input: CreateProfileInput = {
        name: `${src.name} copy`,
        engine: src.engine,
        os: src.os,
        tags: [...src.tags],
      };
      if (src.fingerprintOverrides) input.fingerprintOverrides = src.fingerprintOverrides;
      if (src.proxy) input.proxy = src.proxy;
      if (src.proxyId) input.proxyId = src.proxyId;
      if (src.templateId) input.templateId = src.templateId;
      if (src.osVersion) input.osVersion = src.osVersion;
      // Pending cookie imports are one-shot local secrets. Cloning must never replay them.
      if (src.extensions) input.extensions = src.extensions;
      if (src.folder) input.folder = src.folder;
      if (src.notes) input.notes = src.notes;
      await profilesClient.create_profile(input);
      await refresh();
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, patch: ProfilePatch) => {
      const updated = await profilesClient.update_profile(id, patch);
      await refresh();
      return updated;
    },
    [refresh],
  );

  const moveToTrash = useCallback(
    async (id: string) => {
      await profilesClient.delete_profile(id);
      await refresh();
    },
    [refresh],
  );

  const listTrash = useCallback(async () => {
    return profilesClient.list_trashed_profiles();
  }, []);

  const restore = useCallback(
    async (id: string) => {
      await profilesClient.restore_profile(id);
      await refresh();
    },
    [refresh],
  );

  const permanentlyDelete = useCallback(
    async (id: string) => {
      await profilesClient.permanently_delete_profile(id);
      await refresh();
    },
    [refresh],
  );

  const setPassword = useCallback(
    async (id: string, password: string | null) => {
      await profilesClient.set_profile_password(id, password);
      await refresh();
    },
    [refresh],
  );

  const launch = useCallback(
    async (id: string, password?: string) => {
      const info = await profilesClient.launch_profile(id, password);
      await refresh();
      return info;
    },
    [refresh],
  );

  const stop = useCallback(
    async (id: string) => {
      await profilesClient.stop_profile(id);
      await refresh();
    },
    [refresh],
  );

  return {
    profiles,
    loading,
    error,
    refresh,
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
  };
}
