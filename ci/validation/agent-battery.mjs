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
// local dev proxy env file. Reports BLOCKED (exit 2) when either is absent. The protected release job
// keeps that result non-green so an incomplete capability gate must be rerun.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { resolveLobiumBinary } from '@lobster/engine-runner';
import {
  buildBatteryRunConfig,
  loadBatteryProxy,
  parseBatteryTokenBudget,
} from './agent-battery-config.mjs';
import { startFixtureServer } from './agent-fixtures.mjs';
import { TASKS } from './agent-battery-tasks.mjs';
import {
  chooseAttemptResult,
  hasAnyBrowserAction,
  hasBrowserAttempt,
  hasBrowserEvidence,
  matchesExpectation,
  providerBlockReason,
  summarizeBattery,
} from './agent-battery-results.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LOBIUM = resolveLobiumBinary();
const MODEL = process.env.AGENT_BATTERY_MODEL || 'anthropic/claude-sonnet-5';
const REPORT_PATH = process.env.AGENT_BATTERY_REPORT_JSON || '';
const RPC_TIMEOUT_MS = 30_000;
const startedAt = new Date().toISOString();
let tokenBudget;

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

async function writeReport(report) {
  if (!REPORT_PATH) return;
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function exitBlocked(detail) {
  console.log(`AGENT BATTERY: BLOCKED — ${detail}`);
  await writeReport({
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    model: MODEL,
    repeat,
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    status: 'BLOCKED',
    exitCode: 2,
    detail,
    expectedTasks: battery.map((task) => task.id),
    results: [],
  });
  process.exit(2);
}

try {
  tokenBudget = parseBatteryTokenBudget(process.env.AGENT_BATTERY_TOKEN_BUDGET);
} catch (error) {
  await exitBlocked(`invalid AGENT_BATTERY_TOKEN_BUDGET: ${error.message}`);
}

if (battery.length === 0) {
  const detail = `no battery task matched: ${selected.join(', ') || '(empty task table)'}`;
  console.error(`AGENT BATTERY: FAIL — ${detail}`);
  await writeReport({
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    model: MODEL,
    repeat,
    tokenBudget,
    status: 'FAIL',
    exitCode: 1,
    detail,
    expectedTasks: [],
    results: [],
  });
  process.exit(1);
}

if (!LOBIUM) {
  await exitBlocked('no Lobium binary (set LOBSTER_LOBIUM_BIN)');
}
const proxy = loadBatteryProxy();
if (!proxy) {
  await exitBlocked(
    'no explicit managed LLM proxy pair (set LOBSTER_AGENT_PROXY_URL and LOBSTER_AGENT_PROXY_TOKEN)',
  );
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
const events = [];
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
    const entry = pending.get(msg.id);
    if (entry) {
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
    pending.delete(msg.id);
  }
});

let sidecarFailure = '';
const rejectPending = (reason) => {
  sidecarFailure = reason;
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
};
sidecar.on('error', (error) => rejectPending(`sidecar failed to start: ${error.message}`));
sidecar.stdin.on('error', (error) => rejectPending(`sidecar stdin failed: ${error.message}`));
sidecar.on('exit', (code, signal) => {
  if (sidecarFailure || (code === 0 && pending.size === 0)) return;
  rejectPending(`sidecar exited unexpectedly (code=${code ?? 'none'}, signal=${signal ?? 'none'})`);
});

