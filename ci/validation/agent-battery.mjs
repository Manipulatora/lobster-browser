#!/usr/bin/env node
// LIVE agent capability battery — does Lobee actually complete real web tasks?
//
// The agent's unit tests all drive a FakeDriver: they prove the loop's control flow but cannot see a
// perception or extraction bug, because the fake page always answers. Every defect found in the loop
// so far that MATTERED was invisible to them — an extractor that returned one item from a product
// grid, a scroll unit the model could not learn, a conversation the model could not advance after a
// prose reply. This runs the real sidecar, the real browser and a real model against a spread of site
// archetypes, and grades the outcome.
//
//   node ci/validation/agent-battery.mjs                  # all tasks
//   node ci/validation/agent-battery.mjs pagination login  # only matching ids
//
// Requires: a built Lobium binary, and a managed LLM proxy (LOBSTER_AGENT_PROXY_URL/TOKEN) or the
// local dev proxy env file. Skips cleanly (exit 2) when neither is present, matching the house rule
// that environmental limits are reported, never failed.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { resolveLobiumBinary } from '@lobster/engine-runner';
import { startFixtureServer } from './agent-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LOBIUM = resolveLobiumBinary();
const MODEL = process.env.AGENT_BATTERY_MODEL || 'anthropic/claude-sonnet-5';

/**
 * The battery. Each entry names ONE capability a general-purpose web agent must have; the sites are
 * purpose-built scraping sandboxes (toscrape.com) plus httpbin, so hammering them is intended use.
 *
 * `expect` grades the FINAL result text. Keep it to facts that can only be known by actually doing the
 * task — a task that can be satisfied from the model's own knowledge grades nothing.
 */
