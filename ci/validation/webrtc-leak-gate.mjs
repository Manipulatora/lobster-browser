#!/usr/bin/env node
/**
 * WebRTC leak gate - the launcher's IP-handling policy must actually reach the engine.
 *
 * WHY THIS EXISTS. The launcher spent every launch passing
 * `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` and that flag does nothing here. It is
 * read by content/shell and headless/lib only; a chrome/ build takes the policy from a preference,
 * and chrome/browser/prefs/chrome_command_line_pref_store.cc feeds that pref from a differently
 * named switch, `--webrtc-ip-handling-policy`. So the flag was silently discarded and WebRTC kept
 * gathering candidates exactly as if no policy had been set. Measured on this build:
 *
 *     no flag                                4 candidates: 2 host, 2 srflx
 *     --force-webrtc-ip-handling-policy=...  4 candidates: 2 host, 2 srflx   <- identical, ignored
 *     --webrtc-ip-handling-policy=...        0 candidates
 *
 * The srflx ("server reflexive") candidates are the ones that carry the REAL PUBLIC IP, learned from
 * a STUN server the engine reached directly. That is the leak the policy exists to prevent, and it
 * was open. Nothing caught it because the obvious check - "is the private IP hidden?" - passes
 * anyway: Chrome's default mDNS behaviour hides private IPs whatever the policy says.
 *
 * This gate asserts the OUTCOME after the page calls setConfiguration(STUN+TURN/all), through both
 * candidate events and localDescription.sdp. Launch flags and native JSON come from the production
 * builders, so it also fails if orchestration and browser policy drift apart.
 *
 *   LOBSTER_LOBIUM_BIN=<chrome> node ci/validation/webrtc-leak-gate.mjs
 *
 * Exit codes: 0 pass, 1 leak, 2 blocked.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveFingerprint } from '../../packages/fingerprint/dist/index.js';
import {
  buildLaunchOptions,
  buildLobiumConfig,
  cdpEvaluate,
  lobiumConfigArg,
  withCdpSession,
  writeLobiumConfig,
} from '../../packages/engine-runner/dist/lib.js';

const bin = process.env.LOBSTER_LOBIUM_BIN;
if (!bin) {
  console.error('BLOCKED: set LOBSTER_LOBIUM_BIN');
  process.exit(2);
}

async function startFailingTurnTlsEndpoint() {
  // Accept and immediately close a TURN-over-TLS connection. This produces a
  // prompt relay failure without third-party timing. TLS is intentional:
  // disable_non_proxied_udp still permits page-supplied TURN TCP/TLS, and
  // WebRTC's private-server special case clears local endpoints only for raw
  // TCP, not TLS. The control therefore proves the exact pre-fix leak path.
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.unref();
  const { port } = server.address();
  return {
    url: `turns:127.0.0.1:${port}?transport=tcp`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const failingTurn = await startFailingTurnTlsEndpoint();

const GATE_SEED = '0123456789abcdef0123456789abcdef';
const gateFingerprint = deriveFingerprint(GATE_SEED, { os: 'windows', engine: 'lobium' });
const REQUESTED_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: failingTurn.url,
    username: 'lobium-probe',
    credential: 'lobium-probe',
  },
];

const GATHER = `(async () => {
  // Start deliberately restrictive, then let the page restore STUN + TURN + "all". Constructor-only
  // native enforcement passes the old probe and fails this one.
  const requestedIceServers = ${JSON.stringify(REQUESTED_ICE_SERVERS)};
  const normalizeServers = (servers) =>
    (servers || []).map((server) => ({
      urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(Boolean).sort(),
      username: server.username || '',
      credential: typeof server.credential === 'string' ? server.credential : '',
    }));
  const candidateTypes = (candidates) => {
    const types = {};
    for (const candidate of candidates) {
      const match = /\\btyp\\s+(\\w+)/.exec(candidate);
      if (match) types[match[1]] = (types[match[1]] || 0) + 1;
    }
    return types;
  };

  const out = { constructs: false, reconfigured: false, rejectedSet: false };
  let pc;
  try {
    pc = new RTCPeerConnection({
      iceServers: [],
      iceTransportPolicy: 'relay',
      bundlePolicy: 'balanced',
    });
    out.constructs = true;
  } catch (e) {
    out.errName = e.name;
    out.errMessage = e.message;
    return JSON.stringify(out);
  }

  const initial = pc.getConfiguration();
  out.initialPolicy = initial.iceTransportPolicy;
  out.initialServers = normalizeServers(initial.iceServers);
  try {
    pc.setConfiguration({
      iceServers: requestedIceServers,
      iceTransportPolicy: 'all',
    });
    out.reconfigured = true;
  } catch (e) {
    out.reconfigureErrName = e.name;
    out.reconfigureErrMessage = e.message;
    pc.close();
    return JSON.stringify(out);
  }

  const applied = pc.getConfiguration();
  out.requestedServers = normalizeServers(requestedIceServers);
  out.echoedPolicy = applied.iceTransportPolicy;
  out.echoedServers = normalizeServers(applied.iceServers);

  pc.createDataChannel('probe');
  const eventCandidates = [];
  const candidateErrors = [];
  const targetErrorUrl = ${JSON.stringify(failingTurn.url)};
  let resolveTargetError;
  const targetErrorSeen = new Promise((resolve) => {
    resolveTargetError = resolve;
  });
  pc.onicecandidate = (event) => {
    if (event.candidate) eventCandidates.push(event.candidate.candidate);
  };
  pc.onicecandidateerror = (event) => {
    candidateErrors.push({
      address: event.address,
      port: event.port,
      hostCandidate: event.hostCandidate,
      url: event.url,
      errorCode: event.errorCode,
      errorText: event.errorText,
    });
    if (event.url === targetErrorUrl) resolveTargetError();
  };
  const gatheringComplete = new Promise((resolve) => {
    const onState = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', onState);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', onState);
    onState();
  });
  await pc.setLocalDescription(await pc.createOffer());
  await Promise.race([gatheringComplete, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  // icegatheringstatechange and icecandidateerror arrive through separate task
  // chains. If policy retained the synthetic TURN URL, give its error callback
  // a bounded opportunity to drain before sampling the result.
  const retainsTargetServer = applied.iceServers.some((server) =>
    (Array.isArray(server.urls) ? server.urls : [server.urls]).includes(targetErrorUrl),
  );
  if (retainsTargetServer) {
    await Promise.race([targetErrorSeen, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }

  const sdp = pc.localDescription ? pc.localDescription.sdp : '';
  const sdpCandidates = sdp.match(/^a=candidate:.*$/gm) || [];
  out.eventTotal = eventCandidates.length;
  out.eventTypes = candidateTypes(eventCandidates);
  out.sdpTotal = sdpCandidates.length;
  out.sdpTypes = candidateTypes(sdpCandidates);
  out.candidateErrors = candidateErrors;

  // bundlePolicy is immutable after construction, so this reaches native SetConfiguration and is
  // rejected with INVALID_MODIFICATION. The attempted ICE values must not replace the successful echo.
  try {
    pc.setConfiguration({
      iceServers: [],
      iceTransportPolicy: 'relay',
      bundlePolicy: 'max-bundle',
    });
  } catch (e) {
    out.rejectedSet = true;
    out.rejectedSetName = e.name;
  }
  const afterRejected = pc.getConfiguration();
  out.afterRejectedPolicy = afterRejected.iceTransportPolicy;
  out.afterRejectedServers = normalizeServers(afterRejected.iceServers);
  pc.close();
  return JSON.stringify(out);
})()`;

/**
 * Wait for a PAGE target before attaching.
 *
 * resolveCdpTarget() falls back to the BROWSER endpoint when /json/list has no page yet, and the
 * browser target has no Runtime domain - so attaching too early fails with
 * "'Runtime.evaluate' wasn't found" on some launches and works on others.
 */
