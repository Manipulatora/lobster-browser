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
  [
    'branding/device-frame.patch',
    'does not link on Linux, the only platform it targets: its hooks compile there and reference ' +
      'LobiumDeviceFrameView, whose implementation is in no GN target (7 undefined symbols at the ' +
      'final link of chrome, measured on 152.0.7977.42)',
  ],
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
  const close = () => { if (hunk) { cur.hunks.push(hunk); hunk = null; } };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      close();
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = { path: m ? m[1] : null, toPath: m ? m[2] : null, diffLine: line, header: [], hunks: [] };
      files.push(cur);
      continue;
    }
    if (!cur) { preamble.push(line); continue; }
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
    if (hunk) { hunk.body.push(line); continue; }
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
      if (!f.path || !f.toPath) { bad.push(`${rel}: unparseable "diff --git" line: ${f.diffLine}`); continue; }
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
        if (!h.valid) { bad.push(`${rel}: ${f.path}: unparseable hunk header ${JSON.stringify(h.header)}`); continue; }
        // A "\ No newline at end of file" marker counts toward neither side.
        const body = h.body.filter((l) => !l.startsWith('\\'));
        const oldLines = body.filter((l) => l.startsWith(' ') || l.startsWith('-') || l === '').length;
        const newLines = body.filter((l) => l.startsWith(' ') || l.startsWith('+') || l === '').length;
        if (oldLines !== h.oldCount) {
          bad.push(`${rel}: ${f.path} ${h.header} declares ${h.oldCount} old lines, body has ${oldLines}`);
        }
        if (newLines !== h.newCount) {
          bad.push(`${rel}: ${f.path} ${h.header} declares ${h.newCount} new lines, body has ${newLines}`);
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
          bad.push(`${rel}: ${f.path}: @${prev.oldStart},${prev.oldCount} overlaps @${next.oldStart}`);
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
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bad.push(`${rel}: has a UTF-8 BOM`);
    for (let i = 1; i < buf.length; i++) {
      if (buf[i] === 0x0a && buf[i - 1] === 0x0d) { bad.push(`${rel}: contains CRLF`); break; }
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
          if (hit) bad.push(`${rel}: ${f.path}: ${[...new Set(hit)].join('')} in ${l.slice(0, 80)}`);
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
    ['fingerprint/webgl-surfaces.patch', 'fingerprint/host-gpu-profile.patch', 'fingerprint/webgl-runtime-safety.patch'],
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
  assert.ok(tsBlock, 'could not find LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES in the TypeScript mirror');
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
  assert.equal(nativeVersion[1], tsVersion[1], 'contract version mismatch between engine and sidecar');
});

test('every fingerprint patch in series has a capability that covers it', () => {
  // Not a 1:1 mapping - several patches make up one capability (webgl-deep spans the renderer
  // string, the caps, the extension list and shader precision). What this catches is a NEW
  // fingerprint surface landing in the series with no capability at all, which would ship a hook the
  // sidecar can never require and therefore can never guarantee.
  const covered = {
    'canvas-farbling': [/canvas/],
    'audio-farbling': [/audio/],
    'webgl-farbling': [/webgl-(surfaces|runtime-safety)/],
    // host-gpu-profile is part of webgl-deep: it carries the UNMASKED_VENDOR/RENDERER strings and the
    // MAX_* caps, which is the same surface as the rest of the WebGL1 hooks.
    'webgl-deep': [/webgl/, /gpu-profile/],
    'webgl2-deep': [/webgl/],
    'screen-metrics': [/screen-|media-values/],
    'mobile-persona': [/mobile-persona/],
    'client-rects': [/client-rects/],
    'media-devices': [/media-devices/],
    'webgpu-adapter': [/webgpu/],
    'native-timezone': [/timezone|locale/],
    'font-isolation': [/font/],
    'navigator-languages': [/navigator|language|user-agent|ua-/],
    'network-accept-language': [/accept-language|net/],
    'process-locale-timezone': [/locale|timezone/],
    'native-geolocation': [/geolocation/],
    'webrtc-policy': [/webrtc/],
    'config-channel-v1': [/config-channel/],
  };
  const patterns = Object.values(covered).flat();
  for (const p of series.filter((s) => s.startsWith('fingerprint/'))) {
    const name = p.slice('fingerprint/'.length, -'.patch'.length);
    assert.ok(
      patterns.some((re) => re.test(name)),
      `fingerprint/${name}.patch is not covered by any capability in lobium_capabilities.cc - ` +
        'a surface the sidecar cannot require is a surface it cannot guarantee',
    );
  }
});
