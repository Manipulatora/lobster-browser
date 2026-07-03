import type { EngineKind, OsFamily } from './engine.js';
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
  os: OsFamily;
  /** Deterministic seed → stable coherent fingerprint. */
  fingerprintSeed: FingerprintSeed;
  fingerprintOverrides?: FingerprintOverrides;
  /** Inline proxy, or a reference id resolved from the proxy store. */
  proxy?: ProxyConfig;
  tags: string[];
  folder?: string;
  notes?: string;
  status: ProfileStatus;
  ownerTeamId?: string;
  sharing?: ProfileSharing;
  createdAt: string;
  updatedAt: string;
}

/** Fields accepted when creating a profile (server/store fills the rest). */
export interface CreateProfileInput {
  name: string;
  engine: EngineKind;
  os: OsFamily;
  fingerprintSeed?: FingerprintSeed;
  fingerprintOverrides?: FingerprintOverrides;
  proxy?: ProxyConfig;
  tags?: string[];
  folder?: string;
  notes?: string;
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
  os: OsFamily;
  fingerprintSeed: FingerprintSeed;
  fingerprintOverrides?: FingerprintOverrides;
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