const TASKS = [
  {
    id: 'answer-no-browser',
    why: 'a knowledge question must not open a browser at all',
    task: 'What is 17 multiplied by 23? Reply with just the number.',
    maxSteps: 3,
    expect: /391/,
    assert: (ev) =>
      ev.some((e) => e.type === 'run.needsBrowser') ? 'opened a browser it did not need' : '',
  },
  {
    id: 'extract-grid',
    why: 'read a product grid — the archetype that exposed the <article> scoping bug',
    task: 'Go to https://books.toscrape.com/ and collect the title and price of the first 5 books, then finish.',
    maxSteps: 10,
    expect: /A Light in the Attic[\s\S]*51\.77/i,
  },
  {
    id: 'pagination',
    why: 'collect across multiple pages and keep the dataset coherent',
    task: 'Go to http://quotes.toscrape.com/ and collect the author of every quote on page 1 AND page 2 (use the Next button). Then finish.',
    maxSteps: 14,
    expect: /Einstein[\s\S]*(Rowling|Austen|Marilyn|Dahl)/i,
  },
  {
    id: 'js-rendered',
    why: 'content written by JavaScript after load, not present in the HTML source',
    task: 'Go to http://quotes.toscrape.com/js/ and tell me the author of the very first quote on the page.',
    maxSteps: 8,
    expect: /Einstein/i,
  },
  {
    id: 'js-delayed',
    why: 'content that appears only after a timer — the agent must wait, not give up',
    task: 'Go to http://quotes.toscrape.com/js-delayed/ and tell me the author of the first quote. The page loads its content after a short delay.',
    maxSteps: 10,
    expect: /Einstein/i,
  },
  {
    id: 'infinite-scroll',
    why: 'AJAX-on-scroll: more items exist only after scrolling',
    task: 'Go to http://quotes.toscrape.com/scroll and scroll down until at least 30 quotes have loaded, then tell me approximately how many quotes are on the page.',
    maxSteps: 14,
    expect: /\b(3\d|4\d|5\d|6\d|7\d|8\d|9\d|100)\b/,
  },
  {
    id: 'login-form',
    why: 'fill a real login form and confirm the authenticated state',
    task: 'Go to http://quotes.toscrape.com/login and log in with username "lobee" and password "lobee123". Then tell me whether you are logged in — the page shows a Logout link when you are.',
    maxSteps: 12,
    expect: /logged in|logout|success/i,
  },
  {
    id: 'select-and-submit',
    why: 'operate native <select> dropdowns and submit a filter form',
    task: 'Go to http://quotes.toscrape.com/search.aspx, choose author "Albert Einstein" and tag "world" in the dropdowns, submit the search, and tell me the text of the quote that comes back.',
    maxSteps: 14,
    expect: /world|insanity|think/i,
  },
  {
    id: 'table-layout',
    why: 'data laid out in a table — row/column relationships must survive extraction',
    task: 'Go to http://quotes.toscrape.com/tableful/ and tell me the author of the first quote listed.',
    maxSteps: 10,
    expect: /Einstein/i,
  },
  {
    id: 'form-post',
    why: 'fill a multi-field form with text, radio and checkbox inputs, then submit',
    task: 'Go to https://httpbin.org/forms/post, enter customer name "Lobee Test", telephone "5550100", email "lobee@example.com", choose the Medium size, tick the "cheese" topping, then submit the order. Report exactly what the resulting page shows for custname and size.',
    maxSteps: 16,
    expect: /Lobee Test[\s\S]*medium|medium[\s\S]*Lobee Test/i,
  },
  {
    id: 'multi-tab',
    why: 'open a link in a second tab, read it, and come back',
    task: 'Go to http://quotes.toscrape.com/. Open the "About" page for the author of the first quote in a NEW TAB, read that author\'s date of birth from it, then close that tab and report the date of birth.',
    maxSteps: 16,
    expect: /(March|1879)/i,
  },
  {
    id: 'blocked-honest',
    why: 'a hard denial must escalate and end honestly, not burn the budget',
    task: 'Open http://127.0.0.1:9999/admin-panel and report what it says. Keep trying until you succeed.',
    maxSteps: 14,
    expect: /block|refus|cannot|could not|unable/i,
    wantSuccess: false,
  },
  // ---- Pathological fixtures (loopback, deterministic) ----------------------------------------
  {
    id: 'shadow-dom',
    why: 'content inside an open shadow root must be perceivable and clickable',
    local: true,
    task: 'Open {ORIGIN}/shadow. Click the "Reveal reference" button and report the reference code it shows.',
    maxSteps: 10,
    expect: /ZQ-8831/,
  },
  {
    id: 'custom-combobox',
    why: 'a div/role=listbox dropdown — the native select path cannot drive it',
    local: true,
    task: 'Open {ORIGIN}/combobox. Choose the region "Copper Basin" from the dropdown and report the allocation code that appears.',
    maxSteps: 12,
    expect: /CB-2290/,
  },
  {
    id: 'consent-wall',
    why: 'an overlay hides the answer until it is dismissed',
    local: true,
    task: 'Open {ORIGIN}/consent and tell me the Q3 net revenue figure.',
    maxSteps: 10,
    expect: /4[,.]?182[,.]?900/,
  },
  {
    id: 'dense-index',
    why: '400 links: priority-ordered truncation must not permanently hide the target',
    local: true,
    task: 'Open {ORIGIN}/dense. One record in the list has a clearance token next to it. Find it and report the token.',
    maxSteps: 16,
    expect: /QT-5566/,
  },
  {
    id: 'same-origin-iframe',
    why: 'a readable iframe must be descended into, not reported as unreadable',
    local: true,
    task: 'Open {ORIGIN}/iframe and report the settlement identifier shown on the page.',
    maxSteps: 10,
    expect: /SX-7742/,
  },
  {
    id: 'late-content',
    why: 'the value changes twice — reporting the interim one is a grounding failure',
    local: true,
    task: 'Open {ORIGIN}/lazy and report the FINAL balance once the page has finished updating.',
    maxSteps: 12,
    expect: /9[,.]?314/,
  },
  {
    id: 'gated-control',
    why: 'a disabled button enables only after another field is used — requires re-observation',
    local: true,
    task: 'Open {ORIGIN}/gated. Type the unlock word "lobee" into the field, then press Continue, and report the vault number.',
    maxSteps: 12,
    expect: /VN-6120/,
  },
  // ---- Messy real sites ------------------------------------------------------------------------
  {
    id: 'dense-real-list',
    why: 'a real element-dense list page (30 stories, ~120 links)',
    task: 'Go to https://news.ycombinator.com/ and tell me the title of the very top story and how many points it has.',
    maxSteps: 12,
    // The front page changes constantly, so grade the SHAPE of a real reading: a score adjacent to the
    // word points. `/point/i` alone passed on the word appearing anywhere, including in an apology.
    expect: (text) => /\b\d{1,4}\s*points?\b/i.test(text),
  },
  {
    id: 'long-article',
    why: 'a very long article — find one specific fact inside it',
    task: 'Go to https://en.wikipedia.org/wiki/Web_scraping and tell me, in one sentence, what the "robots.txt" file is used for according to that page.',
    maxSteps: 12,
    // Require BOTH halves of the concept — who it addresses and what it controls — so a single
    // incidental keyword cannot pass.
    expect: (text) => /robot|crawl|bot|spider/i.test(text) && /allow|disallow|exclu|access|permission|polic|instruct/i.test(text),
  },
];

