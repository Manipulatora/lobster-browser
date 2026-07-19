import { invoke, isTauri } from '@tauri-apps/api/core';

import type {
  CreateMobileMachineInput,
  CreateProfileInput,
  CreateProfileTemplateInput,
  CreateStoredProxyInput,
  FingerprintSeed,
  MobileMachine,
  Profile,
  ProfileTemplate,
  ProxyConfig,
  ProxySource,
  ProxyTestResult,
  StoredProxy,
  UpdateStoredProxyInput,
  ProxyRotationResult,
} from '@lobster/shared-types';

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
export type ProfilePatch = Partial<
  Omit<Profile, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'trashedAt'>
>;

/** The command surface the UI consumes. The real (Tauri) and mock impls both satisfy it. */
export interface ProfilesClient {
  list_profiles(): Promise<Profile[]>;
  list_trashed_profiles(): Promise<Profile[]>;
  create_profile(input: CreateProfileInput): Promise<Profile>;
  get_profile(id: string): Promise<Profile>;
  update_profile(id: string, patch: ProfilePatch): Promise<Profile>;
  delete_profile(id: string): Promise<void>;
  restore_profile(id: string): Promise<void>;
  permanently_delete_profile(id: string): Promise<void>;
  set_profile_password(id: string, password: string | null): Promise<void>;
  launch_profile(id: string, password?: string): Promise<LaunchInfo>;
  stop_profile(id: string): Promise<void>;
  export_profile_cookies(id: string): Promise<string>;
  list_font_families(os: string): Promise<string[]>;
}

export interface ProxiesClient {
  list_proxies(source?: ProxySource): Promise<StoredProxy[]>;
  create_proxy(input: CreateStoredProxyInput): Promise<StoredProxy>;
  update_proxy(id: string, patch: UpdateStoredProxyInput): Promise<StoredProxy>;
  delete_proxy(id: string): Promise<void>;
  rotate_proxy(id: string): Promise<ProxyRotationResult>;
  test_proxy(id: string | null, config: ProxyConfig): Promise<ProxyTestResult>;
}

export interface TemplatesClient {
  list_templates(): Promise<ProfileTemplate[]>;
  create_template(input: CreateProfileTemplateInput): Promise<ProfileTemplate>;
}

/**
 * Mobile machines — per-profile isolated Android emulators. The `provision`/`boot`/`stop` commands
 * are infra-gated (they require a KVM+GPU host to run an AVD); the UI is fully exercisable via the
 * in-browser mock, and the commands land with the `android-machine` package + Rust wiring.
 */
export interface MobileMachinesClient {
  list_machines(): Promise<MobileMachine[]>;
  create_machine(input: CreateMobileMachineInput): Promise<MobileMachine>;
  boot_machine(id: string): Promise<MobileMachine>;
  stop_machine(id: string): Promise<MobileMachine>;
  delete_machine(id: string): Promise<void>;
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
  list_trashed_profiles: () => invoke<Profile[]>('list_trashed_profiles'),
  create_profile: (input) => invoke<Profile>('create_profile', { input }),
  get_profile: (id) => invoke<Profile>('get_profile', { id }),
  update_profile: (id, patch) => invoke<Profile>('update_profile', { id, patch }),
  delete_profile: (id) => invoke<void>('delete_profile', { id }),
  restore_profile: (id) => invoke<void>('restore_profile', { id }),
  permanently_delete_profile: (id) => invoke<void>('permanently_delete_profile', { id }),
  set_profile_password: (id, password) => invoke<void>('set_profile_password', { id, password }),
  launch_profile: (id, password) =>
    invoke<LaunchInfo>('launch_profile', { id, password: password ?? null }),
  stop_profile: (id) => invoke<void>('stop_profile', { id }),
  export_profile_cookies: (id) => invoke<string>('export_profile_cookies', { id }),
  list_font_families: (os) => invoke<string[]>('list_font_families', { os }),
};

const tauriProxiesClient: ProxiesClient = {
  list_proxies: (source) => invoke<StoredProxy[]>('list_proxies', { source: source ?? null }),
  create_proxy: (input) => invoke<StoredProxy>('create_proxy', { input }),
  update_proxy: (id, patch) => invoke<StoredProxy>('update_proxy', { id, patch }),
  delete_proxy: (id) => invoke<void>('delete_proxy', { id }),
  rotate_proxy: (id) => invoke<ProxyRotationResult>('rotate_proxy', { id }),
  test_proxy: (id, config) => invoke<ProxyTestResult>('test_proxy', { id, config }),
};

const tauriTemplatesClient: TemplatesClient = {
  list_templates: () => invoke<ProfileTemplate[]>('list_templates'),
  create_template: (input) => invoke<ProfileTemplate>('create_template', { input }),
};

