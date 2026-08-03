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
import { TASKS } from './agent-battery-tasks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LOBIUM = resolveLobiumBinary();
const MODEL = process.env.AGENT_BATTERY_MODEL || 'anthropic/claude-sonnet-5';

const argv = process.argv.slice(2);
/**
 * Repeat every task N times and require ALL runs to pass.
 *
 * A single trial proves very little about a stochastic system: the same task has finished in 4 steps
 * and in 16. One green run is an anecdote; `--repeat 3` is the cheapest thing that turns it into
 * evidence, and it is what catches a task that passes half the time.
 */
const repeat = Math.max(
  1,
  Number(/^--repeat=(\d+)$/.exec(argv.find((a) => a.startsWith('--repeat=')) ?? '')?.[1] ?? 1),
);
const selected = argv.filter((a) => !a.startsWith('-'));
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

  /** True once a provider/billing failure makes every further result meaningless. */
  let blocked = '';

  for (const t of battery) {
    const attempts = [];
    // `memory-recall` depends on `memory-write` having run, so an ordered pair must not be interleaved
    // by repetition; everything else repeats to expose a task that only passes sometimes.
    const runs = t.id.startsWith('memory-') ? 1 : repeat;
    for (let attempt = 1; attempt <= runs && !blocked; attempt += 1) {
      events = [];
      const began = Date.now();
      let confirmsSeen = 0;
      // Facts derived from the live page BEFORE the agent runs, so the grader knows the real answer.
      let facts;
      if (t.derive) {
        try {
          facts = await t.derive();
        } catch (error) {
          attempts.push({
            verdict: 'BLOCKED',
            detail: `could not derive expected facts: ${error.message}`,
          });
          continue;
        }
      }
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
        attempts.push({ verdict: 'FAIL', detail: `start rejected: ${JSON.stringify(res.error)}` });
        continue;
      }
      let finished;
      for (let i = 0; i < 400 && !finished; i += 1) {
        await wait(1000);
        finished = events.find((e) => e.type === 'run.finished');
        const status = (await call('agent.status', { profileId })).result?.runs?.[0];
        if (status?.status === 'awaiting_input') {
          // Stand in for an attentive human. Capability tasks need approval to proceed; a task that is
          // TESTING the confirm gate sets `rejectConfirms` so the refusal itself is what gets graded.
          confirmsSeen += 1;
          await call('agent.sendInput', {
            profileId,
            text: t.rejectConfirms ? 'reject' : 'approve',
          });
        }
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
      const matched = typeof t.expect === 'function' ? t.expect(text, facts) : t.expect.test(text);
      const extra = t.assert?.(events, { confirmsSeen }) ?? '';
      // A billing/credential failure says NOTHING about the agent. Reporting it as FAIL produced a
      // "0/21" that read as catastrophic when it was an empty wallet — twice. It is its own verdict,
      // and it stops the run rather than manufacturing 20 more meaningless failures.
      //
      // Matched against the ERROR field only, and only on a failed run: a task whose ANSWER happens to
      // mention a rate limit (an agent reporting what a site told it) must not be mistaken for one.
      const providerFailure = finished?.status === 'error' ? (finished.error ?? '') : '';
      if (
        /run out of credit|spend limit|credential was rejected|rate-limiting/i.test(providerFailure)
      ) {
        blocked = providerFailure.trim().slice(0, 200);
        attempts.push({ verdict: 'BLOCKED', detail: blocked });
        continue;
      }
      const verdict = !finished ? 'TIMEOUT' : extra ? 'FAIL' : ok && matched ? 'PASS' : 'FAIL';
      attempts.push({
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
      const r = attempts.at(-1);
      console.log(
        `  ${r.verdict.padEnd(7)} ${t.id.padEnd(20)} ${String(r.steps ?? 0).padStart(2)} steps ` +
          `${String(r.seconds ?? 0).padStart(3)}s cache=${String(r.cachePct ?? 0).padStart(3)}%  ${r.detail ?? ''}`,
      );
    }

    // ALL attempts must pass. A task that is green two times in three is a flaky task, and reporting
    // it as PASS is how a real intermittent regression stays invisible.
    const worst =
      attempts.find((a) => a.verdict === 'BLOCKED') ??
      attempts.find((a) => a.verdict !== 'PASS') ??
      attempts[0];
    const passes = attempts.filter((a) => a.verdict === 'PASS').length;
    results.push({
      ...t,
      ...worst,
      attempts: attempts.length,
      passes,
      verdict: worst?.verdict ?? 'TIMEOUT',
    });
    const summary = results.at(-1);
    console.log(
      `${summary.verdict.padEnd(7)} ${t.id.padEnd(20)} ${passes}/${attempts.length} runs  ${summary.detail ?? ''}`,
    );
    if (blocked) break;
  }

  await call('stop', { profileId });
} finally {
  sidecar.stdin.end();
  await wait(1000);
  sidecar.kill('SIGKILL');
  fixtures?.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

const blockedRuns = results.filter((r) => r.verdict === 'BLOCKED');
const failed = results.filter((r) => r.verdict !== 'PASS' && r.verdict !== 'BLOCKED');
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
if (blockedRuns.length > 0) {
  // Exit 2 = "could not run", the same code the harness uses for a missing binary or proxy. It must
  // never be confused with a red result.
  console.log(
    `\nAGENT BATTERY: BLOCKED after ${results.length - blockedRuns.length}/${battery.length} tasks — ` +
      `${blockedRuns[0].detail}\nThis says nothing about the agent. Restore provider capacity and re-run.`,
  );
  process.exit(2);
}
console.log(
  `\nAGENT BATTERY: ${failed.length === 0 ? 'PASS' : 'FAIL'} ` +
    `(${results.length - failed.length}/${results.length} tasks, ${repeat} run(s) each)`,
);
process.exit(failed.length === 0 ? 0 : 1);
