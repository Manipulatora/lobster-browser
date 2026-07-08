import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdbClient, AdbCommandResult } from './lib.js';
import {
  AndroidDeviceBridge,
  DEFAULT_ANDROID_CDP_SOCKET,
  DEFAULT_ANDROID_LOBIUM_ACTIVITY,
  DEFAULT_ANDROID_LOBIUM_PACKAGE,
  buildAndroidConfigDeliveryCommands,
  buildAndroidLaunchPlan,
  buildAndroidStartCommand,
  buildAndroidStopCommand,
  defaultAndroidRemoteConfigPath,
  parseAdbDevices,
  sanitizeAndroidProfileId,
} from './lib.js';

class RecordingAdb implements AdbClient {
  commands: string[][] = [];

  constructor(private readonly responses: AdbCommandResult[] = []) {}

  async run(args: readonly string[]): Promise<AdbCommandResult> {
    this.commands.push([...args]);
    return this.responses.shift() ?? { stdout: '', stderr: '' };
  }
}

test('parseAdbDevices handles ready, unauthorized, and offline devices', () => {
  const devices = parseAdbDevices(`List of devices attached
R5CT123ABC device product:dm1qxx model:SM-S911B device:dm1q transport_id:7
emulator-5554 offline transport_id:1
ZY22BAD unauthorized usb:1-2 product:shiba model:Pixel_8 device:shiba transport_id:9
`);

  assert.deepEqual(devices, [
    {
      serial: 'R5CT123ABC',
      state: 'device',
      product: 'dm1qxx',
      model: 'SM-S911B',
      device: 'dm1q',
      transportId: '7',
    },
    { serial: 'emulator-5554', state: 'offline', transportId: '1' },
    {
      serial: 'ZY22BAD',
      state: 'unauthorized',
      product: 'shiba',
      model: 'Pixel_8',
      device: 'shiba',
      transportId: '9',
    },
  ]);
});

test('Android remote config path sanitizes profile ids and stays in app-specific storage', () => {
  assert.equal(sanitizeAndroidProfileId('../bad id🚫'), '.._bad_id_');
  assert.equal(sanitizeAndroidProfileId(''), 'profile');
  assert.equal(
    defaultAndroidRemoteConfigPath('com.example.lobium', '../bad id🚫'),
    '/sdcard/Android/data/com.example.lobium/files/lobium/profiles/.._bad_id_/lobium-android-fp.json',
  );
});

test('buildAndroidLaunchPlan produces config delivery, CDP forward, start, and stop commands', () => {
  const plan = buildAndroidLaunchPlan({
    serial: 'R5CT123ABC',
    profileId: 'profile 1',
    localConfigPath: '/tmp/lobium-android-fp.json',
    packageName: 'com.example.lobium',
    activityName: '.MainActivity',
    cdpLocalPort: 9333,
    cdpSocketName: 'lobium_devtools_remote',
  });

  assert.equal(
    plan.remoteConfigPath,
    '/sdcard/Android/data/com.example.lobium/files/lobium/profiles/profile_1/lobium-android-fp.json',
  );
  assert.deepEqual(plan.deliveryCommands, [
    [
      '-s',
      'R5CT123ABC',
      'shell',
      'mkdir',
      '-p',
      '/sdcard/Android/data/com.example.lobium/files/lobium/profiles/profile_1',
    ],
    [
      '-s',
      'R5CT123ABC',
      'push',
      '/tmp/lobium-android-fp.json',
      '/sdcard/Android/data/com.example.lobium/files/lobium/profiles/profile_1/lobium-android-fp.json',
    ],
  ]);
  assert.deepEqual(plan.cdpForwardCommand, [
    '-s',
    'R5CT123ABC',
    'forward',
    'tcp:9333',
    'localabstract:lobium_devtools_remote',
  ]);
  assert.deepEqual(plan.startCommand, [
    '-s',
    'R5CT123ABC',
    'shell',
    'am',
    'start',
    '-n',
    'com.example.lobium/.MainActivity',
    '--es',
    'lobium.profile_id',
    'profile 1',
    '--es',
    'lobium.fp_config',
    plan.remoteConfigPath,
    '--ez',
    'lobium.remote_debugging',
    'true',
  ]);
  assert.deepEqual(plan.stopCommand, [
    '-s',
    'R5CT123ABC',
    'shell',
    'am',
    'force-stop',
    'com.example.lobium',
  ]);
});

test('Android command helpers use safe defaults without a serial', () => {
  const remotePath = defaultAndroidRemoteConfigPath(DEFAULT_ANDROID_LOBIUM_PACKAGE, 'p1');
  assert.deepEqual(
    buildAndroidConfigDeliveryCommands({
      packageName: DEFAULT_ANDROID_LOBIUM_PACKAGE,
      profileId: 'p1',
      localConfigPath: '/tmp/cfg.json',
      remoteConfigPath: remotePath,
    }),
    [
      ['shell', 'mkdir', '-p', '/sdcard/Android/data/com.lobster.lobium/files/lobium/profiles/p1'],
      ['push', '/tmp/cfg.json', remotePath],
    ],
  );
  assert.deepEqual(
    buildAndroidStartCommand({
      packageName: DEFAULT_ANDROID_LOBIUM_PACKAGE,
      profileId: 'p1',
      localConfigPath: '/tmp/cfg.json',
      remoteConfigPath: remotePath,
      activityName: DEFAULT_ANDROID_LOBIUM_ACTIVITY,
    }),
    [
      'shell',
      'am',
      'start',
      '-n',
      'com.lobster.lobium/org.chromium.chrome.browser.ChromeTabbedActivity',
      '--es',
      'lobium.profile_id',
      'p1',
      '--es',
      'lobium.fp_config',
      remotePath,
      '--ez',
      'lobium.remote_debugging',
      'true',
    ],
  );
  assert.deepEqual(buildAndroidStopCommand(undefined), [
    'shell',
    'am',
    'force-stop',
    DEFAULT_ANDROID_LOBIUM_PACKAGE,
  ]);
  assert.equal(DEFAULT_ANDROID_CDP_SOCKET, 'chrome_devtools_remote');
});

test('AndroidDeviceBridge sequences list, prepare, start, stop, and forward removal', async () => {
  const adb = new RecordingAdb([
    {
      stdout:
        'List of devices attached\nR5CT123ABC device product:dm1qxx model:SM-S911B device:dm1q transport_id:7\n',
      stderr: '',
    },
  ]);
  const bridge = new AndroidDeviceBridge(adb);
  const devices = await bridge.listDevices();
  const plan = buildAndroidLaunchPlan({
    serial: 'R5CT123ABC',
    profileId: 'p1',
    localConfigPath: '/tmp/cfg.json',
  });

  await bridge.prepareLaunch(plan);
  await bridge.start(plan);
  await bridge.stop(plan);
  await bridge.removeCdpForward(plan);

  assert.equal(devices[0]?.model, 'SM-S911B');
  assert.deepEqual(adb.commands, [
    ['devices', '-l'],
    ...plan.deliveryCommands,
    plan.cdpForwardCommand,
    plan.startCommand,
    plan.stopCommand,
    ['-s', 'R5CT123ABC', 'forward', '--remove', 'tcp:9222'],
  ]);
});
