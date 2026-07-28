import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { FingerprintLaunchPolicy } from '@lobster/shared-types';

const execFileAsync = promisify(execFile);

export const LOBIUM_CAPABILITY_SWITCH = '--lobium-fingerprint-capabilities';
export const LOBIUM_CAPABILITY_CONTRACT_VERSION = 1;

export const LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES = [
  'config-channel-v1',
  'navigator-languages',
  'network-accept-language',
  'process-locale-timezone',
  'native-geolocation',
  'webrtc-policy',
  'webgl-deep',
  'canvas-farbling',
  'webgl-farbling',
  'audio-farbling',
  'client-rects',
  'media-devices',
] as const;

export type LobiumNativeFingerprintCapability =
  (typeof LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES)[number];

export interface LobiumBuildCapabilities {
  contractVersion: number;
  product: 'Lobium';
  capabilities: LobiumNativeFingerprintCapability[];
}

const KNOWN_CAPABILITIES = new Set<string>(LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES);
const probeCache = new Map<string, Promise<LobiumBuildCapabilities>>();

function parseCapabilities(stdout: string, executablePath: string): LobiumBuildCapabilities {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new Error(
      `Lobium binary ${executablePath} did not return a valid native capability manifest`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Lobium binary ${executablePath} returned an invalid capability manifest`);
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.contractVersion !== LOBIUM_CAPABILITY_CONTRACT_VERSION ||
    manifest.product !== 'Lobium' ||
    !Array.isArray(manifest.capabilities) ||
    manifest.capabilities.some(
      (capability) => typeof capability !== 'string' || !KNOWN_CAPABILITIES.has(capability),
    )
  ) {
    throw new Error(
      `Lobium binary ${executablePath} has an incompatible native capability contract`,
    );
  }
  return {
    contractVersion: LOBIUM_CAPABILITY_CONTRACT_VERSION,
    product: 'Lobium',
    capabilities: [...new Set(manifest.capabilities)] as LobiumNativeFingerprintCapability[],
  };
}

/**
 * Ask the exact executable that will be spawned which native hooks it contains. An old/unpatched
 * Chromium binary either times out or returns no manifest and is rejected; filename/version claims are
 * deliberately not trusted.
 */
export async function probeLobiumBuildCapabilities(
  executablePath: string,
): Promise<LobiumBuildCapabilities> {
  const info = await stat(executablePath);
  const cacheKey = `${executablePath}:${info.size}:${info.mtimeMs}`;
  let pending = probeCache.get(cacheKey);
  if (!pending) {
    pending = execFileAsync(executablePath, [LOBIUM_CAPABILITY_SWITCH], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    })
      .then(({ stdout }) => parseCapabilities(stdout, executablePath))
      .catch((error: unknown) => {
        probeCache.delete(cacheKey);
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `cannot prove native fingerprint capabilities for ${executablePath}: ${detail}`,
        );
      });
    probeCache.set(cacheKey, pending);
  }
  return pending;
}

export function requiredLobiumCapabilities(
  policy: FingerprintLaunchPolicy,
  hasConfiguredGeolocation: boolean,
): LobiumNativeFingerprintCapability[] {
  const required: LobiumNativeFingerprintCapability[] = [
    'config-channel-v1',
    'navigator-languages',
    'network-accept-language',
    'process-locale-timezone',
    'webrtc-policy',
    'webgl-deep',
    'media-devices',
  ];
  if (hasConfiguredGeolocation) required.push('native-geolocation');
  if (policy.hardwareNoise.canvas) required.push('canvas-farbling');
  if (policy.hardwareNoise.webgl) required.push('webgl-farbling');
  if (policy.hardwareNoise.audio) required.push('audio-farbling');
  if (policy.hardwareNoise.clientRects) required.push('client-rects');
  return required;
}

export function assertLobiumBuildCapabilities(
  manifest: LobiumBuildCapabilities,
  required: readonly LobiumNativeFingerprintCapability[],
): void {
  const available = new Set(manifest.capabilities);
  const missing = required.filter((capability) => !available.has(capability));
  if (missing.length > 0) {
    throw new Error(`Lobium build lacks required native fingerprint hooks: ${missing.join(', ')}`);
  }
}