const call = (method, params, timeoutMs = RPC_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    if (sidecarFailure) {
      reject(new Error(sidecarFailure));
      return;
    }
    const id = String(nextId++);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`sidecar RPC ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    sidecar.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
      if (!error) return;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      reject(error);
    });
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let harnessFatal = '';

const memoryPairEnvironment = {
  profileId: 'battery-memory-pair',
  profileName: 'Battery memory pair',
  userDataDir: join(root, 'memory-pair', 'profile'),
  memoryDir: join(root, 'memory-pair', 'agent'),
  memoryKey: randomBytes(32).toString('base64'),
  fingerprintSeed: randomBytes(16).toString('hex'),
};

function environmentFor(task, attempt) {
  if (task.id.startsWith('memory-')) return memoryPairEnvironment;
  const id = `battery-${task.id}-${attempt}`;
  const base = join(root, 'attempts', id);
  return {
    profileId: id,
    profileName: `Battery ${task.id} ${attempt}`,
    userDataDir: join(base, 'profile'),
    memoryDir: join(base, 'agent'),
    memoryKey: randomBytes(32).toString('base64'),
    fingerprintSeed: randomBytes(16).toString('hex'),
  };
}

function firstTaskUrl(taskText) {
  const raw = /https?:\/\/[^\s"'<>]+/i.exec(taskText)?.[0]?.replace(/[),.;]+$/, '');
  if (!raw) return '';
  try {
    return new URL(raw).href;
  } catch {
    return '';
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

try {
  /** True once a provider/billing failure makes every further result meaningless. */
  let blocked = '';

  for (const t of battery) {
    const attempts = [];
    // `memory-recall` depends on `memory-write` having run, so an ordered pair must not be interleaved
    // by repetition; everything else repeats to expose a task that only passes sometimes.
    const runs = t.id.startsWith('memory-') ? 1 : repeat;
    for (let attempt = 1; attempt <= runs && !blocked; attempt += 1) {
      const began = Date.now();
      let confirmsSeen = 0;
      // Facts derived from the live page BEFORE the agent runs, so the grader knows the real answer.
      let facts;
      if (t.derive) {
        try {
          facts = await t.derive({ fixtures });
        } catch (error) {
          attempts.push({
            verdict: 'BLOCKED',
            detail: `could not derive expected facts: ${errorMessage(error)}`,
            tokenBudget,
          });
          continue;
        }
      }
      const taskText = t.local ? t.task.replaceAll('{ORIGIN}', fixtures.origin) : t.task;
      const expectedTarget = firstTaskUrl(taskText);
      const env = environmentFor(t, attempt);
      let profileStarted = false;
      let agentStarted = false;
      try {
        // Every stochastic attempt gets a clean browser + memory boundary. The ordered memory pair is
        // the sole exception because sharing one profile store is exactly the capability it tests.
        if (t.mode !== 'ask') {
          const started = await call(
            'startProfile',
            {
              profileId: env.profileId,
              profileName: env.profileName,
              engine: 'lobium',
              os: 'linux',
              fingerprintSeed: env.fingerprintSeed,
              userDataDir: env.userDataDir,
              agentMemoryKey: env.memoryKey,
            },
            180_000,
          );
          if (!started.ok) throw new Error(`startProfile failed: ${JSON.stringify(started.error)}`);
          profileStarted = true;
        }

        const eventOffset = events.length;
        const res = await call('agent.start', {
          profileId: env.profileId,
          task: taskText,
          memoryDir: env.memoryDir,
          memoryKey: env.memoryKey,
          threadId: `battery-${t.id}-${attempt}`,
          llm: {
            provider: 'openrouter',
            managed: true,
            model: MODEL,
            baseUrl: proxy.url,
            apiKey: proxy.token,
          },
          // Fixture tasks opt into loopback only while fenced to the exact fixture host. Every paid
          // attempt also receives the same validated cost ceiling.
          config: buildBatteryRunConfig(t, {
            fixtureOrigin: fixtures?.origin,
            tokenBudget,
          }),
        });
        if (!res.ok) {
          attempts.push({
            verdict: 'FAIL',
            detail: `start rejected: ${JSON.stringify(res.error)}`,
            tokenBudget,
          });
          continue;
        }
        agentStarted = true;
        const sessionId = res.result?.sessionId;
        if (typeof sessionId !== 'string' || !sessionId) {
          attempts.push({
            verdict: 'FAIL',
            detail: 'agent.start returned no session id',
            tokenBudget,
          });
          continue;
        }
        const runEvents = () =>
          events.slice(eventOffset).filter((event) => event.sessionId === sessionId);

        let finished;
        let timedOut = false;
        for (let i = 0; i < 400 && !finished; i += 1) {
          await wait(1000);
          finished = runEvents().find((event) => event.type === 'run.finished');
          if (finished) break;
          const statusResponse = await call('agent.status', { profileId: env.profileId });
          if (!statusResponse.ok)
            throw new Error(`agent.status failed: ${JSON.stringify(statusResponse.error)}`);
          const status = statusResponse.result?.runs?.find((run) => run.sessionId === sessionId);
          if (status?.status === 'awaiting_input') {
            // Stand in for an attentive human. The exact confirmation is graded from the typed event;
            // this counter is telemetry only and cannot make a safety test pass by itself.
            confirmsSeen += 1;
            const sent = await call('agent.sendInput', {
              profileId: env.profileId,
              text: t.rejectConfirms ? 'reject' : 'approve',
            });
            if (!sent.ok || sent.result?.delivered !== true) {
              throw new Error(`could not answer agent input: ${JSON.stringify(sent.error)}`);
            }
          }
        }
        if (!finished) {
          timedOut = true;
          await call('agent.stop', { profileId: env.profileId });
          // Let the stopped terminal event land so its diagnostics belong to this attempt, never the
          // next one. The verdict remains TIMEOUT regardless of the cleanup event's status.
          for (let i = 0; i < 50 && !finished; i += 1) {
            await wait(100);
            finished = runEvents().find((event) => event.type === 'run.finished');
          }
        }

        const attemptEvents = runEvents();
        if (t.deriveAfter && !timedOut) {
          try {
            facts = await t.deriveAfter({ fixtures, facts, events: attemptEvents });
          } catch (error) {
            attempts.push({
              verdict: 'BLOCKED',
              detail: `could not derive final expected facts: ${errorMessage(error)}`,
              tokenBudget,
            });
            continue;
          }
        }
        const text = `${finished?.result ?? ''}\n${finished?.error ?? ''}`;
        const steps = Math.max(
          0,
          ...attemptEvents
            .filter((event) => event.type === 'step.action')
            .map((event) => event.step ?? 0),
        );
        const usage = attemptEvents
          .filter((event) => event.type === 'usage')
          .map((event) => event.usage ?? {});
        const tokensIn = usage.reduce((n, item) => n + (item.tokensIn ?? 0), 0);
        const tokensOut = usage.reduce((n, item) => n + (item.tokensOut ?? 0), 0);
        const cached = usage.reduce((n, item) => n + (item.cachedTokensIn ?? 0), 0);
        const wantSuccess = t.wantSuccess !== false;
        const ok =
          finished?.status === (wantSuccess ? 'done' : 'error') ||
          (!wantSuccess && finished?.status === 'stopped');
        const matched = matchesExpectation(t, text, facts);
        const browserUsed =
          t.browser === false
            ? hasAnyBrowserAction(attemptEvents) ||
              attemptEvents.some((event) => event.type === 'run.needsBrowser')
            : t.browserEvidence === 'attempt'
              ? hasBrowserAttempt(attemptEvents, expectedTarget)
              : hasBrowserEvidence(attemptEvents, expectedTarget);
        const browserIssue =
          t.browser === false
            ? browserUsed
              ? 'used or requested a browser for a browser-free task'
              : ''
            : !expectedTarget
              ? 'browser task has no expected target URL'
              : browserUsed
                ? ''
                : t.browserEvidence === 'attempt'
                  ? 'the denied target navigation was never attempted'
                  : 'the expected page was not both acted on and observed';
        const taskIssue = t.assert?.(attemptEvents, { confirmsSeen }) ?? '';
        const extra = [browserIssue, taskIssue].filter(Boolean).join('; ');

        // Provider capacity says nothing about agent capability. Match only the terminal ERROR field;
        // an answer which quotes a site's outage must remain an ordinary graded answer.
        const providerFailure =
          finished?.status === 'error' ? providerBlockReason(finished.error ?? '') : '';
        if (providerFailure) {
          blocked = providerFailure;
          attempts.push({ verdict: 'BLOCKED', detail: blocked, tokenBudget });
          continue;
        }
        const verdict = timedOut ? 'TIMEOUT' : extra ? 'FAIL' : ok && matched ? 'PASS' : 'FAIL';
        attempts.push({
          ...t,
          verdict,
          steps,
          seconds: Math.round((Date.now() - began) / 1000),
          tokenBudget,
          tokensIn,
          tokensOut,
          cachePct: tokensIn ? Math.round((cached / tokensIn) * 100) : 0,
          status: timedOut ? 'timeout' : (finished?.status ?? 'missing-terminal-event'),
          detail:
            extra ||
            (!ok
              ? `status=${finished?.status}`
              : !matched
                ? 'result did not match expectation'
                : ''),
          text: text.trim().slice(0, 300),
        });
        const result = attempts.at(-1);
        console.log(
          `  ${result.verdict.padEnd(7)} ${t.id.padEnd(20)} ${String(result.steps ?? 0).padStart(2)} steps ` +
            `${String(result.seconds ?? 0).padStart(3)}s cache=${String(result.cachePct ?? 0).padStart(3)}%  ${result.detail ?? ''}`,
        );
      } finally {
        if (agentStarted) {
          await call('agent.stop', { profileId: env.profileId }).catch(() => undefined);
        }
        if (profileStarted) {
          const stopped = await call('stop', { profileId: env.profileId });
          if (!stopped.ok) throw new Error(`stop profile failed: ${JSON.stringify(stopped.error)}`);
        }
      }
    }

    // ALL attempts must pass. A task that is green two times in three is a flaky task, and reporting
    // it as PASS is how a real intermittent regression stays invisible.
    const worst = chooseAttemptResult(attempts);
    const passes = attempts.filter((a) => a.verdict === 'PASS').length;
    results.push({
      ...t,
      ...worst,
      attempts: attempts.length,
      attemptResults: attempts.map((attempt) => ({
        verdict: attempt.verdict,
        status: attempt.status,
        steps: attempt.steps,
        seconds: attempt.seconds,
        cachePct: attempt.cachePct,
        tokenBudget: attempt.tokenBudget,
        tokensIn: attempt.tokensIn,
        tokensOut: attempt.tokensOut,
        detail: attempt.detail,
        text: attempt.text,
      })),
      passes,
      verdict: worst?.verdict ?? 'TIMEOUT',
    });
    const summary = results.at(-1);
    console.log(
      `${summary.verdict.padEnd(7)} ${t.id.padEnd(20)} ${passes}/${attempts.length} runs  ${summary.detail ?? ''}`,
    );
    if (blocked) break;
  }
} catch (error) {
  harnessFatal = error instanceof Error ? error.message : String(error);
} finally {
  sidecar.stdin.end();
  await wait(1000);
  sidecar.kill('SIGKILL');
  fixtures?.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

const computedSummary = summarizeBattery(results, battery.length);
const summary =
  harnessFatal && computedSummary.status === 'PASS'
    ? { ...computedSummary, status: 'BLOCKED', exitCode: 2, incomplete: true }
    : computedSummary;
const { blocked: blockedRuns, failed } = summary;
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
if (harnessFatal) console.log(`\nharness blocked: ${harnessFatal}`);
await writeReport({
  schemaVersion: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  model: MODEL,
  repeat,
  tokenBudget,
  status: summary.status,
  exitCode: summary.exitCode,
  ...(harnessFatal ? { harnessError: harnessFatal } : {}),
  expectedTasks: battery.map((task) => task.id),
  completedTasks: results.length,
  results: results.map((result) => ({
    id: result.id,
    why: result.why,
    verdict: result.verdict,
    attempts: result.attempts,
    passes: result.passes,
    status: result.status,
    steps: result.steps,
    seconds: result.seconds,
    cachePct: result.cachePct,
    tokenBudget: result.tokenBudget,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    detail: result.detail,
    text: result.text,
    attemptResults: result.attemptResults,
  })),
});

if (summary.status === 'FAIL') {
  if (blockedRuns.length > 0 || summary.incomplete) {
    console.log(
      `\nThe harness or provider also blocked the remainder, but ${failed.length} real failure(s) ` +
        'had already been observed and take precedence.',
    );
  }
  console.log(
    `\nAGENT BATTERY: FAIL (${results.filter((r) => r.verdict === 'PASS').length}/` +
      `${battery.length} tasks passed, ${repeat} run(s) each)`,
  );
  process.exit(1);
}
if (summary.status === 'BLOCKED') {
  // Exit 2 = "could not complete", but the protected CI job treats this as a required rerun rather than
  // painting an incomplete release gate green.
  console.log(
    `\nAGENT BATTERY: BLOCKED after ${results.length - blockedRuns.length}/${battery.length} tasks — ` +
      `${blockedRuns[0]?.detail ?? (harnessFatal || 'the run was incomplete')}\n` +
      'This says nothing about the remaining agent capabilities. Restore capacity and re-run.',
  );
  process.exit(2);
}
console.log(
  `\nAGENT BATTERY: PASS (${results.length}/${battery.length} tasks, ${repeat} run(s) each)`,
);
process.exit(0);
