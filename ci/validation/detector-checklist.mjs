#!/usr/bin/env node
/**
 * The manual half of the detector matrix, as a dated ledger instead of a claim.
 *
 * Three of the nineteen tools in detector-matrix.json have parsers, so detector-matrix.mjs can score
 * them without a human reading the page. The other sixteen — browserleaks, pixelscan, iphey, amiunique,
 * browserscan among them — publish their verdict as a page a human reads. Writing scrapers for those
 * would make the gate depend on sixteen third-party DOMs, and the failure mode of a stale scraper is
 * the dangerous direction: it reports green because it stopped finding the row that says red.
 *
 * So they are not automated here. They are LEDGERED: this prints, per tool, when it was last verified,
 * on which engine build, in which scenario, and which artifact backs the verdict — and prints NEVER
 * VERIFIED for every tool that has none.
 *
 *   node ci/validation/detector-checklist.mjs           write reports/detector-checklist.md
 *   node ci/validation/detector-checklist.mjs --check    validate the ledger's shape (offline, CI)
 *
 * `--check` deliberately does NOT fail on missing evidence: an empty ledger is an accurate statement
 * about what has been verified, and reddening every PR for it would only teach people to delete rows.
 * It fails on a MALFORMED ledger — an entry naming a tool or scenario that does not exist, a verdict
 * outside the matrix's own list, a claim with no artifact behind it — because those are the entries
 * that would let unbacked evidence into a release review.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MATRIX_PATH = join(HERE, 'detector-matrix.json');
const LEDGER_PATH = join(HERE, 'detector-manual-log.json');
const OUT_PATH = join(HERE, 'reports', 'detector-checklist.md');

const matrix = JSON.parse(await readFile(MATRIX_PATH, 'utf8'));
const ledger = JSON.parse(await readFile(LEDGER_PATH, 'utf8'));

const tools = new Map(matrix.tools.map((t) => [t.id, t]));
const scenarios = new Set(matrix.scenarios.map((s) => s.id));
const verdicts = new Set(matrix.verdicts);
const entries = ledger.entries ?? [];
const maxAgeDays = ledger.maxAgeDays ?? 30;

// ── Shape ────────────────────────────────────────────────────────────────────────────────────────
const problems = [];
entries.forEach((entry, i) => {
  const at = `entries[${i}]`;
  if (!tools.has(entry.tool)) problems.push(`${at} names tool "${entry.tool}", which is not in detector-matrix.json`);
  if (!scenarios.has(entry.scenario)) problems.push(`${at} names scenario "${entry.scenario}", which is not in detector-matrix.json`);
  if (!verdicts.has(entry.verdict)) problems.push(`${at} has verdict "${entry.verdict}", which is not one of ${[...verdicts].join('/')}`);
  if (!Number.isFinite(Date.parse(entry.verifiedAt ?? ''))) problems.push(`${at} has no parseable verifiedAt`);
  if (!entry.engineBuild) problems.push(`${at} does not say which engine build was measured`);
  // An unbacked verdict is worse than no verdict: it reads as evidence in a release review and cannot
  // be re-examined when a detector changes its scoring.
  if (!entry.artifact) problems.push(`${at} claims ${entry.verdict} for ${entry.tool} with no artifact to back it`);
  if (entry.verdict !== 'pass' && !entry.notes) problems.push(`${at} is ${entry.verdict} with no notes explaining what was seen`);
});

// ── The checklist ────────────────────────────────────────────────────────────────────────────────
const now = Date.now();
const newest = new Map();
for (const entry of entries) {
  const stamp = Date.parse(entry.verifiedAt ?? '');
  if (!Number.isFinite(stamp)) continue;
  const current = newest.get(entry.tool);
  if (!current || stamp > current.stamp) newest.set(entry.tool, { ...entry, stamp });
}

const rows = matrix.tools.map((tool) => {
  const gated = tool.parser !== 'manual';
  const last = newest.get(tool.id);
  const ageDays = last ? Math.floor((now - last.stamp) / 86_400_000) : undefined;
  const state = gated
    ? 'parser-scored'
    : !last
      ? 'never verified'
      : ageDays > maxAgeDays
        ? `stale (${ageDays}d)`
        : `${last.verdict} (${ageDays}d)`;
  return { tool, gated, last, ageDays, state };
});

const manual = rows.filter((r) => !r.gated);
const verified = manual.filter((r) => r.last && r.ageDays <= maxAgeDays);

const lines = [
  '# Detector checklist',
  '',
  `Generated ${new Date().toISOString()} from detector-matrix.json (v${matrix.matrixVersion}) and detector-manual-log.json.`,
  '',
  `Parser-scored (detector-matrix.mjs can grade these without a reviewer): ${rows.length - manual.length}. ` +
    `Manual, ledgered: ${manual.length}, of which ` +
    `${verified.length} carry a verification newer than ${maxAgeDays} days.`,
  '',
  '| Tool | Tier | Scored by | Last verified | Engine build | Artifact |',
  '| --- | --- | --- | --- | --- | --- |',
];
for (const { tool, gated, last, state } of rows) {
  lines.push(
    `| ${tool.name} | ${tool.tier} | ${gated ? `\`${tool.parser}\` parser` : 'human review'} | ` +
      `${last ? `${last.verifiedAt.slice(0, 10)} — ${state}` : state} | ${last?.engineBuild ?? '—'} | ` +
      `${last?.artifact ? `\`${last.artifact}\`` : '—'} |`,
  );
}
lines.push(
  '',
  '## What is missing',
  '',
  ...(manual.filter((r) => !r.last).length
    ? manual
        .filter((r) => !r.last)
        .map((r) => `- **${r.tool.name}** — never verified. Required scenarios: ${r.tool.requiredScenarios.join(', ')}.`)
    : ['- Nothing: every manual tool carries at least one verification.']),
  '',
  ...(manual.filter((r) => r.last && r.ageDays > maxAgeDays).length
    ? manual
        .filter((r) => r.last && r.ageDays > maxAgeDays)
        .map((r) => `- **${r.tool.name}** — last verified ${r.ageDays} days ago on build ${r.last.engineBuild}; older than the ${maxAgeDays}-day evidence window.`)
    : []),
);

if (process.argv.includes('--check')) {
  if (problems.length) {
    console.log('DETECTOR CHECKLIST: FAIL — the manual ledger is malformed:');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `DETECTOR CHECKLIST: OK — ledger well formed; ${rows.length - manual.length} tools parser-scored, ` +
      `${manual.length} ledgered (${verified.length} verified within ${maxAgeDays}d, ` +
      `${manual.filter((r) => !r.last).length} never verified).`,
  );
  process.exit(0);
}

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, `${lines.join('\n')}\n`, 'utf8');
console.log(lines.join('\n'));
console.log(`\nwritten: ${OUT_PATH}`);
if (problems.length) {
  console.log('\nledger problems:');
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
