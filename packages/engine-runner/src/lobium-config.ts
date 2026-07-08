import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashStringToUint32 } from '@lobster/fingerprint';
import type {
  Fingerprint,
  FingerprintLaunchPolicy,
  HardwareNoisePolicy,
  MediaDeviceProfile,
  ProxyConfig,
  RendererPolicy,
  WebRtcPolicy,
} from '@lobster/shared-types';

/**
 * The **Lobium config channel** (per `lobium/config-channel.md`, ticket T-011).
 *
 * The orchestrator sets all fingerprint parameters **natively** (no JS tell) by serializing a
 * profile's resolved {@link Fingerprint} — plus deterministic per-profile farbling seeds and a small
 * network envelope — to a per-profile JSON file, and pointing the native Lobium binary at it with
 * `--lobium-fp-config=<path>`. Lobium parses it once at startup and feeds each C++ subsystem
 * (navigator, screen, WebGL, canvas/audio farbling, timezone/locale, WebRTC policy).
 *
 * This module is the **sidecar side** of that channel — pure, deterministic, and unit-tested. The
 * native reader is the `core/config-channel` patch in `lobium/patches/`. The shape here is the single
 * source of truth both sides serialize/parse, so the UI, sidecar, and Lobium never drift.
 *
 * SECURITY: this file carries NO secrets. Proxy credentials are passed to the engine out-of-band
 * (`--proxy-server` + auth), never written here, so a leaked config file cannot expose them.
 */

export const LOBIUM_CONFIG_VERSION = 1;
export const LOBIUM_CONFIG_FILENAME = 'lobium-fp.json';

/** The per-profile farbling seeds the native canvas/WebGL/audio patches read (stable per profile). */
export interface LobiumFarblingSeeds {
  canvas: number;
  webgl: number;
  audio: number;
}

export interface LobiumNetConfig {
  /** WebRTC IP-handling policy — matches the interim engine's flag (see launch.ts). */
  webrtcPolicy: WebRtcPolicy;
  /** Non-secret proxy summary (type/host/port only — never credentials). */
  proxy?: { type: string; host: string; port: number };
}

export interface LobiumPolicyConfig extends FingerprintLaunchPolicy {
  /** Profile-selected OS build/version label, when present. */
  osVersion?: string;
}

/** The exact JSON document written to `lobium-fp.json` and parsed by the native config-channel patch. */
export interface LobiumConfig {
  version: number;
  /** CPU architecture the persona presents — drives Sec-CH-UA-Arch natively (arm64 for Apple Silicon). */
  arch: Fingerprint['arch'];
  navigator: Fingerprint['navigator'];
  screen: Fingerprint['screen'];
  webgl: Fingerprint['webgl'];
  locale: Fingerprint['locale'];
  fonts: string[];
  seeds: LobiumFarblingSeeds;
  policy: LobiumPolicyConfig;
  net: LobiumNetConfig;
}

export interface BuildLobiumConfigOptions {
  /** Non-secret proxy summary — only type/host/port are recorded (credentials never touch this file). */
  proxy?: Pick<ProxyConfig, 'type' | 'host' | 'port'>;
  /** The profile's fingerprint seed; farbling seeds derive from it (else from a fingerprint signature). */
  seed?: string;
  osVersion?: string;
  webrtcPolicy?: WebRtcPolicy;
  rendererPolicy?: RendererPolicy;
  hardwareNoise?: Partial<HardwareNoisePolicy>;
  mediaDevices?: Partial<MediaDeviceProfile>;
}

const DEFAULT_HARDWARE_NOISE: HardwareNoisePolicy = {
  webgl: true,
  canvas: true,
  audio: true,
  clientRects: false,
};

const DEFAULT_MEDIA_DEVICES: MediaDeviceProfile = {
  cameras: 1,
  microphones: 1,
  speakers: 2,
  stableDeviceIds: true,
};

const DEFAULT_RENDERER_POLICY: RendererPolicy = { mode: 'host' };

/** A stable signature of a fingerprint — the fallback basis for farbling seeds when no seed is given. */
function fingerprintSignature(fp: Fingerprint): string {
  return [fp.os, fp.navigator.userAgent, fp.webgl.renderer, fp.screen.width, fp.screen.height].join(
    '|',
  );
}

/**
 * Build the native Lobium config for a resolved fingerprint. The farbling seeds are derived
 * deterministically from the profile seed (or a fingerprint signature), so canvas/WebGL/audio noise
 * is **stable per profile** across launches — the anti-detect requirement.
 */
export function buildLobiumConfig(
  fp: Fingerprint,
  opts: BuildLobiumConfigOptions = {},
): LobiumConfig {
  const base = opts.seed ?? fingerprintSignature(fp);
  const webrtcPolicy =
    opts.webrtcPolicy ?? (opts.proxy ? 'disable_non_proxied_udp' : 'default_public_interface_only');
  const net: LobiumNetConfig = {
    webrtcPolicy,
  };
  if (opts.proxy) {
    // type/host/port only — credentials are handled out-of-band and never persisted here.
    net.proxy = { type: opts.proxy.type, host: opts.proxy.host, port: opts.proxy.port };
  }
  const policy: LobiumPolicyConfig = {
    renderer: opts.rendererPolicy ?? DEFAULT_RENDERER_POLICY,
    webrtc: webrtcPolicy,
    hardwareNoise: { ...DEFAULT_HARDWARE_NOISE, ...opts.hardwareNoise },
    mediaDevices: { ...DEFAULT_MEDIA_DEVICES, ...opts.mediaDevices },
  };
  if (opts.osVersion) policy.osVersion = opts.osVersion;
  return {
    version: LOBIUM_CONFIG_VERSION,
    arch: fp.arch,
    navigator: fp.navigator,
    screen: fp.screen,
    webgl: fp.webgl,
    locale: fp.locale,
    fonts: fp.fonts,
    seeds: {
      canvas: hashStringToUint32(`${base}:canvas`),
      webgl: hashStringToUint32(`${base}:webgl`),
      audio: hashStringToUint32(`${base}:audio`),
    },
    policy,
    net,
  };
}

/** Write the config to `<userDataDir>/lobium-fp.json` (owner-only, 0600) and return its path. */
export async function writeLobiumConfig(
  userDataDir: string,
  config: LobiumConfig,
): Promise<string> {
  await mkdir(userDataDir, { recursive: true });
  const path = join(userDataDir, LOBIUM_CONFIG_FILENAME);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/** The Lobium command-line flag that points the native engine at a written config file. */
export function lobiumConfigArg(configPath: string): string {
  return `--lobium-fp-config=${configPath}`;
}
