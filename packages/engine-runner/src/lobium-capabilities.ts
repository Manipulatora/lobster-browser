import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { FingerprintLaunchPolicy } from '@lobster/shared-types';

const execFileAsync = promisify(execFile);

export const LOBIUM_CAPABILITY_SWITCH = '--lobium-fingerprint-capabilities';
export const LOBIUM_CAPABILITY_CONTRACT_VERSION = 1;

/**
 * Mirror of the list in `lobium/src/lobium_capabilities.cc`, which is the single source of truth —
 * it sits beside the hooks it describes, so it cannot claim a hook that was never compiled.
 *
 * `ci/validation/patch-series.test.mjs` fails the build if the two lists diverge. This copy exists
 * only so TypeScript can type-check capability names; it is never the authority on what a binary
 * actually contains — that comes from probing the binary itself.
 */
export const LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES = [
  'config-channel-v1',
  /** UA, UA-CH brands, platform, hardwareConcurrency, deviceMemory and maxTouchPoints. */
  'navigator-ua-ch',
  'navigator-languages',
  'network-accept-language',
  'process-locale-timezone',
  'native-geolocation',
  'webrtc-policy',
  'webgl-deep',
  'webgl2-deep',
  'screen-metrics',
  /** Compiled everywhere, but only meaningful for an Android persona, so never required on desktop. */
  'mobile-persona',
  'canvas-farbling',
  'webgl-farbling',
  'audio-farbling',
  'client-rects',
  'media-devices',
  'webgpu-adapter',
  'native-timezone',
  /** Windows-only: the engine reports it just on win64 builds, so never require it elsewhere. */
  'font-isolation',
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
  platform: NodeJS.Platform = process.platform,
): LobiumNativeFingerprintCapability[] {
  const required: LobiumNativeFingerprintCapability[] = [
    'config-channel-v1',
    // navigator.userAgent, the Sec-CH-UA family, navigator.platform, hardwareConcurrency and
    // deviceMemory. Unconditional, and the most important entry in this list: a build that has the
    // config channel but not this hook accepts the persona, launches successfully, and then reports
    // the HOST's identity on the surfaces every detector reads first — a failure that looks exactly
    // like a working profile until the account is banned.
    'navigator-ua-ch',
    'navigator-languages',
    'network-accept-language',
    'process-locale-timezone',
    'webrtc-policy',
    'webgl-deep',
    // Required alongside webgl-deep, not instead of it: a build with only the WebGL1 hooks lets a
    // WebGL2 context report the host's extension list and component limits while WebGL1 reports the
    // persona's, so the two contexts disagree on one page. That is worse than neither being spoofed.
    'webgl2-deep',
    // screen.*, devicePixelRatio and the CSS device-size media values. Unconditional: every persona
    // claims a display, and an unspoofed screen block contradicts the rest of the persona outright.
    'screen-metrics',
    'media-devices',
    // navigator.gpu names the same GPU as WEBGL_debug_renderer_info. Unconditional for the same
    // reason: an unhooked WebGPU adapter reports the real card next to a spoofed WebGL renderer.
    'webgpu-adapter',
    // Applied inside the engine because the TZ environment variable is POSIX-only. On Windows the
    // process-locale route is a no-op, so without this hook the persona timezone silently does not
    // apply at all — the failure mode that made this a required capability rather than an optional
    // one.
    'native-timezone',
  ];
  if (hasConfiguredGeolocation) required.push('native-geolocation');
  // Windows resolves fonts through DirectWrite in the browser process; Linux and macOS reach the
  // same isolation through the launcher's per-profile FONTCONFIG_FILE, which is not a property of
  // the binary. Requiring it everywhere would fail launches on platforms that never compile it.
  if (platform === 'win32') required.push('font-isolation');
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
