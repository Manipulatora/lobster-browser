// Version-coherence gate (roadmap W4). Offline, no browser, no network — runs in the software tier.
//
// The Chrome version is pinned in four files that must never disagree:
//
//   lobium/build.sh            CHROMIUM_REF        — which source is built
//   lobium/build.ps1           ChromiumRef         — which source is built on Windows
//   packages/fingerprint       ENGINE_CHROME       — what every persona's UA claims
//   engine-manifest.json       version/url/sha256  — which tarball first-run provisioning installs
//
// A mismatch among the first three is a fingerprint LIE: the platform builds diverge or every
// profile advertises a Chrome the binary is not, and getHighEntropyValues(['fullVersionList'])
// exposes it without any probing. A mismatch with
// the third is a different thing — a rebuild that has not happened yet — so it is allowed, but only
// when the manifest DECLARES it. Silent drift and a declared pending rebuild look identical on disk
// otherwise, and the declared form is what makes the difference reviewable.
//
// `scripts/track-upstream.mjs` covers the online half (is the pin a real released build, is it behind
// stable). This file covers everything checkable without a network, so it can gate every pull request.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const FULL_VERSION = /^\d+\.\d+\.\d+\.\d+$/;

function pins() {
  const buildSh = read('lobium/build.sh');
  const pinned = /CHROMIUM_REF="\$\{CHROMIUM_REF:-([0-9.]+)\}"/.exec(buildSh)?.[1];
  const buildPs1 = read('lobium/build.ps1');
  const windowsPinned = /\$ChromiumRef\s*=\s*'([0-9.]+)'/.exec(buildPs1)?.[1];
  const pools = read('packages/fingerprint/src/pools.ts');
  const block = /export const ENGINE_CHROME = \{[\s\S]*?\} as const;/.exec(pools)?.[0] ?? '';
  return {
    pinned,
    windowsPinned,
    major: /major:\s*'([0-9]+)'/.exec(block)?.[1],
    reduced: /reduced:\s*'([0-9.]+)'/.exec(block)?.[1],
    full: /full:\s*'([0-9.]+)'/.exec(block)?.[1],
    manifest: JSON.parse(read('apps/desktop/src-tauri/resources/engine-manifest.json')),
  };
}

test('every version pin was found (the regexes still match their files)', () => {
  const p = pins();
  for (const [name, v] of Object.entries({
    'build.sh CHROMIUM_REF': p.pinned,
    'build.ps1 ChromiumRef': p.windowsPinned,
    'ENGINE_CHROME.major': p.major,
    'ENGINE_CHROME.reduced': p.reduced,
    'ENGINE_CHROME.full': p.full,
  })) {
    assert.ok(v, `${name} could not be parsed — a refactor moved it out from under this gate`);
  }
  assert.match(p.pinned, FULL_VERSION, 'CHROMIUM_REF must be a full w.x.y.z build');
  assert.match(p.windowsPinned, FULL_VERSION, 'ChromiumRef must be a full w.x.y.z build');
  assert.match(p.full, FULL_VERSION, 'ENGINE_CHROME.full must be a full w.x.y.z build');
});

test('the UA claims exactly the build that gets compiled', () => {
  const p = pins();
  assert.equal(
    p.windowsPinned,
    p.pinned,
    'build.ps1 ChromiumRef must equal build.sh CHROMIUM_REF — Windows and Linux must build the same source',
  );
  assert.equal(
    p.full,
    p.pinned,
    'ENGINE_CHROME.full must equal build.sh CHROMIUM_REF — otherwise every persona advertises a ' +
      'Chrome build the engine is not, which fullVersionList exposes directly',
  );
  assert.equal(p.major, p.pinned.split('.')[0], 'ENGINE_CHROME.major must be the pinned major');
  assert.equal(
    p.reduced,
    `${p.pinned.split('.')[0]}.0.0.0`,
    'ENGINE_CHROME.reduced must be the UA-reduced form of the pinned major',
  );
});

