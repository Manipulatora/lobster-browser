import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * Structural invariants of the Lobium quilt patch series.
 *
 * Offline and fast: it reads only lobium/patches/, never the Chromium checkout, so it runs in CI on
 * a machine that has no 50 GB source tree. It cannot prove the series APPLIES — that needs the
 * checkout and is what `lobium/build.ps1 -Run -Stop patch` does — but every failure it does catch is
 * one that would otherwise surface hours into a build, or silently ship a half-applied engine.
 *
 * The rules exist because each one has already broken this repo at least once:
 *   - a hunk duplicated across two patches made `patch --forward` exit non-zero on three patches and
 *     abort the whole series apply, and would reject in two places on the next Chrome rebase;
 *   - CRLF patch files applied under GNU patch but were rejected by `git apply`, so half the tooling
 *     silently could not use them;
 *   - malformed hunk headers and missing ---/+++ headers shipped undetected;
 *   - non-ASCII in patch-added source trips Chromium's presubmit.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCHES = join(HERE, '..', '..', 'lobium', 'patches');

/** Patches that live on disk but are deliberately absent from `series`. Keep the reason with it. */
const NOT_IN_SERIES = new Map([
  ['branding/suppress-sandbox-infobar.patch', 'only needed for --no-sandbox dev runs'],
]);

/** Exact patch-to-capability ownership. A broad filename regex cannot prove which hook is present. */
const FINGERPRINT_PATCH_CAPABILITIES = new Map([
  ['fingerprint/canvas-farbling.patch', ['canvas-farbling']],
  ['fingerprint/webgl-surfaces.patch', ['webgl-deep', 'webgl2-deep', 'webgl-farbling']],
  ['fingerprint/host-gpu-profile.patch', ['webgl-deep']],
  ['fingerprint/webgl-runtime-safety.patch', ['webgl-deep', 'webgl2-deep']],
  ['fingerprint/webgl-bypass-closures.patch', ['webgl-deep', 'webgl2-deep', 'webgl-farbling']],
  ['fingerprint/webgl2-surfaces.patch', ['webgl2-deep']],
  ['fingerprint/webgpu-adapter.patch', ['webgpu-adapter']],
  // Availability rather than identity: without it Dawn returns no adapter for the patch above
  // to rewrite, so the two are one capability in two files.
  ['fingerprint/webgpu-availability.patch', ['webgpu-adapter']],
  ['fingerprint/audio-context.patch', ['audio-farbling']],
  ['fingerprint/audio-worklet-tap.patch', ['audio-farbling']],
  ['fingerprint/screen-dpr.patch', ['screen-metrics']],
  ['fingerprint/media-values-device-size.patch', ['screen-metrics']],
  // The colour half of the same surface: (color:), (dynamic-range:), (color-gamut:), all
  // derived from screen.colorDepth so they cannot be configured into disagreeing with it.
  ['fingerprint/media-values-color.patch', ['screen-metrics']],
  ['fingerprint/navigator-webdriver.patch', ['navigator-webdriver']],
  [
    'fingerprint/locale-geolocation.patch',
    ['navigator-languages', 'process-locale-timezone', 'native-geolocation'],
  ],
  ['fingerprint/client-rects.patch', ['client-rects']],
  ['fingerprint/media-devices.patch', ['media-devices']],
  ['fingerprint/mobile-persona.patch', ['mobile-persona']],
  ['fingerprint/webrtc-policy.patch', ['webrtc-policy']],
  ['fingerprint/native-timezone.patch', ['native-timezone']],
  ['fingerprint/windows-font-isolation.patch', ['font-isolation']],
]);

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.patch') ? [p] : [];
  });
}

const onDisk = walk(PATCHES).map((p) => relative(PATCHES, p).split('\\').join('/'));

