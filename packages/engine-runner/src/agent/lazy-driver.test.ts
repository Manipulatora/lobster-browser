import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserDriver } from '@lobster/agent';
import { CdpBrowserDriver } from './cdp-driver.js';
import { LazyBrowserDriver } from './lazy-driver.js';

/**
 * The driver seam, written down once so the COMPILER owns its completeness: `Record<keyof BrowserDriver,
 * true>` fails to build when a member is missing, and excess-property checking fails when a name is not
 * part of the seam. That is what lets the conformance test below reflect over the real driver and simply
 * intersect with this map, instead of maintaining a hand-written list of private helpers to ignore —
 * which would rot the moment someone adds one.
 */
const SEAM: Record<keyof BrowserDriver, true> = {
  browserConfig: true,
  ready: true,
  evaluate: true,
  click: true,
  hover: true,
  drag: true,
  type: true,
  pressKey: true,
  selectAll: true,
  scrollBy: true,
  select: true,
  uploadFiles: true,
  navigate: true,
  goBack: true,
  listTabs: true,
  newTab: true,
  switchTab: true,
  switchTabById: true,
  closeTab: true,
  closeTabById: true,
  currentUrl: true,
  waitForSettle: true,
  screenshot: true,
  takeAdoptedPopup: true,
  close: true,
};

test('the lazy wrapper forwards every driver member the real driver implements', () => {
  const implemented = Object.getOwnPropertyNames(CdpBrowserDriver.prototype).filter(
    // `hasOwn`, not `in`: `in` walks the prototype chain and would smuggle `constructor` into the list.
    (name) => Object.hasOwn(SEAM, name),
  );
  // Guards the assertion below against passing vacuously, and pins the one deliberate gap: the CDP
  // driver is always connected, so it omits the lazy-launch probe and nothing else.
  assert.deepEqual(
    Object.keys(SEAM).filter((name) => !implemented.includes(name)),
    ['ready'],
  );
  const missing = implemented.filter(
    (name) =>
      typeof (LazyBrowserDriver.prototype as unknown as Record<string, unknown>)[name] !==
      'function',
  );
  assert.deepEqual(missing, [], `LazyBrowserDriver does not forward: ${missing.join(', ')}`);
});

test('tab-by-id addressing attaches a browser rather than reporting the driver cannot do it', async () => {
  let requested = 0;
  const driver = new LazyBrowserDriver(async () => {
    requested += 1;
    throw new Error('profile launch declined');
  });
  // The executor reads these two members off the driver and answers "this driver cannot address tabs by
  // id" when either is undefined — while the tool schema tells the model id addressing is the preferred
  // form and the printed tab list carries no positions to fall back to.
  await assert.rejects(driver.switchTabById('T1'), /profile launch declined/);
  await assert.rejects(driver.closeTabById('T1'), /profile launch declined/);
  assert.equal(requested, 2);
});

test('a run with no browser reports no adopted popup without launching one', () => {
  const driver = new LazyBrowserDriver(async () => assert.fail('must not request a browser'));
  assert.equal(driver.takeAdoptedPopup(), undefined);
});
