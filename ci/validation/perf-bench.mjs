#!/usr/bin/env node
/**
 * Engine performance benchmark - local, deterministic, and comparative.
 *
 * WHY. Every other harness in ci/validation measures whether the engine LIES correctly. None of them
 * measured whether it is FAST. The reported symptoms - "generally slower than other browsers",
 * "cannot load some 3D models", "lag increases significantly" - had no number attached to them, so
 * there was no way to tell a real regression from an impression, or to prove a flag change helped.
 *
 * WHAT IT DOES. Serves a fixed workload from loopback and runs every benchmark in perf/benchmarks.mjs
 * under one or more ARMS. An arm is a named set of launch flags, so the same engine can be measured
 * against itself with and without a change - which is the only comparison that isolates a flag or a
 * build setting. Each benchmark is warmed up, then repeated, and the MEDIAN is reported: a mean over
 * a browser benchmark is dominated by whichever run happened to collide with GC.
 *
 * SOFTWARE RENDERING. On a host with no GPU, benchmarks marked `gpu: true` measure a software
 * rasterizer, not the engine's graphics performance. They are still run - a software-raster regression
 * is real, and WebGL failing to initialize at all is exactly the defect this repo just fixed - but
 * every such row is flagged in the report so no one mistakes them for hardware numbers.
 *
 *   LOBSTER_LOBIUM_BIN=<chrome> node ci/validation/perf-bench.mjs
 *   LOBSTER_LOBIUM_BIN=<chrome> node ci/validation/perf-bench.mjs --arms=baseline,threads
 *   ... --repeats=5 --only=js,dom
 *
 * Exit codes: 0 ran, 2 blocked (no binary / nothing measurable).
 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { BENCHMARKS, GROUPS } from './perf/benchmarks.mjs';
import { withCdpSession, cdpEvaluate } from '../../packages/engine-runner/dist/cdp-client.js';
import { buildGpuArgs } from '@lobster/engine-runner';

const HERE = dirname(fileURLToPath(import.meta.url));
const bin = process.env.LOBSTER_LOBIUM_BIN;
if (!bin) { console.error('BLOCKED: set LOBSTER_LOBIUM_BIN'); process.exit(2); }

const argv = process.argv.slice(2);
const argOf = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const REPEATS = Number(argOf('repeats', '3'));
const ONLY = argOf('only', '').split(',').filter(Boolean);
const HEADFUL = argv.includes('--headful');

/**
 * The arms. `baseline` is deliberately EXACTLY what the product launches with, so a comparison always
 * has the shipping configuration as its reference point rather than some tuned variant.
 */
const FP_CONFIG = process.env.LOBSTER_BENCH_FP_CONFIG;
const ALL_ARMS = {
  baseline: [],
  'raster-threads': ['--num-raster-threads=4'],
  'gpu-raster': ['--enable-gpu-rasterization'],
  // What the anti-detect hooks COST. Every other arm runs the engine with no persona, so the
  // fingerprint patches - canvas/webgl/audio farbling, clientRects farbling, the navigator and
  // screen overrides - never execute. clientRects farbling in particular sits directly in the
  // getBoundingClientRect / offsetWidth path that dom-style-thrash and dom-getboundingrect hammer,
  // so if the moat has a performance price this arm is where it shows up.
  'fp-config': FP_CONFIG ? [`--lobium-fp-config=${FP_CONFIG}`] : null,
  'no-fallback': null, // sentinel: drop buildGpuArgs entirely (reproduces the pre-fix, no-WebGL state)
};
const armNames = argOf('arms', 'baseline').split(',').filter(Boolean);
for (const a of armNames) if (!(a in ALL_ARMS)) { console.error(`unknown arm: ${a}`); process.exit(2); }
if (armNames.includes('fp-config') && !FP_CONFIG) {
  console.error('BLOCKED: arm "fp-config" needs LOBSTER_BENCH_FP_CONFIG=<path to a lobium-fp.json>');
  process.exit(2);
}

const selected = BENCHMARKS.filter((b) => !ONLY.length || ONLY.includes(b.group) || ONLY.includes(b.id));
if (!selected.length) { console.error('BLOCKED: no benchmarks selected'); process.exit(2); }

