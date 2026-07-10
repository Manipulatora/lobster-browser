#!/usr/bin/env node
/**
 * Real-GPU stealth gate (QA-1 blocking).
 *
 * The raw detector scripts are permissive by design so they can be run for exploration on any host:
 *   - creepjs-battle.mjs exits 0 whenever no situation *errored*, EVEN ON A SOFTWARE GPU. A 120/120
 *     "zero lies" run on SwiftShader is a FALSE PASS — the exact trap PROJECT-STATUS warns about.
 *   - lobium-detect.mjs already fails a `gpu` run whose renderer is software, but nothing chains the
 *     two into a single blocking verdict.
 *
 * This gate is the strict referee. It reads the reports the detector scripts just wrote and FAILS
 * unless the evidence is real-hardware AND clean:
 *
 *   creepjs-battle-latest.json must satisfy ALL of:
 *     - gpuMode === 'gpu'
 *     - host.renderer is present and is NOT a software renderer (SwiftShader/llvmpipe/…)
 *     - counts.situations >= LOBSTER_GATE_MIN_SITUATIONS (default 100 — a 1-situation run can't sneak by)
 *     - counts.fail === 0 && counts.error === 0 && counts.unavailable === 0
 *     - counts.pass === counts.situations   (every scored situation passed)
 *     - counts.zeroLies === counts.situations
 *     - counts.meanLies === 0
 *
 *   the newest lobium-detect-*.json (if present) must satisfy:
 *     - verdict === 'pass'
 *     - gpuMode === 'gpu'
 *     - softwareRenderer === false
 *
 * Exit 0 only if every check passes. Any violation → exit 1 with a per-check breakdown, so a CI job
 * that runs this after the detector scripts becomes a real blocking zero-lies gate.
 *
 * Usage:
 *   node ci/validation/gate.mjs                 # evaluate the newest reports in ci/validation/reports
 *   LOBSTER_GATE_MIN_SITUATIONS=120 node ci/validation/gate.mjs
 *   LOBSTER_GATE_REQUIRE_DETECT=1 node ci/validation/gate.mjs   # also require a lobium-detect report
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isSoftwareRenderer } from '@lobster/engine-runner';

const here = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(here, 'reports');
const MIN_SITUATIONS = Number(process.env.LOBSTER_GATE_MIN_SITUATIONS || '100');
const REQUIRE_DETECT = process.env.LOBSTER_GATE_REQUIRE_DETECT === '1';

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// Newest `lobium-detect-*.json` in the reports dir, or null if none exists.
async function newestDetectReport() {
  if (!existsSync(REPORTS_DIR)) return null;
  const files = (await readdir(REPORTS_DIR))
    .filter((f) => f.startsWith('lobium-detect-') && f.endsWith('.json'))
    .sort();
  if (files.length === 0) return null;
  const path = join(REPORTS_DIR, files[files.length - 1]);
  return { path, report: await readJson(path) };
}

function evaluateBattle(report) {
  const c = report.counts || {};
  const renderer = report.host?.renderer ?? null;

  check('battle: gpuMode === "gpu"', report.gpuMode === 'gpu', `gpuMode=${report.gpuMode}`);
  check(
    'battle: host renderer is real hardware (not software)',
    typeof renderer === 'string' && renderer.length > 0 && !isSoftwareRenderer(renderer),
    `renderer=${renderer ?? '(absent)'}`,
  );
  check(
    `battle: situations >= ${MIN_SITUATIONS}`,
    typeof c.situations === 'number' && c.situations >= MIN_SITUATIONS,
    `situations=${c.situations}`,
  );
  check('battle: no failures', c.fail === 0, `fail=${c.fail}`);
  check('battle: no errors', c.error === 0, `error=${c.error}`);
  check('battle: none unavailable', c.unavailable === 0, `unavailable=${c.unavailable}`);
  check(
    'battle: every situation passed',
    typeof c.situations === 'number' && c.pass === c.situations,
    `pass=${c.pass}/${c.situations}`,
  );
  check(
    'battle: every scored situation had zero lies',
    typeof c.situations === 'number' && c.zeroLies === c.situations,
    `zeroLies=${c.zeroLies}/${c.situations}`,
  );
  check('battle: meanLies === 0', c.meanLies === 0, `meanLies=${c.meanLies}`);
}

function evaluateDetect(report) {
  check('detect: verdict === "pass"', report.verdict === 'pass', `verdict=${report.verdict}`);
  check('detect: gpuMode === "gpu"', report.gpuMode === 'gpu', `gpuMode=${report.gpuMode}`);
  check(
    'detect: not a software renderer',
    report.softwareRenderer === false,
    `softwareRenderer=${report.softwareRenderer}`,
  );
}

async function main() {
  const battlePath = join(REPORTS_DIR, 'creepjs-battle-latest.json');
  if (!existsSync(battlePath)) {
    console.error(
      `GATE FAIL: no creepjs-battle-latest.json in ${REPORTS_DIR}. Run creepjs-battle.mjs (gpuMode=gpu) first.`,
    );
    process.exit(1);
  }
  evaluateBattle(await readJson(battlePath));

  const detect = await newestDetectReport();
  if (detect) {
    evaluateDetect(detect.report);
  } else if (REQUIRE_DETECT) {
    check('detect: report present', false, 'no lobium-detect-*.json found (LOBSTER_GATE_REQUIRE_DETECT=1)');
  } else {
    console.warn('note: no lobium-detect-*.json found — evaluating creepjs-battle only.');
  }

  const failed = checks.filter((c) => !c.ok);
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    process.stdout.write(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(width)}  ${c.detail ?? ''}\n`);
  }
  process.stdout.write('\n');

  if (failed.length > 0) {
    console.error(
      `GATE FAIL: ${failed.length}/${checks.length} checks failed. This is NOT real-GPU zero-lies evidence.`,
    );
    process.exit(1);
  }
  console.log(`GATE PASS: ${checks.length}/${checks.length} checks passed — real-GPU zero-lies proof.`);
}

main().catch((e) => {
  console.error(`GATE ERROR: ${e?.stack || e}`);
  process.exit(2);
});
