import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeSituationChange,
  detectHarnessSignals,
  situationSignals,
  situationTransitions,
} from './situation.js';

test('error and block pages are recognised from stock phrasings, not from ordinary page text', () => {
  const errors = [
    {
      title: 'example.com',
      text: "This site can't be reached. example.com refused to connect. ERR_CONNECTION_REFUSED",
    },
    { title: '404 Not Found', text: 'nginx' },
    { title: 'Oops', text: 'HTTP ERROR 500' },
    { title: 'Service Unavailable', text: '' },
  ];
  for (const page of errors) {
    assert.deepEqual(detectHarnessSignals(page), ['error-page'], page.title);
  }
  const blocks = [
    { title: 'Attention Required! | Cloudflare', text: 'Sorry, you have been blocked' },
    { title: 'example.com', text: '429 Too Many Requests' },
    { title: 'Access Denied', text: "You don't have permission to access this resource" },
    {
      title: 'Sorry…',
      text: 'Our systems have detected unusual traffic from your computer network.',
    },
  ];
  for (const page of blocks) {
    assert.ok(detectHarnessSignals(page).includes('blocked'), page.title);
  }
  // A page that merely TALKS about errors or rate limits is neither: a false positive here becomes a
  // harness note the model is told to trust, and it would spend a step recovering from nothing.
  const ordinary = [
    { title: 'Inbox — Outlook', text: 'Sign in · Error handling in JavaScript · 12 unread' },
    { title: 'API reference: rate limiting', text: 'How to design rate limiting for your API' },
    { title: 'Order #4041', text: 'Your order has been found and will ship Tuesday' },
  ];
  for (const page of ordinary) {
    assert.deepEqual(detectHarnessSignals(page), [], page.title);
  }
  // Only the top of the text counts: an error sentence buried deep in an article is not the page.
  assert.deepEqual(
    detectHarnessSignals({
      title: 'Blog',
      text: `${'lorem ipsum '.repeat(80)}internal server error`,
    }),
    [],
  );
});

test('transitions report only what changed, in canonical order, and the note names the step', () => {
  assert.deepEqual(situationSignals(['dialog', 'login', 'canvas', 'login', 'captcha']), [
    'login',
    'captcha',
  ]);
  assert.deepEqual(situationSignals(undefined), []);
  assert.deepEqual(situationTransitions([], ['login']), [{ signal: 'login', appeared: true }]);
  assert.deepEqual(situationTransitions(['login', 'captcha'], ['captcha', 'otp']), [
    { signal: 'login', appeared: false },
    { signal: 'otp', appeared: true },
  ]);
  assert.deepEqual(situationTransitions(['login'], ['login']), []);

  assert.equal(
    describeSituationChange({ signal: 'login', appeared: true }, 3),
    'A login wall appeared since step 3 — decide whether the task needs it or whether to ask for credentials through the secure channel.',
  );
  assert.match(
    describeSituationChange({ signal: 'login', appeared: false }, 3),
    /^The login wall seen at step 3 has cleared/,
  );
  assert.match(
    describeSituationChange({ signal: 'error-page', appeared: true }, undefined),
    /^An error page is present on the first page/,
  );
  assert.match(
    describeSituationChange({ signal: 'captcha', appeared: true }, 7),
    /hand off with `ask`/,
  );
  assert.match(describeSituationChange({ signal: 'otp', appeared: true }, 7), /sensitive:true/);
});
