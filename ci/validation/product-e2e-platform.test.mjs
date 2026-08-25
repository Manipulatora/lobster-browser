import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveProductE2eHeadful,
  validateWindowsFontIsolationConfig,
} from './product-e2e-platform.mjs';

test('Windows product E2E defaults headful without DISPLAY and honors the explicit override', () => {
  assert.equal(resolveProductE2eHeadful('win32', {}), true);
  assert.equal(resolveProductE2eHeadful('win32', { LOBSTER_HEADFUL: '0' }), false);
  assert.equal(resolveProductE2eHeadful('win32', { LOBSTER_HEADFUL: '1' }), true);
  assert.equal(resolveProductE2eHeadful('linux', {}), false);
  assert.equal(resolveProductE2eHeadful('linux', { DISPLAY: ':1' }), true);
  assert.equal(resolveProductE2eHeadful('linux', { LOBSTER_HEADFUL: '1' }), true);
});

test('Windows font isolation requires the DirectWrite allowlist and provisioned pack in native config', () => {
  const families = ['Arial', 'Noto Sans'];
  const fallback = ['Noto Sans', 'Noto Serif', 'Noto Sans Mono'];
  const userDataDir = 'C:\\Profiles\\p';
  const staged = `${userDataDir}\\native-font-packs\\${'a'.repeat(64)}`;
  const result = validateWindowsFontIsolationConfig(
    {
      fonts: families,
      fontPackDir: staged,
      fontFallbackFamilies: fallback,
    },
    'c:\\lobster\\fonts',
    userDataDir,
    families,
    fallback,
    'open-fonts-v1',
  );
  assert.equal(result.mode, 'directwrite');
  assert.equal(result.directWriteContractConfigured, true);

  assert.throws(
    () =>
      validateWindowsFontIsolationConfig(
        { fonts: ['Arial'], fontPackDir: staged, fontFallbackFamilies: fallback },
        'C:\\Lobster\\fonts',
        userDataDir,
        families,
        fallback,
        'open-fonts-v1',
      ),
    /family allowlist/,
  );
  assert.throws(
    () =>
      validateWindowsFontIsolationConfig(
        { fonts: families, fontPackDir: 'C:\\wrong', fontFallbackFamilies: fallback },
        'C:\\Lobster\\fonts',
        userDataDir,
        families,
        fallback,
        'open-fonts-v1',
      ),
    /fontPackDir is not a content-keyed persona stage/,
  );
  assert.throws(
    () =>
      validateWindowsFontIsolationConfig(
        { fonts: families, fontPackDir: staged, fontFallbackFamilies: [...fallback].reverse() },
        'C:\\Lobster\\fonts',
        userDataDir,
        families,
        fallback,
        'open-fonts-v1',
      ),
    /ordered persona fallback families/,
  );
});
