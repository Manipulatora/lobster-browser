import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveFingerprint } from '@lobster/fingerprint';
import {
  LOBIUM_CAPABILITY_CONTRACT_VERSION,
  LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES,
} from '../lobium-capabilities.js';
import { LOBIUM_CONFIG_FILENAME } from '../lobium-config.js';
import {
  buildLobiumLaunchArgs,
  buildNativeLobiumProcessArgs,
  createLobiumLauncher,
  ensureChromiumPersonaPreferences,
  isLobiumAvailable,
  lobiumBinaryCandidates,
  proxySummaryFromServer,
  resolveLobiumBinary,
} from './lobium-launcher.js';
import type { LaunchContext } from './types.js';

const fp = deriveFingerprint('seed-lobium-test', { os: 'windows', engine: 'lobium' });
const capabilityManifest = JSON.stringify({
  contractVersion: LOBIUM_CAPABILITY_CONTRACT_VERSION,
  product: 'Lobium',
  capabilities: LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES,
});

function ctxWith(
  userDataDir: string,
  opts: {
    proxy?: { server: string; username?: string; password?: string };
    seed?: string;
    policy?: true;
  } = {},
): LaunchContext {
  return {
    profileId: 'p',
    engine: 'lobium',
    ...(opts.policy ? { osVersion: 'Windows 11 23H2', webrtcPolicy: 'disabled' } : {}),
    fingerprint: fp,
    ...(opts.policy
      ? {
          fingerprintPolicy: {
            renderer: { mode: 'normalized_host' },
            webrtc: 'disabled',
            hardwareNoise: { webgl: true, canvas: false, audio: true, clientRects: true },
            mediaDevices: { cameras: 2, microphones: 1, speakers: 3, stableDeviceIds: false },
          },
        }
      : {}),
    ...(opts.seed !== undefined ? { fingerprintSeed: opts.seed } : {}),
    options: {
      userDataDir,
      headless: false,
      args: [],
      ...(opts.proxy ? { proxy: opts.proxy } : {}),
    },
    emulation: {},
    initScript: '',
  } as unknown as LaunchContext;
}