const tauriMobileMachinesClient: MobileMachinesClient = {
  list_machines: () => invoke<MobileMachine[]>('list_machines'),
  create_machine: (input) => invoke<MobileMachine>('create_machine', { input }),
  boot_machine: (id) => invoke<MobileMachine>('boot_machine', { id }),
  stop_machine: (id) => invoke<MobileMachine>('stop_machine', { id }),
  delete_machine: (id) => invoke<void>('delete_machine', { id }),
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
  if (input.osVersion) profile.osVersion = input.osVersion;
  if (input.proxy) profile.proxy = input.proxy;
  if (input.proxyId) profile.proxyId = input.proxyId;
  if (input.templateId) profile.templateId = input.templateId;
  if (input.cookiesImport) profile.cookiesImport = input.cookiesImport;
  if (input.extensions) profile.extensions = input.extensions;
  if (input.folder) profile.folder = input.folder;
  if (input.notes) profile.notes = input.notes;
  return profile;
}

const mockStore = new Map<string, Profile>();
const mockProfilePasswords = new Map<string, string>();
const mockProxyStore = new Map<string, StoredProxy>();
const mockTemplateStore = new Map<string, ProfileTemplate>();

function buildStoredProxy(input: CreateStoredProxyInput): StoredProxy {
  const ts = nowIso();
  const id = input.config.id || crypto.randomUUID();
  return {
    id,
    source: input.source,
    label: input.label,
    config: { ...input.config, id, label: input.label },
    status: 'warning',
    createdAt: ts,
    updatedAt: ts,
    ...(input.location ? { location: input.location } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.rotateUrl ? { rotateUrl: input.rotateUrl } : {}),
  };
}

function buildTemplate(input: CreateProfileTemplateInput): ProfileTemplate {
  const ts = nowIso();
  const template: ProfileTemplate = {
    id: `tpl_${crypto.randomUUID().replaceAll('-', '')}`,
    name: input.name,
    engine: input.engine,
    os: input.os,
    presetParameters: input.presetParameters ?? [],
    tags: input.tags ?? [],
    createdAt: ts,
    updatedAt: ts,
  };
  if (input.osVersion) template.osVersion = input.osVersion;
  if (input.proxyId) template.proxyId = input.proxyId;
  if (input.proxyLabel) template.proxyLabel = input.proxyLabel;
  if (input.proxyDetail) template.proxyDetail = input.proxyDetail;
  if (input.fingerprintOverrides) template.fingerprintOverrides = input.fingerprintOverrides;
  if (input.cookiesImport) {
    if ('rawText' in (input.cookiesImport as object)) {
      throw new Error('cookie rawText is forbidden in profile templates');
    }
    template.cookiesImport = input.cookiesImport;
  }
  if (input.extensions) template.extensions = input.extensions;
  return template;
}

function seedMockStore(): void {
  const samples: CreateProfileInput[] = [
    {
      name: 'US Retail — Lobium',
      engine: 'lobium',
      os: 'windows',
      tags: ['retail', 'us'],
      folder: 'Shopping',
    },
    { name: 'EU Social — Lobium', engine: 'lobium', os: 'macos_arm', tags: ['social', 'eu'] },
    { name: 'Lobium QA', engine: 'lobium', os: 'linux', tags: ['qa'], folder: 'Internal' },
  ];
  for (const sample of samples) {
    const profile = buildProfile(sample);
    mockStore.set(profile.id, profile);
  }

  const proxySamples: CreateStoredProxyInput[] = [
    {
      source: 'mine',
      label: 'US Residential Gateway',
      config: {
        id: 'px-us-1',
        type: 'https',
        host: 'us-east.proxy.local',
        port: 9443,
        label: 'US Residential Gateway',
      },
      location: 'United States · New York',
      timezone: 'America/New_York',
    },
    {
      source: 'mine',
      label: 'DE Datacenter Backup',
      config: {
        id: 'px-de-1',
        type: 'socks5',
        host: 'de-fra.proxy.local',
        port: 1080,
        label: 'DE Datacenter Backup',
      },
      location: 'Germany · Frankfurt',
      timezone: 'Europe/Berlin',
    },
    {
      source: 'hive',
      label: 'Hive US Mobile Pool',
      config: {
        id: 'hive-us-mobile',
        type: 'https',
        host: 'managed-by-lobster.local',
        port: 443,
        label: 'Hive US Mobile Pool',
      },
      location: 'United States · rotating',
      timezone: 'Auto from exit IP',
    },
  ];
  for (const sample of proxySamples) {
    const proxy = buildStoredProxy(sample);
    const seeded: StoredProxy = {
      ...proxy,
      status: sample.source === 'hive' ? 'testing' : proxy.id === 'px-de-1' ? 'warning' : 'ready',
    };
    if (sample.source !== 'hive') seeded.latencyMs = proxy.id === 'px-de-1' ? 132 : 84;
    mockProxyStore.set(proxy.id, seeded);
  }

  const template = buildTemplate({
    name: 'US Retail Desktop',
    engine: 'lobium',
    os: 'windows',
    osVersion: 'Windows 11',
    presetParameters: ['User Agent', 'Extensions'],
    proxyId: 'px-us-1',
    proxyLabel: 'US Residential Gateway',
    proxyDetail: 'us-east.proxy.local:9443',
    tags: ['test'],
  });
  mockTemplateStore.set(template.id, template);
}

