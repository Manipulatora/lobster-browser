#!/usr/bin/env node
// Are the battery's graders worth anything?
//
// A capability test is only as good as its grader. An adversarial pass — answering every task from
// model knowledge alone, with no browser — found EIGHT of ten graders passed blind: quotes.toscrape
// and books.toscrape are the most-reproduced scraping fixtures on the internet, so "the first quote's
// tags" and "A Light in the Attic £51.77" are memorised, not perceived. Worse, `infinite-scroll`
// printed its own accepted answer ("at least 30") in the task text.
//
// These tests pin the fix. They need no browser, no model and no credit, so they run in ordinary CI
// alongside the unit suites — which is the only way grader strength stays regression-protected.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildBatteryRunConfig,
  DEFAULT_AGENT_BATTERY_TOKEN_BUDGET,
  loadBatteryProxy,
  parseBatteryTokenBudget,
} from './agent-battery-config.mjs';
import { fetchOracleText } from './agent-battery-oracle.mjs';
import {
  parseHackerNewsTop,
  parseQuoteAuthors,
  parseQuotesApiPage,
  TASKS,
} from './agent-battery-tasks.mjs';
import { startFixtureServer } from './agent-fixtures.mjs';
import {
  chooseAttemptResult,
  hasAnyBrowserAction,
  hasBrowserAttempt,
  hasBrowserEvidence,
  matchesExpectation,
  providerBlockReason,
  summarizeBattery,
} from './agent-battery-results.mjs';

/**
 * What a competent model produced for each task with NO web access, from the adversarial run. These
 * are real outputs, not invented straw men — every one of them used to pass.
 */
const BLIND_ANSWERS = {
  'js-rendered':
    'The first quote is by Albert Einstein. Its tags are: change, deep-thoughts, thinking, world.',
  'js-delayed': 'Tags under the first quote: change, deep-thoughts, thinking, world.',
  'login-form':
    'I logged in successfully. A Logout link is present in the navigation. The first tag under the first quote is "change".',
  'extract-grid':
    'A Light in the Attic — £51.77, Tipping the Velvet — £53.74, Soumission — £50.10, Sharp Objects — £47.82, Sapiens — £54.23.',
  pagination:
    'Page 1: Albert Einstein, J.K. Rowling, Jane Austen, Marilyn Monroe. Page 2: Elie Wiesel, Friedrich Nietzsche, Mark Twain, John Lennon.',
  'multi-tab': 'Steve Martin was born in Waco, Texas on August 14, 1945.',
  'infinite-scroll': 'After scrolling, about 30 quotes had loaded on the page.',
  'long-article':
    'robots.txt tells web crawlers which pages they are allowed or disallowed to access.',
  'table-layout': 'Top three tags: love — 10, inspirational — 8, life — 8.',
  'select-and-submit': 'There are only two ways to live your life...',
  'dense-real-list': 'The top story has 128 points.',
};

const byId = new Map(TASKS.map((t) => [t.id, t]));

test('no grader can be satisfied without visiting the page', () => {
  const passedBlind = [];
  for (const [id, answer] of Object.entries(BLIND_ANSWERS)) {
    const task = byId.get(id);
    assert.ok(task, `battery no longer has a task called "${id}" — update this test`);
    // `facts` is undefined here by design: a derive-backed grader has nothing to compare against
    // without a live fetch, so it must refuse rather than pass.
    const passes = matchesExpectation(task, answer, undefined);
    if (passes) passedBlind.push(id);
  }
  assert.deepEqual(
    passedBlind,
    [],
    `these graders pass from model knowledge alone, so they grade nothing:\n  ${passedBlind.join('\n  ')}`,
  );
});

test('a task never contains the answer its grader accepts', () => {
  // `infinite-scroll` used to say "scroll until at least 30 quotes have loaded" and then accept any
  // two-digit number — restating the instruction passed.
  const leaks = [];
  for (const task of TASKS) {
    const prompt = String(task.task);
    if (matchesExpectation(task, prompt, undefined)) leaks.push(task.id);
  }
  assert.deepEqual(leaks, [], `the task text alone satisfies its own grader: ${leaks.join(', ')}`);
});