const series = readFileSync(join(PATCHES, 'series'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

/** Parse one patch into { preamble, files:[{ path, header, hunks:[{ header, body, oldStart, oldCount, newCount }] }] }. */
function parse(rel) {
  const text = readFileSync(join(PATCHES, rel), 'utf8');
  const lines = text.split('\n');
  const preamble = [];
  const files = [];
  let cur = null;
  let hunk = null;
  const close = () => {
    if (hunk) {
      cur.hunks.push(hunk);
      hunk = null;
    }
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      close();
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = {
        path: m ? m[1] : null,
        toPath: m ? m[2] : null,
        diffLine: line,
        header: [],
        hunks: [],
      };
      files.push(cur);
      continue;
    }
    if (!cur) {
      preamble.push(line);
      continue;
    }
    if (line.startsWith('@@')) {
      close();
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      hunk = {
        header: line,
        valid: Boolean(m),
        oldStart: m ? Number(m[1]) : 0,
        oldCount: m ? (m[2] === undefined ? 1 : Number(m[2])) : 0,
        newCount: m ? (m[4] === undefined ? 1 : Number(m[4])) : 0,
        body: [],
      };
      continue;
    }
    if (hunk) {
      hunk.body.push(line);
      continue;
    }
    cur.header.push(line);
  }
  close();
  // Drop the trailing empty element produced by the file's final newline.
  for (const f of files) {
    for (const h of f.hunks) while (h.body.length && h.body.at(-1) === '') h.body.pop();
  }
  return { rel, preamble, files, text };
}

const parsed = new Map(series.map((rel) => [rel, parse(rel)]));

test('every patch named in series exists on disk, and every patch on disk is accounted for', () => {
  for (const rel of series) {
    assert.ok(existsSync(join(PATCHES, rel)), `series names a missing patch: ${rel}`);
  }
  const inSeries = new Set(series);
  for (const [rel, reason] of NOT_IN_SERIES) {
    assert.ok(onDisk.includes(rel), `stale NOT_IN_SERIES entry names a missing patch: ${rel}`);
    assert.ok(!inSeries.has(rel), `${rel} must stay out of the production series: ${reason}`);
  }
  for (const rel of onDisk) {
    if (inSeries.has(rel)) continue;
    assert.ok(
      NOT_IN_SERIES.has(rel),
      `${rel} is on disk but not in series and not in the NOT_IN_SERIES allowlist. ` +
        'A patch that is in neither is invisible: it never applies and nothing tells you.',
    );
  }
  assert.equal(new Set(series).size, series.length, 'series lists a patch twice');
});

test('no hunk body appears in more than one patch', () => {
  // The failure this prevents: `patch --forward` treats the second copy as "previously applied" and
  // exits non-zero, aborting the series; and on rebase one upstream change rejects in two patches
  // at once, with nothing to say which concern actually broke.
  const seen = new Map(); // key -> patch
  const dupes = [];
  for (const [rel, p] of parsed) {
    for (const f of p.files) {
      for (const h of f.hunks) {
        const key = `${f.path}\u0000${h.body.join('\n')}`;
        if (seen.has(key) && seen.get(key) !== rel) {
          dupes.push(`${f.path}: duplicated between ${seen.get(key)} and ${rel}`);
        } else {
          seen.set(key, rel);
        }
      }
    }
  }
  assert.deepEqual(dupes, [], `duplicated hunks:\n  ${dupes.join('\n  ')}`);
});

test('every file section has a complete diff --git / --- / +++ header trio', () => {
  const bad = [];
  for (const [rel, p] of parsed) {
    for (const f of p.files) {
      if (!f.path || !f.toPath) {
        bad.push(`${rel}: unparseable "diff --git" line: ${f.diffLine}`);
        continue;
      }
      const hasMinus = f.header.some((l) => l.startsWith('--- '));
      const hasPlus = f.header.some((l) => l.startsWith('+++ '));
      if (!hasMinus) bad.push(`${rel}: ${f.path} has no "--- a/" header`);
      if (!hasPlus) bad.push(`${rel}: ${f.path} has no "+++ b/" header`);
      if (!f.hunks.length) bad.push(`${rel}: ${f.path} has a header but no hunks`);
    }
  }
  assert.deepEqual(bad, [], `malformed sections:\n  ${bad.join('\n  ')}`);
});

test('every hunk header is well formed and its counts match the body', () => {
  const bad = [];
  for (const [rel, p] of parsed) {
    for (const f of p.files) {
      for (const h of f.hunks) {
        if (!h.valid) {
          bad.push(`${rel}: ${f.path}: unparseable hunk header ${JSON.stringify(h.header)}`);
          continue;
        }
        // A "\ No newline at end of file" marker counts toward neither side.
        const body = h.body.filter((l) => !l.startsWith('\\'));
        const oldLines = body.filter(
          (l) => l.startsWith(' ') || l.startsWith('-') || l === '',
        ).length;
        const newLines = body.filter(
          (l) => l.startsWith(' ') || l.startsWith('+') || l === '',
        ).length;
        if (oldLines !== h.oldCount) {
          bad.push(
            `${rel}: ${f.path} ${h.header} declares ${h.oldCount} old lines, body has ${oldLines}`,
          );
        }
        if (newLines !== h.newCount) {
          bad.push(
            `${rel}: ${f.path} ${h.header} declares ${h.newCount} new lines, body has ${newLines}`,
          );
        }
      }
    }
  }
  assert.deepEqual(bad, [], `hunk header/body mismatches:\n  ${bad.join('\n  ')}`);
});

test('hunks within a file section are ordered and never overlap', () => {
  const bad = [];
  for (const [rel, p] of parsed) {
    for (const f of p.files) {
      for (let i = 1; i < f.hunks.length; i++) {
        const prev = f.hunks[i - 1];
        const next = f.hunks[i];
        if (prev.oldStart + prev.oldCount > next.oldStart) {
          bad.push(
            `${rel}: ${f.path}: @${prev.oldStart},${prev.oldCount} overlaps @${next.oldStart}`,
          );
        }
      }
    }
  }
  assert.deepEqual(bad, [], `overlapping hunks:\n  ${bad.join('\n  ')}`);
});

test('patch files are LF-only UTF-8 without a BOM', () => {
  // CRLF applies under GNU patch (it strips the CRs) but `git apply` rejects it outright, so half
  // the tooling silently cannot consume the series.
  const bad = [];
  for (const rel of [...onDisk, 'series']) {
    const buf = readFileSync(join(PATCHES, rel));
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
      bad.push(`${rel}: has a UTF-8 BOM`);
    for (let i = 1; i < buf.length; i++) {
      if (buf[i] === 0x0a && buf[i - 1] === 0x0d) {
        bad.push(`${rel}: contains CRLF`);
        break;
      }
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('patch-added source lines are pure ASCII', () => {
  // Preambles are prose about the patch and may use whatever punctuation reads best; they are never
  // applied to a file. Added SOURCE lines land in Chromium and must satisfy its presubmit.
  const bad = [];
  for (const [rel, p] of parsed) {
    for (const f of p.files) {
      for (const h of f.hunks) {
        for (const l of h.body) {
          if (!l.startsWith('+')) continue;
          // eslint-disable-next-line no-control-regex
          const hit = l.match(/[^\x00-\x7F]/g);
          if (hit)
            bad.push(`${rel}: ${f.path}: ${[...new Set(hit)].join('')} in ${l.slice(0, 80)}`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], `non-ASCII in added source:\n  ${bad.join('\n  ')}`);
});

test('the WebGL and media-values chains stay in their required order', () => {
  // These patches hook the same upstream file and later ones are cut against the tree with the
  // earlier ones already applied, so their context contains Lobium lines. Reordering them silently
  // produces rejects that look like an upstream drift problem.
  const chains = [
    [
      'fingerprint/webgl-surfaces.patch',
      'fingerprint/host-gpu-profile.patch',
      'fingerprint/webgl-runtime-safety.patch',
      'fingerprint/webgl-bypass-closures.patch',
    ],
    ['fingerprint/screen-dpr.patch', 'fingerprint/media-values-device-size.patch'],
    ['core/build-gn.patch', 'core/config-channel.patch', 'core/navigator-ua-ch.patch'],
  ];
  for (const chain of chains) {
    const idx = chain.map((c) => series.indexOf(c));
    for (const [i, v] of idx.entries()) {
      assert.notEqual(v, -1, `${chain[i]} is missing from series but is part of an ordering chain`);
    }
    for (let i = 1; i < idx.length; i++) {
      assert.ok(idx[i] > idx[i - 1], `${chain[i]} must come after ${chain[i - 1]} in series`);
    }
  }
});

test('config-channel.patch stays a transport-only patch', () => {
  // It was 19 files and 55 hunks, 21 of them copies of other patches. Splitting it was the point of
  // the decomposition; this keeps it split.
  const cc = parsed.get('core/config-channel.patch');
  assert.ok(cc, 'core/config-channel.patch is not in series');
  const paths = cc.files.map((f) => f.path);
  assert.deepEqual(
    paths,
    ['content/browser/renderer_host/render_process_host_impl.cc'],
    'config-channel.patch must only carry the browser-side config read and --lobium-fp-data forward. ' +
      'A new fingerprint SURFACE belongs in its own patch under fingerprint/.',
  );
});

test('the native capability list, its TypeScript mirror, and the series agree', () => {
  // The capability manifest is a SAFETY claim: the sidecar refuses to launch a profile unless the
  // binary reports the hooks that profile's policy needs. Over-reporting is the dangerous direction
  // - the sidecar then launches believing spoofing exists that does not - so the list must not be
  // able to drift from the hooks. It is single-sourced in lobium/src/lobium_capabilities.cc; this
  // test is what makes "single-sourced" true rather than aspirational.
  const root = join(HERE, '..', '..');
  const nativeSrc = readFileSync(join(root, 'lobium', 'src', 'lobium_capabilities.cc'), 'utf8');
  const tsSrc = readFileSync(
    join(root, 'packages', 'engine-runner', 'src', 'lobium-capabilities.ts'),
    'utf8',
  );

  // Native: every "quoted-name" inside the two capability arrays, in order.
  const nativeNames = [...nativeSrc.matchAll(/^\s*"([a-z0-9-]+)",\s*$/gm)].map((m) => m[1]);
  const winOnly = [...nativeSrc.matchAll(/names\.push_back\("([a-z0-9-]+)"\);/g)].map((m) => m[1]);
  const native = new Set([...nativeNames, ...winOnly]);
  assert.ok(native.size > 0, 'could not parse any capability names out of lobium_capabilities.cc');

  const tsBlock = /LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES = \[([\s\S]*?)\] as const;/.exec(tsSrc);
  assert.ok(
    tsBlock,
    'could not find LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES in the TypeScript mirror',
  );
  const ts = new Set([...tsBlock[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]));

  const missingInTs = [...native].filter((n) => !ts.has(n));
  const missingInNative = [...ts].filter((n) => !native.has(n));
  assert.deepEqual(
    missingInTs,
    [],
    'the engine reports capabilities the sidecar does not know; it will reject its own binary',
  );
  assert.deepEqual(
    missingInNative,
    [],
    'the sidecar knows capabilities no build emits; requiring one would fail every launch',
  );

  // The contract version the engine stamps must be the one the sidecar accepts, or every probe is
  // rejected as incompatible and no profile can launch at all.
  const nativeVersion = /kCapabilityContractVersion = (\d+)/.exec(
    readFileSync(join(root, 'lobium', 'src', 'lobium_capabilities.h'), 'utf8'),
  );
  const tsVersion = /LOBIUM_CAPABILITY_CONTRACT_VERSION = (\d+)/.exec(tsSrc);
  assert.ok(nativeVersion && tsVersion, 'could not read the contract version from both sides');
  assert.equal(
    nativeVersion[1],
    tsVersion[1],
    'contract version mismatch between engine and sidecar',
  );
  assert.ok(
    Number(nativeVersion[1]) >= 3,
    'v2 cannot distinguish an engine that leaks local endpoints through icecandidateerror',
  );
});

test('every fingerprint patch has an explicit mapping to emitted capabilities', () => {
  const root = join(HERE, '..', '..');
  const nativeSrc = readFileSync(join(root, 'lobium', 'src', 'lobium_capabilities.cc'), 'utf8');
  const nativeNames = [...nativeSrc.matchAll(/^\s*"([a-z0-9-]+)",\s*$/gm)].map((m) => m[1]);
  const winOnly = [...nativeSrc.matchAll(/names\.push_back\("([a-z0-9-]+)"\);/g)].map((m) => m[1]);
  const native = new Set([...nativeNames, ...winOnly]);
  const fingerprintPatches = series.filter((s) => s.startsWith('fingerprint/')).sort();
  assert.deepEqual(
    [...FINGERPRINT_PATCH_CAPABILITIES.keys()].sort(),
    fingerprintPatches,
    'the explicit capability map must name every fingerprint patch in the series, and no absent one',
  );
  for (const [patch, capabilities] of FINGERPRINT_PATCH_CAPABILITIES) {
    assert.ok(capabilities.length > 0, `${patch} has no capability owner`);
    for (const capability of capabilities) {
      assert.ok(
        native.has(capability),
        `${patch} claims ${capability}, but the native binary does not emit that capability`,
      );
    }
  }
});

test('series replay is pinned and audits the complete checkout footprint', () => {
  const verifier = readFileSync(join(HERE, '..', '..', 'lobium', 'verify-series.mjs'), 'utf8');

  for (const script of [
    'verify-series.mjs',
    'chain-delta.mjs',
    'make-patch.mjs',
    'patch-owners.mjs',
    'regen-patch.mjs',
  ]) {
    const source = readFileSync(join(HERE, '..', '..', 'lobium', script), 'utf8');
    assert.match(source, /import \{ resolveChromiumSrc \} from '\.\/chromium-src\.mjs';/);
    assert.match(source, /const SRC = resolveChromiumSrc\(\);/);
  }

  assert.match(
    verifier,
    /CHROMIUM_REF="\\\$\\\{CHROMIUM_REF:-\(\[0-9\.\]\+\)\\\}"/,
    'the verifier must derive the canonical pin from build.sh instead of carrying another constant',
  );
  assert.match(verifier, /refs\/tags\/\$\{PINNED_REF\}\^\{commit\}/);
  assert.match(verifier, /headCommit !== pinnedCommit/);
  assert.match(
    verifier,
    /\['show', `\$\{pinnedCommit\}:\$\{f\}`\]/,
    'pristine replay blobs must come from the pinned commit, not an unchecked HEAD',
  );
  for (const command of [
    "['diff', '--name-only', '-z', '--']",
    "['diff', '--cached', '--name-only', '-z', '--']",
    "['ls-files', '--others', '--exclude-standard', '-z']",
  ]) {
    assert.ok(
      verifier.includes(command),
      `the verifier does not audit checkout footprint via ${command}`,
    );
  }
  assert.match(verifier, /changed only by patch\(es\) absent from series/);
  assert.match(verifier, /staged copy differs from its Lobium source/);
});

test('Windows patch application never infers success from GNU patch prose', () => {
  const build = readFileSync(join(HERE, '..', '..', 'lobium', 'build.ps1'), 'utf8');

  assert.match(build, /\[string\] \$SrcDir = \$env:LOBIUM_CHROMIUM_SRC/);
  assert.doesNotMatch(build, /[A-Za-z]:\\lobium-build\\src/i);
  assert.match(build, /\$Run -and \(ShouldRun 'patch'\) -and -not \$Force/);
  assert.match(build, /git --no-optional-locks diff --quiet -- \./);
  assert.match(build, /git --no-optional-locks diff --cached --quiet -- \./);
  assert.match(build, /patch-created path already exists/);
  assert.match(build, /stale patch artifact/);
  assert.doesNotMatch(build, /\$out\s+-notmatch/);
  assert.doesNotMatch(build, /SKIP \$p/);
  assert.match(
    build,
    /if \(\$LASTEXITCODE -eq 0\) \{[\s\S]*?Ok \$p[\s\S]*?\} else \{[\s\S]*?Die "Patch \$p did not apply cleanly/,
    'every non-zero patch exit status must stop the build',
  );
});