const mockClient: ProfilesClient = {
  list_profiles: async () =>
    Array.from(mockStore.values())
      .filter((p) => p.trashedAt === undefined)
      .map((p) => structuredClone(p)),

  list_trashed_profiles: async () =>
    Array.from(mockStore.values())
      .filter((p) => p.trashedAt !== undefined)
      .map((p) => structuredClone(p)),

  create_profile: async (input) => {
    const profile = buildProfile(input);
    mockStore.set(profile.id, profile);
    return structuredClone(profile);
  },

  get_profile: async (id) => {
    const existing = mockStore.get(id);
    if (!existing || existing.trashedAt !== undefined) throw new Error(`Profile ${id} not found`);
    return structuredClone(existing);
  },

  update_profile: async (id, patch) => {
    const existing = mockStore.get(id);
    if (!existing || existing.trashedAt !== undefined) throw new Error(`Profile ${id} not found`);
    const updated: Profile = { ...existing, ...patch, updatedAt: nowIso() };
    mockStore.set(id, updated);
    return structuredClone(updated);
  },

  delete_profile: async (id) => {
    const existing = mockStore.get(id);
    if (!existing || existing.trashedAt !== undefined) throw new Error(`Profile ${id} not found`);
    const ts = nowIso();
    mockStore.set(id, { ...existing, status: 'idle', trashedAt: ts, updatedAt: ts });
  },

  restore_profile: async (id) => {
    const existing = mockStore.get(id);
    if (!existing || existing.trashedAt === undefined) {
      throw new Error(`Trashed profile ${id} not found`);
    }
    const active = structuredClone(existing);
    delete active.trashedAt;
    mockStore.set(id, { ...active, updatedAt: nowIso() });
  },

  permanently_delete_profile: async (id) => {
    const existing = mockStore.get(id);
    if (!existing || existing.trashedAt === undefined) {
      throw new Error(`Trashed profile ${id} not found`);
    }
    mockStore.delete(id);
    mockProfilePasswords.delete(id);
  },

  set_profile_password: async (id, password) => {
    const existing = mockStore.get(id);
    if (!existing || existing.trashedAt !== undefined) throw new Error(`Profile ${id} not found`);
    mockStore.set(id, {
      ...existing,
      passwordProtected: Boolean(password && password.length > 0),
      updatedAt: nowIso(),
    });
    if (password && password.length > 0) mockProfilePasswords.set(id, password);
    else mockProfilePasswords.delete(id);
  },

  launch_profile: async (id, password) => {
    const existing = mockStore.get(id);
    if (!existing || existing.trashedAt !== undefined) throw new Error(`Profile ${id} not found`);
    if (existing.passwordProtected && mockProfilePasswords.get(id) !== password) {
      throw new Error('profile password is required or incorrect');
    }
    const port = 9222 + (mockStore.size % 100);
    mockStore.set(id, { ...existing, status: 'running', updatedAt: nowIso() });
    return {
      ws: `ws://127.0.0.1:${port}/devtools/browser/${id}`,
      debuggerAddress: `127.0.0.1:${port}`,
    };
  },

  stop_profile: async (id) => {
    const existing = mockStore.get(id);
    if (!existing || existing.trashedAt !== undefined) throw new Error(`Profile ${id} not found`);
    mockStore.set(id, { ...existing, status: 'idle', updatedAt: nowIso() });
  },
  export_profile_cookies: async (id) => {
    const existing = mockStore.get(id);
    if (!existing || existing.status !== 'running') throw new Error(`Profile ${id} is not running`);
    return '[]';
  },
  list_font_families: async () => [],
};

