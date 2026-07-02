import { invoke, isTauri } from '@tauri-apps/api/core';

import type { CreateProfileInput, FingerprintSeed, Profile } from '@lobster/shared-types';

/**
 * Typed client for the profile-related Tauri commands (registered in
 * src-tauri/src/lib.rs — infra-gated; several land on a later day). The UI depends only on
 * the {@link ProfilesClient} shape, so it develops and typechecks against this contract long
 * before the Rust side exists.
 *
 * When we are NOT running inside a Tauri webview (i.e. `vite dev` in a plain browser), we swap
 * in an in-memory {@link mockClient} so the whole UI is exercisable without the desktop core.
 */

/** Endpoints an automation client connects to after a profile launches. */
export interface LaunchInfo {
  /** Playwright/Puppeteer: `browser.connectOverCDP(ws)`. */
  ws: string;
  /** Selenium: set `debuggerAddress` to this `host:port`. */
  debuggerAddress: string;
}

/**
 * The fields a user may patch on an existing profile. Identity and audit fields
 * (`id`, `createdAt`, `updatedAt`) are owned by the store, and `status` is derived from the
 * engine lifecycle (launch/stop) — none are user-patchable here.
 */
export type ProfilePatch = Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt' | 'status'>>;

/** The command surface the UI consumes. The real (Tauri) and mock impls both satisfy it. */
export interface ProfilesClient {
  list_profiles(): Promise<Profile[]>;
  create_profile(input: CreateProfileInput): Promise<Profile>;
  get_profile(id: string): Promise<Profile>;
  update_profile(id: string, patch: ProfilePatch): Promise<Profile>;
  delete_profile(id: string): Promise<void>;
  launch_profile(id: string): Promise<LaunchInfo>;
  stop_profile(id: string): Promise<void>;
}

/**
 * True when the app is hosted by a Tauri webview. We check the injected internals bag first
 * (present the instant the webview boots) and fall back to the SDK's own `isTauri()` guard.
 */
export function isDesktopRuntime(): boolean {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return true;
  }
  try {
    return isTauri();
  } catch {
    return false;
  }
}

/** Real client: every call forwards to a Rust command over the Tauri IPC bridge. */
const tauriClient: ProfilesClient = {
  list_profiles: () => invoke<Profile[]>('list_profiles'),
  create_profile: (input) => invoke<Profile>('create_profile', { input }),
  get_profile: (id) => invoke<Profile>('get_profile', { id }),
  update_profile: (id, patch) => invoke<Profile>('update_profile', { id, patch }),
  delete_profile: (id) => invoke<void>('delete_profile', { id }),
  launch_profile: (id) => invoke<LaunchInfo>('launch_profile', { id }),
  stop_profile: (id) => invoke<void>('stop_profile', { id }),
};

/* --------------------------------------------------------------------------------------------
 * In-browser mock store
 * ------------------------------------------------------------------------------------------ */

function nowIso(): string {
  return new Date().toISOString();
}

/** A lowercase-hex seed, matching the persisted {@link FingerprintSeed} shape. */
function randomSeed(): FingerprintSeed {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Materialise a full {@link Profile} from create input, filling the store-owned fields.
 * Optional keys are added only when present so the object stays valid under
 * `exactOptionalPropertyTypes` (never assigns a literal `undefined`).
 */
function buildProfile(input: CreateProfileInput): Profile {
  const ts = nowIso();
  const profile: Profile = {
    id: crypto.randomUUID(),
    name: input.name,
    engine: input.engine,
    os: input.os,
    fingerprintSeed: input.fingerprintSeed ?? randomSeed(),
    tags: input.tags ?? [],
    status: 'idle',
    createdAt: ts,
    updatedAt: ts,
  };
  if (input.fingerprintOverrides) profile.fingerprintOverrides = input.fingerprintOverrides;
  if (input.proxy) profile.proxy = input.proxy;
  if (input.folder) profile.folder = input.folder;
  if (input.notes) profile.notes = input.notes;
  return profile;
}

const mockStore = new Map<string, Profile>();

function seedMockStore(): void {
  const samples: CreateProfileInput[] = [
    {
      name: 'US Retail — Chrome',
      engine: 'chromium',
      os: 'windows',
      tags: ['retail', 'us'],
      folder: 'Shopping',
    },
    { name: 'EU Social — Lobium', engine: 'lobium', os: 'macos', tags: ['social', 'eu'] },
    { name: 'Lobium QA', engine: 'lobium', os: 'linux', tags: ['qa'], folder: 'Internal' },
  ];
  for (const sample of samples) {
    const profile = buildProfile(sample);
    mockStore.set(profile.id, profile);
  }
}

const mockClient: ProfilesClient = {
  list_profiles: async () => Array.from(mockStore.values(), (p) => structuredClone(p)),

  create_profile: async (input) => {
    const profile = buildProfile(input);
    mockStore.set(profile.id, profile);
    return structuredClone(profile);
  },

  get_profile: async (id) => {
    const existing = mockStore.get(id);
    if (!existing) throw new Error(`Profile ${id} not found`);
    return structuredClone(existing);
  },

  update_profile: async (id, patch) => {
    const existing = mockStore.get(id);
    if (!existing) throw new Error(`Profile ${id} not found`);
    const updated: Profile = { ...existing, ...patch, updatedAt: nowIso() };
    mockStore.set(id, updated);
    return structuredClone(updated);
  },

  delete_profile: async (id) => {
    if (!mockStore.delete(id)) throw new Error(`Profile ${id} not found`);
  },

  launch_profile: async (id) => {
    const existing = mockStore.get(id);
    if (!existing) throw new Error(`Profile ${id} not found`);
    const port = 9222 + (mockStore.size % 100);
    mockStore.set(id, { ...existing, status: 'running', updatedAt: nowIso() });
    return {
      ws: `ws://127.0.0.1:${port}/devtools/browser/${id}`,
      debuggerAddress: `127.0.0.1:${port}`,
    };
  },

  stop_profile: async (id) => {
    const existing = mockStore.get(id);
    if (!existing) throw new Error(`Profile ${id} not found`);
    mockStore.set(id, { ...existing, status: 'idle', updatedAt: nowIso() });
  },
};

/** The active client — real bridge in the desktop shell, in-memory mock in a dev browser. */
export const profilesClient: ProfilesClient = isDesktopRuntime() ? tauriClient : mockClient;

if (!isDesktopRuntime()) {
  seedMockStore();
}
