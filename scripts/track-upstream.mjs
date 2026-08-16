#!/usr/bin/env node
// Item 4 — Chrome-version tracking. Compares the pinned Chromium ref against the latest published
// stable and reports whether a rebase is due. Also asserts the internal version pins agree with each
// other (build.sh CHROMIUM_REF ↔ ENGINE_CHROME in pools.ts ↔ engine-manifest.json), the
// "version-coherence" invariant: a persona must never claim a Chrome the binary isn't.
//
//   node scripts/track-upstream.mjs            # report; exit 1 if action is needed
//   node scripts/track-upstream.mjs --json     # machine-readable
//
// CI wires this to open a tracking issue and (with lobium/rebase.sh + the regression gate) to drive an
// automated rebase → build → gate run on each new stable.
//
// CHANNEL MEMBERSHIP IS CHECKED, NOT JUST ORDERING.
// The original version of this script decided staleness with `behind = cmp(latest, pinned) > 0` alone.
// That is only half the question, and the half it missed is the one that actually bit: the repo sat on
// 152.0.7928.0 — a CANARY nightly — while stable was 151.0.7922.x. Because 152 > 151 the comparison
// said "UP TO DATE" and exited 0, so the tool built to catch version drift green-lit a build no real
// user runs, for months. Freshness and population are different properties and an anti-detect product
// needs both: `getHighEntropyValues(['fullVersionList'])` returns the real build, so a canary number is
// close to a globally unique identifier, and its `.0` patch component advertises it as a branch-point
// build rather than a release. So the pin is now verified to EXIST on a release channel
// (stable/beta/dev) and to not be ahead of stable by more than one milestone.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANNEL = process.env.LOBSTER_TRACK_CHANNEL || 'stable';
const HOST = 'https://versionhistory.googleapis.com/v1/chrome';
const API = `${HOST}/platforms/linux/channels/${CHANNEL}/versions?order_by=version%20desc`;
/** Channels a shipping pin may legitimately come from. `canary` is deliberately absent. */
const RELEASE_CHANNELS = ['stable', 'beta', 'dev'];
/** Platforms consulted for channel membership: where we build, plus the dominant persona platform. */
const MEMBERSHIP_PLATFORMS = ['linux', 'win64'];
const TIMEOUT_MS = Number(process.env.LOBSTER_TRACK_TIMEOUT_MS || 20_000);

const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
};