const mockProxiesClient: ProxiesClient = {
  list_proxies: async (source) =>
    Array.from(mockProxyStore.values())
      .filter((proxy) => source === undefined || proxy.source === source)
      .map((proxy) => structuredClone(proxy)),

  create_proxy: async (input) => {
    const proxy = buildStoredProxy(input);
    mockProxyStore.set(proxy.id, proxy);
    return structuredClone(proxy);
  },
  update_proxy: async (id, patch) => {
    const existing = mockProxyStore.get(id);
    if (!existing) throw new Error(`Proxy ${id} not found`);
    const updated: StoredProxy = {
      ...existing,
      ...patch,
      config: patch.config ?? existing.config,
      updatedAt: nowIso(),
      status: 'warning',
    };
    mockProxyStore.set(id, updated);
    return structuredClone(updated);
  },
  delete_proxy: async (id) => {
    if (!mockProxyStore.delete(id)) throw new Error(`Proxy ${id} not found`);
  },
  rotate_proxy: async (id) => {
    const existing = mockProxyStore.get(id);
    if (!existing?.rotateUrl) throw new Error(`Proxy ${id} has no rotation URL`);
    return { proxyId: id, rotatedAt: nowIso(), status: 200 };
  },

  test_proxy: async (id, config) => {
    const result: ProxyTestResult = {
      ok: true,
      latencyMs: 58,
      geo: {
        ip: '203.0.113.42',
        countryCode: 'US',
        region: 'NY',
        city: 'New York',
        timezone: 'America/New_York',
        isDatacenter: false,
      },
    };
    if (id !== null) {
      const existing = mockProxyStore.get(id);
      if (existing) {
        const checked: StoredProxy = {
          ...existing,
          config,
          status: 'ready',
          location: 'US · NY · New York',
          lastCheckedAt: nowIso(),
          updatedAt: nowIso(),
        };
        const timezone = result.geo?.timezone ?? existing.timezone;
        if (timezone) checked.timezone = timezone;
        if (result.latencyMs !== undefined) checked.latencyMs = result.latencyMs;
        mockProxyStore.set(id, checked);
      }
    }
    return structuredClone(result);
  },
};

const mockTemplatesClient: TemplatesClient = {
  list_templates: async () =>
    Array.from(mockTemplateStore.values()).map((template) => structuredClone(template)),

  create_template: async (input) => {
    const template = buildTemplate(input);
    mockTemplateStore.set(template.id, template);
    return structuredClone(template);
  },
};

/** In-memory mobile-machine store for the dev browser (no AVD host needed to exercise the UI). */
const mobileMachineStore: MobileMachine[] = [];
const mockMobileMachinesClient: MobileMachinesClient = {
  list_machines: async () => mobileMachineStore.map((m) => ({ ...m })),
  create_machine: async (input) => {
    const machine: MobileMachine = {
      id: `mm_${crypto.randomUUID().replaceAll('-', '')}`,
      name: input.name,
      config: {
        machineType: input.machineType,
        apiLevel: input.apiLevel,
        fingerprintSeed:
          input.fingerprintSeed ?? crypto.randomUUID().replaceAll('-', '').slice(0, 32),
        ...(input.fingerprintOverrides ? { fingerprintOverrides: input.fingerprintOverrides } : {}),
        ...(input.proxy ? { proxy: input.proxy } : {}),
        ...(input.proxyId ? { proxyId: input.proxyId } : {}),
        playServices: input.playServices ?? true,
        island: {
          builtIn: true,
          isolateOnInstall: input.island?.isolateOnInstall ?? [],
          freezeIdleApps: input.island?.freezeIdleApps ?? true,
        },
      },
      status: 'stopped',
      tags: input.tags ?? [],
      ...(input.notes ? { notes: input.notes } : {}),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    mobileMachineStore.unshift(machine);
    return { ...machine };
  },
  boot_machine: async (id) => {
    const m = mobileMachineStore.find((x) => x.id === id);
    if (!m) throw new Error('machine not found');
    m.status = 'running';
    m.adbSerial = 'emulator-5554';
    m.updatedAt = nowIso();
    return { ...m };
  },
  stop_machine: async (id) => {
    const m = mobileMachineStore.find((x) => x.id === id);
    if (!m) throw new Error('machine not found');
    m.status = 'stopped';
    delete m.adbSerial;
    m.updatedAt = nowIso();
    return { ...m };
  },
  delete_machine: async (id) => {
    const i = mobileMachineStore.findIndex((x) => x.id === id);
    if (i >= 0) mobileMachineStore.splice(i, 1);
  },
};

/** The active client — real bridge in the desktop shell, in-memory mock in a dev browser. */
export const profilesClient: ProfilesClient = isDesktopRuntime() ? tauriClient : mockClient;
export const proxiesClient: ProxiesClient = isDesktopRuntime()
  ? tauriProxiesClient
  : mockProxiesClient;
export const templatesClient: TemplatesClient = isDesktopRuntime()
  ? tauriTemplatesClient
  : mockTemplatesClient;
export const mobileMachinesClient: MobileMachinesClient = isDesktopRuntime()
  ? tauriMobileMachinesClient
  : mockMobileMachinesClient;

if (!isDesktopRuntime()) {
  seedMockStore();
}
