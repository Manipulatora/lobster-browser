#!/usr/bin/env node
/**
 * Real-browser deterministic agent fixtures — docs/LOBEE_AGENT_ROADMAP.md §7.2, Gate B.
 *
 * Everything below runs the PRODUCTION loop (`runAgent`) through the PRODUCTION driver
 * (`CdpBrowserDriver` over the first-party CDP client) against a REAL browser and a real HTTP
 * origin. The only substitution is the model, which is replaced by a deterministic pilot that reads
 * the same rendered observation a model reads and picks its target by role and name (see pilot.mjs).
 *
 * Until this harness existed, the entire browser half of the agent was covered only by fake CDP
 * sessions: `cdp-driver.test.ts` asserts what commands the driver *sends*, never what a browser
 * *does* with them. Perception ran only against a hand-written JSON page. So a change that made
 * `Input.dispatchKeyEvent` produce no text, or that renumbered elements between perception and
 * dispatch, or that broke shadow-root traversal, could ship with a green suite.
 *
 * Exit codes: 0 pass · 1 a scenario failed · 2 BLOCKED (no engine provisioned). A block is never a
 * pass, and an interim-engine pass is reported as browser-integration evidence, not Gate B.
 *
 *   node ci/validation/e2e/agent-browser-e2e.mjs [--only=name,name] [--headful] [--keep-going]
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FileMemoryStore, resolveConfig, runAgent } from '../../../packages/agent/dist/index.js';
import { RunJournalStore } from '../../../packages/agent/dist/journal/index.js';
import { CdpBrowserDriver } from '../../../packages/engine-runner/dist/agent/cdp-driver.js';
import { withCdpSession, cdpEvaluate } from '../../../packages/engine-runner/dist/cdp-client.js';
import { startFixtureSite } from './fixture-site.mjs';
import { launchEngine, resolveEngine } from './engine.mjs';
import { need, PilotLlm } from './pilot.mjs';

const argv = process.argv.slice(2);
const only = argv
  .find((a) => a.startsWith('--only='))
  ?.slice(7)
  .split(',')
  .filter(Boolean);
const HEADFUL = argv.includes('--headful');
const KEEP_GOING = argv.includes('--keep-going');
const DEBUG = argv.includes('--debug') || process.env.LOBEE_E2E_DEBUG === '1';

/* ─────────────────────────────── run harness ─────────────────────────────── */

/**
 * Execute one scenario: fresh fixture site facts, fresh memory dir, fresh journal, fresh browser tab.
 * The browser process is shared across scenarios (launching Chromium per scenario would dominate the
 * runtime); isolation that matters — origin nonce, memory, journal, session, driver — is per scenario.
 */
