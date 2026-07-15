#!/usr/bin/env node
// Item 4 — Chrome-version tracking. Compares the pinned Chromium ref against the latest published
// stable and reports whether a rebase is due. Also asserts the internal version pins agree with each
// other (build.sh CHROMIUM_REF ↔ ENGINE_CHROME in pools.ts), the "version-coherence" invariant: a
// persona must never claim a Chrome the binary isn't.
//
//   node scripts/track-upstream.mjs            # report; exit 1 if behind stable
//   node scripts/track-upstream.mjs --json     # machine-readable
//
// CI wires this to open a tracking issue and (with lobium/rebase.sh + the regression gate) to drive an
// automated rebase → build → gate run on each new stable.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANNEL = process.env.LOBSTER_TRACK_CHANNEL || 'stable';
const API = `https://versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/${CHANNEL}/versions?order_by=version%20desc`;

const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
};

async function readPins() {
  const buildSh = await readFile(join(ROOT, 'lobium/build.sh'), 'utf8');
  const pinned = /CHROMIUM_REF="\$\{CHROMIUM_REF:-([0-9.]+)\}"/.exec(buildSh)?.[1] ?? null;
  const pools = await readFile(join(ROOT, 'packages/fingerprint/src/pools.ts'), 'utf8');
  const major = /ENGINE_CHROME\s*=\s*\{[\s\S]*?major:\s*'([0-9]+)'/.exec(pools)?.[1] ?? null;
  const full = /ENGINE_CHROME\s*=\s*\{[\s\S]*?full:\s*'([0-9.]+)'/.exec(pools)?.[1] ?? null;
  return { pinned, engineMajor: major, engineFull: full };
}

async function latestStable() {
  const res = await fetch(API);
  if (!res.ok) throw new Error(`versionhistory API ${res.status}`);
  const data = await res.json();
  const versions = (data.versions || []).map((v) => v.version).filter(Boolean);
  versions.sort((a, b) => cmp(b, a));
  return versions[0] ?? null;
}

const pins = await readPins();
let latest = null;
let apiError = null;
try {
  latest = await latestStable();
} catch (e) {
  apiError = String(e.message || e);
}

const pinnedMajor = pins.pinned?.split('.')[0] ?? null;
const latestMajor = latest?.split('.')[0] ?? null;
const behind = latest && pins.pinned ? cmp(latest, pins.pinned) > 0 : false;
const majorsBehind = latestMajor && pinnedMajor ? Number(latestMajor) - Number(pinnedMajor) : null;
// version-coherence: build ref major must equal the UA-pinned major, and the full pins must agree.
const coherent =
  pins.pinned && pins.engineMajor
    ? pinnedMajor === pins.engineMajor &&
      (!pins.engineFull || pins.engineFull.split('.')[0] === pinnedMajor)
    : false;

const report = {
  channel: CHANNEL,
  pinned: pins.pinned,
  engineMajor: pins.engineMajor,
  engineFull: pins.engineFull,
  latestStable: latest,
  apiError,
  behind,
  majorsBehind,
  versionCoherent: coherent,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Channel:        ${CHANNEL}`);
  console.log(`Pinned ref:     ${pins.pinned}  (UA major ${pins.engineMajor}, full ${pins.engineFull})`);
  console.log(`Latest stable:  ${latest ?? `(unavailable: ${apiError})`}`);
  console.log(`Version pins coherent (build ↔ UA): ${coherent ? 'YES ✓' : 'NO ✗ — UA claims a version the build is not'}`);
  if (latest) {
    console.log(
      behind
        ? `STATUS: BEHIND — rebase due (${majorsBehind ?? '?'} major(s) behind). Run lobium/rebase.sh onto ${latest}, then the regression gate.`
        : `STATUS: UP TO DATE (pinned ${pins.pinned} ≥ latest stable ${latest}).`,
    );
  }
}

// Non-zero when action is needed: either behind stable or an internal pin mismatch.
process.exit(!coherent || behind ? 1 : 0);