async function waitForPageTarget(wsUrl, timeoutMs = 30_000) {
  const u = new URL(wsUrl);
  const listUrl = `http://${u.hostname}:${u.port}/json/list`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(listUrl, { signal: AbortSignal.timeout(4_000) }).then((r) =>
        r.json(),
      );
      if (targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) return;
    } catch {
      /* endpoint not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('engine never exposed a page target');
}

async function gather(
  label,
  { launchPolicy = 'default_public_interface_only', nativePolicy } = {},
) {
  const udd = await mkdtemp(join(tmpdir(), 'lobium-rtc-gate-'));
  const launch = buildLaunchOptions({
    profileId: `webrtc-gate-${label}`,
    engine: 'lobium',
    userDataDir: udd,
    fingerprint: gateFingerprint,
    fingerprintSeed: GATE_SEED,
    webrtcPolicy: launchPolicy,
    headless: true,
  });
  const nativeArgs = [];
  if (nativePolicy) {
    // Keep this axis intentionally independent from the browser flag. proxy_only requires a proxy
    // summary in the production config builder, but the process is left unproxied so a stale native
    // hook cannot be masked by launch defense-in-depth.
    const proxy =
      nativePolicy === 'proxy_only' ? { type: 'http', host: '127.0.0.1', port: 9 } : undefined;
    const config = buildLobiumConfig(gateFingerprint, {
      seed: GATE_SEED,
      webrtcPolicy: nativePolicy,
      ...(proxy ? { proxy } : {}),
    });
    nativeArgs.push(lobiumConfigArg(await writeLobiumConfig(udd, config)));
  }
  const child = spawn(
    bin,
    [
      `--user-data-dir=${launch.userDataDir}`,
      '--remote-debugging-port=0',
      '--no-sandbox',
      ...(launch.headless ? ['--headless=new'] : []),
      ...launch.args,
      ...nativeArgs,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    const ws = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('no devtools endpoint')), 45_000);
      child.stderr.on('data', (b) => {
        const m = /(ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/.exec(b.toString());
        if (m) {
          clearTimeout(t);
          res(m[1]);
        }
      });
      child.on('exit', (c) => {
        clearTimeout(t);
        rej(new Error(`engine exited (${c})`));
      });
    });
    await waitForPageTarget(ws);
    const raw = await withCdpSession(ws, (s) =>
      cdpEvaluate(s, GATHER, { awaitPromise: true, timeoutMs: 40_000 }),
    );
    return JSON.parse(raw);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 1000));
    await rm(udd, { recursive: true, force: true }).catch(() => {});
  }
}

let control, browserPolicy, disabled, proxyOnly, nativeDisableUdp;
try {
  // The control proves the probe can SEE a leak on this host. Without it, a network that simply
  // cannot reach STUN would make every guarded run look like a pass.
  control = await gather('control');
  browserPolicy = await gather('browser', { launchPolicy: 'disable_non_proxied_udp' });
  disabled = await gather('disabled', { nativePolicy: 'disabled' });
  proxyOnly = await gather('proxy_only', { nativePolicy: 'proxy_only' });
  nativeDisableUdp = await gather('disable_udp', {
    nativePolicy: 'disable_non_proxied_udp',
  });
} catch (err) {
  await failingTurn.close();
  console.error(`BLOCKED: ${err.message}`);
  process.exit(2);
}
await failingTurn.close();

const show = (name, r) =>
  console.log(
    `  ${name.padEnd(24)} constructs=${r.constructs} reconfigured=${r.reconfigured} ` +
      `event=${r.eventTotal ?? '-'} ${JSON.stringify(r.eventTypes ?? {})} ` +
      `sdp=${r.sdpTotal ?? '-'} ${JSON.stringify(r.sdpTypes ?? {})} ` +
      `errors=${r.candidateErrors?.length ?? '-'} ` +
      `echo=${r.echoedPolicy ?? '-'}/${r.echoedServers?.length ?? '-'} ` +
      `rejectedSet=${r.rejectedSetName ?? r.rejectedSet}`,
  );
show('control (no policy)', control);
show('--webrtc-ip-handling', browserPolicy);
show('native disabled', disabled);
show('native proxy_only', proxyOnly);
show('native disable_udp', nativeDisableUdp);

const stunOracleReady = (control.eventTypes?.srflx ?? 0) > 0 && (control.sdpTypes?.srflx ?? 0) > 0;
const turnOracleReady = (control.eventTypes?.relay ?? 0) > 0 && (control.sdpTypes?.relay ?? 0) > 0;
const syntheticError = (result) =>
  (result.candidateErrors ?? []).find((event) => event.url === failingTurn.url);
if (!stunOracleReady) {
  console.error(
    'BLOCKED: the control did not expose a STUN/srflx candidate through both the event and SDP, ' +
      'so this host cannot demonstrate the public-IP leak',
  );
  process.exit(2);
}
const rawSyntheticError = syntheticError(control);
if (
  !rawSyntheticError ||
  !rawSyntheticError.address ||
  !Number.isInteger(rawSyntheticError.port) ||
  rawSyntheticError.port <= 0 ||
  !rawSyntheticError.hostCandidate
) {
  console.error(
    'BLOCKED: the local TURN responder did not produce a control icecandidateerror with a raw ' +
      'address, port, and hostCandidate, so endpoint redaction cannot be demonstrated',
  );
  process.exit(2);
}

const failures = [];
const serverJson = (servers) => JSON.stringify(servers ?? []);
const typeTotal = (types) => Object.values(types ?? {}).reduce((sum, count) => sum + count, 0);
const checkCandidateChannel = (name, channel, total, types, mode) => {
  if (typeTotal(types) !== total) {
    failures.push(
      `${name}: ${channel} exposed ${total} candidate(s), but ${typeTotal(types)} had a parseable type`,
    );
  }
  const forbidden =
    mode === 'none'
      ? Object.entries(types ?? {})
      : Object.entries(types ?? {}).filter(([type]) => type !== 'relay');
  for (const [type, count] of forbidden) {
    failures.push(`${name}: ${channel} exposed ${count} forbidden ${type} candidate(s)`);
  }
};
const check = (name, r, candidateMode) => {
  if (!r.constructs) {
    // Real Chrome never throws from this constructor in an attached document, so throwing at all is
    // a browser difference - whatever the message says.
    failures.push(`${name}: RTCPeerConnection threw ${r.errName}: ${r.errMessage}`);
    return;
  }
  if (!r.reconfigured) {
    failures.push(
      `${name}: STUN+TURN/all setConfiguration failed ${r.reconfigureErrName}: ${r.reconfigureErrMessage}`,
    );
    return;
  }
  if (r.initialPolicy !== 'relay' || (r.initialServers?.length ?? -1) !== 0) {
    failures.push(`${name}: constructor baseline was not relay with an empty ICE-server list`);
  }
  if (r.echoedPolicy !== 'all') {
    failures.push(
      `${name}: getConfiguration() reports iceTransportPolicy "${r.echoedPolicy}" after the page successfully requested "all"`,
    );
  }
  if (serverJson(r.echoedServers) !== serverJson(r.requestedServers)) {
    failures.push(
      `${name}: getConfiguration() did not echo the page's latest STUN+TURN server list`,
    );
  }
  if (!r.rejectedSet || r.rejectedSetName !== 'InvalidModificationError') {
    failures.push(
      `${name}: immutable bundlePolicy reconfiguration was not rejected with InvalidModificationError`,
    );
  }
  if (
    r.afterRejectedPolicy !== r.echoedPolicy ||
    serverJson(r.afterRejectedServers) !== serverJson(r.echoedServers)
  ) {
    failures.push(`${name}: rejected setConfiguration corrupted getConfiguration() echo state`);
  }
  checkCandidateChannel(name, 'icecandidate event', r.eventTotal ?? 0, r.eventTypes, candidateMode);
  checkCandidateChannel(name, 'localDescription.sdp', r.sdpTotal ?? 0, r.sdpTypes, candidateMode);
};
const checkCandidateErrorPrivacy = (name, result) => {
  const event = syntheticError(result);
  if (!event) {
    failures.push(`${name}: synthetic TURN failure did not reach icecandidateerror`);
    return;
  }
  if (event.address !== null || event.port !== null || event.hostCandidate !== '') {
    failures.push(
      `${name}: icecandidateerror exposed endpoint ${JSON.stringify({
        address: event.address,
        port: event.port,
        hostCandidate: event.hostCandidate,
      })}`,
    );
  }
  for (const field of ['url', 'errorCode', 'errorText']) {
    if (event[field] !== rawSyntheticError[field]) {
      failures.push(`${name}: redaction changed legitimate icecandidateerror.${field}`);
    }
  }
};
check('--webrtc-ip-handling', browserPolicy, 'relay_only');
check('native disabled', disabled, 'none');
check('native proxy_only', proxyOnly, 'relay_only');
checkCandidateErrorPrivacy('native proxy_only', proxyOnly);
checkCandidateErrorPrivacy('native disable_non_proxied_udp', nativeDisableUdp);
if ((disabled.candidateErrors?.length ?? 0) !== 0) {
  failures.push(
    `native disabled: exposed ${disabled.candidateErrors.length} icecandidateerror event(s)`,
  );
}

if (failures.length) {
  console.error('WEBRTC LEAK GATE: FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
if (!turnOracleReady) {
  console.error(
    'BLOCKED: STUN policy checks passed, but the control did not expose a TURN/relay candidate ' +
      'through both the event and SDP, so disabled server stripping is not proven',
  );
  process.exit(2);
}
console.log(
  'WEBRTC LEAK GATE: PASS - reconfiguration stays policy-constrained in events and SDP, ' +
    'candidate errors hide local endpoints without losing relay failure details, successful values ' +
    'echo exactly, and rejected updates preserve prior echo state',
);
