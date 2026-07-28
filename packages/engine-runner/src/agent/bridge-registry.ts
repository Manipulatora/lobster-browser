import { randomBytes } from 'node:crypto';

/**
 * Process-singleton registry that lets the in-browser Lobee side panel drive its own profile's agent
 * over the loopback bridge, safely.
 *
 * Each launched profile gets an unguessable per-profile token (written into that profile's Lobee
 * extension snapshot, which no web page can read) mapped to the profile id + the secrets a run needs
 * (its encrypted-memory dir + key). A bridge request authenticates by token, so a panel can only ever
 * act on ITS profile, and the sensitive memory key never leaves this process. The bridge origin is the
 * loopback URL of the sidecar's bridge server (set once when it starts).
 */
interface ProfileEntry {
  profileId: string;
  token: string;
  memoryDir?: string;
  memoryKey?: string;
}

const byProfile = new Map<string, ProfileEntry>();
const byToken = new Map<string, string>();
let bridgeOrigin = '';

function ensure(profileId: string): ProfileEntry {
  let entry = byProfile.get(profileId);
  if (!entry) {
    const token = randomBytes(32).toString('base64url');
    entry = { profileId, token };
    byProfile.set(profileId, entry);
    byToken.set(token, profileId);
  }
  return entry;
}

/** The loopback origin (e.g. `http://127.0.0.1:PORT`) of the bridge server; set when it starts. */
export function setBridgeOrigin(origin: string): void {
  bridgeOrigin = origin;
}
export function getBridgeOrigin(): string {
  return bridgeOrigin;
}

/** Issue (or return) the stable per-profile bridge token. Called by the launcher when it snapshots Lobee. */
export function issueBridgeToken(profileId: string): string {
  return ensure(profileId).token;
}

/** Provision the per-profile run secrets (memory dir + key). Upserts; safe to call before/after token issue. */
export function provisionProfile(
  profileId: string,
  secrets: { memoryDir?: string; memoryKey?: string },
): void {
  const entry = ensure(profileId);
  if (secrets.memoryDir !== undefined) entry.memoryDir = secrets.memoryDir;
  if (secrets.memoryKey !== undefined) entry.memoryKey = secrets.memoryKey;
}

/** Resolve a bridge token to its profile + secrets, or `undefined` when the token is unknown. */
export function resolveBridgeToken(token: string): ProfileEntry | undefined {
  const profileId = byToken.get(token);
  return profileId ? byProfile.get(profileId) : undefined;
}

/** Forget a profile (e.g. on browser close) so a stale token can't be reused. */
export function forgetProfile(profileId: string): void {
  const entry = byProfile.get(profileId);
  if (!entry) return;
  byToken.delete(entry.token);
  byProfile.delete(profileId);
}
