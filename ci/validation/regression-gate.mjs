#!/usr/bin/env node
// Item 5 — software-tier detection regression gate.
//
// One command that fails on any anti-detect regression the software environment CAN see. Two checks run
// inline (fast, no browser) plus the live TLS gate; the heavier pure-native surface probe (deep-probe-50)
// and the real-GPU zero-lies gate (gate.mjs) are the CI/HW tiers layered on top (see top-tier-roadmap.md).
//
//   node ci/validation/regression-gate.mjs
//
// Environmental limits that are NOT regressions on a software-GPU / no-proxy host are allow-listed and
// reported separately, never failing the gate: (a) deep-GPU extension coherence needs a real GPU;
// (b) egress-IP/proxy checks need a proxy.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveFingerprint, validateFingerprintCoherence, applyGeoToFingerprint } from '@lobster/fingerprint';

const HERE = dirname(fileURLToPath(import.meta.url));
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── Check 1: catalog diversity + coherence (guards Item 2; fast, no launch) ──────────────────────────
{
  const GEOS = [
    { countryCode: 'US', timezone: 'America/New_York', ip: '0.0.0.0', latitude: 40, longitude: -74 },
    { countryCode: 'DE', timezone: 'Europe/Berlin', ip: '0.0.0.0', latitude: 52, longitude: 13 },
    { countryCode: 'JP', timezone: 'Asia/Tokyo', ip: '0.0.0.0', latitude: 35, longitude: 139 },
  ];
  const MIN_CLASSES = { windows: 500, macos: 200, linux: 500 };
  let coherenceFailures = 0;
  const perOs = {};
  for (const os of ['windows', 'macos', 'linux']) {
    const arch = os === 'macos' ? 'arm64' : 'x86_64';
    const classes = new Set();
    for (let i = 0; i < 2000; i++) {
      const geo = GEOS[i % GEOS.length];
      const fp = applyGeoToFingerprint(deriveFingerprint(`gate-${os}-${i}`, { os, engine: 'lobium', arch }), geo);
      classes.add(`${fp.webgl.unmaskedRenderer}|${fp.screen.width}x${fp.screen.height}|${fp.navigator.hardwareConcurrency}`);
      if (validateFingerprintCoherence(fp).length) coherenceFailures++;
    }
    perOs[os] = classes.size;
  }
  const diversityOk = Object.entries(MIN_CLASSES).every(([os, min]) => perOs[os] >= min);
  record(
    'catalog-diversity',
    diversityOk,
    `distinct classes: win=${perOs.windows} mac=${perOs.macos} linux=${perOs.linux} (min ${JSON.stringify(MIN_CLASSES)})`,
  );
  record('fingerprint-coherence', coherenceFailures === 0, `${coherenceFailures} incoherent of 6000`);
}

// ── Check 2: fingerprint unit tests (guards derivation/coherence contracts) ───────────────────────────
{
  const fpDir = join(HERE, '../../packages/fingerprint');
  const r = spawnSync('node', ['--test', 'dist/derive.test.js', 'dist/coherence.test.js', 'dist/catalog.test.js'], {
    cwd: fpDir,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const passed = /# fail 0\b/.test(r.stdout) || / fail 0\b/.test(r.stdout);
  record('fingerprint-unit-tests', r.status === 0 && passed, r.status === 0 ? 'derive+coherence+catalog green' : `exit ${r.status}`);
}

// ── Check 3: live TLS/JA4 network fingerprint (guards Item 3; needs a launch) ─────────────────────────
if (process.env.SKIP_TLS !== '1') {
  const r = spawnSync('node', [join(HERE, 'tls-fingerprint.mjs')], { encoding: 'utf8', timeout: 150_000 });
  const detail = r.stdout.trim().split('\n').pop() || `exit ${r.status}`;
  // Exit 2 = no Lobium binary on this host. That is an environmental limit, not a regression (same
  // rule as the allow-list below), so it is reported and skipped rather than failing the gate.
  if (r.status === 2) console.log(`SKIP  tls-ja4-chrome-family — ${detail}`);
  else record('tls-ja4-chrome-family', r.status === 0, r.status === 0 ? 'JA4 t13d…h2 == Chrome' : detail);
} else {
  console.log('SKIP  tls-ja4-chrome-family (SKIP_TLS=1)');
}

// ── Allow-listed environmental limits (reported, never failing) ──────────────────────────────────────
console.log('\nEnvironmental (allow-listed — need real hardware, not regressions):');
console.log('  • deep-GPU extension coherence — needs a real GPU host (Item 1 capture pipeline).');
console.log('  • egress-IP / DNS / WebRTC-public — needs a proxy configured.');
console.log('  • Heavier tiers: deep-probe-50.mjs (50-profile pure-native surface probe), gate.mjs (real-GPU zero-lies).');

const failed = results.filter((r) => !r.pass);
console.log(`\nGATE: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length} checks passed)`);
process.exit(failed.length === 0 ? 0 : 1);
