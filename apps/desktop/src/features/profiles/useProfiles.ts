import { useCallback, useEffect, useState } from 'react';

import type { CreateProfileInput, Profile } from '@lobster/shared-types';

import { profilesClient, type LaunchInfo, type ProfilePatch } from '../../api/tauri';

/** Data + mutation surface the Profiles view binds to. Every mutation refreshes the list. */
export interface UseProfiles {
  profiles: Profile[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (input: CreateProfileInput) => Promise<void>;
  clone: (id: string) => Promise<void>;
  update: (id: string, patch: ProfilePatch) => Promise<Profile>;
  remove: (id: string) => Promise<void>;
  launch: (id: string) => Promise<LaunchInfo>;
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
  }, [refresh]);

  const create = useCallback(
    async (input: CreateProfileInput) => {
      await profilesClient.create_profile(input);
      await refresh();
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

  const remove = useCallback(
    async (id: string) => {
      await profilesClient.delete_profile(id);
      await refresh();
    },
    [refresh],
  );

  const launch = useCallback(
    async (id: string) => {
      const info = await profilesClient.launch_profile(id);
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

  return { profiles, loading, error, refresh, create, clone, update, remove, launch, stop };
}