// ---------------------------------------------------------------- the page
const PAGE = `<!doctype html><meta charset="utf-8"><title>bench</title>
<body><div id="sandbox"></div><script>
window.__run = async (id, body, isAsync) => {
  const fn = isAsync ? new Function('return (async () => {' + body + '})()')
                     : new Function(body);
  const t0 = performance.now();
  const out = await fn();
  const t1 = performance.now();
  return { ms: t1 - t0, out: typeof out === 'number' ? out : String(out).slice(0, 40) };
};
</script></body>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

// ---------------------------------------------------------------- engine
async function launch(extraArgs) {
  const udd = await mkdtemp(join(tmpdir(), 'lobium-perf-'));
  const args = [
    `--user-data-dir=${udd}`, '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
    '--no-sandbox', '--disable-dev-shm-usage',
    ...(HEADFUL ? [] : ['--headless=new']),
    ...extraArgs, pageUrl,
  ];
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const ws = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('engine did not expose a devtools endpoint')), 60_000);
    child.stderr.on('data', (b) => {
      const m = /(ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/.exec(b.toString());
      if (m) { clearTimeout(t); res(m[1]); }
    });
    child.on('exit', (c) => { clearTimeout(t); rej(new Error(`engine exited early (${c})`)); });
  });
  return {
    ws,
    close: async () => {
      // Wait for the process to actually exit before removing its directory: Chromium keeps writing
      // to the profile as it shuts down, so an immediate rm races it and throws ENOTEMPTY.
      const exited = new Promise((res) => child.once('exit', res));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 8_000))]);
      await rm(udd, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Wait until the engine actually has a PAGE target.
 *
 * resolveCdpTarget() falls back to the BROWSER endpoint when /json/list has no page yet, and the
 * browser target has neither Runtime nor Page - so connecting too early fails with
 * "'Runtime.evaluate' wasn't found" on some launches and succeeds on others. That race is why this
 * harness reported a different scatter of ERROR rows on every run.
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

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

const results = {};
for (const arm of armNames) {
  const flags = ALL_ARMS[arm];
  const extra = flags === null ? [] : [...buildGpuArgs(), ...flags];
  process.stdout.write(`\n=== arm ${arm} · flags: ${extra.join(' ') || '(none)'} ===\n`);
  const rows = [];
  // A FRESH ENGINE PER BENCHMARK. Slower, but it is the only way to get numbers that mean anything:
  // it removes cross-benchmark state (one benchmark's DOM or heap feeding the next), removes GC
  // carry-over, and - the reason it became necessary - stops a single benchmark that wedges or kills
  // its renderer from silently truncating every benchmark after it.
  for (const b of selected) {
    const samples = [];
    let note = '', out = null;
    let engine = null;
    try {
      engine = await launch(extra);
      await waitForPageTarget(engine.ws);
      await withCdpSession(engine.ws, async (session) => {
        // No Page.navigate: the URL is already the engine's startup argument, and issuing a navigate
        // against a page target that has not finished attaching intermittently fails with
        // "'Page.navigate' wasn't found". Just wait for the harness function to exist.
        for (let i = 0; i < 150; i++) {
          const ready = await cdpEvaluate(session, `document.readyState + '|' + (typeof window.__run)`, { timeoutMs: 10_000 });
          if (String(ready) === 'complete|function') break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const call = `window.__run(${JSON.stringify(b.id)}, ${JSON.stringify(b.body)}, ${!!b.async})`;
        // One warm-up so JIT tiering and first-touch allocation are not charged to the measurement.
        await cdpEvaluate(session, call, { awaitPromise: true, timeoutMs: 60_000 });
        for (let r = 0; r < REPEATS; r++) {
          const raw = await cdpEvaluate(session, `${call}.then(JSON.stringify)`, { awaitPromise: true, timeoutMs: 60_000 });
          const v = JSON.parse(raw); samples.push(v.ms); out = v.out;
        }
      }, { timeoutMs: 600_000 });
    } catch (err) {
      note = String(err.message || err).slice(0, 90);
    } finally {
      await engine?.close().catch(() => {});
    }
    const ms = samples.length ? median(samples) : null;
    rows.push({ id: b.id, group: b.group, gpu: !!b.gpu, ms, note, out });
    const flag = b.gpu ? ' [sw-render]' : '';
    console.log(
      `  ${b.id.padEnd(24)} ${ms === null ? 'ERROR '.padStart(10) : ms.toFixed(1).padStart(9) + 'ms'}${flag}` +
      `${note ? '  <- ' + note : ''}`);
  }
  results[arm] = rows;
}
server.close();

// ---------------------------------------------------------------- report
const reportDir = join(HERE, 'reports');
await mkdir(reportDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = join(reportDir, `perf-bench-${stamp}.json`);
await writeFile(reportPath, JSON.stringify({
  binary: bin, headful: HEADFUL, repeats: REPEATS, arms: armNames, groups: GROUPS, results,
}, null, 2));

if (armNames.length > 1) {
  const [base, ...rest] = armNames;
  process.stdout.write(`\n=== comparison vs ${base} (negative = faster) ===\n`);
  for (const arm of rest) {
    process.stdout.write(`\n  -- ${arm} --\n`);
    for (const row of results[arm]) {
      const b = results[base].find((r) => r.id === row.id);
      if (!b || b.ms === null || row.ms === null) continue;
      const pct = ((row.ms - b.ms) / b.ms) * 100;
      if (Math.abs(pct) < 3) continue; // below noise
      process.stdout.write(`  ${row.id.padEnd(24)} ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%` +
        `  (${b.ms.toFixed(1)} → ${row.ms.toFixed(1)}ms)${row.gpu ? ' [sw-render]' : ''}\n`);
    }
  }
}
const errors = results[armNames[0]].filter((r) => r.ms === null);
process.stdout.write(`\nreport: ${reportPath}\n`);
process.stdout.write(`${selected.length - errors.length}/${selected.length} benchmarks measured` +
  `${errors.length ? `, ${errors.length} errored: ${errors.map((e) => e.id).join(', ')}` : ''}\n`);