test('a provider block cannot mask a real failed attempt or failed task', () => {
  const failedAttempt = { verdict: 'FAIL', detail: 'wrong grounded answer' };
  assert.equal(
    chooseAttemptResult([
      { verdict: 'PASS' },
      failedAttempt,
      { verdict: 'BLOCKED', detail: 'provider credit exhausted' },
    ]),
    failedAttempt,
  );

  const summary = summarizeBattery(
    [
      { id: 'first', verdict: 'FAIL' },
      { id: 'second', verdict: 'BLOCKED' },
    ],
    5,
  );
  assert.equal(summary.status, 'FAIL');
  assert.equal(summary.exitCode, 1);
});

test('an incomplete battery is blocked, never green', () => {
  assert.deepEqual(summarizeBattery([{ verdict: 'PASS' }], 2).status, 'BLOCKED');
  assert.deepEqual(summarizeBattery([{ verdict: 'BLOCKED' }], 1).exitCode, 2);
  assert.deepEqual(summarizeBattery([], 0).status, 'FAIL', 'an empty selection cannot pass 0/0');
});

test('browser evidence is task-local and excludes agent-only actions', () => {
  const target = 'https://example.com/report';
  assert.equal(
    hasBrowserEvidence([{ type: 'step.action', action: { kind: 'done' } }], target),
    false,
  );
  assert.equal(
    hasAnyBrowserAction([{ type: 'step.action', action: { kind: 'navigate', url: target } }]),
    true,
  );
  assert.equal(
    hasBrowserEvidence(
      [{ type: 'step.action', action: { kind: 'navigate', url: target } }],
      target,
    ),
    false,
    'an action is emitted before execution and proves nothing by itself',
  );
  assert.equal(
    hasBrowserEvidence(
      [
        { type: 'step.action', action: { kind: 'navigate', url: target } },
        { type: 'step.observation', url: 'https://example.com/report?fresh=1' },
      ],
      target,
    ),
    true,
  );
  assert.equal(
    hasBrowserEvidence(
      [
        { type: 'step.action', action: { kind: 'navigate', url: target } },
        { type: 'step.observation', url: 'https://example.com/unrelated' },
      ],
      target,
    ),
    false,
  );
  assert.equal(
    hasBrowserAttempt([{ type: 'step.action', action: { kind: 'navigate', url: target } }], target),
    true,
  );
});

test('provider capacity and transport failures are blocked, not capability failures', () => {
  for (const error of [
    'the model provider is unavailable (managed 503: maintenance)',
    'the model provider timed out (managed 504: upstream timeout)',
    'Chat failed: LLM request timed out',
    'Chat failed: fetch failed',
    'Chat failed: connect ECONNRESET',
  ]) {
    assert.ok(providerBlockReason(error), error);
  }
  for (const productError of [
    'fetch failed',
    'connect ECONNRESET',
    'Browser action failed: fetch failed',
    'Could not fetch the page contents',
    'Navigation policy blocked localhost',
  ]) {
    assert.equal(
      providerBlockReason(productError),
      '',
      `untagged product failure was misclassified as provider capacity: ${productError}`,
    );
  }
});

test('oracle fetch is bounded and rejects HTTP errors and empty bodies', async () => {
  const ok = await fetchOracleText('https://oracle.test/data', {
    fetchImpl: async (_url, init) => {
      assert.ok(init.signal instanceof AbortSignal);
      return new Response('ground truth');
    },
    timeoutMs: 100,
  });
  assert.equal(ok, 'ground truth');

  await assert.rejects(
    fetchOracleText('https://oracle.test/missing', {
      fetchImpl: async () => new Response('upstream error', { status: 503 }),
      timeoutMs: 100,
    }),
    /HTTP 503/,
  );
  await assert.rejects(
    fetchOracleText('https://oracle.test/empty', {
      fetchImpl: async () => new Response('  \n'),
      timeoutMs: 100,
    }),
    /empty body/,
  );
  await assert.rejects(
    fetchOracleText('https://oracle.test/large', {
      fetchImpl: async () => new Response('too large'),
      timeoutMs: 100,
      maxBytes: 3,
    }),
    /exceeded 3 bytes/,
  );
  await assert.rejects(
    fetchOracleText('https://oracle.test/hangs', {
      fetchImpl: async () => new Promise(() => {}),
      timeoutMs: 10,
    }),
    /timed out after 10ms/,
  );
});

