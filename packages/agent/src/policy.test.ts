import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAction } from './actions.js';
import {
  actionCommitIntent,
  commitIntentGatesUnattended,
  actionRisk,
  assessCurrentPage,
  assessNavigation,
  isDomainAllowed,
  isPrivateHostname,
  isTextEntryElement,
  normalizeAllowedDomains,
} from './policy.js';
import { describeSafeAction, redactAction, redactRawActionInput, redactUrl } from './security.js';
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
  for (const privateIpv6 of [
    '::ffff:7f00:1',
    '::ffff:a00:1',
    '::ffff:ac10:1',
    '::ffff:c0a8:1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '100::1',
    '2001:db8::1',
    '2001::1',
    '64:ff9b:1::1',
    'fe80::1',
    'ff02::1',
  ]) {
    assert.ok(isPrivateHostname(privateIpv6), `${privateIpv6} must be private`);
    assert.equal(
      assessNavigation(`http://[${privateIpv6}]/`, page.url, config).verdict,
      'deny',
      `${privateIpv6} must not bypass navigation policy`,
    );
  }
  assert.equal(isPrivateHostname('2606:4700:4700::1111'), false);
  for (const localOrSpecial of [
    'intranet',
    'home.arpa',
    'router.home.arpa',
    '198.51.100.10',
    '203.0.113.10',
  ]) {
    assert.ok(isPrivateHostname(localOrSpecial), `${localOrSpecial} must be non-public`);
    assert.equal(
      assessCurrentPage(`http://${localOrSpecial}/`, config).verdict,
      'deny',
      `${localOrSpecial} must be blocked even when it is already open`,
    );
  }
  assert.ok(isDomainAllowed('a.example.com', ['example.com']));
  assert.ok(!isDomainAllowed('notexample.com', ['example.com']));
  assert.throws(() => normalizeAllowedDomains(['https://example.com']), /invalid allowed domain/);
  assert.throws(() => normalizeAllowedDomains(['com']), /too broad/);
  assert.throws(() => normalizeAllowedDomains(['co.uk']), /too broad/);
  assert.throws(() => normalizeAllowedDomains(['de']), /too broad/);
  assert.deepEqual(normalizeAllowedDomains(['localhost', 'intranet', '127.0.0.1']), [
    'localhost',
    'intranet',
    '127.0.0.1',
  ]);

  assert.equal(
    assessCurrentPage('https://sub.example.com/path', config).verdict,
    'allow',
    'an already-open page inside the fence remains usable',
  );
  assert.equal(
    assessCurrentPage('https://attacker.test/path', config).verdict,
    'deny',
    'the fence applies to the current page, not only proposed destinations',
  );
  assert.equal(
    assessCurrentPage(
      'http://localhost:3000/',
      resolveConfig({ allowedDomains: ['localhost'], allowPrivateNetwork: true }),
    ).verdict,
    'allow',
    'explicit private-network test runs keep working',
  );
  assert.equal(
    assessCurrentPage('', config).verdict,
    'allow',
    'a lazy unopened browser has no page',
  );
  assert.equal(assessCurrentPage('about:blank', config).verdict, 'allow');
  assert.equal(assessCurrentPage('chrome://newtab/', config).verdict, 'allow');
  assert.equal(assessCurrentPage('chrome://settings/appearance', config).verdict, 'allow');
  for (const blocked of [
    'file:///etc/passwd',
    'data:text/html,private',
    'blob:https://example.com/9af0f476-8d1b-4b71-8bd2-e4039de2334f',
    'filesystem:https://example.com/temporary/private.txt',
    'javascript:document.body.innerText',
    'chrome://policy/',
    'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/private.html',
  ]) {
    assert.equal(
      assessCurrentPage(blocked, config).verdict,
      'deny',
      `${blocked} must not bypass the current-page boundary`,
    );
  }
});

