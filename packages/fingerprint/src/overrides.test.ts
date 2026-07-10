import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOverrides, deriveFingerprint } from './index.js';

test('applyOverrides merges navigator/screen/locale/fonts and leaves the rest untouched', () => {
  const base = deriveFingerprint('seed-ov', { os: 'windows', engine: 'lobium' });

  const out = applyOverrides(base, {
    navigator: { hardwareConcurrency: 16 },
    locale: { timezone: 'Europe/Paris' },
    fonts: ['Custom Font'],
  });

  assert.equal(out.navigator.hardwareConcurrency, 16);
  assert.equal(out.navigator.userAgent, base.navigator.userAgent, 'UA left untouched');
  assert.equal(out.locale.timezone, 'Europe/Paris');
  assert.equal(out.locale.locale, base.locale.locale, 'other locale fields untouched');
  assert.deepEqual(out.fonts, ['Custom Font']);
});

test('applyOverrides with no overrides returns the fingerprint unchanged', () => {
  const base = deriveFingerprint('seed-ov2', { os: 'macos', engine: 'lobium' });
  assert.deepEqual(applyOverrides(base), base);
  assert.deepEqual(applyOverrides(base, {}), base);
});
