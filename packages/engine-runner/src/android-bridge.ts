import { execFile } from 'node:child_process';
import { posix as pathPosix } from 'node:path';
import { promisify } from 'node:util';
import { ANDROID_LOBIUM_CONFIG_FILENAME } from './android-config.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_ANDROID_LOBIUM_PACKAGE = 'com.lobster.lobium';
export const DEFAULT_ANDROID_LOBIUM_ACTIVITY = 'org.chromium.chrome.browser.ChromeTabbedActivity';
export const DEFAULT_ANDROID_CDP_SOCKET = 'chrome_devtools_remote';

export type AndroidDeviceState = 'device' | 'offline' | 'unauthorized' | 'unknown';

export interface AndroidDeviceInfo {
  serial: string;
  state: AndroidDeviceState;
  product?: string;
  model?: string;
  device?: string;
  transportId?: string;
}

export interface AdbCommandResult {
  stdout: string;
  stderr: string;
}

export interface AdbClient {
  run(args: readonly string[]): Promise<AdbCommandResult>;
}

export class NodeAdbClient implements AdbClient {
  constructor(private readonly adbPath = process.env.LOBSTER_ADB_BIN ?? 'adb') {}

  async run(args: readonly string[]): Promise<AdbCommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync(this.adbPath, [...args], {
        encoding: 'utf8',
      });
      return { stdout: String(stdout), stderr: String(stderr) };
    } catch (error) {
      throw new Error(
        `ADB command failed (${this.adbPath} ${args.join(' ')}): ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'Install Android platform-tools or set LOBSTER_ADB_BIN.',
      );
    }
  }
}

export interface AndroidConfigDeliveryPlan {
  serial?: string;
  packageName: string;
  profileId: string;
  localConfigPath: string;
  remoteConfigPath: string;
}

export interface AndroidLaunchPlan extends AndroidConfigDeliveryPlan {
  activityName: string;
  cdpLocalPort: number;
  cdpSocketName: string;
  deliveryCommands: string[][];
  cdpForwardCommand: string[];
  startCommand: string[];
  stopCommand: string[];
}

export interface BuildAndroidLaunchPlanOptions {
  serial?: string;
  profileId: string;
  localConfigPath: string;
  packageName?: string;
  activityName?: string;
  remoteConfigPath?: string;
  cdpLocalPort?: number;
  cdpSocketName?: string;
}

function adbArgs(serial: string | undefined, args: readonly string[]): string[] {
  return serial ? ['-s', serial, ...args] : [...args];
}

function componentName(packageName: string, activityName: string): string {
  if (activityName.includes('/')) return activityName;
  return `${packageName}/${activityName}`;
}

export function parseAdbDevices(output: string): AndroidDeviceInfo[] {
  const devices: AndroidDeviceInfo[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('List of devices attached')) continue;

    const [serial, stateRaw, ...detailParts] = line.split(/\s+/);
    if (!serial || !stateRaw) continue;

    const state: AndroidDeviceState =
      stateRaw === 'device' || stateRaw === 'offline' || stateRaw === 'unauthorized'
        ? stateRaw
        : 'unknown';
    const info: AndroidDeviceInfo = { serial, state };
    for (const part of detailParts) {
      const [key, value] = part.split(':');
      if (!key || value === undefined) continue;
      if (key === 'product') info.product = value;
      if (key === 'model') info.model = value;
      if (key === 'device') info.device = value;
      if (key === 'transport_id') info.transportId = value;
    }
    devices.push(info);
  }
  return devices;
}

export function sanitizeAndroidProfileId(profileId: string): string {
  const safe = profileId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  if (!safe || safe === '.' || safe === '..') return 'profile';
  return safe;
}

export function defaultAndroidRemoteConfigPath(packageName: string, profileId: string): string {
  return `/sdcard/Android/data/${packageName}/files/lobium/profiles/${sanitizeAndroidProfileId(
    profileId,
  )}/${ANDROID_LOBIUM_CONFIG_FILENAME}`;
}

export function buildAndroidConfigDeliveryCommands(plan: AndroidConfigDeliveryPlan): string[][] {
  return [
    adbArgs(plan.serial, ['shell', 'mkdir', '-p', pathPosix.dirname(plan.remoteConfigPath)]),
    adbArgs(plan.serial, ['push', plan.localConfigPath, plan.remoteConfigPath]),
  ];
}

export function buildAndroidCdpForwardCommand(
  serial: string | undefined,
  cdpLocalPort: number,
  cdpSocketName = DEFAULT_ANDROID_CDP_SOCKET,
): string[] {
  return adbArgs(serial, ['forward', `tcp:${cdpLocalPort}`, `localabstract:${cdpSocketName}`]);
}

export function buildAndroidStartCommand(
  plan: AndroidConfigDeliveryPlan & { activityName: string },
): string[] {
  return adbArgs(plan.serial, [
    'shell',
    'am',
    'start',
    '-n',
    componentName(plan.packageName, plan.activityName),
    '--es',
    'lobium.profile_id',
    plan.profileId,
    '--es',
    'lobium.fp_config',
    plan.remoteConfigPath,
    '--ez',
    'lobium.remote_debugging',
    'true',
  ]);
}

export function buildAndroidStopCommand(
  serial: string | undefined,
  packageName = DEFAULT_ANDROID_LOBIUM_PACKAGE,
): string[] {
  return adbArgs(serial, ['shell', 'am', 'force-stop', packageName]);
}

export function buildAndroidLaunchPlan(opts: BuildAndroidLaunchPlanOptions): AndroidLaunchPlan {
  const packageName = opts.packageName ?? DEFAULT_ANDROID_LOBIUM_PACKAGE;
  const activityName = opts.activityName ?? DEFAULT_ANDROID_LOBIUM_ACTIVITY;
  const cdpLocalPort = opts.cdpLocalPort ?? 9222;
  const cdpSocketName = opts.cdpSocketName ?? DEFAULT_ANDROID_CDP_SOCKET;
  const remoteConfigPath =
    opts.remoteConfigPath ?? defaultAndroidRemoteConfigPath(packageName, opts.profileId);
  const base: AndroidConfigDeliveryPlan = {
    ...(opts.serial ? { serial: opts.serial } : {}),
    packageName,
    profileId: opts.profileId,
    localConfigPath: opts.localConfigPath,
    remoteConfigPath,
  };

  return {
    ...base,
    activityName,
    cdpLocalPort,
    cdpSocketName,
    deliveryCommands: buildAndroidConfigDeliveryCommands(base),
    cdpForwardCommand: buildAndroidCdpForwardCommand(opts.serial, cdpLocalPort, cdpSocketName),
    startCommand: buildAndroidStartCommand({ ...base, activityName }),
    stopCommand: buildAndroidStopCommand(opts.serial, packageName),
  };
}

export class AndroidDeviceBridge {
  constructor(private readonly adb: AdbClient = new NodeAdbClient()) {}

  async listDevices(): Promise<AndroidDeviceInfo[]> {
    const result = await this.adb.run(['devices', '-l']);
    return parseAdbDevices(result.stdout);
  }

  async installApk(apkPath: string, serial?: string): Promise<void> {
    await this.adb.run(adbArgs(serial, ['install', '-r', apkPath]));
  }

  async removeCdpForward(plan: Pick<AndroidLaunchPlan, 'serial' | 'cdpLocalPort'>): Promise<void> {
    await this.adb.run(adbArgs(plan.serial, ['forward', '--remove', `tcp:${plan.cdpLocalPort}`]));
  }

  async prepareLaunch(plan: AndroidLaunchPlan): Promise<void> {
    for (const command of plan.deliveryCommands) await this.adb.run(command);
    await this.adb.run(plan.cdpForwardCommand);
  }

  async start(plan: AndroidLaunchPlan): Promise<void> {
    await this.adb.run(plan.startCommand);
  }

  async stop(plan: Pick<AndroidLaunchPlan, 'serial' | 'packageName'>): Promise<void> {
    await this.adb.run(buildAndroidStopCommand(plan.serial, plan.packageName));
  }
}
