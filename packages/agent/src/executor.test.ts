import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserDriver } from './driver.js';
import { executeAction } from './executor.js';
import type { RawPerception } from './types.js';

const page: RawPerception = {
  url: 'https://example.test/',
  title: 'Example',
  scrollY: 0,
  viewportH: 720,
  docH: 720,
  canScrollUp: false,
  canScrollDown: false,
  elements: [],
  truncated: 0,
};

test('tab list withholds out-of-fence and local tabs and scrubs visible metadata', async () => {
  const driver = {
    listTabs: async () => [
      {
        index: 0,
        id: 'safe',
        active: true,
        title: 'api key: sk-testOnlyTabTitleCredential123456789',
        url: 'https://example.test/callback?code=testOnlyTabUrlCredential',
      },
      {
        index: 1,
        id: 'file',
        active: false,
        title: 'Private file',
        url: 'file:///home/user/private.txt',
      },
      {
        index: 2,
        id: 'outside',
        active: false,
        title: 'Other tenant',
        url: 'https://outside.test/private',
      },
      {
        index: 3,
        id: 'local',
        active: false,
        title: 'Metadata',
        url: 'http://169.254.169.254/latest/meta-data/',
      },
    ],
  } as unknown as BrowserDriver;

  const result = await executeAction({ kind: 'tab', operation: 'list' }, page, driver, {
    config: {
      maxSteps: 4,
      autonomy: 'auto',
      allowedDomains: ['example.test'],
      allowPrivateNetwork: false,
    },
  });

  assert.match(result.outcome, /tabId=safe/);
  assert.match(result.outcome, /3 tab\(s\) hidden by run policy/);
  assert.doesNotMatch(
    result.outcome,
    /testOnlyTabTitleCredential|testOnlyTabUrlCredential|file:\/\/|outside\.test|169\.254/,
  );
});

test('an unpressable key is refused before the durable dispatch barrier', async () => {
  // The barrier's meaning is "an effect may now have happened". A deterministic refusal recorded on
  // its far side is journaled as a possible dispatch, which blocks every later run on the profile —
  // so the ordering here is a safety property, not a tidiness one.
  const order: string[] = [];
  const driver = {
    pressKey: async (key: string) => {
      order.push(`pressKey:${key}`);
    },
    waitForSettle: async () => {},
  } as unknown as BrowserDriver;

  const refused = await executeAction({ kind: 'key', key: 'F13' }, page, driver, {
    beforeEffect: async () => {
      order.push('beforeEffect');
    },
  });

  assert.match(refused.outcome, /^blocked: unsupported key/);
  assert.deepEqual(order, [], 'nothing may be dispatched, and no durable barrier may be crossed');
});

/** A page with one labelled control, and a point-probe that answers with a DIFFERENT control. */
function movedPage(role: string, name: string): { page: RawPerception; driver: BrowserDriver } {
  const page: RawPerception = {
    url: 'https://example.test/',
    title: 'Example',
    scrollY: 0,
    viewportH: 720,
    docH: 720,
    canScrollUp: false,
    canScrollDown: false,
    elements: [
      { index: 0, tag: 'select', role, name, x: 100, y: 200, w: 180, h: 30 },
      { index: 1, tag: 'li', role: 'listitem', name: 'Row two', x: 100, y: 400, w: 180, h: 30 },
    ],
    truncated: 0,
  };
  const driver = {
    evaluate: async () => ({ name: 'Accept all cookies', role: 'button' }),
    select: async () => {
      throw new Error('the stale target was dispatched to');
    },
    drag: async () => {
      throw new Error('the stale target was dispatched to');
    },
    waitForSettle: async () => {},
  } as unknown as BrowserDriver;
  return { page, driver };
}

test('a select whose target moved under the measured point is refused, not dispatched', async () => {
  // A select commits a quantity, a shipping method, an account. It is classified as a commit-capable
  // gesture for that reason, so the coordinate it fires at has to be re-identified like a click's.
  const { page: moved, driver } = movedPage('combobox', 'Quantity');
  const result = await executeAction({ kind: 'select', id: 0, values: ['3'] }, moved, driver, {
    beforeEffect: async () => assert.fail('the durable barrier must not be crossed'),
  });
  assert.match(result.outcome, /^error: the page moved/);
  assert.match(result.outcome, /Accept all cookies/);
});

test('a drag is refused when either endpoint moved under its measured point', async () => {
  const { page: moved, driver } = movedPage('listitem', 'Row one');
  const result = await executeAction({ kind: 'drag', fromId: 0, toId: 1 }, moved, driver, {
    beforeEffect: async () => assert.fail('the durable barrier must not be crossed'),
  });
  assert.match(result.outcome, /^error: the page moved/);
});

test('a space is pressable and reaches the driver under the name the driver knows', async () => {
  // `{key:' '}` passed validation and then threw inside the driver, which has no entry for a literal
  // space — after the barrier had already been crossed.
  const order: string[] = [];
  const driver = {
    pressKey: async (key: string) => {
      order.push(`pressKey:${key}`);
    },
    waitForSettle: async () => {},
  } as unknown as BrowserDriver;

  const pressed = await executeAction({ kind: 'key', key: ' ' }, page, driver, {
    beforeEffect: async () => {
      order.push('beforeEffect');
    },
  });

  assert.deepEqual(order, ['beforeEffect', 'pressKey:Space']);
  assert.equal(pressed.outcome, 'pressed Space');
});
