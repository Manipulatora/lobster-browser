import assert from 'node:assert/strict';
import test from 'node:test';
import type { OsFamily } from '@lobster/shared-types';
import {
  MACOS_RETINA_MODES,
  displayModesFor,
  isPlausibleDisplayMode,
  normalizeDevicePixelRatio,
} from './displays.js';
import { DEVICE_TEMPLATES } from './pools.js';

const OSES: OsFamily[] = ['windows', 'macos', 'linux'];

test('every offered display mode is one the same rule accepts', () => {
  for (const os of OSES) {
    const modes = displayModesFor(os);
    assert.ok(modes.length >= 20, `${os} offers only ${modes.length} display modes`);
    for (const mode of modes) {
      assert.ok(
        isPlausibleDisplayMode(os, mode),
        `${os} offers ${mode.width}x${mode.height}@${mode.dpr} but its own rule rejects it`,
      );
    }
  }
});

test('the scaled sizes analytics actually report are legal, with the scale that produces them', () => {
  // 1536x864 and 1280x720 are among the most common desktop resolutions on the web precisely because
  // they are a 1080p panel at 125% and 150%. They are only coherent WITH that ratio.
  for (const [width, height, dpr] of [
    [1536, 864, 1.25],
    [1280, 720, 1.5],
    [2048, 1152, 1.25],
    [1707, 960, 1.5],
    [2560, 1440, 1.5],
    [1920, 1080, 2],
  ] as const) {
    assert.ok(
      isPlausibleDisplayMode('windows', { width, height, dpr }),
      `${width}x${height}@${dpr} is a real Windows mode`,
    );
  }
  // ...and the same sizes at a scale that implies a panel nobody built are not.
  for (const [width, height, dpr] of [
    [1920, 1080, 1.25], // a 2400x1350 panel
    [1536, 864, 2], // a 3072x1728 panel
    [3440, 1440, 1.5], // a 5160x2160 ultrawide
    [1366, 768, 1.25], // 1707.5 physical pixels — not a whole panel at all
  ] as const) {
    assert.equal(
      isPlausibleDisplayMode('windows', { width, height, dpr }),
      false,
      `${width}x${height}@${dpr} implies a panel nobody built`,
    );
  }
});

test('a ratio between the OS scale steps is rejected on every desktop OS', () => {
  for (const os of OSES) {
    for (const dpr of [0.5, 1.1, 1.33, 2.625, 5]) {
      assert.equal(
        isPlausibleDisplayMode(os, { width: 1920, height: 1080, dpr }),
        false,
        `${os} must not accept devicePixelRatio ${dpr}`,
      );
    }
  }
  // macOS has no fractional backing scale at all: it is 1 or 2, with everything else a scaled mode.
  assert.equal(isPlausibleDisplayMode('macos', { width: 1536, height: 864, dpr: 1.25 }), false);
  assert.ok(isPlausibleDisplayMode('linux', { width: 1536, height: 864, dpr: 1.25 }));
});

test('Retina modes are Apple s own scaled sizes, not the panel halved', () => {
  assert.ok(MACOS_RETINA_MODES.every((mode) => mode.dpr === 2));
  assert.ok(isPlausibleDisplayMode('macos', { width: 1512, height: 982, dpr: 2 }));
  assert.ok(isPlausibleDisplayMode('macos', { width: 1470, height: 956, dpr: 2 }));
  // 3024x1964 is the 14" panel itself; macOS reports it as 1512x982.
  assert.equal(isPlausibleDisplayMode('macos', { width: 3024, height: 1964, dpr: 2 }), false);
});

test('an unscaled screen is left alone — only the panel itself is claimed at dpr 1', () => {
  // A VM, an unusual monitor mode or an ultrawide we have not tabulated is a real machine, so dpr 1
  // is checked for the ratio only. The pair becomes checkable the moment scaling is claimed.
  assert.ok(isPlausibleDisplayMode('windows', { width: 1912, height: 1053, dpr: 1 }));
  assert.equal(isPlausibleDisplayMode('windows', { width: 1912, height: 1053, dpr: 1.5 }), false);
});

test('a captured devicePixelRatio is snapped onto the OS scale ladder, page zoom and all', () => {
  assert.equal(normalizeDevicePixelRatio('windows', 1.1), 1);
  assert.equal(normalizeDevicePixelRatio('windows', 1.32), 1.25);
  assert.equal(normalizeDevicePixelRatio('macos', 1.75), 2);
  assert.equal(normalizeDevicePixelRatio('linux', 0), 1);
  assert.equal(normalizeDevicePixelRatio('linux', Number.NaN), 1);
  assert.equal(normalizeDevicePixelRatio('windows', 1.5), 1.5);
});

test('every curated catalog device claims a screen a real panel can present', () => {
  for (const os of OSES) {
    for (const device of DEVICE_TEMPLATES[os].devices) {
      assert.ok(
        isPlausibleDisplayMode(os, {
          width: device.screen.width,
          height: device.screen.height,
          dpr: device.screen.dpr,
        }),
        `catalog device ${device.id} claims ${device.screen.width}x${device.screen.height}@${device.screen.dpr}`,
      );
    }
  }
});
