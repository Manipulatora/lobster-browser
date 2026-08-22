#!/usr/bin/env node
/**
 * Cross-browser performance comparison on ONE machine.
 *
 * WHY. "The browser is generally slower than other browsers" is not actionable without a reference
 * measured on the same hardware, at the same time, on the same workload. A number from Lobium alone
 * cannot separate "this engine is slow" from "this VM is slow" - and on a GPU-less VM with software
 * rasterization, almost everything looks slow.
 *
 * HOW. The page drives ITSELF: it runs the whole battery and POSTs the results back. That needs no
 * automation protocol, so the same page measures Lobium (CDP), Firefox (no CDP), or anything else
 * that can open a URL. Both browsers are launched HEADFUL against the same X display, because
 * headless and headful differ in exactly the way that hid the missing-WebGL defect.
 *
 *   LOBSTER_LOBIUM_BIN=<chrome> node ci/validation/perf-crossbrowser.mjs
 *   ... --reference=/usr/bin/firefox
 *
 * Exit codes: 0 ran, 2 blocked.
 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { BENCHMARKS } from './perf/benchmarks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const REPEATS = Number(argOf('repeats', '3'));
const TIMEOUT_MS = Number(argOf('timeout', '900')) * 1000;

const subjectBin = process.env.LOBSTER_LOBIUM_BIN;
const referenceBin = argOf('reference', '/usr/bin/firefox');
if (!subjectBin) { console.error('BLOCKED: set LOBSTER_LOBIUM_BIN'); process.exit(2); }

// Benchmarks that mutate #sandbox or need a canvas are all self-contained by construction; the page
// simply runs them in order and reports the median of REPEATS after one warm-up.
const PAGE = `<!doctype html><meta charset="utf-8"><title>xbench</title>
<body><h1 id="st">running…</h1><div id="sandbox"></div><script>
const BENCH = ${JSON.stringify(BENCHMARKS.map((b) => ({ id: b.id, group: b.group, gpu: !!b.gpu, body: b.body, async: !!b.async })))};
const REPEATS = ${REPEATS};
const median = (xs) => { const s=[...xs].sort((a,b)=>a-b), h=s.length>>1;
  return s.length%2 ? s[h] : (s[h-1]+s[h])/2; };
(async () => {
  const rows = [];
  for (const b of BENCH) {
    const fn = b.async ? new Function('return (async () => {' + b.body + '})()')
                       : new Function(b.body);
    let ms = null, note = '';
    try {
      await fn();                                   // warm-up: JIT tiering, first-touch allocation
      const s = [];
      for (let r = 0; r < REPEATS; r++) {
        const t0 = performance.now(); await fn(); s.push(performance.now() - t0);
      }
      ms = median(s);
    } catch (e) { note = String(e && e.message || e).slice(0, 80); }
    rows.push({ id: b.id, group: b.group, gpu: b.gpu, ms, note });
    document.getElementById('st').textContent = b.id + ' … ' + rows.length + '/' + BENCH.length;
  }
  const ua = navigator.userAgent;
  let renderer = null;
  try { const c=document.createElement('canvas'); const gl=c.getContext('webgl');
    if (gl) { const d=gl.getExtension('WEBGL_debug_renderer_info');
      renderer = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } } catch {}
  await fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows, ua, renderer }) });
  document.getElementById('st').textContent = 'done';
})();
</script></body>`;

let resolveReport;
const reportPromise = () => new Promise((res) => { resolveReport = res; });
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/report') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(204); res.end();
      try { resolveReport(JSON.parse(body)); } catch { resolveReport(null); }
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

/**
 * Where the throwaway browser profile goes.
 *
 * NOT tmpdir() for the reference: /usr/bin/firefox on Ubuntu is a SNAP, and snap confinement cannot
 * read a profile directory under /tmp. Firefox then exits immediately and the run reports nothing,
 * which looks exactly like "the benchmark hung" - it does not. A directory under $HOME is inside the
 * snap's allowed paths.
 */
async function profileRoot(name) {
  const base = name === 'firefox' ? join(process.env.HOME ?? tmpdir(), '.cache', 'lobster-xbench') : tmpdir();
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, `xbench-${name}-`));
}

async function measure(name, bin, mkArgs) {
  const dir = await profileRoot(name);
  const waiter = reportPromise();
  const child = spawn(bin, mkArgs(dir), { stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => resolveReport(null), TIMEOUT_MS);
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString().slice(0, 200); });
  const report = await waiter;
  clearTimeout(timer);
  child.kill();
  await new Promise((r) => setTimeout(r, 1500));
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  if (!report) console.error(`  ${name}: NO REPORT (timeout). stderr head: ${stderr.slice(0, 160)}`);
  return report;
}

console.log(`subject   : ${subjectBin}`);
console.log(`reference : ${referenceBin}`);
console.log(`workload  : ${BENCHMARKS.length} benchmarks, median of ${REPEATS}, HEADFUL on ${process.env.DISPLAY || '(no DISPLAY)'}\n`);

const subject = await measure('lobium', subjectBin, (dir) => [
  `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-sync', '--no-sandbox', '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader', url,
]);
const reference = await measure('firefox', referenceBin, (dir) => [
  '--profile', dir, '--no-remote', '--new-instance',
  // Suppress the first-run/import UI, which otherwise sits in front of the page and never lets it run.
  '--setDefaultBrowser=false',
  url,
]);
server.close();

if (!subject) { console.error('BLOCKED: subject produced no results'); process.exit(2); }

const byId = (r) => Object.fromEntries((r?.rows ?? []).map((x) => [x.id, x]));
const S = byId(subject), R = byId(reference);
console.log(`subject   renderer: ${subject.renderer}`);
if (reference) console.log(`reference renderer: ${reference.renderer}`);
console.log('');
console.log(`  ${'benchmark'.padEnd(24)} ${'lobium'.padStart(10)} ${'firefox'.padStart(10)}   ratio`);
console.log(`  ${'-'.repeat(24)} ${'-'.repeat(10)} ${'-'.repeat(10)}   -----`);
const ratios = [];
for (const b of BENCHMARKS) {
  const s = S[b.id], r = R[b.id];
  const sv = s?.ms, rv = r?.ms;
  let ratio = '';
  if (sv != null && rv != null && rv > 0) {
    const k = sv / rv; ratios.push({ id: b.id, group: b.group, gpu: !!b.gpu, k });
    ratio = `${k.toFixed(2)}x${k > 1.5 ? '  SLOWER' : k < 0.67 ? '  faster' : ''}`;
  }
  console.log(`  ${b.id.padEnd(24)} ${(sv == null ? (s?.note ? 'ERR' : '-') : sv.toFixed(1)).padStart(10)} ` +
    `${(rv == null ? (r?.note ? 'ERR' : '-') : rv.toFixed(1)).padStart(10)}   ${ratio}${b.gpu ? ' [sw-render]' : ''}`);
}
const worst = ratios.filter((x) => x.k > 1.5).sort((a, b) => b.k - a.k);
if (worst.length) {
  console.log(`\n  slower than the reference by >1.5x (${worst.length}):`);
  for (const w of worst) console.log(`    ${w.id.padEnd(24)} ${w.k.toFixed(2)}x${w.gpu ? ' [sw-render]' : ''}`);
}
const reportDir = join(HERE, 'reports');
await mkdir(reportDir, { recursive: true });
const p = join(reportDir, `perf-crossbrowser-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(p, JSON.stringify({ subjectBin, referenceBin, repeats: REPEATS, subject, reference }, null, 2));
console.log(`\nreport: ${p}`);