// Explicit controller + cleared timer rather than AbortSignal.timeout(), which leaves an armed handle
// alive after the request settles. This script ends on process.exit(), and exiting with live libuv
// handles aborts the process on Windows instead of returning the intended status code.
async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`versionhistory API ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function readPins() {
  const buildSh = await readFile(join(ROOT, 'lobium/build.sh'), 'utf8');
  const pinned = /CHROMIUM_REF="\$\{CHROMIUM_REF:-([0-9.]+)\}"/.exec(buildSh)?.[1] ?? null;
  const pools = await readFile(join(ROOT, 'packages/fingerprint/src/pools.ts'), 'utf8');
  const major = /ENGINE_CHROME\s*=\s*\{[\s\S]*?major:\s*'([0-9]+)'/.exec(pools)?.[1] ?? null;
  const reduced = /ENGINE_CHROME\s*=\s*\{[\s\S]*?reduced:\s*'([0-9.]+)'/.exec(pools)?.[1] ?? null;
  const full = /ENGINE_CHROME\s*=\s*\{[\s\S]*?full:\s*'([0-9.]+)'/.exec(pools)?.[1] ?? null;
  // The manifest is the third pin: it names the tarball first-run provisioning downloads. It moves only
  // when a rebuilt engine has actually been published, so a mismatch here means "rebuild pending" —
  // reported distinctly from a pin typo, because the two need completely different actions.
  let manifestVersion = null;
  try {
    const manifest = JSON.parse(
      await readFile(join(ROOT, 'apps/desktop/src-tauri/resources/engine-manifest.json'), 'utf8'),
    );
    // The reference platform, which is the one whose artifact has been published since the manifest
    // existed. Per-platform entries can legitimately sit at different versions (they are built on
    // different hosts), so "the manifest version" only means something relative to one of them.
    const ref = manifest.platforms?.['linux-x64'] ?? manifest;
    manifestVersion = typeof ref.version === 'string' ? ref.version : null;
  } catch {
    manifestVersion = null;
  }
  return { pinned, engineMajor: major, engineReduced: reduced, engineFull: full, manifestVersion };
}

async function latestStable() {
  const data = await getJson(API);
  const versions = (data.versions || []).map((v) => v.version).filter(Boolean);
  versions.sort((a, b) => cmp(b, a));
  return versions[0] ?? null;
}

/**
 * Which release channels published this exact build, across the platforms we care about.
 *
 * A build that appears in no channel at all, or only in `canary`, must never be a shipping pin.
 */
async function channelsFor(version) {
  const found = new Set();
  const probes = [];
  for (const platform of MEMBERSHIP_PLATFORMS) {
    for (const channel of [...RELEASE_CHANNELS, 'canary']) {
      const url =
        `${HOST}/platforms/${platform}/channels/${channel}/versions` +
        `?filter=version%3D${encodeURIComponent(version)}`;
      probes.push(
        getJson(url)
          .then((data) => {
            if ((data.versions || []).length > 0) found.add(channel);
          })
          // A single 404/timeout must not be read as "not on this channel" — that would turn a network
          // blip into a false "unreleased pin" failure. Surface it as an unknown instead.
          .catch(() => {
            found.add(`?${channel}`);
          }),
      );
    }
  }
  await Promise.all(probes);
  return [...found].sort();
}

const pins = await readPins();
let latest = null;
let pinnedChannels = [];
let apiError = null;
let membershipKnown = false;
// Resolved INDEPENDENTLY. Chaining them meant a failure of the stable feed skipped the membership probe
// entirely, leaving `pinnedChannels` empty — which reads identically to "published on no release
// channel" and turned any network blip into a false UNRELEASED-PIN failure. Each half now degrades to
// "unknown" on its own.
{
  const [stableResult, channelResult] = await Promise.allSettled([
    latestStable(),
    pins.pinned ? channelsFor(pins.pinned) : Promise.resolve([]),
  ]);
  if (stableResult.status === 'fulfilled') latest = stableResult.value;
  else apiError = String(stableResult.reason?.message || stableResult.reason);
  if (channelResult.status === 'fulfilled') {
    pinnedChannels = channelResult.value;
    membershipKnown = true;
  } else {
    apiError ??= String(channelResult.reason?.message || channelResult.reason);
  }
}

const pinnedMajor = pins.pinned?.split('.')[0] ?? null;
const latestMajor = latest?.split('.')[0] ?? null;
const behind = latest && pins.pinned ? cmp(latest, pins.pinned) > 0 : false;
const majorsBehind = latestMajor && pinnedMajor ? Number(latestMajor) - Number(pinnedMajor) : null;

const releaseChannels = pinnedChannels.filter((c) => RELEASE_CHANNELS.includes(c));
const probeIncomplete = !membershipKnown || pinnedChannels.some((c) => c.startsWith('?'));
// `null` = genuinely unknown (the API could not be reached), which must never fail the build. `false`
// is only claimed when every probe SUCCEEDED and none of them found the build on a release channel.
const pinnedIsReleased = releaseChannels.length > 0 ? true : probeIncomplete ? null : false;
// Being one milestone ahead of stable is normal and intended (we track beta so a rebuild lands before
// the milestone ships). Two or more means the pin left the release train entirely.
const milestonesAhead =
  latestMajor && pinnedMajor ? Math.max(0, Number(pinnedMajor) - Number(latestMajor)) : null;
const tooFarAhead = milestonesAhead !== null && milestonesAhead > 1;

// version-coherence: build ref must equal the UA-pinned full build, and the reduced form must follow.
const buildMatchesUa = Boolean(pins.pinned && pins.engineFull && pins.pinned === pins.engineFull);
const reducedOk = !pins.engineReduced || pins.engineReduced === `${pinnedMajor}.0.0.0`;
const majorOk = Boolean(pinnedMajor && pins.engineMajor && pinnedMajor === pins.engineMajor);
const coherent = buildMatchesUa && reducedOk && majorOk;
// Separate signal: the published engine artifact still predates the pin, i.e. a rebuild is outstanding.
const manifestPending = Boolean(
  pins.manifestVersion && pins.engineFull && pins.manifestVersion !== pins.engineFull,
);

const report = {
  channel: CHANNEL,
  pinned: pins.pinned,
  pinnedChannels,
  pinnedIsReleased,
  engineMajor: pins.engineMajor,
  engineReduced: pins.engineReduced,
  engineFull: pins.engineFull,
  manifestVersion: pins.manifestVersion,
  manifestPending,
  latestStable: latest,
  apiError,
  behind,
  majorsBehind,
  milestonesAhead,
  tooFarAhead,
  versionCoherent: coherent,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Channel:        ${CHANNEL}`);
  console.log(
    `Pinned ref:     ${pins.pinned}  (UA major ${pins.engineMajor}, full ${pins.engineFull})`,
  );
  console.log(
    `Pinned build published on: ${
      pinnedChannels.length ? pinnedChannels.join(', ') : '(none found)'
    }`,
  );
  console.log(`Engine manifest: ${pins.manifestVersion ?? '(unreadable)'}`);
  console.log(`Latest stable:  ${latest ?? `(unavailable: ${apiError})`}`);
  console.log(
    `Version pins coherent (build ↔ UA): ${
      coherent ? 'YES ✓' : 'NO ✗ — UA claims a version the build is not'
    }`,
  );
  if (pinnedIsReleased === false) {
    console.log(
      `STATUS: UNRELEASED PIN ✗ — ${pins.pinned} is not published on any release channel` +
        `${pinnedChannels.includes('canary') ? ' (it is a CANARY build)' : ''}. Every profile would` +
        ' advertise a near-unique build via fullVersionList. Repin to a stable/beta build.',
    );
  } else if (pinnedIsReleased === null) {
    console.log('STATUS: channel membership UNKNOWN (version-history API unreachable).');
  } else if (tooFarAhead) {
    console.log(
      `STATUS: AHEAD ✗ — pinned milestone ${pinnedMajor} is ${milestonesAhead} ahead of stable` +
        ` ${latestMajor}. Tracking beta is fine; two milestones is not.`,
    );
  } else if (latest) {
    console.log(
      behind
        ? `STATUS: BEHIND — rebase due (${majorsBehind ?? '?'} major(s) behind). Run lobium/rebase.sh onto ${latest}, then the regression gate.`
        : `STATUS: UP TO DATE (pinned ${pins.pinned} ≥ latest stable ${latest}, published on ${releaseChannels.join('/')}).`,
    );
  }
  if (manifestPending) {
    console.log(
      `NOTE: engine-manifest.json still points at ${pins.manifestVersion} — rebuild + publish the` +
        ` ${pins.engineFull} runtime, then run scripts/bump-engine-version.mjs --tarball <path>.`,
    );
  }
}

// Non-zero when action is needed: an incoherent pin, an unreleased pin, a runaway-ahead pin, or behind
// stable. A pending manifest is reported but does not fail — it is the expected state between a version
// bump and the rebuild that satisfies it.
//
// `process.exitCode`, never `process.exit()`. This script has just made ~9 HTTP requests, and forcing
// an immediate exit while undici's handles are still tearing down aborts the process on Windows
// (`UV_HANDLE_CLOSING` assertion in libuv), replacing the intended status with 0xC0000409. Setting the
// code and letting the event loop drain naturally reports the real verdict on every platform.
process.exitCode = !coherent || pinnedIsReleased === false || tooFarAhead || behind ? 1 : 0;