test('the volatile HN grader pairs each story with its score and accepts either run boundary', () => {
  const snapshot = parseHackerNewsTop(`
    <tr class="athing submission" id="101">
      <td><span class="titleline"><a href="item?id=101">Fresh &amp; Grounded Headline</a></span></td>
    </tr>
    <tr><td><span id="score_999">999 points</span><span id="score_101">42 points</span></td></tr>
  `);
  assert.deepEqual(snapshot, {
    id: '101',
    title: 'Fresh & Grounded Headline',
    points: 42,
  });

  const task = byId.get('dense-real-list');
  const facts = {
    snapshots: [
      { id: '101', title: 'Fresh & Grounded Headline', points: 42 },
      { id: '101', title: 'Fresh & Grounded Headline', points: 82 },
    ],
  };
  assert.equal(task.expect('Fresh & Grounded Headline — 60 points', facts), true);
  const reordered = {
    snapshots: [
      facts.snapshots[0],
      { id: '202', title: 'Replacement Story After Refresh', points: 17 },
    ],
  };
  assert.equal(task.expect('Replacement Story After Refresh — 17 points', reordered), true);
  assert.equal(task.expect('Unrelated Story — 42 points', facts), false);
});

test('collection graders reject partial rows, pages, and scroll totals', () => {
  const grid = byId.get('extract-grid');
  assert.equal(
    grid.expect('A Light in the Attic — £51.77. UPC a897fe39b1053632. In stock: 22 available.'),
    false,
    'one product plus detail facts is not a five-row collection',
  );
  assert.equal(
    grid.expect(
      'A Light in the Attic — £51.77; Tipping the Velvet — £53.74; Soumission — £50.10; ' +
        'Sharp Objects — £47.82; Sapiens: A Brief History of Humankind — £54.23. ' +
        'UPC a897fe39b1053632; In stock (22 available).',
    ),
    true,
  );

  const pagination = byId.get('pagination');
  const pageFacts = {
    authors: ['Albert Einstein', 'J.K. Rowling', 'Albert Einstein', 'Allen Saunders'],
  };
  assert.equal(
    pagination.expect('Albert Einstein, J.K. Rowling, Allen Saunders', pageFacts),
    false,
  );
  assert.equal(
    pagination.expect(
      '1. Albert Einstein\n2. J.K. Rowling\n3. Albert Einstein\n4. Allen Saunders',
      pageFacts,
    ),
    true,
  );

  const infinite = byId.get('infinite-scroll');
  const scrollFacts = { total: 100, lastAuthor: 'George Carlin' };
  assert.equal(infinite.expect('There were exactly 100 quotes.', scrollFacts), false);
  assert.equal(
    infinite.expect(
      'There were exactly 100 quotes; the last author was George Carlin.',
      scrollFacts,
    ),
    true,
  );
});

test('quote oracle parsers preserve author order and validate the scroll API shape', () => {
  assert.deepEqual(
    parseQuoteAuthors(`
      <small itemprop="author" class="author">Albert Einstein</small>
      <small class="author" itemprop="author">Andr&eacute; Gide</small>
    `),
    ['Albert Einstein', 'Andr&eacute; Gide'],
  );
  assert.deepEqual(
    parseQuotesApiPage(
      JSON.stringify({
        quotes: [{ author: { name: 'First Author' } }, { author: { name: 'Last Author' } }],
        has_next: false,
      }),
    ),
    { authors: ['First Author', 'Last Author'], hasNext: false },
  );
  assert.throws(() => parseQuotesApiPage('{broken'), /malformed JSON/);
  assert.throws(
    () => parseQuotesApiPage(JSON.stringify({ quotes: [{}], has_next: false })),
    /without an author/,
  );
});

test('the multi-tab grader proves both opening and closing the extra tab', () => {
  const assertTabs = byId.get('multi-tab').assert;
  assert.match(assertTabs([]), /never opened/);
  assert.match(
    assertTabs([{ type: 'step.action', action: { kind: 'tab', operation: 'new' } }]),
    /not observed/,
  );
  assert.match(
    assertTabs([
      { type: 'step.action', action: { kind: 'tab', operation: 'new' } },
      { type: 'step.observation', url: 'http://quotes.toscrape.com/author/Allen-Saunders/' },
    ]),
    /never closed/,
  );
  assert.equal(
    assertTabs([
      { type: 'step.action', action: { kind: 'tab', operation: 'new' } },
      { type: 'step.observation', url: 'http://quotes.toscrape.com/author/Allen-Saunders/' },
      { type: 'step.action', action: { kind: 'tab', operation: 'close' } },
      { type: 'step.observation', url: 'http://quotes.toscrape.com/page/2/' },
    ]),
    '',
  );
});

