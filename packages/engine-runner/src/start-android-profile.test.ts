import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AdbClient, AdbCommandResult } from './android-bridge.js';
import {
  androidProfileStatus,
  startAndroidProfile,
  stopAndroidProfile,
} from './start-android-profile.js';

class RecordingAdb implements AdbClient {
  commands: string[][] = [];

  constructor(private readonly responses: AdbCommandResult[] = []) {}

  async run(args: readonly string[]): Promise<AdbCommandResult> {
    this.commands.push([...args]);
    return this.responses.shift() ?? { stdout: '', stderr: '' };
  }
}

test('startAndroidProfile refuses when no ADB device is ready', async () => {
  const adb = new RecordingAdb([
    { stdout: 'List of devices attached\nemulator-5554 offline\n', stderr: '' },
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'android-start-'));
  await assert.rejects(
    () =>
      startAndroidProfile(
        {
          profileId: 'p1',
          engine: 'lobium',
          os: 'android',
          fingerprintSeed: 'android-seed-1',
          userDataDir: dir,
        },
        { adb },
      ),
    /no ADB device/,
  );
});

test('startAndroidProfile pushes config, forwards CDP, and starts the APK activity', async () => {
  const adb = new RecordingAdb([
    {
      stdout:
        'List of devices attached\nR5CT123ABC device product:dm1qxx model:SM-S911B device:dm1q\n',
      stderr: '',
    },
    { stdout: '', stderr: '' }, // mkdir
    { stdout: '', stderr: '' }, // push
    { stdout: '', stderr: '' }, // forward
    { stdout: '', stderr: '' }, // am start
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'android-start-'));
  const result = await startAndroidProfile(
    {
      profileId: 'android-profile',
      engine: 'lobium',
      os: 'android',
      fingerprintSeed: 'android-seed-2',
      userDataDir: dir,
    },
    {
      adb,
      cdpLocalPort: 9333,
      launchMirror: async () => ({ close: async () => undefined }),
    },
  );

  assert.equal(result.profileId, 'android-profile');
  assert.equal(result.debuggerAddress, '127.0.0.1:9333');
  assert.match(result.ws, /9333/);
  assert.ok(adb.commands.some((c) => c.includes('push')));
  assert.ok(adb.commands.some((c) => c.includes('forward')));
  assert.ok(adb.commands.some((c) => c.includes('am') && c.includes('start')));
  assert.ok(
    adb.commands.some((c) => c.some((arg) => arg.includes('com.lobster.lobium'))),
    'starts Lobium package',
  );
  assert.equal(androidProfileStatus('android-profile').length, 1);
  assert.equal(await stopAndroidProfile('android-profile'), true);
  assert.equal(androidProfileStatus('android-profile').length, 0);
  assert.ok(adb.commands.some((c) => c.includes('force-stop')));
  assert.ok(cdpForwardRemoval(adb.commands, '9333'));
});

function cdpForwardRemoval(commands: string[][], port: string): boolean {
  return commands.some(
    (command) =>
      command.includes('forward') &&
      command.includes('--remove') &&
      command.includes(`tcp:${port}`),
  );
}
