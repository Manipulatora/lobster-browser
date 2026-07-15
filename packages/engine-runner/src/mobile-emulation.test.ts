import assert from 'node:assert/strict';
import test from 'node:test';
import type { Fingerprint } from '@lobster/shared-types';
import { mobileEmulationCommands } from './mobile-emulation.js';

test('mobile emulation commands enforce touch, portrait metrics and overlay-style scrollbars', () => {
  const fingerprint = {
    screen: { width: 360, height: 780, devicePixelRatio: 3 },
    navigator: { maxTouchPoints: 5 },
  } as Pick<Fingerprint, 'screen' | 'navigator'>;
  const commands = mobileEmulationCommands(fingerprint);
  const byName = new Map(commands.map((command) => [command.method, command.params]));
  assert.deepEqual(byName.get('Emulation.setTouchEmulationEnabled'), {
    enabled: true,
    maxTouchPoints: 5,
  });
  assert.deepEqual(byName.get('Emulation.setDeviceMetricsOverride'), {
    width: 360,
    height: 780,
    deviceScaleFactor: 3,
    mobile: true,
    screenWidth: 360,
    screenHeight: 780,
    scale: 1,
    screenOrientation: { type: 'portraitPrimary', angle: 0 },
  });
  assert.deepEqual(byName.get('Emulation.setScrollbarsHidden'), { hidden: true });
});

test('tablet emulation uses landscape orientation and a supplied visual scale', () => {
  const fingerprint = {
    screen: { width: 873, height: 393, devicePixelRatio: 2 },
    navigator: { maxTouchPoints: 5 },
  } as Pick<Fingerprint, 'screen' | 'navigator'>;
  const metrics = mobileEmulationCommands(fingerprint, {
    formFactor: 'tablet',
    initialScale: 0.8,
  }).find((command) => command.method === 'Emulation.setDeviceMetricsOverride');
  assert.deepEqual(metrics?.params.screenOrientation, {
    type: 'landscapePrimary',
    angle: 90,
  });
  assert.equal(metrics?.params.scale, 0.8);
});
