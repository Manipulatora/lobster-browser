import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashStringToUint32 } from '@lobster/fingerprint';
import type {
  AndroidFingerprint,
  FingerprintLaunchPolicy,
  HardwareNoisePolicy,
  MediaDeviceProfile,
  ProxyConfig,
  RendererPolicy,
  WebRtcPolicy,
} from '@lobster/shared-types';

export const ANDROID_LOBIUM_CONFIG_VERSION = 1;
export const ANDROID_LOBIUM_CONFIG_FILENAME = 'lobium-android-fp.json';

export interface AndroidLobiumFarblingSeeds {
  canvas: number;
  webgl: number;
  audio: number;
  clientRects: number;
  mediaDevices: number;
}

export interface AndroidLobiumNetConfig {
  webrtcPolicy: WebRtcPolicy;
  proxy?: { type: string; host: string; port: number };
}

export interface AndroidLobiumPolicyConfig extends FingerprintLaunchPolicy {
  androidRunner: {
    configDelivery: 'adb-external-app-files' | 'app-private-bridge';
    cdp: 'localabstract';
  };
}

export interface AndroidLobiumConfig {
  version: number;
  target: 'android';
  arch: AndroidFingerprint['arch'];
  android: AndroidFingerprint['android'];
  navigator: AndroidFingerprint['navigator'];
  screen: AndroidFingerprint['screen'];
  webgl: AndroidFingerprint['webgl'];
  webgpu: AndroidFingerprint['webgpu'];
  locale: AndroidFingerprint['locale'];
  fonts: string[];
  seeds: AndroidLobiumFarblingSeeds;
  policy: AndroidLobiumPolicyConfig;
  net: AndroidLobiumNetConfig;
}

export interface BuildAndroidLobiumConfigOptions {
  proxy?: Pick<ProxyConfig, 'type' | 'host' | 'port'>;
  seed?: string;
  webrtcPolicy?: WebRtcPolicy;
  rendererPolicy?: RendererPolicy;
  hardwareNoise?: Partial<HardwareNoisePolicy>;
  mediaDevices?: Partial<MediaDeviceProfile>;
  configDelivery?: AndroidLobiumPolicyConfig['androidRunner']['configDelivery'];
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
  speakers: 1,
  stableDeviceIds: true,
};

function defaultRendererPolicy(fp: AndroidFingerprint): RendererPolicy {
  return { mode: 'validated_preset', presetId: `android:${fp.android.model}` };
}

function fingerprintSignature(fp: AndroidFingerprint): string {
  return [
    fp.os,
    fp.android.model,
    fp.android.buildFingerprint,
    fp.navigator.userAgent,
    fp.webgl.renderer,
    fp.screen.width,
    fp.screen.height,
  ].join('|');
}

export function buildAndroidLobiumConfig(
  fp: AndroidFingerprint,
  opts: BuildAndroidLobiumConfigOptions = {},
): AndroidLobiumConfig {
  const base = opts.seed ?? fingerprintSignature(fp);
  const webrtcPolicy =
    opts.webrtcPolicy ?? (opts.proxy ? 'disable_non_proxied_udp' : 'default_public_interface_only');
  const net: AndroidLobiumNetConfig = { webrtcPolicy };
  if (opts.proxy) {
    net.proxy = { type: opts.proxy.type, host: opts.proxy.host, port: opts.proxy.port };
  }
  const hardwareNoise = { ...DEFAULT_HARDWARE_NOISE, ...opts.hardwareNoise };

  return {
    version: ANDROID_LOBIUM_CONFIG_VERSION,
    target: 'android',
    arch: fp.arch,
    android: fp.android,
    navigator: fp.navigator,
    screen: fp.screen,
    webgl: fp.webgl,
    webgpu: fp.webgpu,
    locale: fp.locale,
    fonts: fp.fonts,
    seeds: {
      canvas: hardwareNoise.canvas ? hashStringToUint32(`${base}:canvas`) : 0,
      webgl: hardwareNoise.webgl ? hashStringToUint32(`${base}:webgl`) : 0,
      audio: hardwareNoise.audio ? hashStringToUint32(`${base}:audio`) : 0,
      clientRects: hardwareNoise.clientRects ? hashStringToUint32(`${base}:clientRects`) : 0,
      mediaDevices: hashStringToUint32(`${base}:mediaDevices`),
    },
    policy: {
      renderer: opts.rendererPolicy ?? defaultRendererPolicy(fp),
      webrtc: webrtcPolicy,
      hardwareNoise,
      mediaDevices: { ...DEFAULT_MEDIA_DEVICES, ...opts.mediaDevices },
      androidRunner: {
        configDelivery: opts.configDelivery ?? 'adb-external-app-files',
        cdp: 'localabstract',
      },
    },
    net,
  };
}

export async function writeAndroidLobiumConfig(
  userDataDir: string,
  config: AndroidLobiumConfig,
): Promise<string> {
  await mkdir(userDataDir, { recursive: true });
  const path = join(userDataDir, ANDROID_LOBIUM_CONFIG_FILENAME);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}