async function runScenario(scenario, ctx) {
  const site = await startFixtureSite();
  const memoryDir = await mkdtemp(join(tmpdir(), 'lobee-e2e-mem-'));
  const memoryKey = randomBytes(32).toString('base64');
  const events = [];
  const approvals = [];
  const driver = await CdpBrowserDriver.create(ctx.ws);
  // Every scenario starts from a clean page so a previous scenario's DOM cannot answer this one.
  await driver.navigate('about:blank');

  const memory = new FileMemoryStore(memoryDir, { encryptionKey: memoryKey });
  const journal = new RunJournalStore(join(memoryDir, 'journals'), { encryptionKey: memoryKey });
  const pilot = new PilotLlm((view, state, step) => scenario.plan(view, state, step, site, driver));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), scenario.timeoutMs ?? 90_000);

  const answer = (prompt, kind, action) => {
    approvals.push({ prompt, kind, action });
    const verdict = scenario.approve
      ? scenario.approve({ prompt, kind, action, index: approvals.length - 1 })
      : 'approve';
    return Promise.resolve(verdict);
  };

  let runError;
  try {
    await runAgent(
      {
        sessionId: `e2e-${scenario.name}`,
        profileId: `e2e-${scenario.name}`,
        task: typeof scenario.task === 'function' ? scenario.task(site) : scenario.task,
        runId: `run-${randomBytes(6).toString('hex')}`,
        llmConfig: { provider: 'anthropic', model: 'pilot/deterministic', apiKey: 'unused' },
        config: resolveConfig({
          maxSteps: scenario.maxSteps ?? 14,
          autonomy: scenario.autonomy ?? 'auto',
          allowPrivateNetwork: scenario.allowPrivateNetwork !== false,
          ...(scenario.config ?? {}),
        }),
      },
      {
        driver,
        llm: pilot,
        memory,
        journal,
        emit: (event) => events.push(event),
        waitForInput: answer,
        signal: abort.signal,
        now: () => new Date().toISOString(),
      },
    );
  } catch (error) {
    runError = error;
  } finally {
    clearTimeout(timer);
  }

  const finished = events.find((e) => e.type === 'run.finished');
  const view = {
    site,
    events,
    approvals,
    pilot,
    finished,
    runError,
    memory,
    memoryDir,
    driver,
    /** Everything the agent said it produced. */
    result: finished?.result ?? '',
    error: finished?.error ?? runError?.message ?? '',
    actions: pilot.actions,
    observations: pilot.observations,
    /** Read the live page directly, bypassing the agent, to check real DOM effects. */
    async pageText() {
      return await driver.evaluate('document.body ? document.body.innerText : ""');
    },
    async pageUrl() {
      return await driver.currentUrl();
    },
  };

  try {
    await scenario.assert(view);
  } catch (error) {
    // Carry the run's own evidence out with the assertion so `--debug` can print it.
    error.debug = {
      actions: view.actions,
      observations: view.observations,
      result: view.result,
      error: view.error,
    };
    throw error;
  } finally {
    try {
      driver.close();
    } catch {
      /* the socket may already be gone */
    }
    await site.close();
    await rm(memoryDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ─────────────────────────────── scenarios ─────────────────────────────── */

/** `done` with whatever the pilot has collected. */
const done = (summary) => ({ kind: 'done', success: true, summary });
const extract = (description) => ({ kind: 'extract', description });

/**
 * A pilot that navigates to `path`, extracts the page, and answers with what it read.
 * `readySignal` lets a scenario keep waiting until late content arrives.
 */
function readScenario({ name, path, factKey, extraSteps, timeoutMs, maxSteps }) {
  return {
    name,
    timeoutMs,
    maxSteps,
    task: (site) => `Open ${site.url}${path} and report the access code you find there.`,
    plan(view, state, step, site) {
      if (!state.navigated) {
        state.navigated = true;
        return { kind: 'navigate', url: `${site.url}${path}` };
      }
      const extraAction = extraSteps?.(view, state, step, site);
      if (extraAction) return extraAction;
      if (!state.extracted) {
        state.extracted = true;
        return extract('the access code shown on this page');
      }
      return done(state.text ?? view.raw);
    },
    assert(view) {
      const expected = view.site.facts[factKey];
      const everythingTheAgentSaw = view.observations.join('\n') + '\n' + view.result;
      assert.equal(view.finished?.status, 'done', `run did not succeed: ${view.error}`);
      assert.ok(
        everythingTheAgentSaw.includes(expected),
        `the agent never observed ${expected} through the browser`,
      );
    },
  };
}

const SCENARIOS = [
  /* 1 — the floor: a real navigation, a real extraction, a real per-boot fact. */
  readScenario({ name: 'basic-read', path: '/basic', factKey: 'basic' }),

  /* 2 — content that only exists after JS runs; the first observation must NOT contain it. */
  {
    ...readScenario({
      name: 'delayed-content',
      path: '/delayed',
      factKey: 'delayed',
      extraSteps: (view, state) => {
        if (!state.waited) {
          state.waited = true;
          return { kind: 'wait', ms: 1500 };
        }
        return undefined;
      },
    }),
    assert(view) {
      const expected = view.site.facts.delayed;
      assert.equal(view.finished?.status, 'done', `run did not succeed: ${view.error}`);
      const [first] = view.observations;
      assert.ok(
        !first.includes(expected),
        'the fixture is broken: the delayed fact was visible on the first observation',
      );
      assert.ok(
        view.observations.join('\n').includes(expected),
        'the agent never saw the delayed content after waiting',
      );
    },
  },

  /* 3 — infinite scroll: row 60 only renders after the reader reaches the bottom. */
  {
    name: 'infinite-scroll',
    maxSteps: 20,
    task: (site) => `Open ${site.url}/scroll, scroll to the end, and report the code in row 60.`,
    plan(view, state, step, site) {
      if (!state.navigated) {
        state.navigated = true;
        return { kind: 'navigate', url: `${site.url}/scroll` };
      }
      // Keep scrolling while the observation itself still reports content below. This is the signal
      // a real model would use, so a perception regression that stops reporting scroll extent fails
      // the scenario instead of quietly turning it into a fixed number of scrolls.
      if (view.raw.includes('(more below)') && (state.scrolls ?? 0) < 12) {
        state.scrolls = (state.scrolls ?? 0) + 1;
        return { kind: 'scroll', direction: 'down', amount: 1200 };
      }
      if (!state.extracted) {
        state.extracted = true;
        return extract('every row of the list');
      }
      return done('scrolled to the end');
    },
    assert(view) {
      assert.equal(view.finished?.status, 'done', `run did not succeed: ${view.error}`);
      assert.ok(
        view.observations.join('\n').includes(view.site.facts.deep),
        'scrolling never reached row 60 — the deep fact was never observed',
      );
    },
  },

  /* 4 — open shadow root: perception must cross the boundary. */
  {
    name: 'shadow-dom',
    task: (site) => `Open ${site.url}/shadow and report the access code.`,
    plan(view, state, step, site) {
      if (!state.navigated) {
        state.navigated = true;
        return { kind: 'navigate', url: `${site.url}/shadow` };
      }
      if (!state.checked) {
        state.checked = true;
        // Fails loudly if perception stops traversing open shadow roots.
        need(view, ['button'], 'Inner button', 'the button inside the open shadow root');
        return extract('the access code');
      }
      return done('read the shadow content');
    },
    assert(view) {
      assert.equal(view.finished?.status, 'done', `run did not succeed: ${view.error}`);
      assert.ok(
        view.observations.join('\n').includes(view.site.facts.shadow),
        'the agent never read text inside the open shadow root',
      );
    },
  },

  /* 5 — same-origin iframe. */
  readScenario({ name: 'same-origin-frame', path: '/frame', factKey: 'frame' }),

  /* 6 — consent overlay: a real click on a real overlay, then the content behind it. */
  {
    name: 'consent-overlay',
    task: (site) => `Open ${site.url}/consent, accept the privacy choices, and report the code.`,
    plan(view, state, step, site) {
      if (!state.navigated) {
        state.navigated = true;
        return { kind: 'navigate', url: `${site.url}/consent` };
      }
      if (!state.accepted) {
        state.accepted = true;
        const accept = need(view, ['button'], 'Accept all', 'the consent accept button');
        return { kind: 'click', id: accept.index };
      }
      if (!state.extracted) {
        state.extracted = true;
        return extract('the access code');
      }
      return done('accepted consent');
    },
    assert(view) {
      assert.equal(view.finished?.status, 'done', `run did not succeed: ${view.error}`);
      assert.ok(
        view.observations.join('\n').includes(view.site.facts.consent),
        'the consent click did not reveal the gated content',
      );
      // A click is commit-capable in EVERY autonomy mode (docs S2). It must have been approved.
      assert.ok(
        view.approvals.some((a) => a.kind === 'confirm' && a.action?.kind === 'click'),
        'the click was dispatched without a human approval prompt',
      );
    },
  },

  /* 7 — popup adoption + tab lifecycle. */
  {
    name: 'popup-adoption',
    maxSteps: 16,
    task: (site) => `Open ${site.url}/popup, open the report, and report its access code.`,
    plan(view, state, step, site) {
      if (!state.navigated) {
        state.navigated = true;
        return { kind: 'navigate', url: `${site.url}/popup` };
      }
      if (!state.opened) {
        state.opened = true;
        const link = need(view, ['link'], 'Open report', 'the target=_blank report link');
        return { kind: 'click', id: link.index };
      }
      if (!state.listed) {
        state.listed = true;
        return { kind: 'tab', operation: 'list' };
      }
      if (!state.extracted) {
        state.extracted = true;
        return extract('the access code on the report page');
      }
      return done('read the report tab');
    },
    assert(view) {
      assert.equal(view.finished?.status, 'done', `run did not succeed: ${view.error}`);
      assert.ok(
        view.observations.join('\n').includes(view.site.facts.popup),
        'the popup was never adopted — its content was never observed',
      );
    },
  },

  /* 8 — native <select>. */
  {
    name: 'native-select',
    task: (site) => `Open ${site.url}/controls, set the channel to gamma, and report the code.`,
    plan(view, state, step, site) {
      if (!state.navigated) {
        state.navigated = true;
        return { kind: 'navigate', url: `${site.url}/controls` };
      }
      if (!state.selected) {
        state.selected = true;
        const sel = need(view, ['combobox', 'listbox', 'select'], 'Channel', 'the native select');
        return { kind: 'select', id: sel.index, values: ['gamma'] };
      }
      if (!state.extracted) {
        state.extracted = true;
        return extract('the access code revealed by the channel selection');
      }
      return done('selected gamma');
    },
    assert(view) {
      assert.equal(view.finished?.status, 'done', `run did not succeed: ${view.error}`);
      assert.ok(
        view.observations.join('\n').includes(view.site.facts.select),
        'the native select never produced its change event',
      );
    },
  },

  /* 9 — a custom (non-<select>) ARIA combobox: click to open, click the option. */
  {
    name: 'custom-combobox',
    maxSteps: 16,
    task: (site) => `Open ${site.url}/controls, pick the delta tier, and report the code.`,
    plan(view, state, step, site) {
      if (!state.navigated) {
        state.navigated = true;
        return { kind: 'navigate', url: `${site.url}/controls` };
      }
      if (!state.opened) {
        state.opened = true;
        const trigger = need(view, ['combobox', 'button'], 'Pick a tier', 'the combobox trigger');
        return { kind: 'click', id: trigger.index };
      }
      if (!state.picked) {
        state.picked = true;
        const option = need(
          view,
          ['option', 'listitem', 'generic', 'li'],
          'delta',
          'the delta option',
        );
        return { kind: 'click', id: option.index };
      }
      if (!state.extracted) {
        state.extracted = true;
        return extract('the access code revealed by the tier choice');
      }
      return done('picked delta');
    },
    assert(view) {
      assert.equal(view.finished?.status, 'done', `run did not succeed: ${view.error}`);
      assert.ok(
        view.observations.join('\n').includes(view.site.facts.combobox),
        'the custom combobox option was never activated',
      );
    },
  },

  /* 10 — a control that is disabled until a checkbox enables it. */
  {
    name: 'gated-control',
    maxSteps: 16,
    task: (site) =>
      `Open ${site.url}/controls, agree to the terms, reveal the code, and report it.`,
    plan(view, state, step, site) {
      if (!state.navigated) {
        state.navigated = true;
        return { kind: 'navigate', url: `${site.url}/controls` };
      }
      if (!state.agreed) {
        state.agreed = true;
        const box = need(view, ['checkbox'], 'I agree', 'the terms checkbox');
        return { kind: 'click', id: box.index };
      }
      if (!state.revealed) {
        state.revealed = true;
        const go = need(view, ['button'], 'Reveal', 'the reveal button');
        assert.ok(
          !/\(disabled\)/.test(go.rest),
          'perception still reports the button as disabled after the checkbox was ticked',
        );
        return { kind: 'click', id: go.index };
      }
      if (!state.extracted) {
        state.extracted = true;
        return extract('the revealed access code');
      }
      return done('revealed the code');
    },
    assert(view) {
      assert.equal(view.finished?.status, 'done', `run did not succeed: ${view.error}`);
      assert.ok(
        view.observations.join('\n').includes(view.site.facts.gated),
        'the gated control never fired',
      );
    },
  },

  /* 11 — a multi-field POST that mints a server-side receipt. The strongest positive test:
     the receipt exists nowhere until a real form submit reaches a real server. */
  {
    name: 'form-post-receipt',
    maxSteps: 20,
    task: (site) =>
      `Open ${site.url}/form, order 3 pro units for Dana Vance, and report the receipt.`,
    plan(view, state, step, site) {
      if (!state.navigated) {
        state.navigated = true;
        return { kind: 'navigate', url: `${site.url}/form` };
      }
      if (!state.name) {
        state.name = true;
        return { kind: 'type', id: need(view, ['textbox'], 'Full name').index, text: 'Dana Vance' };
      }
      if (!state.qty) {
        state.qty = true;
        return { kind: 'type', id: need(view, ['textbox'], 'Quantity').index, text: '3' };
      }
      if (!state.tier) {
        state.tier = true;
        const tier = need(view, ['combobox', 'listbox', 'select'], 'Tier');
        return { kind: 'select', id: tier.index, values: ['pro'] };
      }
      if (!state.tos) {
        state.tos = true;
        return { kind: 'click', id: need(view, ['checkbox'], 'Accept terms').index };
      }
      if (!state.submitted) {
        state.submitted = true;
        return { kind: 'click', id: need(view, ['button'], 'Place order').index };
      }
      if (!state.extracted) {
        state.extracted = true;
        return extract('the receipt number');
      }
      return done('order placed');
    },
    async assert(view) {
      assert.equal(view.finished?.status, 'done', `run did not succeed: ${view.error}`);
      assert.equal(view.site.submissions.length, 1, 'expected exactly one real POST');
      const submission = view.site.submissions[0];
      assert.equal(submission.name, 'Dana Vance', 'the typed name did not reach the server');
      assert.equal(submission.qty, '3', 'the typed quantity did not reach the server');
      assert.equal(submission.tier, 'pro', 'the selected tier did not reach the server');
      assert.equal(submission.tos, 'yes', 'the checkbox never became checked');
      assert.ok(
        view.observations.join('\n').includes(submission.receipt),
        'the agent never observed the receipt the server minted',
      );
    },
  },

  /* 12 — the safety twin of 11: the human rejects the submit. NOTHING may reach the server. */
  {
    name: 'commit-rejected',
    maxSteps: 20,
    approve: ({ action }) =>
      action?.kind === 'click' && action.id !== undefined ? 'no' : 'approve',
    task: (site) =>
      `Open ${site.url}/form, order 1 standard unit for Kai Ito, and report the receipt.`,
    plan(view, state, step, site) {
      if (!state.navigated) {
        state.navigated = true;
        return { kind: 'navigate', url: `${site.url}/form` };
      }
      if (!state.name) {
        state.name = true;
        return { kind: 'type', id: need(view, ['textbox'], 'Full name').index, text: 'Kai Ito' };
      }
      if (!state.submitted) {
        state.submitted = true;
        return { kind: 'click', id: need(view, ['button'], 'Place order').index };
      }
      return done('the submit was rejected by the human');
    },
    assert(view) {
      assert.equal(
        view.site.submissions.length,
        0,
        'a REJECTED approval still produced a real POST — the commit gate does not hold',
      );
      assert.ok(
        view.site.hits.every((hit) => !hit.startsWith('POST')),
        `the server saw a mutating request after rejection: ${view.site.hits.join(', ')}`,
      );
      assert.ok(
        view.approvals.some((a) => a.kind === 'confirm'),
        'no approval was requested for a form submit click',
      );
    },
  },

  /* 13 — private-network policy: without the explicit opt-in, the loopback fixture is refused. */
  {
    name: 'private-network-denied',
    allowPrivateNetwork: false,
    maxSteps: 4,
    task: (site) => `Open ${site.url}/basic and report the access code.`,
    plan(view, state, step, site) {
      if (!state.navigated) {
        state.navigated = true;
        return { kind: 'navigate', url: `${site.url}/basic` };
      }
      return done('navigation was refused');
    },
    assert(view) {
      assert.deepEqual(
        view.site.hits,
        [],
        `a private destination was fetched without allowPrivateNetwork: ${view.site.hits.join(', ')}`,
      );
      assert.ok(
        !view.observations.join('\n').includes(view.site.facts.basic),
        'the blocked page still reached the model',
      );
    },
  },

  /* 14 — a page far past the perception element cap. Truncation must be honest and `extract`
     must still be able to read what the element list dropped. */
  {
    name: 'dense-truncation',
    maxSteps: 10,
    task: (site) => `Open ${site.url}/dense and report the tail marker.`,
    plan(view, state, step, site) {
      if (!state.navigated) {
        state.navigated = true;
        return { kind: 'navigate', url: `${site.url}/dense` };
      }
      if (!state.extracted) {
        state.extracted = true;
        return extract('the tail marker at the bottom of the page');
      }
      return done('read the dense page');
    },
    assert(view) {
      assert.equal(view.finished?.status, 'done', `run did not succeed: ${view.error}`);
      const seen = view.observations.join('\n');
      assert.match(
        seen,
        /more element\(s\) not shown/,
        'a 400-control page did not report truncation — the model would think it saw everything',
      );
      assert.ok(
        seen.includes(`tail marker ${view.site.nonce}`),
        'extract could not reach content the element list truncated away',
      );
    },
  },

  /* 15 — the time-of-check/time-of-use guard. The page swaps the two buttons while the "model" is
     deciding, so the coordinate the chosen element was measured at now holds a DIFFERENT control.
     Dispatching there would activate something the agent never chose — the exact wrong-click that
     reports success. The run must refuse instead. */
  {
    name: 'stale-target-refused',
    maxSteps: 8,
    task: (site) => `Open ${site.url}/swap and click "Keep this one".`,
    async plan(view, state, step, site, driver) {
      if (!state.navigated) {
        state.navigated = true;
        return { kind: 'navigate', url: `${site.url}/swap` };
      }
      if (!state.clicked) {
        state.clicked = true;
        const keep = need(view, ['button'], 'Keep this one', 'the Keep button');
        // Between the observation above and the dispatch below — precisely where a real page would
        // reflow behind a slow model call.
        await driver.evaluate('window.__swap()');
        return { kind: 'click', id: keep.index };
      }
      return done('finished');
    },
    async assert(view) {
      const text = await view.pageText();
      assert.ok(
        !text.includes('clicked:alpha'),
        'the click activated the control that moved under the coordinate — the pre-dispatch target ' +
          'check did not hold',
      );
      const everything = `${view.observations.join('\n')}\n${view.result}\n${view.error}`;
      // Two independent guards can catch this: the approval binding (the approved page/target
      // fingerprint no longer matches) and the executor's pre-dispatch point check. Either is a
      // correct refusal; silence is not.
      assert.match(
        everything,
        /the page moved|approved target changed/i,
        'the drifted target was neither clicked nor reported — the agent must say why it refused',
      );
    },
  },

  /* 16 — a native dialog blocks the renderer. The run must SAY so, not hang or report an empty page. */
  {
    name: 'native-dialog',
    maxSteps: 6,
    timeoutMs: 120_000,
    task: (site) => `Open ${site.url}/dialog and report what you find.`,
    plan(view, state, step, site) {
      if (!state.navigated) {
        state.navigated = true;
        return { kind: 'navigate', url: `${site.url}/dialog` };
      }
      if (!state.extracted) {
        state.extracted = true;
        return extract('the page content');
      }
      return done(view.raw.slice(0, 400));
    },
    assert(view) {
      const everything = `${view.observations.join('\n')}\n${view.result}\n${view.error}`;
      assert.match(
        everything,
        /native browser dialog|not responding/i,
        'a blocking native dialog must be named as the cause, not reported as an empty page',
      );
      // A page the agent cannot read is not an unresolved external effect: navigating to one commits
      // nothing outside the browser. Ending the run as an ambiguous write would leave the journal
      // recovery-required and refuse every later run on this profile — one `alert()` would disable
      // the agent for that profile permanently.
      assert.doesNotMatch(
        view.error,
        /ambiguous|recovery is required/i,
        'a blocking dialog must not be recorded as a possibly-dispatched write',
      );
      // Discovering it must not cost the whole run either: every call against a blocked renderer
      // waits out a timeout, so without the liveness bound one `alert()` buys minutes of silence.
      // The bound is loose because it is guarding against the unbounded case, not benchmarking.
      const elapsed = view.events.length
        ? Date.parse(view.events[view.events.length - 1].ts) - Date.parse(view.events[0].ts)
        : 0;
      assert.ok(
        elapsed < 120_000,
        `took ${Math.round(elapsed / 1000)}s to report a blocking dialog; the renderer-liveness ` +
          'bound is not being applied',
      );
    },
  },

  /* 17 — remember on one page, recall on another page of the same host. */
  {
    name: 'memory-recall',
    maxSteps: 14,
    task: (site) => `Open ${site.url}/recall, save the code you find, and confirm it is saved.`,
    plan(view, state, step, site) {
      if (!state.navigated) {
        state.navigated = true;
        return { kind: 'navigate', url: `${site.url}/recall` };
      }
      if (!state.extracted) {
        state.extracted = true;
        return extract('the saved code');
      }
      if (!state.remembered) {
        state.remembered = true;
        const code = /RECALL-[0-9A-F]+/.exec(view.raw)?.[0];
        assert.ok(code, 'never observed the recall fact to remember');
        state.code = code;
        return { kind: 'remember', factKey: 'access code', factValue: code };
      }
      return done(`saved ${state.code}`);
    },
    async assert(view) {
      assert.equal(view.finished?.status, 'done', `run did not succeed: ${view.error}`);
      // Read it back the way the NEXT run would: the durable per-domain context block. That proves
      // recall, not merely that a file was written.
      const context = await view.memory.loadContext('127.0.0.1', 'what is the saved code');
      assert.ok(
        context.includes(view.site.facts.recall),
        `the remembered fact is not recalled for the host: ${String(context).slice(0, 400)}`,
      );
      // A durable memory write is commit-capable and must have been approved.
      assert.ok(
        view.approvals.some((a) => a.action?.kind === 'remember'),
        'a durable memory write happened without approval',
      );
    },
  },

  /* 18 — back navigation across two real documents. */
  {
    name: 'back-navigation',
    maxSteps: 12,
    task: (site) => `Open ${site.url}/basic, then ${site.url}/recall, then go back.`,
    plan(view, state, step, site) {
      if (!state.first) {
        state.first = true;
        return { kind: 'navigate', url: `${site.url}/basic` };
      }
      if (!state.second) {
        state.second = true;
        return { kind: 'navigate', url: `${site.url}/recall` };
      }
      if (!state.back) {
        state.back = true;
        return { kind: 'back' };
      }
      return done(`back at ${view.url}`);
    },
    async assert(view) {
      assert.equal(view.finished?.status, 'done', `run did not succeed: ${view.error}`);
      const url = await view.pageUrl();
      assert.match(url, /\/basic$/, `back did not return to the previous document (at ${url})`);
    },
  },

  /* 19 — tab lifecycle driven explicitly. */
  {
    name: 'tab-lifecycle',
    maxSteps: 14,
    task: (site) => `Open a second tab on ${site.url}/basic, then close it.`,
    plan(view, state, step, site) {
      if (!state.opened) {
        state.opened = true;
        return { kind: 'tab', operation: 'new', url: `${site.url}/basic` };
      }
      if (!state.listed) {
        state.listed = true;
        return { kind: 'tab', operation: 'list' };
      }
      if (!state.closed) {
        state.closed = true;
        state.listing = view.raw;
        return { kind: 'tab', operation: 'close', index: 0 };
      }
      return done('tab lifecycle complete');
    },
    assert(view) {
      assert.equal(view.finished?.status, 'done', `run did not succeed: ${view.error}`);
      assert.ok(
        view.observations.join('\n').includes('/basic'),
        'the new tab never appeared in a tab listing',
      );
    },
  },
];

/* ─────────────────────────── automation-tell probe ─────────────────────────── */

/**
 * The runtime half of `stealth-invariant.test.ts`, which can only read source.
 *
 * Snapshot the page-observable automation surface BEFORE the driver ever attaches, then again after
 * a full agent run has driven the same browser. Any field that changed is a tell the agent itself
 * introduced — exactly what the product promises never to do.
 */
const TELL_PROBE = `(() => JSON.stringify({
  webdriver: navigator.webdriver === true,
  cdcKeys: Object.keys(window).filter((k) => /^(cdc_|\\$cdc)/.test(k)).length,
  permissionsBroken: typeof navigator.permissions === 'undefined',
  pluginCount: navigator.plugins.length,
  languages: navigator.languages.join(','),
  hasChrome: typeof window.chrome === 'object',
  stackDepthTell: (() => { try { null.x; } catch (e) { return /puppeteer|playwright|devtools/i.test(String(e.stack)); } return false; })(),
}))()`;

async function probeTells(ws) {
  // Probe a tab this run creates, never whatever tab is currently first. The dialog scenario
  // deliberately leaves a renderer blocked by an un-dismissable `alert()`, and `resolveCdpTarget`
  // picks the first page target — so probing "the browser" would hang on that wedged tab and report
  // an infrastructure timeout as a stealth regression.
  const driver = await CdpBrowserDriver.create(ws);
  try {
    await driver.newTab('about:blank');
    return JSON.parse(await driver.evaluate(TELL_PROBE));
  } finally {
    try {
      driver.close();
    } catch {
      /* already gone */
    }
  }
}

/* ─────────────────────────────── main ─────────────────────────────── */

async function main() {
  const engine = resolveEngine();
  if (!engine) {
    console.error(
      'BLOCKED: no browser engine provisioned. Set LOBSTER_LOBIUM_BIN (Gate B) or ' +
        'LOBSTER_E2E_CHROMIUM / install a Chromium (browser-integration evidence).',
    );
    process.exit(2);
  }
  console.log(`engine: ${engine.kind} — ${engine.bin}`);
  if (engine.kind !== 'lobium') {
    console.log(
      'NOTE: interim engine. This run is browser-integration evidence for the agent stack, ' +
        'NOT a Gate B pass and NOT fingerprint evidence.',
    );
  }

  const browser = await launchEngine({ bin: engine.bin, headless: !HEADFUL });
  const selected = SCENARIOS.filter((s) => !only || only.includes(s.name));
  const results = [];
  let tellsBefore;
  try {
    tellsBefore = await probeTells(browser.ws);
    for (const scenario of selected) {
      const started = Date.now();
      process.stdout.write(`• ${scenario.name} … `);
      try {
        await runScenario(scenario, { ws: browser.ws });
        const ms = Date.now() - started;
        results.push({ name: scenario.name, ok: true, ms });
        console.log(`PASS (${ms}ms)`);
      } catch (error) {
        const ms = Date.now() - started;
        results.push({
          name: scenario.name,
          ok: false,
          ms,
          error: String(error?.message ?? error),
        });
        console.log(
          `FAIL (${ms}ms)\n    ${String(error?.message ?? error)
            .split('\n')
            .join('\n    ')}`,
        );
        // A failing browser scenario is nearly impossible to diagnose from the assertion alone: the
        // question is always "what did the agent actually see, and what did it do about it?".
        if (DEBUG && error?.debug) {
          console.log(`    ── actions ──\n    ${JSON.stringify(error.debug.actions)}`);
          for (const [index, text] of error.debug.observations.entries()) {
            console.log(
              `    ── observation ${index + 1} ──\n    ${text.split('\n').join('\n    ')}`,
            );
          }
          console.log(`    ── result: ${error.debug.result}\n    ── error: ${error.debug.error}`);
        }
        if (!KEEP_GOING) break;
      }
    }

    const tellsAfter = await probeTells(browser.ws);
    const changed = Object.keys(tellsAfter).filter(
      (key) => JSON.stringify(tellsAfter[key]) !== JSON.stringify(tellsBefore[key]),
    );
    if (changed.length) {
      results.push({
        name: 'automation-tell-invariant',
        ok: false,
        ms: 0,
        error: `driving the browser changed observable automation surfaces: ${changed
          .map((k) => `${k}: ${JSON.stringify(tellsBefore[k])} → ${JSON.stringify(tellsAfter[k])}`)
          .join('; ')}`,
      });
      console.log(`• automation-tell-invariant … FAIL\n    changed: ${changed.join(', ')}`);
    } else {
      results.push({ name: 'automation-tell-invariant', ok: true, ms: 0 });
      console.log('• automation-tell-invariant … PASS (no new page-observable surface)');
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  const report = {
    engine: engine.kind,
    engineBin: engine.bin,
    startedAt: new Date().toISOString(),
    tellsBefore,
    total: results.length,
    passed: results.length - failed.length,
    results,
  };
  const reportPath = join(
    new URL('.', import.meta.url).pathname,
    '..',
    'reports',
    `agent-browser-e2e-${Date.now()}.json`,
  );
  await writeFile(reportPath, JSON.stringify(report, null, 2)).catch(() => {});

  console.log(
    `\n${report.passed}/${report.total} scenarios passed on the ${engine.kind} engine` +
      (failed.length ? `\nfailed: ${failed.map((f) => f.name).join(', ')}` : ''),
  );
  process.exit(failed.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
