#!/usr/bin/env node
// Anti-detect validation gate.
//
// Real implementation (T-005): host CreepJS + bot.sannysoft locally, launch a profile via the
// engine-runner, scrape trust score / lies / Sannysoft matrix / WebRTC leak, compare to
// thresholds.json, emit a JSON report and a pass/fail exit code.
//
// Day 0: `--stub` verifies the harness wiring (loads thresholds, prints a structured report) so the
// CI gate job exists and stays green until the real detectors are wired.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const stub = process.argv.includes('--stub');
  const thresholds = JSON.parse(await readFile(join(here, 'thresholds.json'), 'utf8'));

  if (stub) {
    const report = {
      mode: 'stub',
      thresholdsLoaded: true,
      thresholds,
      note: 'Detector scraping is implemented in T-005. This stub only verifies harness wiring.',
      verdict: 'pass',
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  process.stderr.write('[validation] real detector run not implemented yet — see ticket T-005.\n');
  process.exit(2);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
