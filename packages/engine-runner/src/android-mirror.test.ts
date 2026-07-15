import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAndroidMirrorArgs } from './android-mirror.js';

test('Android mirror is phone-sized and centered on the desktop', () => {
  const args = buildAndroidMirrorArgs({
    serial: 'device-1',
    profileName: 'Pixel profile',
    width: 412,
    height: 915,
    desktopWidth: 1440,
    desktopHeight: 1080,
  });
  const valueAfter = (flag: string): string => args[args.indexOf(flag) + 1] ?? '';
  assert.equal(valueAfter('--serial'), 'device-1');
  assert.equal(valueAfter('--window-title'), 'Pixel profile — Lobium');
  assert.equal(valueAfter('--window-width'), '412');
  assert.equal(valueAfter('--window-height'), '915');
  assert.equal(valueAfter('--window-x'), '514');
  assert.equal(valueAfter('--window-y'), '82');
  assert.ok(args.includes('--stay-awake'));
});

test('Android mirror clamps oversized personas while preserving a usable centered window', () => {
  const args = buildAndroidMirrorArgs({
    serial: 'device-2',
    width: 2000,
    height: 4000,
    desktopWidth: 1000,
    desktopHeight: 800,
  });
  const valueAfter = (flag: string): number => Number(args[args.indexOf(flag) + 1]);
  assert.equal(valueAfter('--window-width'), 900);
  assert.equal(valueAfter('--window-height'), 720);
  assert.equal(valueAfter('--window-x'), 50);
  assert.equal(valueAfter('--window-y'), 40);
});
