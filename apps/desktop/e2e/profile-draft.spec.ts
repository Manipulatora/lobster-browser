import { expect, test } from '@playwright/test';

import type { Profile } from '@lobster/shared-types';

import { OS_OPTIONS } from '../src/features/profiles/options';
import {
  androidModelsForSelection,
  fontPresetsForTarget,
  rendererPresetsForTarget,
} from '../src/features/profiles/fingerprintCatalog';
import {
  changeDraftOs,
  createProfileDraft,
  hydrateProfileDraft,
  serializeProfileDraft,
  validateProfileDraft,
} from '../src/features/profiles/profileDraft';

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'profile-1',
    name: 'Round trip',
    engine: 'lobium',
    os: 'windows',
    osVersion: 'Windows 11',
    fingerprintSeed: '00112233445566778899aabbccddeeff',
    tags: ['one', 'two'],
    folder: 'QA',
    notes: 'Draft coverage',
    status: 'idle',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    ...overrides,
  };
}

test('profile draft hydrates and serializes the complete editable desktop shape', () => {
  const source = profile({
    proxyId: 'proxy-1',
    cookiesImport: {
      mode: 'merge',
      source: 'plain_text',
      rawText: '[{"name":"a","value":"b","domain":"example.com","path":"/"}]',
      parsedCount: 1,
    },
    extensions: [
      {
        source: 'chrome_web_store',
        enabled: true,
        id: 'abcdefghijklmnopabcdefghijklmnop',
        url: 'https://chromewebstore.google.com/detail/example/abcdefghijklmnopabcdefghijklmnop',
        installState: 'ready',
      },
      {
        source: 'unpacked',
        enabled: false,
        name: 'Local fixture',
        path: '/opt/lobster/extensions/local-fixture',
        installState: 'disabled',
      },
    ],
    passwordProtected: true,
    fingerprintOverrides: {
      navigator: {
        languages: ['fr-FR', 'fr'],
        hardwareConcurrency: 12,
        deviceMemory: 4,
      },
      screen: {
        width: 1920,
        height: 1080,
        availWidth: 1920,
        availHeight: 1040,
        devicePixelRatio: 1,
      },
      locale: {
        timezone: 'Europe/Paris',
        geolocation: { latitude: 48.8566, longitude: 2.3522, accuracy: 50 },
      },
      fontsMode: 'manual',
      fonts: ['Arial'],
      languageMode: 'manual',
      timezoneMode: 'manual',
      geolocationMode: 'manual',
      renderer: { mode: 'host' },
      webrtcMode: 'based_ip',
      webrtc: 'proxy_only',
      hardwareNoise: { webgl: true, canvas: false, audio: true, clientRects: true },
      mediaDevices: { cameras: 2, microphones: 1, speakers: 3, stableDeviceIds: true },
    },
  });

  const draft = hydrateProfileDraft(source);
  expect(draft.folder).toBe('QA');
  expect(draft.languageMode).toBe('manual');
  expect(draft.timezone).toBe('Europe/Paris');
  expect(draft.cpuCores).toBe('12');
  expect(draft.ramSize).toBe('4');
  expect(draft.fonts.available).toContain('Arial');
  expect(draft.fonts.available.length).toBeGreaterThan(400);
  expect(draft.fonts.selected).toEqual(['Arial']);
  expect(draft.mediaSpeakers).toBe('3');
  expect(draft.proxyId).toBe('proxy-1');
  expect(draft.extensions).toHaveLength(2);
  expect(draft.extensions[1]?.enabled).toBe(false);

  const { input, password } = serializeProfileDraft(draft, source);
  expect(password).toBeUndefined();
  expect(input.folder).toBe('QA');
  expect(input.proxyId).toBe('proxy-1');
  expect(input.cookiesImport?.parsedCount).toBe(1);
  expect(input.extensions).toHaveLength(2);
  expect(input.extensions?.[1]?.path).toBe('/opt/lobster/extensions/local-fixture');
  expect(input.fingerprintOverrides?.navigator?.languages).toEqual(['fr-FR', 'fr']);
  expect(input.fingerprintOverrides?.mediaDevices?.speakers).toBe(3);
  expect(input.fingerprintOverrides?.renderer).toEqual({ mode: 'host' });
  expect(input.fingerprintOverrides?.webgl).toBeUndefined();
});

