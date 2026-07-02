import assert from 'node:assert/strict';
import test from 'node:test';
import type { Fingerprint } from '@lobster/shared-types';
import { applyCdpFingerprint, type CdpSession } from './cdp-fingerprint.js';

/** Records every CDP `send` so tests can assert which overrides were applied. */
class RecordingCdp implements CdpSession {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push(params === undefined ? { method } : { method, params });
    return {};
  }
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
  paramsFor(method: string): Record<string, unknown> | undefined {
    return this.calls.find((c) => c.method === method)?.params;
  }
}

function fingerprint(withGeo: boolean): Fingerprint {
  return {
    os: 'windows',
    arch: 'x86_64',
    navigator: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      platform: 'Win32',
      languages: ['de-DE', 'de'],
      hardwareConcurrency: 12,
      deviceMemory: 8,
      maxTouchPoints: 0,
      uaBrands: [{ brand: 'Chromium', version: '131' }],
      uaPlatform: 'Windows',
      uaPlatformVersion: '15.0.0',
      uaMobile: false,
      uaFullVersion: '131.0.0.0',
    },
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      devicePixelRatio: 1,
    },
    webgl: { vendor: 'v', renderer: 'r', unmaskedVendor: 'v', unmaskedRenderer: 'r' },
    locale: {
      timezone: 'Europe/Berlin',
      locale: 'de-DE',
      acceptLanguage: 'de-DE,de;q=0.9',
      ...(withGeo ? { geolocation: { latitude: 52.52, longitude: 13.405, accuracy: 100 } } : {}),
    },
    fonts: ['Arial'],
  };
}

test('applies the core JS-safe overrides + a main-world init script', async () => {
  const cdp = new RecordingCdp();
  await applyCdpFingerprint(cdp, fingerprint(false));
  const methods = cdp.methods();
  assert.ok(methods.includes('Emulation.setHardwareConcurrencyOverride'));
  assert.ok(methods.includes('Emulation.setTimezoneOverride'));
  assert.ok(methods.includes('Emulation.setUserAgentOverride'));
  assert.ok(methods.includes('Page.addScriptToEvaluateOnNewDocument'));
  assert.equal(cdp.paramsFor('Emulation.setTimezoneOverride')?.timezoneId, 'Europe/Berlin');
  // acceptLanguage must be the CLEAN comma-joined language list (not the q-weighted header value),
  // so Chromium's comma-split yields a clean navigator.languages (regression guard for the q-leak fix).
  assert.equal(cdp.paramsFor('Emulation.setUserAgentOverride')?.acceptLanguage, 'de-DE,de');
});

test('sends a geolocation override matching the fingerprint coordinates', async () => {
  const cdp = new RecordingCdp();
  await applyCdpFingerprint(cdp, fingerprint(true));
  assert.ok(
    cdp.methods().includes('Emulation.setGeolocationOverride'),
    'geolocation override must be applied when the profile carries coordinates',
  );
  assert.deepEqual(cdp.paramsFor('Emulation.setGeolocationOverride'), {
    latitude: 52.52,
    longitude: 13.405,
    accuracy: 100,
  });
});

test('does NOT send a geolocation override when the profile has no coordinates', async () => {
  const cdp = new RecordingCdp();
  await applyCdpFingerprint(cdp, fingerprint(false));
  assert.ok(!cdp.methods().includes('Emulation.setGeolocationOverride'));
});

test('never spoofs deep surfaces (canvas/WebGL/audio) via CDP', async () => {
  const cdp = new RecordingCdp();
  await applyCdpFingerprint(cdp, fingerprint(true));
  const script = String(cdp.paramsFor('Page.addScriptToEvaluateOnNewDocument')?.source ?? '');
  assert.doesNotMatch(script, /canvas|webgl|audiocontext|toDataURL|getImageData/i);
});
