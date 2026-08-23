#!/usr/bin/env node
// Chrome-version bump — the ONE command that moves every version pin in lockstep (roadmap W4).
//
//   node scripts/bump-engine-version.mjs 152.0.7977.42                 # bump the source pins
//   node scripts/bump-engine-version.mjs 152.0.7977.42 --dry-run       # show the diff, write nothing
//   node scripts/bump-engine-version.mjs 152.0.7977.42 \
//        --tarball out/lobium-linux-x64.tar.gz                         # ALSO finalize engine-manifest
//   node scripts/bump-engine-version.mjs --latest-stable               # resolve the target from the API
//
// WHY THIS EXISTS
// The version lives in four places that must never disagree:
//
//   1. lobium/build.sh          CHROMIUM_REF   — which Chromium source gets built
//   2. lobium/build.ps1         ChromiumRef    — the same build on Windows
//   3. packages/fingerprint     ENGINE_CHROME  — what every persona's UA claims
//   4. engine-manifest.json     version/url/sha256 — which tarball first-run provisioning installs
//
// (3) is a lie the moment it disagrees with the binaries produced by (1)/(2) and shipped by (4): a detector
// that feature-probes the engine, or simply reads getHighEntropyValues(['fullVersionList']), sees the
// contradiction directly. Bumping them by hand is four chances to get that wrong, so it is one command.
//
// (4) IS GATED ON A REAL ARTIFACT. Pointing the manifest at a version whose tarball has not been built
// and uploaded does not "prepare" anything — it breaks first-run provisioning for every user, because
// the URL 404s or the SHA-256 mismatches. So the manifest only moves when --tarball/--sha256 supplies a
// digest that exists. Between the source bump and the rebuild, `scripts/track-upstream.mjs` reports the
// manifest as pending rather than failing, which is the correct description of that state.
//
// THE PIN MUST BE A RELEASED BUILD. Verified against the Chrome version-history API before anything is
// written. A canary nightly is numerically newer than stable but is a build essentially nobody runs, so
// it hands every profile a near-unique fullVersionList — the exact defect this script was written to
// clean up (the repo sat on canary 152.0.7928.0). Override with --allow-unreleased only for a local
// experiment, never for a shipping pin.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'https://versionhistory.googleapis.com/v1/chrome';
const RELEASE_CHANNELS = ['stable', 'beta', 'dev'];
const MEMBERSHIP_PLATFORMS = ['linux', 'win64'];
const VERSION_RE = /^\d+\.\d+\.\d+\.\d+$/;
const TIMEOUT_MS = Number(process.env.LOBSTER_TRACK_TIMEOUT_MS || 20_000);

const BUILD_SH = 'lobium/build.sh';
const BUILD_PS1 = 'lobium/build.ps1';
const POOLS_TS = 'packages/fingerprint/src/pools.ts';
const MANIFEST = 'apps/desktop/src-tauri/resources/engine-manifest.json';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const DRY = flag('dry-run');
const ALLOW_UNRELEASED = flag('allow-unreleased');
const OFFLINE = flag('offline');

/**
 * Abort the bump with a usage-style error.
 *
 * Throws rather than calling `process.exit()`. This script makes ~9 HTTP requests before it can decide
 * a version is unacceptable, and forcing an immediate exit while undici's handles are still tearing
 * down aborts the process on Windows (`UV_HANDLE_CLOSING` assertion in libuv) — so a correct, fully
 * explained refusal exited 0xC0000409 with a crash dump instead of 2. The sentinel is caught in the
 * runner at the bottom, which sets the status and lets the event loop drain.
 */
class BumpError extends Error {}
function die(message) {
  throw new BumpError(message);
}

