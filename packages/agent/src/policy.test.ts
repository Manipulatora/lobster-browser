import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAction } from './actions.js';
import {
  actionRisk,
  assessNavigation,
  isDomainAllowed,
  isPrivateHostname,
  normalizeAllowedDomains,
} from './policy.js';
import { redactAction, redactUrl } from './security.js';
import type { RawPerception } from './types.js';
import { resolveConfig } from './loop.js';

const page: RawPerception = {
  url: 'https://shop.example/',
  title: 'Shop',
  scrollY: 0,
  viewportH: 800,
  docH: 800,
  canScrollUp: false,
  canScrollDown: false,
  truncated: 0,
  elements: [
    { index: 0, tag: 'button', role: 'button', name: 'Place order', x: 1, y: 1, w: 10, h: 10 },
    {
      index: 1,
      tag: 'input',
      role: 'textbox',
      name: 'Password',
      type: 'password',
      sensitive: true,
      x: 1,
      y: 1,
      w: 10,
      h: 10,
    },
  ],
};

test('navigation policy blocks local networks, unsafe schemes, and domain-fence escapes', () => {
  // `confirm` autonomy keeps the cross-domain gate; hard denies apply in every mode.
  const config = resolveConfig({ autonomy: 'confirm', allowedDomains: ['example.com'] });
  assert.equal(assessNavigation('http://127.0.0.1/admin', page.url, config).verdict, 'deny');
  assert.equal(assessNavigation('file:///etc/passwd', page.url, config).verdict, 'deny');
  assert.equal(assessNavigation('https://example.com/path', page.url, config).verdict, 'confirm');
  assert.equal(assessNavigation('https://evil-example.com/', page.url, config).verdict, 'deny');
  assert.equal(assessNavigation('https://sub.example.com/', page.url, config).verdict, 'confirm');
  assert.ok(isPrivateHostname('169.254.169.254'));
  assert.ok(isPrivateHostname('fd00::1'));
  assert.ok(isDomainAllowed('a.example.com', ['example.com']));
  assert.ok(!isDomainAllowed('notexample.com', ['example.com']));
  assert.throws(() => normalizeAllowedDomains(['https://example.com']), /invalid allowed domain/);
});

test('auto autonomy runs without approval pauses: cross-domain defaults to allow, denies still hold', () => {
  const auto = resolveConfig({ allowedDomains: ['example.com'] });
  assert.equal(auto.crossDomainNavigation, 'allow');
  assert.equal(assessNavigation('https://sub.example.com/', page.url, auto).verdict, 'allow');
  assert.equal(assessNavigation('http://127.0.0.1/admin', page.url, auto).verdict, 'deny');
  assert.equal(assessNavigation('https://evil-example.com/', page.url, auto).verdict, 'deny');
  // An explicit override still wins over the autonomy-derived default.
  const strict = resolveConfig({ crossDomainNavigation: 'confirm' });
  assert.equal(strict.crossDomainNavigation, 'confirm');
});

test('high-impact controls require confirmation and secret action data is redacted', () => {
  assert.equal(actionRisk({ kind: 'click', id: 0 }, page).high, true);
  const safe = redactAction({ kind: 'type', id: 1, text: 'hunter2' }, page);
  assert.deepEqual(safe, { kind: 'type', id: 1, text: '[REDACTED]' });
  assert.equal(
    redactUrl('https://example.com/cb?code=abc&state=ok'),
    'https://example.com/cb?code=%5BREDACTED%5D&state=ok',
  );
});

test('expanded action parser validates bounded action-specific fields', () => {
  assert.deepEqual(parseAction({ kind: 'drag', fromId: 1, toId: 2 }), {
    ok: true,
    action: { kind: 'drag', fromId: 1, toId: 2 },
  });
  assert.equal(parseAction({ kind: 'tab', operation: 'switch' }).ok, false);
  assert.equal(parseAction({ kind: 'ask', question: 'secret?', targetId: 1 }).ok, false);
  assert.equal(parseAction({ kind: 'wait', ms: 9000 }).ok, false);
  assert.deepEqual(parseAction({ kind: 'click_at', x: 12, y: 34 }), {
    ok: true,
    action: { kind: 'click_at', x: 12, y: 34 },
  });
  assert.equal(parseAction({ kind: 'click_at', x: 20_001, y: 1 }).ok, false);
  assert.deepEqual(redactAction({ kind: 'type_at', x: 1, y: 2, text: 'coordinate secret' }), {
    kind: 'type_at',
    x: 1,
    y: 2,
    text: '[REDACTED]',
  });
});