test('resolveLobiumBinary / isLobiumAvailable follow LOBSTER_LOBIUM_BIN', async () => {
  const prev = process.env.LOBSTER_LOBIUM_BIN;
  const prevDir = process.env.LOBSTER_LOBIUM_DIR;
  const prevAuto = process.env.LOBSTER_LOBIUM_AUTO_DISCOVER;
  try {
    process.env.LOBSTER_LOBIUM_AUTO_DISCOVER = '0';
    delete process.env.LOBSTER_LOBIUM_BIN;
    delete process.env.LOBSTER_LOBIUM_DIR;
    assert.equal(resolveLobiumBinary(), undefined);
    assert.equal(isLobiumAvailable(), false);

    process.env.LOBSTER_LOBIUM_BIN = '/no/such/lobium/binary';
    assert.equal(resolveLobiumBinary(), undefined, 'a non-existent path is not "available"');

    // Point at a real file (this test file) to prove the existsSync gate.
    const real = await mkdtemp(join(tmpdir(), 'lobium-bin-'));
    const binPath = join(real, 'chrome');
    await writeFile(binPath, '#!/bin/true\n', { mode: 0o755 });
    process.env.LOBSTER_LOBIUM_BIN = binPath;
    assert.equal(resolveLobiumBinary(), binPath);
    assert.equal(isLobiumAvailable(), true);
    await rm(real, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env.LOBSTER_LOBIUM_BIN;
    else process.env.LOBSTER_LOBIUM_BIN = prev;
    if (prevDir === undefined) delete process.env.LOBSTER_LOBIUM_DIR;
    else process.env.LOBSTER_LOBIUM_DIR = prevDir;
    if (prevAuto === undefined) delete process.env.LOBSTER_LOBIUM_AUTO_DISCOVER;
    else process.env.LOBSTER_LOBIUM_AUTO_DISCOVER = prevAuto;
  }
});

test('resolveLobiumBinary can discover a built output from LOBSTER_LOBIUM_DIR', async () => {
  const prevBin = process.env.LOBSTER_LOBIUM_BIN;
  const prevDir = process.env.LOBSTER_LOBIUM_DIR;
  const prevAuto = process.env.LOBSTER_LOBIUM_AUTO_DISCOVER;
  const root = await mkdtemp(join(tmpdir(), 'lobium-root-'));
  try {
    delete process.env.LOBSTER_LOBIUM_BIN;
    process.env.LOBSTER_LOBIUM_AUTO_DISCOVER = '0';
    const out = join(root, 'src', 'out', 'Lobium');
    const binPath = join(out, 'chrome');
    await mkdir(out, { recursive: true });
    await writeFile(binPath, '#!/bin/true\n', { mode: 0o755 });
    process.env.LOBSTER_LOBIUM_DIR = root;

    assert.ok(lobiumBinaryCandidates().includes(binPath));
    assert.equal(resolveLobiumBinary(), binPath);
    assert.equal(isLobiumAvailable(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (prevBin === undefined) delete process.env.LOBSTER_LOBIUM_BIN;
    else process.env.LOBSTER_LOBIUM_BIN = prevBin;
    if (prevDir === undefined) delete process.env.LOBSTER_LOBIUM_DIR;
    else process.env.LOBSTER_LOBIUM_DIR = prevDir;
    if (prevAuto === undefined) delete process.env.LOBSTER_LOBIUM_AUTO_DISCOVER;
    else process.env.LOBSTER_LOBIUM_AUTO_DISCOVER = prevAuto;
  }
});

test('createLobiumLauncher throws when the binary is not provisioned', () => {
  const prev = process.env.LOBSTER_LOBIUM_BIN;
  const prevDir = process.env.LOBSTER_LOBIUM_DIR;
  const prevAuto = process.env.LOBSTER_LOBIUM_AUTO_DISCOVER;
  try {
    process.env.LOBSTER_LOBIUM_AUTO_DISCOVER = '0';
    delete process.env.LOBSTER_LOBIUM_BIN;
    delete process.env.LOBSTER_LOBIUM_DIR;
    assert.throws(() => createLobiumLauncher(), /LOBSTER_LOBIUM_BIN/);
  } finally {
    if (prev !== undefined) process.env.LOBSTER_LOBIUM_BIN = prev;
    if (prevDir === undefined) delete process.env.LOBSTER_LOBIUM_DIR;
    else process.env.LOBSTER_LOBIUM_DIR = prevDir;
    if (prevAuto === undefined) delete process.env.LOBSTER_LOBIUM_AUTO_DISCOVER;
    else process.env.LOBSTER_LOBIUM_AUTO_DISCOVER = prevAuto;
  }
});

test('proxySummaryFromServer parses type/host/port and rejects garbage', () => {
  assert.deepEqual(proxySummaryFromServer('http://1.2.3.4:8080'), {
    type: 'http',
    host: '1.2.3.4',
    port: 8080,
  });
  assert.deepEqual(proxySummaryFromServer('socks5://proxy.example:1080'), {
    type: 'socks5',
    host: 'proxy.example',
    port: 1080,
  });
  assert.equal(proxySummaryFromServer('not-a-url'), undefined);
  assert.equal(proxySummaryFromServer('http://host-without-port'), undefined);
});

test('buildLobiumLaunchArgs writes lobium-fp.json and returns the --lobium-fp-config flag', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-udd-'));
  try {
    const args = await buildLobiumLaunchArgs(ctxWith(userDataDir));
    const configPath = join(userDataDir, LOBIUM_CONFIG_FILENAME);
    assert.deepEqual(args, [`--lobium-fp-config=${configPath}`]);

    const written = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(written.version, 1);
    // The native surfaces the config drives are present + match the resolved fingerprint.
    assert.equal(written.navigator.userAgent, fp.navigator.userAgent);
    assert.equal(written.screen.width, fp.screen.width);
    assert.equal(written.webgl.renderer, fp.webgl.renderer);
    // Farbling seeds are present (uint32) and deterministic across builds of the same fingerprint.
    for (const k of ['canvas', 'webgl', 'audio'] as const) {
      assert.equal(typeof written.seeds[k], 'number');
    }
    const again = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(again.seeds, written.seeds, 'seeds are stable per profile');
    // No proxy → default WebRTC policy, no proxy summary.
    assert.equal(written.net.webrtcPolicy, 'default_public_interface_only');
    assert.equal(written.net.proxy, undefined);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('farbling seeds are UNIQUE per profile seed even for the SAME device (distinct-per-profile, §5)', async () => {
  // Same resolved fingerprint (identical device), two different profile seeds. Without threading the
  // seed, both would fall back to the device signature and get IDENTICAL farbling seeds → linkable.
  const uddA = await mkdtemp(join(tmpdir(), 'lobium-A-'));
  const uddB = await mkdtemp(join(tmpdir(), 'lobium-B-'));
  try {
    await buildLobiumLaunchArgs(ctxWith(uddA, { seed: 'profile-A' }));
    await buildLobiumLaunchArgs(ctxWith(uddB, { seed: 'profile-B' }));
    const a = JSON.parse(await readFile(join(uddA, LOBIUM_CONFIG_FILENAME), 'utf8'));
    const b = JSON.parse(await readFile(join(uddB, LOBIUM_CONFIG_FILENAME), 'utf8'));
    assert.equal(a.navigator.userAgent, b.navigator.userAgent, 'same device (control)');
    assert.notDeepEqual(
      a.seeds,
      b.seeds,
      'different profile seed → different canvas/webgl/audio seeds',
    );
    // Stable per profile: re-deriving profile A yields the same seeds.
    const uddA2 = await mkdtemp(join(tmpdir(), 'lobium-A2-'));
    await buildLobiumLaunchArgs(ctxWith(uddA2, { seed: 'profile-A' }));
    const a2 = JSON.parse(await readFile(join(uddA2, LOBIUM_CONFIG_FILENAME), 'utf8'));
    assert.deepEqual(a2.seeds, a.seeds, 'same profile seed → same farbling seeds across launches');
    await rm(uddA2, { recursive: true, force: true });
  } finally {
    await rm(uddA, { recursive: true, force: true });
    await rm(uddB, { recursive: true, force: true });
  }
});

test('buildLobiumLaunchArgs records the proxy WebRTC policy + non-secret summary (no creds)', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-udd-'));
  try {
    await buildLobiumLaunchArgs(
      ctxWith(userDataDir, { proxy: { server: 'socks5://10.0.0.9:1080' } }),
    );
    const written = JSON.parse(await readFile(join(userDataDir, LOBIUM_CONFIG_FILENAME), 'utf8'));
    assert.equal(
      written.net.webrtcPolicy,
      'disable_non_proxied_udp',
      'proxied → suppress non-proxied UDP',
    );
    assert.deepEqual(written.net.proxy, { type: 'socks5', host: '10.0.0.9', port: 1080 });
    // The config file must never carry proxy credentials.
    const raw = await readFile(join(userDataDir, LOBIUM_CONFIG_FILENAME), 'utf8');
    assert.ok(!/username|password/.test(raw), 'no credentials in the config file');
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('buildLobiumLaunchArgs writes profile policy into the native config', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-policy-'));
  try {
    await buildLobiumLaunchArgs(ctxWith(userDataDir, { policy: true }));
    const written = JSON.parse(await readFile(join(userDataDir, LOBIUM_CONFIG_FILENAME), 'utf8'));
    assert.equal(written.policy.osVersion, 'Windows 11 23H2');
    assert.equal(written.net.webrtcPolicy, 'disabled');
    assert.equal(written.policy.webrtc, 'disabled');
    assert.deepEqual(written.policy.renderer, { mode: 'normalized_host' });
    assert.deepEqual(written.policy.hardwareNoise, {
      webgl: true,
      canvas: false,
      audio: true,
      clientRects: true,
    });
    assert.deepEqual(written.policy.mediaDevices, {
      cameras: 2,
      microphones: 1,
      speakers: 3,
      stableDeviceIds: false,
    });
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('ensureChromiumPersonaPreferences persists language sources for main frames and workers', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-persona-prefs-'));
  try {
    const ctx = ctxWith(userDataDir);
    ctx.fingerprint.navigator.languages = ['ja-JP', 'ja'];
    ctx.fingerprint.locale.locale = 'ja-JP';
    ensureChromiumPersonaPreferences(ctx);
    const prefs = JSON.parse(await readFile(join(userDataDir, 'Default', 'Preferences'), 'utf8'));
    assert.equal(prefs.intl.accept_languages, 'ja-JP,ja');
    assert.equal(prefs.intl.selected_languages, 'ja-JP,ja');
    const localState = JSON.parse(await readFile(join(userDataDir, 'Local State'), 'utf8'));
    assert.equal(localState.intl.app_locale, 'ja-JP');
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('buildNativeLobiumProcessArgs is direct native Chromium args, not Patchright context config', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-native-args-'));
  try {
    const args = await buildNativeLobiumProcessArgs(ctxWith(userDataDir), {
      headless: true,
      extraArgs: ['--no-sandbox'],
    });
    assert.ok(args.includes(`--user-data-dir=${userDataDir}`));
    assert.ok(args.includes('--remote-debugging-port=0'));
    assert.ok(args.includes('--headless=new'));
    assert.ok(args.includes('--no-sandbox'));
    assert.ok(args.includes(`--lobium-fp-config=${join(userDataDir, LOBIUM_CONFIG_FILENAME)}`));
    // No forced startup URL: the launcher relies on --restore-last-session so the profile's
    // previous tabs reopen instead of a forced New Tab Page (which discarded unpinned tabs).
    assert.ok(args.includes('--restore-last-session'));
    assert.ok(!args.includes('chrome://newtab/'));
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('buildNativeLobiumProcessArgs keeps Android inside a maximized Lobium device stage', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-native-android-stage-'));
  try {
    const ctx = ctxWith(userDataDir);
    ctx.isMobileProfile = true;
    ctx.mobileFormFactor = 'tablet';
    ctx.fingerprint.screen.width = 1280;
    ctx.fingerprint.screen.height = 800;
    ctx.options.args = ['--window-size=640,480', '--window-position=10,20'];

    const args = await buildNativeLobiumProcessArgs(ctx);

    assert.ok(args.includes('--start-maximized'));
    assert.ok(args.includes('--lobium-device-frame=tablet'));
    assert.ok(args.includes('--lobium-device-screen=1280x800'));
    assert.ok(!args.some((arg) => arg.startsWith('--window-size=')));
    assert.ok(!args.some((arg) => arg.startsWith('--window-position=')));
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('buildNativeLobiumProcessArgs requires the auth adapter for credentialed proxies', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-proxy-auth-'));
  try {
    await assert.rejects(
      () =>
        buildNativeLobiumProcessArgs(
          ctxWith(userDataDir, {
            proxy: { server: 'socks5://proxy.example:1080', username: 'u', password: 'p' },
          }),
        ),
      /authenticated proxy requires the local proxy auth adapter/,
    );
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('buildNativeLobiumProcessArgs accepts a local shim --proxy-server for authed proxies', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-proxy-shim-'));
  try {
    const args = await buildNativeLobiumProcessArgs(
      ctxWith(userDataDir, {
        proxy: { server: 'socks5://proxy.example:1080', username: 'u', password: 'secret-pass' },
      }),
      {},
      'http://127.0.0.1:18080',
    );
    assert.ok(args.includes('--proxy-server=http://127.0.0.1:18080'));
    assert.ok(!args.some((a) => a.includes('secret-pass')), 'credentials must not appear in argv');
    assert.ok(!args.some((a) => a.includes('proxy.example')), 'upstream host not passed raw');
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('buildNativeLobiumProcessArgs passes unauthenticated proxy straight through', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-proxy-plain-'));
  try {
    const args = await buildNativeLobiumProcessArgs(
      ctxWith(userDataDir, { proxy: { server: 'socks5://10.0.0.9:1080' } }),
    );
    assert.ok(args.includes('--proxy-server=socks5://10.0.0.9:1080'));
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('createLobiumLauncher fail-closes when the upstream proxy TCP is unreachable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lobium-proxy-dead-'));
  const userDataDir = join(root, 'profile');
  const fakeBin = join(root, 'fake-lobium.cjs');
  await writeFile(
    fakeBin,
    `#!/usr/bin/env node
if (process.argv.includes('--lobium-fingerprint-capabilities')) {
  process.stdout.write(${JSON.stringify(capabilityManifest)});
}
process.exit(0);
`,
  );
  await chmod(fakeBin, 0o755);
  try {
    const launcher = createLobiumLauncher({
      executablePath: fakeBin,
      extraArgsFor: async () => [],
      envFor: async () => undefined,
    });
    await assert.rejects(
      () =>
        launcher(
          ctxWith(userDataDir, {
            // Closed loopback port — TCP connect fails immediately (not a long timeout).
            proxy: { server: 'socks5://127.0.0.1:1', username: 'u', password: 'p' },
          }),
        ),
      /proxy 127\.0\.0\.1:1 is unreachable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createLobiumLauncher spawns a native binary directly and reads DevToolsActivePort', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lobium-direct-launch-'));
  const userDataDir = join(root, 'profile');
  const fakeBin = join(root, 'fake-lobium.cjs');
  await writeFile(
    fakeBin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
if (process.argv.includes('--lobium-fingerprint-capabilities')) {
  process.stdout.write(${JSON.stringify(capabilityManifest)});
  process.exit(0);
}
const uddArg = process.argv.find((arg) => arg.startsWith('--user-data-dir='));
if (!uddArg) process.exit(7);
const userDataDir = uddArg.slice('--user-data-dir='.length);
fs.mkdirSync(userDataDir, {recursive: true});
// Listen so readDevToolsEndpoint's TCP reachability check passes.
const server = net.createServer();
server.listen(43210, '127.0.0.1', () => {
  fs.writeFileSync(path.join(userDataDir, 'DevToolsActivePort'), '43210\\n/devtools/browser/native-fake\\n');
});
setInterval(() => {}, 1000);
`,
  );
  await chmod(fakeBin, 0o755);
  try {
    const launcher = createLobiumLauncher({
      executablePath: fakeBin,
      extraArgsFor: buildLobiumLaunchArgs,
      envFor: async () => undefined,
    });
    const handle = await launcher(ctxWith(userDataDir));
    assert.equal(handle.ws, 'ws://127.0.0.1:43210/devtools/browser/native-fake');
    assert.equal(handle.debuggerAddress, '127.0.0.1:43210');
    assert.ok(handle.pid > 0);
    const written = JSON.parse(await readFile(join(userDataDir, LOBIUM_CONFIG_FILENAME), 'utf8'));
    assert.equal(written.version, 1);
    await handle.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
