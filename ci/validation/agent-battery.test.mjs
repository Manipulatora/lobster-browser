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
import test from 'node:test';
import { TASKS } from './agent-battery-tasks.mjs';

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
    const passes =
      typeof task.expect === 'function' ? task.expect(answer, undefined) : task.expect.test(answer);
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
    if (typeof task.expect !== 'function') continue;
    const prompt = String(task.task);
    if (task.expect(prompt, undefined)) leaks.push(task.id);
  }
  assert.deepEqual(leaks, [], `the task text alone satisfies its own grader: ${leaks.join(', ')}`);
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
  }
});
