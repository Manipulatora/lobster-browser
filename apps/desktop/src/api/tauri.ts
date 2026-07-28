import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type {
  AgentConfig,
  AgentEvent,
  AgentLlmConfig,
  AgentLlmProvider,
  AgentSendInputResult,
  AgentStartResult,
  AgentStatusResult,
  AgentStopResult,
  CreateProfileInput,
  CreateProfileTemplateInput,
  CreateStoredProxyInput,
  FingerprintSeed,
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
 * The per-profile web-agent command surface. `start` kicks off a run on an ALREADY-LAUNCHED profile
 * and returns immediately; live progress arrives via {@link AgentClient.onEvent} (streamed by the
 * sidecar → Rust → the `agent-event` Tauri event). One agent per profile — starting again while one
 * runs is rejected by the sidecar.
 */
export interface AgentClient {
  start(
    id: string,
    task: string,
    llm: AgentLlmConfig,
    config?: Partial<AgentConfig>,
  ): Promise<AgentStartResult>;
  stop(id: string): Promise<AgentStopResult>;
  sendInput(id: string, text: string): Promise<AgentSendInputResult>;
  status(id?: string): Promise<AgentStatusResult>;
  apiKeyStatus(provider: AgentLlmConfig['provider']): Promise<{ stored: boolean }>;
  /** Save in the Rust encrypted store; null forgets the provider key. */
  setApiKey(
    provider: AgentLlmConfig['provider'],
    apiKey: string | null,
  ): Promise<{ stored: boolean }>;
  /** Validate a BYOK key and list its usable chat models (uses `apiKey` if given, else the stored key). */
  listModels(provider: AgentLlmConfig['provider'], apiKey?: string): Promise<{ models: string[] }>;
  /** Subscribe to ALL agent events (every profile); the caller filters by `profileId`. Returns unsubscribe. */
  onEvent(cb: (event: AgentEvent) => void): () => void;
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

/* --------------------------------------------------------------------------------------------
 * Agent client
 * ------------------------------------------------------------------------------------------ */

const tauriAgentClient: AgentClient = {
  start: (id, task, llm, config) =>
    invoke<AgentStartResult>('agent_start', { id, task, llm, config: config ?? null }),
  stop: (id) => invoke<AgentStopResult>('agent_stop', { id }),
  sendInput: (id, text) => invoke<AgentSendInputResult>('agent_send_input', { id, text }),
  status: (id) => invoke<AgentStatusResult>('agent_status', { id: id ?? null }),
  apiKeyStatus: (provider) => invoke<{ stored: boolean }>('agent_api_key_status', { provider }),
  setApiKey: (provider, apiKey) =>
    invoke<{ stored: boolean }>('agent_set_api_key', { provider, apiKey }),
  listModels: (provider, apiKey) =>
    invoke<{ models: string[] }>('agent_list_models', { provider, apiKey: apiKey ?? null }),
  onEvent: (cb) => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<AgentEvent>('agent-event', (e) => cb(e.payload)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  },
};

/**
 * In-browser mock: drives a believable scripted run so the Agent panel is fully exercisable under
 * `vite dev` without the desktop core. Events fan out to every registered listener, mirroring the real
 * broadcast.
 */
const mockAgentListeners = new Set<(e: AgentEvent) => void>();
const mockAgentTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
const mockAgentKeys = new Set<AgentLlmProvider>();

function emitMock(e: AgentEvent): void {
  for (const cb of mockAgentListeners) cb(e);
}

const mockAgentClient: AgentClient = {
  start: async (id, task) => {
    const sessionId = crypto.randomUUID();
    const ts = (): string => new Date().toISOString();
    const base = { sessionId, profileId: id };
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void): void => {
      timers.push(setTimeout(fn, ms));
    };
    emitMock({ type: 'run.started', ...base, task, ts: ts() });
    at(400, () => emitMock({ type: 'step.thinking', ...base, step: 1, ts: ts() }));
    at(900, () =>
      emitMock({
        type: 'step.observation',
        ...base,
        step: 1,
        url: 'https://example.com/',
        title: 'Example',
        summary: 'url: https://example.com/  |  "Example"',
        elementCount: 6,
        ts: ts(),
      }),
    );
    at(1200, () =>
      emitMock({
        type: 'step.action',
        ...base,
        step: 1,
        action: { kind: 'type', id: 2, text: task.slice(0, 24), submit: true },
        ts: ts(),
      }),
    );
    at(1400, () =>
      emitMock({ type: 'usage', ...base, usage: { tokensIn: 820, tokensOut: 40 }, ts: ts() }),
    );
    at(2000, () =>
      emitMock({
        type: 'run.finished',
        ...base,
        status: 'done',
        result: `(mock) Completed: ${task}`,
        usage: { tokensIn: 1640, tokensOut: 95 },
        ts: ts(),
      }),
    );
    mockAgentTimers.set(id, timers);
    return { sessionId, profileId: id };
  },
  stop: async (id) => {
    const timers = mockAgentTimers.get(id);
    if (timers) {
      for (const t of timers) clearTimeout(t);
      mockAgentTimers.delete(id);
      emitMock({
        type: 'run.finished',
        sessionId: 'mock',
        profileId: id,
        status: 'stopped',
        result: 'Stopped by user.',
        usage: { tokensIn: 0, tokensOut: 0 },
        ts: new Date().toISOString(),
      });
      return { stopped: true };
    }
    return { stopped: false };
  },
  sendInput: async () => ({ delivered: true }),
  status: async () => ({ runs: [] }),
  apiKeyStatus: async (provider) => ({ stored: mockAgentKeys.has(provider) }),
  listModels: async (provider) => {
    const byProvider: Record<string, string[]> = {
      anthropic: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
      openai: ['gpt-4o', 'gpt-4o-mini', 'o4-mini'],
      openrouter: ['anthropic/claude-opus-4.8', 'openai/gpt-4o-mini', 'google/gemini-2.5-pro'],
      google: ['gemini-2.5-pro', 'gemini-2.0-flash'],
      xai: ['grok-4', 'grok-3-mini'],
    };
    return { models: byProvider[provider] ?? [] };
  },
  setApiKey: async (provider, apiKey) => {
    if (apiKey) mockAgentKeys.add(provider);
    else mockAgentKeys.delete(provider);
    return { stored: mockAgentKeys.has(provider) };
  },
  onEvent: (cb) => {
    mockAgentListeners.add(cb);
    return () => mockAgentListeners.delete(cb);
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
export const agentClient: AgentClient = isDesktopRuntime() ? tauriAgentClient : mockAgentClient;

if (!isDesktopRuntime()) {
  seedMockStore();
}