test('the version bump command moves both platform build pins', () => {
  const bump = read('scripts/bump-engine-version.mjs');
  assert.match(bump, /const BUILD_PS1 = 'lobium\/build\.ps1'/);
  assert.match(
    bump,
    /await patch\(BUILD_PS1,[\s\S]*?\['ChromiumRef',[\s\S]*?`\$ChromiumRef = '\$\{target\}'`/,
    'bumping Chromium must update the Windows build pin in the same operation',
  );
});

test('the pin is not a branch-point/canary build', () => {
  const p = pins();
  // A shipped Chrome release always carries a non-zero patch component. `w.x.y.0` is the signature of
  // a branch-point build — which is what a canary nightly is. This is the offline half of the check
  // that track-upstream.mjs makes authoritatively against the version-history API; it exists here so a
  // canary pin cannot reach main on a runner with no network egress. The repo shipped 152.0.7928.0 —
  // a canary — for months precisely because nothing asserted this.
  assert.notEqual(
    p.pinned.split('.')[3],
    '0',
    `CHROMIUM_REF ${p.pinned} has a .0 patch component, the signature of a canary/branch-point ` +
      'build. Pin a build published on stable/beta/dev; see scripts/bump-engine-version.mjs',
  );
});

test('the engine manifest lists at least one platform, each well formed', () => {
  // The manifest is per-platform now. A flat single-artifact manifest meant a Windows install
  // downloaded the Linux tarball and unpacked a `chrome` ELF it could not execute — provisioning
  // reported success and first launch failed with an unrelated-looking error.
  const p = pins();
  const platforms = p.manifest.platforms;
  assert.ok(
    platforms && typeof platforms === 'object' && !Array.isArray(platforms),
    'engine-manifest.json must carry a `platforms` map keyed by platform id',
  );
  const ids = Object.keys(platforms);
  assert.ok(ids.length > 0, 'engine-manifest.json lists no platforms at all');
  const KNOWN = new Set(['linux-x64', 'linux-arm64', 'win-x64', 'mac-x64', 'mac-arm64']);
  for (const [id, entry] of Object.entries(platforms)) {
    assert.ok(KNOWN.has(id), `unknown platform id '${id}'; the Rust side would never look it up`);
    assert.match(entry.version ?? '', FULL_VERSION, `platforms.${id}.version must be w.x.y.z`);
    assert.match(
      String(entry.sha256 ?? '').toLowerCase(),
      /^[0-9a-f]{64}$/,
      `platforms.${id}.sha256 must be a 64-char hex digest`,
    );
    assert.ok(
      typeof entry.url === 'string' && entry.url.startsWith('https://'),
      `platforms.${id}.url must be an https URL`,
    );
    assert.ok(
      entry.url.includes(entry.version),
      `platforms.${id}.url must name its own version (${entry.version}): ${entry.url}`,
    );
    // The archive has to be for the platform it is filed under. A copy-paste that leaves a
    // linux tarball under win-x64 is exactly the failure the platforms map exists to prevent.
    assert.ok(
      entry.url.includes(id),
      `platforms.${id}.url does not mention '${id}'; it may be another platform's archive`,
    );
  }
});

test('the engine manifest either matches the pin, or declares the rebuild as pending', () => {
  const p = pins();
  // Coherence is checked against the reference platform, which is the one that has a published
  // artifact today. Other platforms are validated for shape above; they cannot be checked against
  // ENGINE_CHROME until they are actually published, and a missing entry is a declared gap
  // (`<id>Pending`) rather than a silent one.
  const REFERENCE = 'linux-x64';
  const ref = p.manifest.platforms?.[REFERENCE];
  assert.ok(ref, `engine-manifest.json has no '${REFERENCE}' entry to check the pin against`);
  // Only the platforms the product actually ships an installer for — scripts/build-linux-product.sh
  // and scripts/build-windows-product.ps1. macOS is not a target, so demanding a pending block for
  // it would be noise rather than a gap.
  for (const id of ['win-x64']) {
    if (!p.manifest.platforms[id]) {
      const marker = p.manifest[`${id}Pending`];
      assert.ok(
        marker && typeof marker.why === 'string' && typeof marker.howToClear === 'string',
        `'${id}' has no manifest entry and no '${id}Pending' block explaining why. An undeclared ` +
          'gap is indistinguishable from an oversight, and users on that platform get no engine.',
      );
    }
  }
  // Read the reference entry through the same names the rest of this test already uses.
  p.manifest = { ...p.manifest, ...ref };
  assert.match(p.manifest.version, FULL_VERSION, 'manifest.version must be a full w.x.y.z build');
  if (p.manifest.version === p.full) {
    assert.equal(
      p.manifest.rebuildPending,
      undefined,
      'manifest matches the pin, so the rebuildPending marker is stale and must be removed',
    );
    assert.ok(
      p.manifest.url.includes(p.full),
      `manifest.url must name the pinned version (${p.full}): ${p.manifest.url}`,
    );
    assert.match(
      String(p.manifest.sha256).toLowerCase(),
      /^[0-9a-f]{64}$/,
      'manifest.sha256 must be a 64-char hex digest',
    );
    return;
  }
  // Versions differ: legitimate ONLY as an explicitly declared pending rebuild.
  const pending = p.manifest.rebuildPending;
  assert.ok(
    pending && typeof pending === 'object',
    `engine-manifest.json is at ${p.manifest.version} but ENGINE_CHROME is ${p.full}. ` +
      'If a rebuild is genuinely outstanding, declare it with a `rebuildPending` block; ' +
      'otherwise finalize it via `node scripts/bump-engine-version.mjs <version> --tarball <path>`.',
  );
  assert.equal(
    pending.targetVersion,
    p.full,
    'rebuildPending.targetVersion must name the version ENGINE_CHROME now claims',
  );
  for (const field of ['why', 'howToClear']) {
    assert.ok(
      typeof pending[field] === 'string' && pending[field].length > 20,
      `rebuildPending.${field} must explain the pending state to the next reader`,
    );
  }
  // The url/sha256 must still describe the OLD artifact, because that is what is actually published.
  assert.ok(
    p.manifest.url.includes(p.manifest.version),
    'while a rebuild is pending, manifest.url must still point at the published (old) artifact',
  );
  assert.match(String(p.manifest.sha256).toLowerCase(), /^[0-9a-f]{64}$/);
  // Same milestone keeps the UA honest enough to ship: the reduced UA (major.0.0.0) is identical, so
  // only the high-entropy patch differs. A whole milestone apart changes the feature surface and is a
  // probeable lie, so it must not survive a pull request.
  assert.equal(
    p.manifest.version.split('.')[0],
    p.full.split('.')[0],
    `pending rebuild spans a milestone (${p.manifest.version} → ${p.full}). The reduced UA and the ` +
      'engine feature surface now disagree; ship the rebuild before merging a cross-milestone bump.',
  );
});

test('the Windows product build cannot reuse a source-stale sidecar', () => {
  const productBuild = read('scripts/build-windows-product.ps1');
  const sidecarBundler = read('scripts/bundle-sidecar.mjs');
  const sidecarStep =
    /Step '\[1\/4\] Bundle the self-contained sidecar'([\s\S]*?)Step "\[2\/4\] Vendor/.exec(
      productBuild,
    )?.[1];

  assert.ok(sidecarStep, 'could not isolate the Windows sidecar staging step');
  assert.match(sidecarStep, /node scripts\\bundle-sidecar\.mjs/);
  assert.doesNotMatch(
    sidecarStep,
    /Test-Path|already staged|\$Force/,
    'an existing sidecar is not evidence that it was built from the current workspace sources',
  );

  // The always-run staging command is also the artifact test: bundle-sidecar rebuilds its workspace
  // inputs, starts the exact generated entry point, and requires a successful ping/pong round trip.
  assert.match(sidecarBundler, /mustBuild\(ws\)/);
  assert.match(sidecarBundler, /spawnSync\(process\.execPath, \[join\(outDir, 'index\.js'\)\]/);
  assert.match(sidecarBundler, /pong\.ok !== true \|\| pong\.result\?\.pong !== true/);
});
