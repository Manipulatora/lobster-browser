import assert from 'node:assert/strict';
import test from 'node:test';
import type { GeoInfo } from '@lobster/shared-types';
import { applyGeoToFingerprint, validateFingerprintCoherence } from './coherence.js';
import { deriveFingerprint } from './derive.js';

test('applyGeoToFingerprint aligns timezone/locale/languages with the proxy geo', () => {
  const fp = deriveFingerprint('seed-de', { os: 'windows', engine: 'chromium' });
  const geo: GeoInfo = {
    ip: '1.2.3.4',
    countryCode: 'DE',
    timezone: 'Europe/Berlin',
    latitude: 52.52,
    longitude: 13.4,
  };
  const out = applyGeoToFingerprint(fp, geo);

  assert.equal(out.locale.timezone, 'Europe/Berlin');
  assert.equal(out.locale.locale, 'de-DE');
  assert.equal(out.navigator.languages[0], 'de-DE');
  assert.ok(out.locale.acceptLanguage.startsWith('de-DE'));
  assert.deepEqual(out.locale.geolocation, { latitude: 52.52, longitude: 13.4, accuracy: 100 });
  assert.deepEqual(validateFingerprintCoherence(out), []);
});

test('unknown country keeps a coherent fallback locale and applies the timezone', () => {
  const fp = deriveFingerprint('seed-xx', { os: 'linux', engine: 'camoufox' });
  const geo: GeoInfo = { ip: '9.9.9.9', countryCode: 'ZZ', timezone: 'Etc/UTC' };
  const out = applyGeoToFingerprint(fp, geo);

  assert.equal(out.locale.timezone, 'Etc/UTC');
  assert.equal(out.navigator.languages[0], out.locale.locale);
  assert.equal(out.locale.geolocation, undefined);
  assert.deepEqual(validateFingerprintCoherence(out), []);
});
