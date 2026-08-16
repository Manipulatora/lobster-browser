import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createReportTemplate,
  evaluateReport,
  loadMatrix,
  validateMatrix,
} from './detector-matrix.mjs';

const matrix = await loadMatrix();

test('detector matrix is valid and contains 10+ independent required providers', () => {
  assert.deepEqual(validateMatrix(matrix), []);
  const providers = new Set(
    matrix.tools.filter((tool) => tool.tier === 'required').map((tool) => tool.providerId),
  );
  assert.ok(matrix.tools.length > 10);
  assert.ok(providers.size >= 10);
});

test('matrix rejects an unofficial CreepJS deployment', () => {
  const copy = structuredClone(matrix);
  copy.tools.find((tool) => tool.id === 'creepjs').routes = ['https://creepjs.org/'];
  assert.match(validateMatrix(copy).join('\n'), /official abrahamjuliot\.github\.io/);
});

test('new report templates are explicitly incomplete', () => {
  const report = createReportTemplate(matrix, new Date('2026-07-11T12:00:00.000Z'));
  assert.ok(report.results.length > matrix.tools.length);
  assert.ok(report.results.every((result) => result.verdict === 'not_run'));
  const evaluation = evaluateReport(matrix, report, Date.parse('2026-07-11T12:00:00.000Z'));
  assert.equal(evaluation.releaseReady, false);
  assert.ok(evaluation.counts.notRun > 0);
});

test('complete fresh evidence passes only with all environment preconditions and required pairs', () => {
  const now = new Date('2026-07-11T12:00:00.000Z');
  const report = createReportTemplate(matrix, now);
  report.capturedAt = now.toISOString();
  report.environment = {
    ...report.environment,
    productBuild: 'lobium-test-build',
    lobiumBinarySha256: 'a'.repeat(64),
    profileId: 'profile-a',
    profileSeed: 'seed-a',
    secondProfileId: 'profile-b',
    secondProfileSeed: 'seed-b',
    headful: true,
    gpuMode: 'gpu',
    softwareRenderer: false,
    observedRenderer: 'ANGLE (NVIDIA, GeForce RTX 3060, Vulkan)',
    gpuBaselineReportSha256: 'e'.repeat(64),
    expectedProxyIp: '203.0.113.8',
    observedProxyIp: '203.0.113.8',
    expectedDirectIp: '198.51.100.20',
    observedDirectIp: '198.51.100.20',
    expectedTimezone: 'Europe/Berlin',
    observedTimezone: 'Europe/Berlin',
    stockBrowserBuild: 'Chromium 152.0.7977.42',
    stockBrowserBinarySha256: 'c'.repeat(64),
    connectionModesTested: ['uncontrolled', 'controlled'],
  };
  for (const result of report.results) {
    result.verdict = 'pass';
    result.observed = { reviewed: true };
    result.artifacts = ['sha256:artifact'];
    result.reviewer = 'senior-browser-engineer';
    result.reviewedAt = now.toISOString();
  }
  const evaluation = evaluateReport(matrix, report, now.getTime());
  assert.equal(evaluation.releaseReady, true);
  assert.equal(evaluation.counts.failed, 0);
  assert.ok(evaluation.counts.passingIndependentProviders >= 10);
});

test('an inconclusive public page cannot be promoted to release-ready evidence', () => {
  const now = new Date('2026-07-11T12:00:00.000Z');
  const report = createReportTemplate(matrix, now);
  report.capturedAt = now.toISOString();
  report.environment = {
    ...report.environment,
    productBuild: 'lobium-test-build',
    lobiumBinarySha256: 'b'.repeat(64),
    profileId: 'profile-a',
    profileSeed: 'seed-a',
    secondProfileId: 'profile-b',
    secondProfileSeed: 'seed-b',
    headful: true,
    gpuMode: 'gpu',
    softwareRenderer: false,
    observedRenderer: 'ANGLE (AMD, Radeon RX 6600, Vulkan)',
    gpuBaselineReportSha256: 'f'.repeat(64),
    expectedProxyIp: '203.0.113.9',
    observedProxyIp: '203.0.113.9',
    expectedDirectIp: '198.51.100.21',
    observedDirectIp: '198.51.100.21',
    expectedTimezone: 'America/New_York',
    observedTimezone: 'America/New_York',
    stockBrowserBuild: 'Chromium 152.0.7977.42',
    stockBrowserBinarySha256: 'd'.repeat(64),
    connectionModesTested: ['uncontrolled', 'controlled'],
  };
  for (const result of report.results) {
    result.verdict = 'pass';
    result.observed = { reviewed: true };
    result.artifacts = ['sha256:artifact'];
    result.reviewer = 'senior-browser-engineer';
    result.reviewedAt = now.toISOString();
  }
  report.results[0].verdict = 'inconclusive';
  const evaluation = evaluateReport(matrix, report, now.getTime());
  assert.equal(evaluation.releaseReady, false);
  assert.equal(evaluation.counts.inconclusive, 1);
});

test('a typed pass without reviewer and artifacts is still rejected', () => {
  const now = new Date('2026-07-11T12:00:00.000Z');
  const report = createReportTemplate(matrix, now);
  report.capturedAt = now.toISOString();
  report.results[0].verdict = 'pass';
  const evaluation = evaluateReport(matrix, report, now.getTime());
  assert.equal(evaluation.checks.find((check) => check.id === 'results.reviewed').pass, false);
  assert.equal(
    evaluation.checks.find((check) => check.id === 'results.evidence-attached').pass,
    false,
  );
});