test('allowed-domain fences use ICANN and private PSL boundaries without blocking narrow scopes', () => {
  for (const suffix of [
    'com',
    'co.uk',
    'github.io',
    'appspot.com',
    'pages.dev',
    'vercel.app',
    'co.za',
  ]) {
    assert.throws(
      () => normalizeAllowedDomains([suffix]),
      /too broad/,
      `${suffix} must not grant every registrant or tenant beneath it`,
    );
  }

  const narrow = normalizeAllowedDomains([
    'Example.COM',
    '*.accounts.example.com.',
    'tenant.github.io',
    'tenant.appspot.com',
    'tenant.pages.dev',
    'tenant.vercel.app',
    'brand.co.za',
  ]);
  assert.deepEqual(narrow, [
    'example.com',
    'accounts.example.com',
    'tenant.github.io',
    'tenant.appspot.com',
    'tenant.pages.dev',
    'tenant.vercel.app',
    'brand.co.za',
  ]);
  assert.ok(isDomainAllowed('child.tenant.github.io', narrow));
  assert.ok(!isDomainAllowed('other.github.io', narrow));
  assert.ok(!isDomainAllowed('github.io', narrow));
});

test('allowed-domain fences canonicalize IDNA and IP literals and reject malformed hosts', () => {
  assert.deepEqual(
    normalizeAllowedDomains([
      'BÜCHER.de.',
      '*.xn--bcher-kva.de',
      'localhost',
      'intranet',
      '127.0.0.1',
      '[2001:0DB8:0:0:0:0:0:1]',
      '2001:db8::1',
    ]),
    ['xn--bcher-kva.de', 'localhost', 'intranet', '127.0.0.1', '2001:db8::1'],
  );
  assert.ok(isDomainAllowed('shop.bücher.de.', ['xn--bcher-kva.de']));
  assert.ok(isDomainAllowed('[2001:db8::1]', ['2001:db8::1']));
  assert.ok(!isDomainAllowed('[2001:db8::2]', ['2001:db8::1']));
  assert.ok(!isDomainAllowed('attacker.127.0.0.1', ['127.0.0.1']));

  for (const malformed of [
    '',
    '*.',
    'a..example.com',
    'example.com..',
    '-bad.example',
    'bad-.example',
    'bad_name.example',
    'https://example.com',
    'example.com/path',
    'user@example.com',
    'example.com:443',
    '[2001:db8::zz]',
  ]) {
    assert.throws(
      () => normalizeAllowedDomains([malformed]),
      /invalid allowed domain/,
      `${JSON.stringify(malformed)} must fail closed`,
    );
  }
  assert.equal(isDomainAllowed('example.com', ['com']), false, 'raw broad fences fail closed too');
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

test('every action free-text field is credential-scrubbed before UI or history', () => {
  const secret = 'api key: sk-testOnlyNestedActionCredential123456789';
  const done = redactAction({ kind: 'done', success: true, summary: secret });
  const collected = redactAction({
    kind: 'collect',
    columns: ['account'],
    rows: [{ account: secret }],
    note: secret,
  });

  assert.doesNotMatch(JSON.stringify(done), /testOnlyNestedActionCredential/);
  assert.doesNotMatch(JSON.stringify(collected), /testOnlyNestedActionCredential/);
  assert.match(JSON.stringify(done), /REDACTED/);
  assert.match(JSON.stringify(collected), /REDACTED/);
});

test('every browser commit path is classified before execution', () => {
  const commitPage: RawPerception = {
    ...page,
    elements: [
      ...page.elements,
      {
        index: 2,
        tag: 'button',
        role: 'button',
        name: 'Continue',
        submitsForm: true,
        x: 1,
        y: 1,
        w: 10,
        h: 10,
      },
      {
        index: 3,
        tag: 'select',
        role: 'combobox',
        name: 'Plan',
        focused: true,
        x: 1,
        y: 1,
        w: 10,
        h: 10,
      },
      {
        index: 4,
        tag: 'button',
        role: 'button',
        name: 'Show details',
        x: 1,
        y: 1,
        w: 10,
        h: 10,
      },
      {
        index: 5,
        tag: 'button',
        role: 'textbox',
        name: 'Continue',
        x: 1,
        y: 1,
        w: 10,
        h: 10,
      },
      {
        index: 6,
        tag: 'div',
        role: 'button',
        name: 'Invoice 1042',
        x: 1,
        y: 1,
        w: 10,
        h: 10,
      },
      {
        index: 7,
        tag: 'div',
        role: 'button',
        name: 'Delete invoice',
        x: 1,
        y: 1,
        w: 10,
        h: 10,
      },
      {
        index: 8,
        tag: 'a',
        role: 'link',
        name: 'Continue',
        href: 'https://shop.example/account/delete-account?confirm=1',
        x: 1,
        y: 1,
        w: 10,
        h: 10,
      },
      {
        index: 9,
        tag: 'div',
        role: 'textbox',
        name: 'Spoofed editor',
        x: 1,
        y: 1,
        w: 10,
        h: 10,
      },
      {
        index: 10,
        tag: 'div',
        role: 'textbox',
        name: 'Real rich-text editor',
        editable: true,
        x: 1,
        y: 1,
        w: 10,
        h: 10,
      },
    ],
  };
  const cases: Array<{
    name: string;
    action: Parameters<typeof actionCommitIntent>[0];
    kind: NonNullable<ReturnType<typeof actionCommitIntent>>['kind'];
  }> = [
    { name: 'semantic submit click', action: { kind: 'click', id: 0 }, kind: 'semantic-commit' },
    { name: 'unlabelled form submit', action: { kind: 'click', id: 2 }, kind: 'form-submit' },
    {
      name: 'type plus submit',
      action: { kind: 'type', id: 1, text: 'value', submit: true },
      kind: 'explicit-submit',
    },
    {
      name: 'coordinate type plus submit',
      action: { kind: 'type_at', x: 10, y: 10, text: 'value', submit: true },
      kind: 'explicit-submit',
    },
    {
      name: 'coordinate type focus click',
      action: { kind: 'type_at', x: 10, y: 10, text: 'value' },
      kind: 'coordinate-activation',
    },
    {
      name: 'embedded Enter in typed text',
      action: { kind: 'type', id: 1, text: 'value\n' },
      kind: 'keyboard-activation',
    },
    {
      name: 'type aimed at non-text control',
      action: { kind: 'type', id: 2, text: ' ' },
      kind: 'semantic-commit',
    },
    {
      name: 'Enter activation',
      action: { kind: 'key', key: 'Enter' },
      kind: 'keyboard-activation',
    },
    {
      name: 'Space activation',
      action: { kind: 'key', key: 'Space' },
      kind: 'keyboard-activation',
    },
    {
      name: 'literal Space activation',
      action: { kind: 'key', key: ' ' },
      kind: 'keyboard-activation',
    },
    {
      name: 'select change handler',
      action: { kind: 'select', id: 3, values: ['pro'] },
      kind: 'selection-change',
    },
    {
      name: 'coordinate activation',
      action: { kind: 'click_at', x: 10, y: 10 },
      kind: 'coordinate-activation',
    },
    {
      name: 'coordinate context-menu activation',
      action: { kind: 'click_at', x: 10, y: 10, button: 'right' },
      kind: 'coordinate-activation',
    },
    {
      name: 'ARIA role cannot disguise a native activation control as text entry',
      action: { kind: 'type', id: 5, text: 'draft' },
      kind: 'semantic-commit',
    },
    {
      name: 'Delete outside a text field',
      action: { kind: 'key', key: 'Delete' },
      kind: 'keyboard-activation',
    },
    {
      name: 'Tab can trigger blur autosave',
      action: { kind: 'key', key: 'Tab' },
      kind: 'keyboard-activation',
    },
    {
      name: 'destructive drag destination',
      action: { kind: 'drag', fromId: 6, toId: 7 },
      kind: 'drag-drop',
    },
    {
      name: 'dangerous same-domain link URL with a generic label',
      action: { kind: 'click', id: 8 },
      kind: 'semantic-commit',
    },
    {
      name: 'dangerous direct same-domain navigation',
      action: { kind: 'navigate', url: 'https://shop.example/account/delete-account?confirm=1' },
      kind: 'semantic-commit',
    },
    {
      name: 'dangerous new-tab navigation',
      action: {
        kind: 'tab',
        operation: 'new',
        url: 'https://shop.example/unsubscribe?list=weekly',
      },
      kind: 'semantic-commit',
    },
    {
      name: 'durable fact write',
      action: { kind: 'remember', factKey: 'layout', factValue: 'compact' },
      kind: 'semantic-commit',
    },
    {
      name: 'durable learned procedure',
      action: {
        kind: 'learn',
        skillName: 'open-report',
        skillTrigger: 'open the report',
        skillSteps: 'Use the Reports link.',
      },
      kind: 'semantic-commit',
    },
    {
      name: 'persistent browser setting',
      action: { kind: 'browser_config', op: 'set_theme', value: 'dark' },
      kind: 'semantic-commit',
    },
  ];

  for (const entry of cases) {
    assert.equal(actionCommitIntent(entry.action, commitPage)?.kind, entry.kind, entry.name);
    assert.equal(actionRisk(entry.action, commitPage).consequential, true, entry.name);
  }

  assert.equal(isTextEntryElement(commitPage.elements[5]!), false);
  assert.equal(isTextEntryElement(commitPage.elements[9]!), false);
  assert.equal(isTextEntryElement(commitPage.elements[10]!), true);
});

test('gestures whose only risk is unreadable page script defer to the autonomy setting', () => {
  const box = { x: 1, y: 1, w: 10, h: 10 };
  const opaquePage: RawPerception = {
    ...page,
    elements: [
      { index: 0, tag: 'div', role: 'button', name: 'Show details', ...box },
      { index: 1, tag: 'button', role: 'button', name: 'Place order', ...box },
      { index: 2, tag: 'button', role: 'button', name: '', submitsForm: true, ...box },
      { index: 3, tag: 'select', role: 'combobox', name: 'Plan', ...box },
      { index: 4, tag: 'li', role: 'listitem', name: 'Report', ...box },
      { index: 5, tag: 'div', role: 'generic', name: 'Trash', ...box },
    ],
  };

  // Classified, and reported to the model as risky — but not a reason to stop an UNATTENDED run,
  // because it is true of every click on the web. Gating on it made Auto and Review the same mode.
  const deferred: Parameters<typeof actionCommitIntent>[0][] = [
    { kind: 'click', id: 0 },
    { kind: 'click', id: 0, button: 'right' },
    { kind: 'key', key: 'ArrowDown' },
    { kind: 'key', key: 'PageDown' },
    { kind: 'key', key: 'Escape' },
  ];
  for (const action of deferred) {
    const intent = actionCommitIntent(action, opaquePage);
    assert.ok(intent, JSON.stringify(action));
    assert.equal(commitIntentGatesUnattended(intent), false, JSON.stringify(action));
    assert.equal(actionRisk(action, opaquePage).high, true, JSON.stringify(action));
  }

  // The keys that can submit, activate the focused control, or blur-save still gate everywhere.
  for (const key of ['Enter', 'Space', ' ', 'Tab', 'Delete', 'Backspace', 'a']) {
    const intent = actionCommitIntent({ kind: 'key', key }, opaquePage);
    assert.ok(intent, key);
    assert.equal(commitIntentGatesUnattended(intent), true, key);
  }
  for (const action of [
    { kind: 'click', id: 1 },
    { kind: 'click', id: 2 },
    { kind: 'click_at', x: 10, y: 10 },
    { kind: 'select', id: 3, values: ['pro'] },
    { kind: 'drag', fromId: 4, toId: 5 },
  ] as Parameters<typeof actionCommitIntent>[0][]) {
    const intent = actionCommitIntent(action, opaquePage);
    assert.ok(intent, JSON.stringify(action));
    assert.equal(commitIntentGatesUnattended(intent), true, JSON.stringify(action));
  }
});

test('composition and non-activation actions stay outside the commit boundary', () => {
  const safeActions: Parameters<typeof actionCommitIntent>[0][] = [
    { kind: 'type', id: 1, text: 'draft' },
    { kind: 'hover', id: 0 },
    { kind: 'scroll', direction: 'down' },
  ];
  for (const action of safeActions) {
    assert.equal(actionCommitIntent(action, page), undefined, JSON.stringify(action));
  }

  const focusedTextPage: RawPerception = {
    ...page,
    elements: page.elements.map((element) =>
      element.index === 1 ? { ...element, focused: true } : element,
    ),
  };
  assert.equal(
    actionCommitIntent({ kind: 'key', key: 'Delete' }, focusedTextPage)?.kind,
    'keyboard-activation',
    'page-level key events remain opaque even inside a text field',
  );
  assert.equal(
    actionCommitIntent(
      { kind: 'navigate', url: 'https://shop.example/account/delete-account-help' },
      page,
    )?.kind,
    'semantic-commit',
    'ambiguous destructive URL names fail closed',
  );
  assert.equal(
    actionCommitIntent({ kind: 'drag', fromId: 0, toId: 1 }, page)?.kind,
    'drag-drop',
    'generic drop handlers are uninspectable and fail closed too',
  );
});

test('approval descriptions expose the exact gesture and destination without raw secret data', () => {
  const descriptivePage: RawPerception = {
    ...page,
    elements: [
      ...page.elements,
      { index: 2, tag: 'div', role: 'button', name: 'Trash', x: 1, y: 1, w: 10, h: 10 },
    ],
  };
  assert.match(
    describeSafeAction({ kind: 'click', id: 0, count: 2 }, descriptivePage),
    /double-click.*Place order/,
  );
  assert.match(
    describeSafeAction({ kind: 'type', id: 1, text: 'hunter2', submit: true }, descriptivePage),
    /sensitive text.*press Enter/,
  );
  assert.match(
    describeSafeAction({ kind: 'drag', fromId: 0, toId: 2 }, descriptivePage),
    /Place order.*Trash/,
  );
  assert.match(
    describeSafeAction({
      kind: 'tab',
      operation: 'new',
      url: 'https://shop.example/delete-account?token=secret',
    }),
    /delete-account\?token=%5BREDACTED%5D/,
  );
  const safeMemory = redactAction({
    kind: 'remember',
    factKey: 'login hint',
    factValue: 'api key: sk-testOnlyCredential123456789',
  });
  assert.equal(
    safeMemory.kind === 'remember' ? safeMemory.factValue : '',
    '[REDACTED: credential-like content]',
  );
  assert.doesNotMatch(describeSafeAction(safeMemory), /testOnly/);
  const secretMemoryKey = redactAction({
    kind: 'remember',
    factKey: 'sk-testOnlyCredential123456789',
    factValue: 'account preference',
  });
  assert.equal(
    secretMemoryKey.kind === 'remember' ? secretMemoryKey.factKey : '',
    '[REDACTED: credential-like content]',
  );
  const safeSkill = redactAction({
    kind: 'learn',
    skillName: 'open-report',
    skillTrigger: 'open the report',
    skillSteps: 'Use Bearer syntheticCredential123456789.',
  });
  assert.equal(
    safeSkill.kind === 'learn' ? safeSkill.skillSteps : '',
    '[REDACTED: credential-like content]',
  );
  assert.doesNotMatch(describeSafeAction(safeSkill), /syntheticCredential/);
  assert.deepEqual(
    redactRawActionInput({
      kind: 'learn',
      skillName: 'sk-testOnlyCredential123456789',
      skillTrigger: 'when asked',
      skillSteps: 'do it',
    }),
    {
      kind: 'learn',
      skillName: '[REDACTED]',
      skillTrigger: '[REDACTED]',
      skillSteps: '[REDACTED]',
    },
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