test('serialization removes generated UA and UA-CH overrides', () => {
  const source = profile({
    fingerprintOverrides: {
      navigator: {
        userAgent: 'stale generated UA',
        uaBrands: [{ brand: 'Old', version: '1' }],
        uaPlatform: 'Windows',
        uaPlatformVersion: '1.0.0',
        uaMobile: false,
        uaFullVersion: '1.0.0.0',
        platform: 'Win32',
        languages: ['en-US'],
        hardwareConcurrency: 8,
        deviceMemory: 8,
        maxTouchPoints: 0,
      },
    },
  });
  const serialized = serializeProfileDraft(hydrateProfileDraft(source), source);
  const navigator = serialized.input.fingerprintOverrides?.navigator;
  expect(navigator?.userAgent).toBeUndefined();
  expect(navigator?.uaBrands).toBeUndefined();
  expect(navigator?.uaPlatform).toBeUndefined();
  expect(navigator?.uaPlatformVersion).toBeUndefined();
  expect(navigator?.uaFullVersion).toBeUndefined();
  expect(navigator?.platform).toBe('Win32');
});

test('changing OS rebuilds target-specific screen, fonts, renderer, and navigator values', () => {
  const source = profile({
    fingerprintOverrides: {
      navigator: { platform: 'Win32', hardwareConcurrency: 24, deviceMemory: 8 },
      fontsMode: 'manual',
      fonts: ['Segoe UI'],
      renderer: { mode: 'host' },
    },
  });
  const changed = changeDraftOs(hydrateProfileDraft(source), 'linux');
  const { input } = serializeProfileDraft(changed, source);
  expect(input.os).toBe('linux');
  expect(input.fingerprintOverrides?.navigator?.platform).toBeUndefined();
  expect(input.fingerprintOverrides?.fonts).not.toContain('Segoe UI');
  expect(input.fingerprintOverrides?.renderer).toEqual({ mode: 'host' });
  expect(input.fingerprintOverrides?.webgl).toBeUndefined();
});

test('Android is selectable and its device identity round-trips', () => {
  expect(OS_OPTIONS.some((option) => option.value === 'android')).toBe(true);
  const model = androidModelsForSelection('mobile', 'Android 13')[0];
  expect(model).toBeTruthy();
  const android = profile({
    os: 'android',
    osVersion: 'Android 13',
    fingerprintOverrides: {
      androidDeviceType: 'mobile',
      androidDeviceModel: model,
      navigator: { userAgent: 'stale Android UA', uaMobile: true },
    },
  });
  const draft = hydrateProfileDraft(android);
  expect(draft.os).toBe('android');
  expect(validateProfileDraft(draft)).toEqual([]);
  const serialized = serializeProfileDraft(draft, android);
  expect(serialized.input.fingerprintOverrides?.androidDeviceModel).toBe(model);
  expect(serialized.input.fingerprintOverrides?.androidDeviceCode).toBeTruthy();
  expect(serialized.input.fingerprintOverrides?.navigator?.userAgent).toBeUndefined();
});

test('rich font and WebGL catalogs remain exposed to the profile editor', () => {
  expect(fontPresetsForTarget('windows').length).toBeGreaterThan(400);
  expect(fontPresetsForTarget('macos_arm').length).toBeGreaterThan(400);
  expect(fontPresetsForTarget('linux').length).toBeGreaterThan(300);
  expect(rendererPresetsForTarget('windows').length).toBeGreaterThan(100);
  expect(rendererPresetsForTarget('macos_intel').length).toBeGreaterThan(100);
  expect(rendererPresetsForTarget('linux').length).toBeGreaterThan(100);
});

test('validation checks desktop values, extension links, media limits, and password intent', () => {
  const draft = createProfileDraft();
  draft.name = 'Validation';
  draft.languageMode = 'manual';
  draft.languages = 'not a language tag';
  draft.mediaCameras = '17';
  draft.extensions = [
    { source: 'chrome_web_store', enabled: true, url: 'http://example.com/extension' },
    { source: 'unpacked', enabled: true, path: 'relative/extension' },
  ];
  draft.password = 'one';
  draft.passwordConfirm = 'two';
  const messages = validateProfileDraft(draft).map((issue) => issue.message);
  expect(messages).toContain('Use valid BCP-47 language tags, for example en-US, en.');
  expect(messages).toContain('Camera count must be a whole number from 0 to 16.');
  expect(messages).toContain(
    'A Chrome Web Store extension has an invalid ID or official detail URL.',
  );
  expect(messages).toContain('Local unpacked extension paths must be absolute.');
  expect(messages).toContain('Password confirmation does not match.');
});
