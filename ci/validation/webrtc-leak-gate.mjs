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
 * This gate asserts the OUTCOME (no candidates escape) rather than the flag string, so it stays
 * honest if Chromium renames the switch again.
 *
 *   LOBSTER_LOBIUM_BIN=<chrome> node ci/validation/webrtc-leak-gate.mjs
 *
 * Exit codes: 0 pass, 1 leak, 2 blocked.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withCdpSession, cdpEvaluate } from '../../packages/engine-runner/dist/cdp-client.js';

const bin = process.env.LOBSTER_LOBIUM_BIN;
if (!bin) { console.error('BLOCKED: set LOBSTER_LOBIUM_BIN'); process.exit(2); }

const GATHER = `(async () => {
  // The page supplies its OWN stun+turn, because that is the case a relay-only policy alone does not
  // cover: a detector can hand the browser a TURN server and harvest the relay candidates.
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  ];
  const out = { constructs: false };
  try { const p = new RTCPeerConnection(); p.close(); out.constructs = true; }
  catch (e) { out.errName = e.name; out.errMessage = e.message; return JSON.stringify(out); }
  const pc = new RTCPeerConnection({ iceServers });
  pc.createDataChannel('probe');
  const cands = [];
  pc.onicecandidate = (e) => { if (e.candidate) cands.push(e.candidate.candidate); };
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, 6000));
  const sdp = pc.localDescription ? pc.localDescription.sdp : '';
  const cfg = pc.getConfiguration();
  pc.close();
  const types = {};
  for (const c of cands) { const m = /\\btyp (\\w+)/.exec(c); if (m) types[m[1]] = (types[m[1]] || 0) + 1; }
  out.total = cands.length;
  out.types = types;
  // Candidates reach script through the SDP as well as the event. A gate that watches only the
  // event passes a build that is still handing out the public IP - measured, not hypothetical.
  out.sdpCandidateLines = (sdp.match(/^a=candidate:/gm) || []).length;
  out.echoedPolicy = cfg.iceTransportPolicy;
  out.echoedServers = (cfg.iceServers || []).length;
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
      const targets = await fetch(listUrl, { signal: AbortSignal.timeout(4_000) }).then((r) => r.json());
      if (targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) return;
    } catch { /* endpoint not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('engine never exposed a page target');
}

async function gather(label, extraArgs) {
  const udd = await mkdtemp(join(tmpdir(), 'lobium-rtc-gate-'));
  const child = spawn(bin, [
    `--user-data-dir=${udd}`, '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', '--no-sandbox', '--headless=new', ...extraArgs, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const ws = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('no devtools endpoint')), 45_000);
      child.stderr.on('data', (b) => {
        const m = /(ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/.exec(b.toString());
        if (m) { clearTimeout(t); res(m[1]); }
      });
      child.on('exit', (c) => { clearTimeout(t); rej(new Error(`engine exited (${c})`)); });
    });
    await waitForPageTarget(ws);
    const raw = await withCdpSession(ws, (s) => cdpEvaluate(s, GATHER, { awaitPromise: true, timeoutMs: 40_000 }));
    return JSON.parse(raw);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 1000));
    await rm(udd, { recursive: true, force: true }).catch(() => {});
  }
}

// The native policies need a config file; only the fields the engine reads are required.
const cfgDir = await mkdtemp(join(tmpdir(), 'lobium-rtc-cfg-'));
async function policyConfig(policy) {
  const p = join(cfgDir, `fp-${policy}.json`);
  await writeFile(p, JSON.stringify({ version: 1, net: { webrtcPolicy: policy } }), 'utf8');
  return p;
}

let control, browserPolicy, disabled, proxyOnly;
try {
  // The control proves the probe can SEE a leak on this host. Without it, a network that simply
  // cannot reach STUN would make every guarded run look like a pass.
  control = await gather('control', []);
  browserPolicy = await gather('browser', ['--webrtc-ip-handling-policy=disable_non_proxied_udp']);
  disabled = await gather('disabled', [`--lobium-fp-config=${await policyConfig('disabled')}`]);
  proxyOnly = await gather('proxy_only', [`--lobium-fp-config=${await policyConfig('proxy_only')}`]);
} catch (err) {
  console.error(`BLOCKED: ${err.message}`);
  process.exit(2);
} finally {
  await rm(cfgDir, { recursive: true, force: true }).catch(() => {});
}

const show = (name, r) =>
  console.log(
    `  ${name.padEnd(24)} constructs=${r.constructs} candidates=${r.total ?? '-'} ` +
      `${JSON.stringify(r.types ?? {})} sdpLines=${r.sdpCandidateLines ?? '-'} ` +
      `echoedPolicy=${r.echoedPolicy ?? '-'} echoedServers=${r.echoedServers ?? '-'}`,
  );
show('control (no policy)', control);
show('--webrtc-ip-handling', browserPolicy);
show('native disabled', disabled);
show('native proxy_only', proxyOnly);

if (!control.total || !control.sdpCandidateLines) {
  console.error('BLOCKED: the control gathered nothing, so this host cannot demonstrate a leak');
  process.exit(2);
}

const failures = [];
const check = (name, r) => {
  if (!r.constructs) {
    // Real Chrome never throws from this constructor in an attached document, so throwing at all is
    // a browser difference - whatever the message says.
    failures.push(`${name}: RTCPeerConnection threw ${r.errName}: ${r.errMessage}`);
    return;
  }
  if ((r.types?.srflx ?? 0) > 0) failures.push(`${name}: ${r.types.srflx} srflx candidate(s) escaped - real public IP`);
  if ((r.sdpCandidateLines ?? 0) > 0) failures.push(`${name}: ${r.sdpCandidateLines} candidate line(s) in localDescription.sdp`);
  if (r.echoedPolicy !== control.echoedPolicy) {
    failures.push(`${name}: getConfiguration() reports iceTransportPolicy "${r.echoedPolicy}", contradicting the page's "${control.echoedPolicy}"`);
  }
  if (r.echoedServers !== control.echoedServers) {
    failures.push(`${name}: getConfiguration() reports ${r.echoedServers} iceServers, the page supplied ${control.echoedServers}`);
  }
};
check('--webrtc-ip-handling', browserPolicy);
check('native disabled', disabled);
check('native proxy_only', proxyOnly);
if (browserPolicy.total >= control.total) {
  failures.push('--webrtc-ip-handling changed nothing, so the switch is not reaching the engine');
}

if (failures.length) {
  console.error('WEBRTC LEAK GATE: FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('WEBRTC LEAK GATE: PASS - no candidate escapes by event or SDP, and every policy echoes the page back unchanged');
