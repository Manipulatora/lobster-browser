import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveFingerprint } from '@lobster/fingerprint';
import {
  LOBIUM_CAPABILITY_CONTRACT_VERSION,
  LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES,
} from '../lobium-capabilities.js';
import { LOBIUM_CONFIG_FILENAME } from '../lobium-config.js';
import { CHROMIUM_BINARY_NAME, writeFakeBinary } from '../test-fake-binary.js';
import { LOBEE_EXTENSION_ID } from '../extensions.js';
import {
  bindLobiumRuntimeEnvironment,
  buildLobiumLaunchArgs,
  buildNativeLobiumProcessArgs,
  createLobiumLauncher,
  ensureChromiumLaunchPreferences,
  isLobiumAvailable,
  lobiumBinaryCandidates,
  proxySummaryFromServer,
  resolveFontsBaseDir,
  resolveLobiumBinary,
} from './lobium-launcher.js';
import {
  MANAGED_ENGINE_BIN_ORIGIN_ENV,
  MANAGED_ENGINE_SHA256_ENV,
  MANAGED_ENGINE_VERSION_ENV,
} from './managed-engine.js';
import { profileMark } from './profile-mark.js';
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
    os?: 'windows' | 'macos' | 'linux';
    mobile?: boolean;
    fonts?: string[];
  } = {},
): LaunchContext {
  const derived = opts.os
    ? deriveFingerprint(`seed-lobium-test-${opts.os}`, { os: opts.os, engine: 'lobium' })
    : fp;
  return {
    profileId: 'p',
    engine: 'lobium',
    ...(opts.policy ? { webrtcPolicy: 'disabled' } : {}),
    fingerprint: opts.fonts ? { ...derived, fonts: opts.fonts } : derived,
    ...(opts.mobile ? { isMobileProfile: true } : {}),
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

async function writeLauncherFontPack(root: string): Promise<string> {
  const pack = join(root, 'source-pack');
  const families = [
    'Liberation Sans',
    'Liberation Serif',
    'Liberation Mono',
    'Noto Sans',
    'Noto Serif',
    'Noto Sans Mono',
    'Ubuntu',
    'Roboto',
  ];
  await mkdir(join(pack, 'files'), { recursive: true });
  const files = [];
  for (const [index, family] of families.entries()) {
    const bytes = `font-${family}`;
    const name = `${String(index).padStart(2, '0')}-${family.replaceAll(' ', '')}.ttf`;
    await writeFile(join(pack, 'files', name), bytes);
    files.push({
      path: `files/${name}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      families: [family],
      license: 'OFL-1.1',
    });
  }
  await writeFile(
    join(pack, 'font-pack.manifest.json'),
    JSON.stringify({
      version: 1,
      packId: 'launcher-persona-pack',
      files,
      personas: {
        windows: {
          families: ['Arial', 'Consolas'],
          physicalFamilies: ['Liberation Sans', 'Liberation Serif', 'Liberation Mono'],
        },
        macos: {
          families: ['Helvetica', 'SF Mono'],
          physicalFamilies: ['Noto Sans', 'Noto Serif', 'Noto Sans Mono'],
        },
        linux: {
          families: ['Ubuntu', 'Noto Sans Mono'],
          physicalFamilies: ['Ubuntu', 'Noto Serif', 'Noto Sans Mono'],
        },
        android: {
          families: ['Roboto', 'Droid Sans'],
          physicalFamilies: ['Roboto', 'Noto Serif', 'Noto Sans Mono'],
        },
      },
    }),
  );
  return pack;
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
    const binPath = join(real, CHROMIUM_BINARY_NAME);
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
    // Discovery is name-based, and the name is platform-specific: a Chromium build output is
    // `chrome.exe` on Windows and `chrome` elsewhere, so the fixture has to match the real artifact.
    const binPath = join(out, CHROMIUM_BINARY_NAME);
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

test(
  'canonical managed path needs its stamp unless LOBSTER_LOBIUM_BIN explicitly overrides it',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'lobium-canonical-'));
    const bin = join(root, 'lobster', 'lobium', 'chrome.exe');
    const saved = {
      bin: process.env.LOBSTER_LOBIUM_BIN,
      dir: process.env.LOBSTER_LOBIUM_DIR,
      auto: process.env.LOBSTER_LOBIUM_AUTO_DISCOVER,
      local: process.env.LOCALAPPDATA,
      version: process.env[MANAGED_ENGINE_VERSION_ENV],
      sha: process.env[MANAGED_ENGINE_SHA256_ENV],
      origin: process.env[MANAGED_ENGINE_BIN_ORIGIN_ENV],
    };
    try {
      await mkdir(join(root, 'lobster', 'lobium'), { recursive: true });
      await writeFile(bin, 'browser');
      await writeFile(
        join(root, 'lobster', 'lobium', '.lobium-engine-version'),
        `version=152.0.7977.42\nsha256=${'b'.repeat(64)}\n`,
      );
      delete process.env.LOBSTER_LOBIUM_BIN;
      delete process.env.LOBSTER_LOBIUM_DIR;
      process.env.LOBSTER_LOBIUM_AUTO_DISCOVER = '0';
      process.env.LOCALAPPDATA = root;
      process.env[MANAGED_ENGINE_VERSION_ENV] = '152.0.7977.42';
      process.env[MANAGED_ENGINE_SHA256_ENV] = 'a'.repeat(64);
      delete process.env[MANAGED_ENGINE_BIN_ORIGIN_ENV];
      assert.equal(resolveLobiumBinary(), undefined, 'mismatched managed archive must be denied');

      process.env.LOBSTER_LOBIUM_BIN = bin;
      assert.equal(
        resolveLobiumBinary(),
        bin,
        'the exact binary env remains an intentional override',
      );

      process.env[MANAGED_ENGINE_BIN_ORIGIN_ENV] = 'managed';
      assert.equal(
        resolveLobiumBinary(),
        undefined,
        'a Rust-published managed binary cannot impersonate an explicit override',
      );

      delete process.env.LOBSTER_LOBIUM_BIN;
      delete process.env[MANAGED_ENGINE_BIN_ORIGIN_ENV];
      await writeFile(
        join(root, 'lobster', 'lobium', '.lobium-engine-version'),
        `version=152.0.7977.42\nsha256=${'a'.repeat(64)}\n`,
      );
      assert.equal(resolveLobiumBinary(), bin);

      process.env.LOBSTER_LOBIUM_BIN = join(root, 'missing-explicit.exe');
      assert.equal(
        resolveLobiumBinary(),
        undefined,
        'a missing explicit override must not fall through to the valid managed runtime',
      );
      process.env.LOBSTER_LOBIUM_BIN = '';
      assert.equal(
        resolveLobiumBinary(),
        undefined,
        'an empty explicit override is still present and must fail closed like Rust',
      );
    } finally {
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      restore('LOBSTER_LOBIUM_BIN', saved.bin);
      restore('LOBSTER_LOBIUM_DIR', saved.dir);
      restore('LOBSTER_LOBIUM_AUTO_DISCOVER', saved.auto);
      restore('LOCALAPPDATA', saved.local);
      restore(MANAGED_ENGINE_VERSION_ENV, saved.version);
      restore(MANAGED_ENGINE_SHA256_ENV, saved.sha);
      restore(MANAGED_ENGINE_BIN_ORIGIN_ENV, saved.origin);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('one selected runtime owns its adjacent fonts and SwiftShader resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lobium-runtime-binding-'));
  const selectedDir = join(root, 'selected');
  const inheritedPack = join(root, 'inherited-fonts');
  const selectedPack = join(selectedDir, 'fonts');
  const selectedRuntime = {
    executablePath: join(selectedDir, CHROMIUM_BINARY_NAME),
    managed: true,
  };
  const previousFonts = process.env.LOBSTER_FONTS_DIR;
  try {
    await mkdir(selectedPack, { recursive: true });
    await mkdir(inheritedPack, { recursive: true });
    await writeFile(join(selectedPack, 'font-pack.manifest.json'), '{}');
    await writeFile(join(inheritedPack, 'font-pack.manifest.json'), '{}');
    process.env.LOBSTER_FONTS_DIR = inheritedPack;

    assert.equal(resolveFontsBaseDir(selectedRuntime), selectedPack);
    await rm(join(selectedPack, 'font-pack.manifest.json'));
    assert.equal(
      resolveFontsBaseDir(selectedRuntime),
      undefined,
      'managed engine B must not consume inherited engine A fonts',
    );
    assert.equal(
      resolveFontsBaseDir({ ...selectedRuntime, managed: false }),
      inheritedPack,
      'an explicit development binary may still use the explicit font-pack override',
    );

    const inheritedVulkan = {
      VK_ICD_FILENAMES: join(root, 'other-runtime', 'vk_swiftshader_icd.json'),
      VK_DRIVER_FILES: join(root, 'other-runtime', 'vk_swiftshader_icd.json'),
    };
    assert.deepEqual(
      bindLobiumRuntimeEnvironment(inheritedVulkan, selectedRuntime, 'software'),
      {},
      "missing adjacent SwiftShader must clear another engine runtime's inherited ICD",
    );
    const selectedIcd = join(selectedDir, 'vk_swiftshader_icd.json');
    await writeFile(selectedIcd, '{}');
    assert.deepEqual(bindLobiumRuntimeEnvironment(inheritedVulkan, selectedRuntime, 'software'), {
      VK_ICD_FILENAMES: selectedIcd,
      VK_DRIVER_FILES: selectedIcd,
    });
  } finally {
    if (previousFonts === undefined) delete process.env.LOBSTER_FONTS_DIR;
    else process.env.LOBSTER_FONTS_DIR = previousFonts;
    await rm(root, { recursive: true, force: true });
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

test(
  'Windows engine stages and aliases the claimed persona rather than hardcoding Windows fonts',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'lobium-persona-font-pack-'));
    const previous = process.env.LOBSTER_FONTS_DIR;
    try {
      const sourcePack = await writeLauncherFontPack(root);
      process.env.LOBSTER_FONTS_DIR = sourcePack;
      const cases = [
        {
          name: 'macos',
          ctx: ctxWith(join(root, 'mac'), {
            os: 'macos',
            fonts: ['Helvetica', 'SF Mono'],
          }),
          included: ['NotoSans', 'NotoSerif', 'NotoSansMono'],
          order: ['NotoSans.ttf', 'NotoSerif.ttf', 'NotoSansMono.ttf'],
          fallback: ['Noto Sans', 'Noto Serif', 'Noto Sans Mono'],
          excluded: ['Liberation', 'Ubuntu', 'Roboto'],
          aliases: { Helvetica: 'Noto Sans', 'SF Mono': 'Noto Sans Mono' },
        },
        {
          name: 'linux',
          ctx: ctxWith(join(root, 'linux'), {
            os: 'linux',
            fonts: ['Ubuntu', 'Noto Sans Mono'],
          }),
          included: ['Ubuntu', 'NotoSerif', 'NotoSansMono'],
          order: ['Ubuntu.ttf', 'NotoSerif.ttf', 'NotoSansMono.ttf'],
          fallback: ['Ubuntu', 'Noto Serif', 'Noto Sans Mono'],
          excluded: ['Liberation', 'NotoSans.ttf', 'Roboto'],
          aliases: {},
          absentAliases: ['Ubuntu', 'Noto Sans Mono'],
        },
        {
          name: 'android',
          ctx: ctxWith(join(root, 'android'), {
            mobile: true,
            fonts: ['Roboto', 'Droid Sans'],
          }),
          included: ['Roboto', 'NotoSerif', 'NotoSansMono'],
          order: ['Roboto.ttf', 'NotoSerif.ttf', 'NotoSansMono.ttf'],
          fallback: ['Roboto', 'Noto Serif', 'Noto Sans Mono'],
          excluded: ['Liberation', 'Ubuntu', 'NotoSans.ttf'],
          aliases: { 'Droid Sans': 'Roboto' },
          absentAliases: ['Roboto'],
        },
      ];

      for (const entry of cases) {
        await buildLobiumLaunchArgs(entry.ctx);
        const config = JSON.parse(
          await readFile(join(entry.ctx.options.userDataDir, LOBIUM_CONFIG_FILENAME), 'utf8'),
        );
        assert.notEqual(config.fontPackDir, sourcePack, `${entry.name} must use a private subset`);
        assert.match(config.fontPackDir, /native-font-packs/);
        assert.deepEqual(config.fontFallbackFamilies.slice(0, 3), entry.fallback);
        const stagedFiles = readdirSync(join(config.fontPackDir, 'files')).sort();
        const staged = stagedFiles.join('|');
        entry.order.forEach((name, index) =>
          assert.match(stagedFiles[index] ?? '', new RegExp(name)),
        );
        for (const name of entry.included) assert.match(staged, new RegExp(name));
        for (const name of entry.excluded) assert.doesNotMatch(staged, new RegExp(name));
        for (const [claimed, physical] of Object.entries(entry.aliases)) {
          assert.equal(config.fontAliases[claimed], physical);
        }
        for (const claimed of entry.absentAliases ?? []) {
          assert.equal(config.fontAliases?.[claimed], undefined);
        }
      }
    } finally {
      if (previous === undefined) delete process.env.LOBSTER_FONTS_DIR;
      else process.env.LOBSTER_FONTS_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'Windows engine fails before launch when a non-Windows persona has no verified font pack',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'lobium-missing-persona-pack-'));
    const previous = process.env.LOBSTER_FONTS_DIR;
    try {
      delete process.env.LOBSTER_FONTS_DIR;
      // Clearing LOBSTER_FONTS_DIR is NOT enough to mean "no pack on this machine".
      // resolveFontsBaseDir falls through several machine-dependent candidates, among them
      // %LOCALAPPDATA%\lobster\lobium\fonts — so on any box with the product actually installed a
      // pack WAS found, no rejection happened, and this test quietly stopped testing anything. It
      // passed only where the product had never run. Caught 2026-08-26, minutes after provisioning
      // an engine on the Windows QA host.
      //
      // Pin the runtime instead of trusting the environment: a MANAGED runtime with no adjacent
      // fonts/ directory resolves to "no pack" and stops there — resolveFontsBaseDir returns
      // undefined for a managed runtime rather than consulting any fallback — which is precisely the
      // state this test is about, and is now independent of what the host has installed.
      const runtimeWithoutPack = {
        executablePath: join(root, 'engine', CHROMIUM_BINARY_NAME),
        managed: true,
      };
      await assert.rejects(
        () => buildLobiumLaunchArgs(ctxWith(root, { os: 'macos' }), runtimeWithoutPack),
        /verified font pack is required to present a macos font persona on a Windows engine/,
      );
    } finally {
      if (previous === undefined) delete process.env.LOBSTER_FONTS_DIR;
      else process.env.LOBSTER_FONTS_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
    // The persona's OS-version label is not part of the document: the sidecar has already turned it
    // into navigator.uaPlatformVersion, and the engine has no parser for the label itself.
    assert.equal(written.policy.osVersion, undefined);
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

test('ensureChromiumLaunchPreferences persists language sources for main frames and workers', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-persona-prefs-'));
  try {
    const ctx = ctxWith(userDataDir);
    ctx.fingerprint.navigator.languages = ['ja-JP', 'ja'];
    ctx.fingerprint.locale.locale = 'ja-JP';
    ensureChromiumLaunchPreferences(ctx);
    const prefs = JSON.parse(await readFile(join(userDataDir, 'Default', 'Preferences'), 'utf8'));
    assert.equal(prefs.intl.accept_languages, 'ja-JP,ja');
    assert.equal(prefs.intl.selected_languages, 'ja-JP,ja');
    const localState = JSON.parse(await readFile(join(userDataDir, 'Local State'), 'utf8'));
    assert.equal(localState.intl.app_locale, 'ja-JP');
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('ensureChromiumLaunchPreferences replaces Preferences exactly once, by rename, keeping user state', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-prefs-atomic-'));
  const prevLobee = process.env.LOBSTER_LOBEE_DIR;
  try {
    process.env.LOBSTER_LOBEE_DIR = join(userDataDir, 'lobee');
    const prefsPath = join(userDataDir, 'Default', 'Preferences');
    await mkdir(join(userDataDir, 'Default'), { recursive: true });
    // ~40 KB of real Chromium state stands in for what a launch must never drop.
    await writeFile(
      prefsPath,
      JSON.stringify({
        profile: {
          content_settings: { exceptions: { notifications: { 'https://a.test,*': {} } } },
        },
        partition: { per_host_zoom_levels: { x: { 'a.test': 1.5 } } },
        extensions: { pinned_extensions: ['aaaabbbbccccddddeeeeffffgggghhhh'] },
      }),
      { mode: 0o600 },
    );
    const before = statSync(prefsPath);

    const ctx = ctxWith(userDataDir);
    ctx.profileName = 'Shopper 4';
    ensureChromiumLaunchPreferences(ctx);

    const after = statSync(prefsPath);
    // A rename publishes a NEW inode; an in-place writeFileSync would keep the old one. This is what
    // proves the launch cannot leave a truncated Preferences behind.
    assert.notEqual(after.ino, before.ino, 'Preferences must be replaced by temp+rename');
    // POSIX only. Windows has no Unix permission bits — NTFS ACLs are the real mechanism — and Node
    // synthesises a mode of 0o666 for any writable file there, so this asserts nothing on the
    // platform the product actually ships on and fails the suite for a reason unrelated to the
    // behaviour under test.
    if (process.platform !== 'win32') {
      assert.equal(after.mode & 0o777, 0o600);
    }
    assert.deepEqual(
      readdirSync(join(userDataDir, 'Default')).filter((name) => name !== 'Preferences'),
      [],
      'no temp file may be left behind',
    );

    const prefs = JSON.parse(await readFile(prefsPath, 'utf8'));
    // Every one of the collapsed writes landed, in one file …
    assert.equal(prefs.profile.name, 'Your Lobium');
    assert.equal(prefs.profile.name_truncated, true);
    assert.equal(prefs.intl.accept_languages, fp.navigator.languages.join(','));
    assert.deepEqual(prefs.extensions.pinned_extensions, [
      LOBEE_EXTENSION_ID,
      'aaaabbbbccccddddeeeeffffgggghhhh',
    ]);
    // … the user's unrelated state survived …
    assert.ok(prefs.profile.content_settings.exceptions.notifications['https://a.test,*']);
    assert.equal(prefs.partition.per_host_zoom_levels.x['a.test'], 1.5);
    // … and session.restore_on_startup is NOT written: kRestoreOnStartup is a tracked/protected pref, so
    // writing it without a matching MAC resets the startup prefs on Windows/macOS. --restore-last-session
    // carries session restore instead.
    assert.equal(prefs.session, undefined);
  } finally {
    if (prevLobee === undefined) delete process.env.LOBSTER_LOBEE_DIR;
    else process.env.LOBSTER_LOBEE_DIR = prevLobee;
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('ensureChromiumLaunchPreferences never replaces an unparseable Preferences file', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-prefs-corrupt-'));
  try {
    const prefsPath = join(userDataDir, 'Default', 'Preferences');
    await mkdir(join(userDataDir, 'Default'), { recursive: true });
    // A half-written file from a crash. Replacing it with a fresh object would DISCARD the profile's
    // real preferences; the launch instead relies on --lobium-profile-name / --lang.
    const truncated = '{"profile":{"content_settings":{"exce';
    await writeFile(prefsPath, truncated, { mode: 0o600 });
    ensureChromiumLaunchPreferences(ctxWith(userDataDir));
    assert.equal(await readFile(prefsPath, 'utf8'), truncated);
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

test('buildNativeLobiumProcessArgs hands the engine a per-profile window mark', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-profile-mark-'));
  try {
    const ctx = ctxWith(userDataDir);
    ctx.profileName = 'Acme US';
    const args = await buildNativeLobiumProcessArgs(ctx);

    assert.ok(args.includes('--lobium-profile-name=Acme US'));
    assert.ok(args.includes('--lobium-profile-initials=AU'));
    // The whole name now, not just its first word: the icon wraps it over two lines.
    assert.ok(args.includes('--lobium-profile-word=Acme US'));
    assert.ok(args.includes(`--lobium-profile-tint=${profileMark('Acme US', ctx.profileId).tint}`));

    // A profile with no name at all leaves every mark switch off, so the engine keeps the stock
    // Chromium icon rather than drawing an empty violet square.
    const unnamed = await buildNativeLobiumProcessArgs(ctxWith(userDataDir));
    assert.ok(!unnamed.some((arg) => arg.startsWith('--lobium-profile-')));
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

    const args = await buildNativeLobiumProcessArgs(ctx, { extraArgsFor: () => [] });

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
  // The capability probe runs before the proxy check, so the fixture has to be genuinely spawnable
  // for the proxy gate to be reached at all (see writeFakeBinary for the Windows mechanics).
  const fakeBin = await writeFakeBinary(
    root,
    'fake-lobium',
    `if (process.argv.includes('--lobium-fingerprint-capabilities')) {
  process.stdout.write(${JSON.stringify(capabilityManifest)});
}
process.exit(0);
`,
  );
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
  const fakeBin = await writeFakeBinary(
    root,
    'fake-lobium',
    `const fs = require('node:fs');
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
// Stay resident like a browser, but never outlive the launcher. On Windows the launcher can only
// terminate the .exe shim that started this script, so no signal reaches here — poll the parent
// instead, otherwise a torn-down launch leaks an orphan still holding port 43210 and the next run
// of this test never sees a DevToolsActivePort.
setInterval(() => {
  try {
    process.kill(process.ppid, 0);
  } catch {
    process.exit(0);
  }
}, 250);
`,
  );
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
