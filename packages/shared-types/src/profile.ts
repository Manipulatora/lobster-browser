import type { EngineKind, ProfileOsTarget } from './engine.js';
import type { FingerprintOverrides, FingerprintSeed } from './fingerprint.js';
import type { ProxyConfig } from './proxy.js';

export type ProfileStatus = 'idle' | 'launching' | 'running' | 'stopping' | 'error';

/** How a profile is shared within a team. */
export interface ProfileSharing {
  /** Team members (by role) that may open this profile. */
  visibleToRoles: Array<'admin' | 'member'>;
}

export interface Profile {
  id: string;
  name: string;
  engine: EngineKind;
  os: ProfileOsTarget;
  /** OS build/version label, e.g. Windows 11 23H2 or macOS 14. */
  osVersion?: string;
  /** Deterministic seed → stable coherent fingerprint. */
  fingerprintSeed: FingerprintSeed;
  fingerprintOverrides?: FingerprintOverrides;
  /** Inline proxy, or a reference id resolved from the proxy store. */
  proxy?: ProxyConfig;
  proxyId?: string;
  templateId?: string;
  cookiesImport?: CookieImportDraft;
  extensions?: BrowserExtensionRef[];
  tags: string[];
  folder?: string;
  notes?: string;
  status: ProfileStatus;
  passwordProtected?: boolean;
  ownerTeamId?: string;
  sharing?: ProfileSharing;
  /** Store-owned soft-delete marker; active profile lists omit rows where this is set. */
  trashedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Fields accepted when creating a profile (server/store fills the rest). */
export interface CreateProfileInput {
  name: string;
  engine: EngineKind;
  os: ProfileOsTarget;
  osVersion?: string;
  fingerprintSeed?: FingerprintSeed;
  fingerprintOverrides?: FingerprintOverrides;
  proxy?: ProxyConfig;
  proxyId?: string;
  templateId?: string;
  cookiesImport?: CookieImportDraft;
  extensions?: BrowserExtensionRef[];
  tags?: string[];
  folder?: string;
  notes?: string;
}

export interface ProfileTemplate {
  id: string;
  name: string;
  engine: EngineKind;
  os: ProfileOsTarget;
  osVersion?: string;
  presetParameters: string[];
  proxyId?: string;
  proxyLabel?: string;
  proxyDetail?: string;
  fingerprintOverrides?: FingerprintOverrides;
  /** Templates may carry import behavior/diagnostics, never a pending cookie secret. */
  cookiesImport?: CookieImportMetadata;
  extensions?: BrowserExtensionRef[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateProfileTemplateInput {
  name: string;
  engine: EngineKind;
  os: ProfileOsTarget;
  osVersion?: string;
  presetParameters?: string[];
  proxyId?: string;
  proxyLabel?: string;
  proxyDetail?: string;
  fingerprintOverrides?: FingerprintOverrides;
  /** rawText is deliberately forbidden in templates. */
  cookiesImport?: CookieImportMetadata;
  extensions?: BrowserExtensionRef[];
  tags?: string[];
}

export type CookieImportMode = 'merge' | 'replace' | 'empty';
export type CookieImportSource = 'file' | 'plain_text';

export interface CookieImportDraft {
  mode: CookieImportMode;
  source?: CookieImportSource;
  fileName?: string;
  rawText?: string;
  parsedCount?: number;
  errors?: Array<{ line?: number; message: string }>;
}

/** Non-secret cookie import diagnostics safe to sync/export. The cookie payload itself stays local. */
export type CookieImportMetadata = Omit<CookieImportDraft, 'rawText'>;

export interface BrowserExtensionRef {
  source: 'chrome_web_store' | 'unpacked';
  enabled: boolean;
  /** Chrome Web Store extension id (32 lowercase a-p characters). Derived from `url` when omitted. */
  id?: string;
  name?: string;
  /** Canonical Chrome Web Store detail URL. Never used as an arbitrary download URL. */
  url?: string;
  /** Absolute local directory for `unpacked` sources. The launcher snapshots it into the profile. */
  path?: string;
  /** Last known install state, persisted so profile editors can show actionable state. */
  installState?: 'pending' | 'ready' | 'disabled' | 'error';
  /** Human-readable failure from the last install attempt; safe to display, never silently ignored. */
  installError?: string;
}

/**
 * A portable, SECRET-FREE snapshot of a profile used for export / import / transfer between teams and
 * accounts. It carries only the deterministic identity (`fingerprintSeed`) + non-secret metadata —
 * never the encrypted blob (cookies/storage) or any server/team ids. Importing it re-materialises the
 * same coherent fingerprint identity under the importing team.
 */
export interface ProfileExport {
  name: string;
  engine: EngineKind;
  os: ProfileOsTarget;
  osVersion?: string;
  fingerprintSeed: FingerprintSeed;
  fingerprintOverrides?: FingerprintOverrides;
  proxyId?: string;
  templateId?: string;
  cookiesImport?: CookieImportMetadata;
  extensions?: BrowserExtensionRef[];
  tags: string[];
  folder?: string;
  notes?: string;
}

/** Versioned envelope for a bundle of exported profiles (the import/export/transfer wire format). */
export interface ProfileExportBundle {
  /** Bump on any breaking change to `ProfileExport`. */
  version: 1;
  exportedAt: string;
  profiles: ProfileExport[];
}
