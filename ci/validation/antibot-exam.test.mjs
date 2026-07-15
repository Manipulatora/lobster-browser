import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyWaf, isExamProvisional } from './antibot-exam.mjs';

test('generic HTTP 200 without a target assertion is inconclusive, never pass', () => {
  const result = classifyWaf(200, '<main>expected-looking content</main>', 'Example');
  assert.equal(result.verdict, 'inconclusive');
  assert.match(result.detail, /telemetry required/);
});

test('visible challenge markers and blocking statuses remain actionable', () => {
  assert.equal(
    classifyWaf(200, '<title>Just a moment</title>', 'Just a moment').verdict,
    'challenged',
  );
  assert.equal(classifyWaf(403, '<main>denied</main>', 'Denied').verdict, 'blocked');
});

test('only a headful explicit-gpu run can be non-provisional', () => {
  assert.equal(
    isExamProvisional({
      gpuMode: 'gpu',
      softwareRenderer: false,
      headless: false,
      rendererAvailable: true,
      gpuBaselineRecorded: true,
    }),
    false,
  );
  assert.equal(
    isExamProvisional({
      gpuMode: 'auto',
      softwareRenderer: false,
      headless: false,
      rendererAvailable: true,
      gpuBaselineRecorded: true,
    }),
    true,
    'a spoofed hardware renderer string must not make auto mode defensible',
  );
  assert.equal(
    isExamProvisional({
      gpuMode: 'gpu',
      softwareRenderer: false,
      headless: true,
      rendererAvailable: true,
      gpuBaselineRecorded: true,
    }),
    true,
  );
  assert.equal(
    isExamProvisional({
      gpuMode: 'gpu',
      softwareRenderer: true,
      headless: false,
      rendererAvailable: true,
      gpuBaselineRecorded: true,
    }),
    true,
  );
  assert.equal(
    isExamProvisional({
      gpuMode: 'gpu',
      softwareRenderer: false,
      headless: false,
      rendererAvailable: false,
      gpuBaselineRecorded: true,
    }),
    true,
  );
  assert.equal(
    isExamProvisional({
      gpuMode: 'gpu',
      softwareRenderer: false,
      headless: false,
      rendererAvailable: true,
      gpuBaselineRecorded: false,
    }),
    true,
  );
});