test('the long-article grader requires a description, not only a case citation', () => {
  const task = byId.get('long-article');
  const facts = {
    cases: [
      {
        parties: ['Alpha Markets', 'Beta Data'],
        terms: ['copyright', 'listings', 'database'],
      },
    ],
  };
  assert.equal(task.expect('Alpha Markets v. Beta Data.', facts), false);
  assert.equal(
    task.expect(
      'Alpha Markets v. Beta Data concerned copying protected event listings from a database under copyright rules.',
      facts,
    ),
    true,
  );
});

test('the consent answer is delivered only after the privacy-choice request', async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  const coveredPage = await (await fetch(`${fixture.origin}/consent`)).text();
  assert.doesNotMatch(coveredPage, /4[,.]?182[,.]?900/);
  assert.equal(byId.get('consent-wall').expect.test(coveredPage), false);

  const revealed = await (await fetch(`${fixture.origin}/consent-data`)).text();
  assert.match(revealed, /4[,.]?182[,.]?900/);
});

test('the form grader requires a receipt revealed only after a real submit', async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  const form = await (await fetch(`${fixture.origin}/form-post`)).text();
  assert.doesNotMatch(form, new RegExp(fixture.facts.formPostReceipt));

  const submitted = await fetch(`${fixture.origin}/form-post-result`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      custname: 'Lobee Test',
      custtel: '5550100',
      custemail: 'lobee@example.com',
      size: 'medium',
      topping: 'cheese',
    }),
  });
  const receiptPage = await submitted.text();
  assert.match(receiptPage, /Lobee Test/);
  assert.match(receiptPage, /medium/);
  assert.match(receiptPage, new RegExp(fixture.facts.formPostReceipt));

  const invalid = await fetch(`${fixture.origin}/form-post-result`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      custname: 'Lobee Test',
      custtel: '5550100',
      custemail: 'lobee@example.com',
      size: 'medium',
      // Deliberately omit the checkbox: no receipt may be issued for a partial capability pass.
    }),
  });
  const invalidPage = await invalid.text();
  assert.equal(invalid.status, 422);
  assert.doesNotMatch(invalidPage, new RegExp(fixture.facts.formPostReceipt));

  const task = byId.get('form-post');
  const facts = await task.derive({ fixtures: fixture });
  assert.equal(matchesExpectation(task, receiptPage, facts), true);
  assert.equal(matchesExpectation(task, task.task, undefined), false);
});