// An explicit controller + cleared timer, NOT AbortSignal.timeout(): that leaves an armed handle behind
// after the request settles, which is one more reason an immediate exit was unsafe.
async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`versionhistory API ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function latestStable() {
  const data = await getJson(
    `${HOST}/platforms/linux/channels/stable/versions?order_by=version%20desc`,
  );
  return (data.versions || []).map((v) => v.version).filter(Boolean)[0] ?? null;
}

/** Release channels that published this exact build. Throws only if EVERY probe failed. */
async function releaseChannelsFor(version) {
  const found = new Set();
  let ok = 0;
  await Promise.all(
    MEMBERSHIP_PLATFORMS.flatMap((platform) =>
      [...RELEASE_CHANNELS, 'canary'].map((channel) =>
        getJson(
          `${HOST}/platforms/${platform}/channels/${channel}/versions` +
            `?filter=version%3D${encodeURIComponent(version)}`,
        )
          .then((data) => {
            ok += 1;
            if ((data.versions || []).length > 0) found.add(channel);
          })
          .catch(() => {}),
      ),
    ),
  );
  if (ok === 0) throw new BumpError('version-history API unreachable');
  return [...found].sort();
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Apply one regex replacement, asserting it actually matched — a silent no-op is the failure mode. */
async function patch(relPath, replacements) {
  const path = join(ROOT, relPath);
  const before = await readFile(path, 'utf8');
  let after = before;
  for (const [label, re, next] of replacements) {
    if (!re.test(after)) die(`${relPath}: could not locate ${label} (pattern did not match)`);
    after = after.replace(re, next);
  }
  if (after === before) {
    console.log(`  ${relPath}: already at the target version`);
    return false;
  }
  if (!DRY) await writeFile(path, after, 'utf8');
  console.log(`  ${relPath}: updated${DRY ? ' (dry-run)' : ''}`);
  return true;
}

async function resolveTarget() {
  let target = argv.find((a) => VERSION_RE.test(a));
  if (!target && flag('latest-stable')) {
    try {
      target = await latestStable();
    } catch (e) {
      die(`cannot resolve latest stable: ${e.message}`);
    }
    console.log(`Resolved --latest-stable → ${target}`);
  }
  if (!target) {
    die('usage: bump-engine-version.mjs <major.minor.build.patch> | --latest-stable  [--dry-run]');
  }
  if (!VERSION_RE.test(target)) die(`"${target}" is not a full Chrome build (w.x.y.z)`);
  return target;
}

/** Refuse anything Google did not publish on a release channel. */
async function assertReleased(target) {
  if (OFFLINE) return;
  let channels;
  try {
    channels = await releaseChannelsFor(target);
  } catch (e) {
    die(
      `${e.message}. Re-run with --offline to skip channel validation (only safe when you have ` +
        'already confirmed the build is a real release).',
    );
  }
  const released = channels.filter((c) => RELEASE_CHANNELS.includes(c));
  console.log(`Published on: ${channels.length ? channels.join(', ') : '(no channel)'}`);
  if (released.length === 0 && !ALLOW_UNRELEASED) {
    die(
      `${target} is not published on stable/beta/dev` +
        `${channels.includes('canary') ? ' — it is a CANARY nightly' : ''}. ` +
        'Pinning it gives every profile a near-unique fullVersionList. ' +
        'Pass --allow-unreleased only for a local experiment.',
    );
  }
  if (released.length === 0) {
    console.warn('WARNING: --allow-unreleased — this pin must never ship.');
  }
}

/**
 * Finalize engine-manifest.json, but only against a digest that actually exists.
 *
 * The manifest is keyed by platform, so a bump names which platform's artifact it is publishing.
 * `--platform` defaults to linux-x64, the platform that has shipped since the manifest existed;
 * `--archive` is the platform-neutral spelling of `--tarball` (the Windows artifact is a .zip).
 * Finalizing one platform never touches another's entry — they are built on different hosts and are
 * routinely at different versions.
 */
async function finalizeManifest(target) {
  const tarball = value('tarball') ?? value('archive');
  const suppliedSha = value('sha256');
  const urlOverride = value('url');
  const platform = value('platform') ?? 'linux-x64';
  const path = join(ROOT, MANIFEST);

  if (!tarball && !suppliedSha) {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const current = manifest.platforms?.[platform]?.version;
    if (current !== target) {
      console.log(
        `\n  ${MANIFEST}: ${platform} LEFT AT ${current ?? 'unpublished'} ` +
          '(no --tarball/--archive/--sha256 given).\n' +
          '    This is intentional. Moving it without a published artifact breaks first-run\n' +
          '    provisioning. Build the engine, then re-run with --archive <path> to finalize.',
      );
    }
    return;
  }

  let sha = suppliedSha;
  if (tarball) {
    let info;
    try {
      info = await stat(tarball);
    } catch {
      die(`--tarball not found: ${tarball}`);
    }
    if (!info.isFile()) die(`--tarball is not a file: ${tarball}`);
    sha = await sha256File(tarball);
    console.log(`  sha256(${tarball}) = ${sha}  (${(info.size / 1e6).toFixed(1)} MB)`);
    if (suppliedSha && suppliedSha.toLowerCase() !== sha) {
      die(`--sha256 does not match the tarball digest (${suppliedSha} vs ${sha})`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test((sha || '').toLowerCase())) {
    die('--sha256 must be 64 lowercase hex characters');
  }

  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.platforms ??= {};
  const previous = manifest.platforms[platform];
  const url =
    urlOverride ??
    (previous?.url
      ? previous.url.replace(/engine-v[0-9.]+\//, `engine-v${target}/`)
      : die(
          `${platform} has no existing url to derive from; pass --url explicitly the first time a ` +
            'platform is published',
        ));
  manifest.platforms[platform] = { version: target, url, sha256: sha.toLowerCase() };

  // The artifact now exists, so the markers describing its absence are no longer true. Only the
  // markers for THIS platform are cleared — another platform's pending rebuild is still pending.
  if (platform === 'linux-x64') delete manifest.rebuildPending;
  delete manifest[`${platform}Pending`];

  if (!DRY) await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`  ${MANIFEST}: ${platform} version+url+sha256 updated${DRY ? ' (dry-run)' : ''}`);
  console.log(`    url = ${url}`);
}

async function main() {
  const target = await resolveTarget();
  await assertReleased(target);

  const major = target.split('.')[0];
  const reduced = `${major}.0.0.0`;
  console.log(`\nBumping engine version → ${target} (major ${major}, reduced ${reduced})`);

  await patch(BUILD_SH, [
    [
      'CHROMIUM_REF',
      /CHROMIUM_REF="\$\{CHROMIUM_REF:-[0-9.]+\}"/,
      `CHROMIUM_REF="\${CHROMIUM_REF:-${target}}"`,
    ],
  ]);
  await patch(BUILD_PS1, [
    ['ChromiumRef', /\$ChromiumRef = '[0-9.]+'/, `$ChromiumRef = '${target}'`],
  ]);
  await patch(POOLS_TS, [
    ['ENGINE_CHROME.major', /(ENGINE_CHROME[\s\S]*?major:\s*')[0-9]+(')/, `$1${major}$2`],
    ['ENGINE_CHROME.reduced', /(ENGINE_CHROME[\s\S]*?reduced:\s*')[0-9.]+(')/, `$1${reduced}$2`],
    ['ENGINE_CHROME.full', /(ENGINE_CHROME[\s\S]*?full:\s*')[0-9.]+(')/, `$1${target}$2`],
  ]);
  await finalizeManifest(target);

  console.log(
    `\nNext:\n` +
      `  1. lobium/rebase.sh ${target} --run     # re-apply the quilt series onto the new ref\n` +
      `  2. lobium/build.sh --run                # ~8-12h on the build host\n` +
      `  3. scripts/package-lobium-runtime.sh    # produce lobium-linux-x64.tar.gz\n` +
      `  4. node scripts/bump-engine-version.mjs ${target} --tarball <tarball>\n` +
      `  5. node scripts/track-upstream.mjs      # must exit 0\n` +
      `  6. node ci/validation/regression-gate.mjs\n`,
  );
}

try {
  await main();
} catch (error) {
  if (!(error instanceof BumpError)) throw error;
  console.error(`error: ${error.message}`);
  process.exitCode = 2;
}
