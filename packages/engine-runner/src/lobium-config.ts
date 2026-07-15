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
/** Must stay equal to kMaxLobiumFpDataBytes in core/config-channel.patch. */
export const LOBIUM_MAX_RENDERER_CONFIG_BASE64_BYTES = 28 * 1024;

/** The per-profile farbling seeds the native canvas/WebGL/audio patches read (stable per profile). */
export interface LobiumFarblingSeeds {
  canvas: number;
  webgl: number;
  audio: number;
  /** Sub-pixel getClientRects / getBoundingClientRect noise; 0 disables the native hook. */
  clientRects: number;
  /** Always-on profile identity seed for stable media device IDs (independent of noise switches). */
  mediaDevices: number;
}

export interface LobiumNetConfig {
  /** WebRTC IP-handling policy — mirrored in launch hardening flags and consumed by native Lobium. */
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
/**
 * Fail-closed guard: assert the generated native config carries every critical spoofing surface before
 * it is handed to the engine. The native parser fails OPEN (a missing field leaves the HOST value), so a
 * silently-incomplete config would ship a mixed host/persona fingerprint while the launch reported
 * success. Aborting here turns that into a loud launch failure instead of a stealth leak.
 */
export function validateLobiumConfig(config: LobiumConfig): void {
  const missing: string[] = [];
  const need = (ok: boolean, field: string): void => {
    if (!ok) missing.push(field);
  };
  const str = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
  const posNum = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;

  need(config.version === LOBIUM_CONFIG_VERSION, `version (expected ${LOBIUM_CONFIG_VERSION})`);
  const n = config.navigator;
  need(str(n?.userAgent), 'navigator.userAgent');
  need(str(n?.platform), 'navigator.platform');
  need(posNum(n?.hardwareConcurrency), 'navigator.hardwareConcurrency');
  need(posNum(n?.deviceMemory), 'navigator.deviceMemory');
  need(Array.isArray(n?.languages) && n.languages.length > 0, 'navigator.languages');
  need(Array.isArray(n?.uaBrands) && n.uaBrands.length > 0, 'navigator.uaBrands');
  need(str(n?.uaPlatform), 'navigator.uaPlatform');
  const s = config.screen;
  need(posNum(s?.width), 'screen.width');
  need(posNum(s?.height), 'screen.height');
  need(posNum(s?.devicePixelRatio), 'screen.devicePixelRatio');
  need(posNum(s?.colorDepth), 'screen.colorDepth');
  const w = config.webgl;
  need(str(w?.unmaskedVendor), 'webgl.unmaskedVendor');
  need(str(w?.unmaskedRenderer), 'webgl.unmaskedRenderer');
  const l = config.locale;
  need(str(l?.timezone), 'locale.timezone');
  need(str(l?.locale), 'locale.locale');
  need(str(l?.acceptLanguage), 'locale.acceptLanguage');

  if (missing.length > 0) {
    throw new Error(
      `refusing to launch: incomplete Lobium fingerprint config — missing/invalid ${missing.join(', ')}. ` +
        'Launching would leave the HOST value on these surfaces (the native config channel fails open), ' +
        'producing a mixed host/persona fingerprint.',
    );
  }
}

export function buildLobiumConfig(
  fp: Fingerprint,
  opts: BuildLobiumConfigOptions = {},
): LobiumConfig {
  const base = opts.seed ?? fingerprintSignature(fp);
  const webrtcPolicy =
    opts.webrtcPolicy ?? (opts.proxy ? 'disable_non_proxied_udp' : 'default_public_interface_only');
  if (webrtcPolicy === 'proxy_only' && !opts.proxy) {
    throw new Error('Lobium WebRTC proxy_only policy requires a configured proxy');
  }
  if (webrtcPolicy === 'default_public_interface_only' && opts.proxy) {
    throw new Error(
      'Lobium WebRTC default_public_interface_only is unsafe with a proxy because host ICE may bypass it',
    );
  }
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
  const noise = policy.hardwareNoise;
  // Gate farbling seeds by Hardware noise checkboxes. A zero seed disables native farbling for that
  // surface (Lobium treats seed==0 as off).
  //
  // fonts: intentionally empty in the native channel. Lobium does not yet consume cfg.fonts (font
  // isolation is FONTCONFIG_FILE / LOBSTER_FONTS_DIR packaging). Shipping the full OS catalog here
  // (macOS ~2500 names) base64-blows past the renderer command-line size guard (~24 KiB), so the
  // browser silently drops --lobium-fp-data and workers leak host platform/HWC — a CreepJS lie.
  // Keep the field for schema stability; populate only when a non-cmdline transport exists.
  const config: LobiumConfig = {
    version: LOBIUM_CONFIG_VERSION,
    arch: fp.arch,
    navigator: fp.navigator,
    screen: fp.screen,
    webgl: fp.webgl,
    locale: fp.locale,
    fonts: [],
    seeds: {
      canvas: noise.canvas ? hashStringToUint32(`${base}:canvas`) : 0,
      webgl: noise.webgl ? hashStringToUint32(`${base}:webgl`) : 0,
      audio: noise.audio ? hashStringToUint32(`${base}:audio`) : 0,
      clientRects: noise.clientRects ? hashStringToUint32(`${base}:clientRects`) : 0,
      // Do not derive media IDs from the gated canvas/WebGL seeds. With both noise toggles off those
      // seeds are zero, which previously made every profile expose the same linkable device IDs.
      mediaDevices: hashStringToUint32(`${base}:mediaDevices`),
    },
    policy,
    net,
  };
  // Fail-closed: abort the launch rather than ship a silently-incomplete (host-leaking) config.
  validateLobiumConfig(config);
  return config;
}

/** Write the config to `<userDataDir>/lobium-fp.json` (owner-only, 0600) and return its path. */
export async function writeLobiumConfig(
  userDataDir: string,
  config: LobiumConfig,
): Promise<string> {
  await mkdir(userDataDir, { recursive: true });
  const path = join(userDataDir, LOBIUM_CONFIG_FILENAME);
  // Compact JSON: the browser base64-forwards this onto the renderer command line (Windows ~32K
  // CreateProcess cap). Pretty-print would waste budget for no benefit at runtime.
  const serialized = `${JSON.stringify(config)}\n`;
  const bytes = Buffer.byteLength(serialized, 'utf8');
  const base64Bytes = Math.ceil(bytes / 3) * 4;
  if (base64Bytes > LOBIUM_MAX_RENDERER_CONFIG_BASE64_BYTES) {
    // Native forwarding otherwise logs and SKIPS --lobium-fp-data, producing a mixed host/persona
    // fingerprint. Refuse before browser spawn instead of silently leaking host values.
    throw new Error(
      `Lobium fingerprint config is too large for the renderer channel ` +
        `(${base64Bytes} > ${LOBIUM_MAX_RENDERER_CONFIG_BASE64_BYTES} base64 bytes)`,
    );
  }
  await writeFile(path, serialized, { mode: 0o600 });
  return path;
}

/** The Lobium command-line flag that points the native engine at a written config file. */
export function lobiumConfigArg(configPath: string): string {
  return `--lobium-fp-config=${configPath}`;
}