const selected = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const battery = selected.length
  ? TASKS.filter((t) => selected.some((s) => t.id.includes(s)))
  : TASKS;

function loadProxy() {
  const url = process.env.LOBSTER_AGENT_PROXY_URL;
  const token = process.env.LOBSTER_AGENT_PROXY_TOKEN;
  if (url && token) return { url, token };
  // Dev fallback: the local proxy's env file.
  try {
    const raw = readFileSync(join(homedir(), '.config/lobster-agent-proxy.env'), 'utf8');
    const env = Object.fromEntries(
      raw
        .split('\n')
        .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    );
    if (env.AGENT_PROXY_TOKEN) {
      return {
        url: `http://127.0.0.1:${env.PORT || 8790}/agent/llm`,
        token: env.AGENT_PROXY_TOKEN,
      };
    }
  } catch {
    /* fall through to skip */
  }
  return null;
}

if (!LOBIUM) {
  console.log('AGENT BATTERY: SKIPPED — no Lobium binary (set LOBSTER_LOBIUM_BIN).');
  process.exit(2);
}
const proxy = loadProxy();
if (!proxy) {
  console.log('AGENT BATTERY: SKIPPED — no managed LLM proxy (set LOBSTER_AGENT_PROXY_URL/TOKEN).');
  process.exit(2);
}

// Loopback fixture server for the pathological pages. Started only when a selected task needs it.
const needsFixtures = battery.some((t) => t.local);
const fixtures = needsFixtures ? await startFixtureServer() : null;

const root = await mkdtemp(join(tmpdir(), 'agent-battery-'));
const sidecar = spawn('node', [join(REPO, 'packages/engine-runner/dist/index.js')], {
  cwd: REPO,
  env: {
    ...process.env,
    LOBSTER_LOBIUM_BIN: LOBIUM,
    LOBSTER_FONTS_DIR: process.env.LOBSTER_FONTS_DIR || join(REPO, 'lobium/fonts'),
    LOBSTER_LOBEE_DIR: process.env.LOBSTER_LOBEE_DIR || join(REPO, 'packages/lobee'),
    LOBSTER_NO_SANDBOX: '1',
    LOBSTER_AGENT_PROXY_URL: proxy.url,
    LOBSTER_AGENT_PROXY_TOKEN: proxy.token,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const sidecarErrors = [];
sidecar.stderr.on('data', (d) => {
  const line = String(d).trim();
  if (line && !/^\[lobee-bridge\]/.test(line)) sidecarErrors.push(line);
});

let nextId = 1;
const pending = new Map();
let events = [];
let buffer = '';
sidecar.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.notify === 'agent') {
      events.push(msg.event);
      continue;
    }
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});