test('the live gate is isolated from PR CI and cannot neutralize exit 2', () => {
  const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const live = readFileSync(
    new URL('../../.github/workflows/agent-battery.yml', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(ci, /^\s{2}agent-battery:\s*$/m);
  assert.doesNotMatch(live, /^\s+pull_request:\s*$/m);
  assert.match(live, /push:\s*\n\s+branches:\s*\[main\]/);
  assert.match(live, /workflow_dispatch:/);
  assert.match(live, /runs-on:\s*\[self-hosted, agent-battery\]/);
  assert.match(live, /environment:\s*agent-battery/);
  assert.match(live, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(live, /persist-credentials:\s*false/);
  assert.doesNotMatch(live, /LOBSTER_ENABLE_AGENT_BATTERY/);
  assert.doesNotMatch(live, /^\s{4}if:/m, 'the protected job must run, not skip green');
  assert.match(live, /Validate protected battery configuration/);
  assert.match(live, /AGENT_BATTERY_TOKEN_BUDGET:\s*'250000'/);
  assert.match(live, /run:\s*node ci\/validation\/agent-battery\.mjs/);
  assert.doesNotMatch(live, /if \[ "\$code" = "2" \][\s\S]*?exit 0/);
  assert.doesNotMatch(live, /continue-on-error:\s*true/);
  assert.doesNotMatch(live, /\|\|\s*true/);
});

test('paid attempts have a validated token ceiling and local tasks have an exact host fence', () => {
  assert.equal(parseBatteryTokenBudget(undefined), DEFAULT_AGENT_BATTERY_TOKEN_BUDGET);
  assert.equal(parseBatteryTokenBudget('1000'), 1_000);
  assert.equal(parseBatteryTokenBudget('10000000'), 10_000_000);
  for (const value of ['', '999', '10000001', '1.5', '-5000', 'not-a-number']) {
    assert.throws(() => parseBatteryTokenBudget(value), /between 1000 and 10000000/, value);
  }

  const publicConfig = buildBatteryRunConfig(
    { mode: 'agent', maxSteps: 8 },
    { tokenBudget: 25_000 },
  );
  assert.deepEqual(publicConfig, {
    mode: 'agent',
    maxSteps: 8,
    visionFallback: true,
    tokenBudget: 25_000,
  });

  const localConfig = buildBatteryRunConfig(
    { local: true, maxSteps: 9 },
    { fixtureOrigin: 'http://127.0.0.1:41827', tokenBudget: 30_000 },
  );
  assert.deepEqual(localConfig, {
    mode: 'agent',
    maxSteps: 9,
    visionFallback: true,
    tokenBudget: 30_000,
    allowPrivateNetwork: true,
    allowedDomains: ['127.0.0.1'],
  });
  assert.throws(
    () =>
      buildBatteryRunConfig(
        { local: true, maxSteps: 9 },
        { fixtureOrigin: 'http://192.168.1.20:8080', tokenBudget: 30_000 },
      ),
    /loopback HTTP/,
  );
  assert.throws(
    () =>
      buildBatteryRunConfig(
        { maxSteps: 9 },
        { fixtureOrigin: 'http://127.0.0.1:41827', tokenBudget: 999 },
      ),
    /token budget between 1000 and 10000000/,
  );
});

test('protected CI never inherits a proxy token from the runner home directory', () => {
  let reads = 0;
  const readFile = () => {
    reads += 1;
    return 'PORT=8790\nAGENT_PROXY_TOKEN=stale-runner-secret\n';
  };
  assert.equal(loadBatteryProxy({ env: { CI: '1' }, homeDirectory: '/runner', readFile }), null);
  assert.equal(reads, 0);
  assert.equal(
    loadBatteryProxy({
      env: { GITHUB_ACTIONS: 'true', LOBSTER_AGENT_PROXY_URL: 'https://proxy.test' },
      homeDirectory: '/runner',
      readFile,
    }),
    null,
    'a partial explicit credential pair must fail closed',
  );
  assert.equal(reads, 0);
  assert.deepEqual(
    loadBatteryProxy({
      env: {
        CI: 'true',
        LOBSTER_AGENT_PROXY_URL: 'https://proxy.test/agent/llm',
        LOBSTER_AGENT_PROXY_TOKEN: 'protected-secret',
      },
      homeDirectory: '/runner',
      readFile,
    }),
    { url: 'https://proxy.test/agent/llm', token: 'protected-secret' },
  );
  assert.deepEqual(
    loadBatteryProxy({ env: {}, homeDirectory: '/developer', readFile }),
    { url: 'http://127.0.0.1:8790/agent/llm', token: 'stale-runner-secret' },
    'the convenience-file fallback remains available for an explicit local run',
  );
  assert.equal(reads, 1);
});

test('every task is graded, named, and bounded', () => {
  const ids = new Set();
  for (const task of TASKS) {
    assert.match(task.id, /^[a-z0-9-]+$/, `bad task id ${JSON.stringify(task.id)}`);
    assert.ok(!ids.has(task.id), `duplicate task id ${task.id}`);
    ids.add(task.id);
    assert.ok(task.why, `${task.id} does not say which capability it covers`);
    assert.ok(task.expect, `${task.id} has no grader`);
    assert.ok(
      Number.isInteger(task.maxSteps) && task.maxSteps > 0 && task.maxSteps <= 40,
      `${task.id} has an implausible step budget`,
    );
    // A loopback fixture task must be marked `local`, or the SSRF guard will refuse it and the task
    // will fail for a reason that has nothing to do with the capability under test.
    if (String(task.task).includes('{ORIGIN}')) {
      assert.equal(task.local, true, `${task.id} uses a fixture but is not marked local`);
    }
    if (task.browser === false) {
      assert.equal(task.mode, 'ask', `${task.id} claims browser-free behavior outside Ask mode`);
    } else {
      assert.match(
        task.task,
        /https?:\/\/|\{ORIGIN\}/,
        `${task.id} has no target URL for task-local browser evidence`,
      );
    }
  }
});