const call = (method, params) =>
  new Promise((resolve) => {
    const id = String(nextId++);
    pending.set(id, resolve);
    sidecar.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
try {
  const profileId = 'battery';
  // ONE memory key and directory for the WHOLE battery. Minting a fresh key per task meant every run
  // started with an unreadable store, so nothing the agent remembered could ever be recalled — the
  // memory system was structurally untestable by its own test.
  const memoryDir = join(root, 'agent');
  const memoryKey = randomBytes(32).toString('base64');
  const started = await call('startProfile', {
    profileId,
    profileName: 'Battery',
    engine: 'lobium',
    os: 'linux',
    fingerprintSeed: randomBytes(16).toString('hex'),
    userDataDir: join(root, 'profile'),
    agentMemoryKey: randomBytes(32).toString('base64'),
  });
  if (!started.ok) throw new Error(`startProfile failed: ${JSON.stringify(started.error)}`);

  for (const t of battery) {
    events = [];
    const began = Date.now();
    const taskText = t.local ? t.task.replaceAll('{ORIGIN}', fixtures.origin) : t.task;
    const res = await call('agent.start', {
      profileId,
      task: taskText,
      memoryDir,
      memoryKey,
      threadId: `battery-${t.id}`,
      llm: {
        provider: 'openrouter',
        managed: true,
        model: MODEL,
        baseUrl: proxy.url,
        apiKey: proxy.token,
      },
      // Loopback is blocked by default (SSRF guard); the fixture tasks are the only ones allowed it.
      config: {
        mode: 'agent',
        maxSteps: t.maxSteps,
        visionFallback: true,
        ...(t.local ? { allowPrivateNetwork: true } : {}),
      },
    });
    if (!res.ok) {
      results.push({ ...t, verdict: 'FAIL', why: `start rejected: ${JSON.stringify(res.error)}` });
      continue;
    }
    let finished;
    for (let i = 0; i < 400 && !finished; i += 1) {
      await wait(1000);
      finished = events.find((e) => e.type === 'run.finished');
      const status = (await call('agent.status', { profileId })).result?.runs?.[0];
      if (status?.status === 'awaiting_input')
        await call('agent.sendInput', { profileId, text: 'reject' });
    }

    const text = `${finished?.result ?? ''}\n${finished?.error ?? ''}`;
    const steps = Math.max(
      0,
      ...events.filter((e) => e.type === 'step.action').map((e) => e.step ?? 0),
    );
    const usage = events.filter((e) => e.type === 'usage').map((e) => e.usage ?? {});
    const tokensIn = usage.reduce((n, u) => n + (u.tokensIn ?? 0), 0);
    const cached = usage.reduce((n, u) => n + (u.cachedTokensIn ?? 0), 0);
    const wantSuccess = t.wantSuccess !== false;
    const ok =
      finished?.status === (wantSuccess ? 'done' : 'error') ||
      (!wantSuccess && finished?.status === 'stopped');
    const matched = typeof t.expect === 'function' ? t.expect(text) : t.expect.test(text);
    const extra = t.assert?.(events) ?? '';
    const verdict = !finished ? 'TIMEOUT' : extra ? 'FAIL' : ok && matched ? 'PASS' : 'FAIL';

    results.push({
      ...t,
      verdict,
      steps,
      seconds: Math.round((Date.now() - began) / 1000),
      cachePct: tokensIn ? Math.round((cached / tokensIn) * 100) : 0,
      status: finished?.status ?? 'timeout',
      detail:
        extra ||
        (!ok ? `status=${finished?.status}` : !matched ? 'result did not match expectation' : ''),
      text: text.trim().slice(0, 300),
    });
    const r = results.at(-1);
    console.log(
      `${r.verdict.padEnd(7)} ${r.id.padEnd(20)} ${String(r.steps).padStart(2)} steps ` +
        `${String(r.seconds).padStart(3)}s cache=${String(r.cachePct).padStart(3)}%  ${r.detail}`,
    );
  }

  await call('stop', { profileId });
} finally {
  sidecar.stdin.end();
  await wait(1000);
  sidecar.kill('SIGKILL');
  fixtures?.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => r.verdict !== 'PASS');
console.log(`\n${'='.repeat(78)}`);
for (const r of failed) {
  console.log(
    `\n${r.verdict} ${r.id} — ${r.why}\n  task: ${r.task}\n  got:  ${r.text || '(nothing)'}`,
  );
}
if (sidecarErrors.length) {
  console.log(`\nsidecar stderr (${sidecarErrors.length} lines):`);
  for (const line of sidecarErrors.slice(-8)) console.log(`  ${line}`);
}
console.log(
  `\nAGENT BATTERY: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`,
);
process.exit(failed.length === 0 ? 0 : 1);
