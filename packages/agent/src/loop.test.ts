import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent, AgentUsage } from '@lobster/shared-types';
import type { BrowserDriver, Point } from './driver.js';
import type { LlmClient, LlmRequest, LlmResult } from './llm/index.js';
import type { MemoryStore, ThreadMessage } from './memory/index.js';
import { EXTRACT_SCRIPT } from './perception/extract-script.js';
import { resolveConfig, runAgent } from './loop.js';

/** A page the fake extraction script "sees": one search box, one button. */
const PAGE = {
  url: 'https://example.test/',
  title: 'Example',
  scrollY: 0,
  viewportH: 720,
  docH: 720,
  canScrollUp: false,
  canScrollDown: false,
  truncated: 0,
  elements: [
    { index: 0, tag: 'input', role: 'searchbox', name: 'Search', x: 100, y: 40, w: 200, h: 30 },
    { index: 1, tag: 'button', role: 'button', name: 'Go', x: 320, y: 40, w: 40, h: 30 },
    {
      index: 2,
      tag: 'input',
      role: 'textbox',
      name: 'Password',
      type: 'password',
      sensitive: true,
      x: 100,
      y: 90,
      w: 200,
      h: 30,
    },
  ],
};

class FakeDriver implements BrowserDriver {
  clicks: Point[] = [];
  typed: string[] = [];
  navigations: string[] = [];
  async evaluate<T>(expression: string): Promise<T> {
    // Check the full extract script FIRST — it embeds `location.href`/`document.readyState`, so an
    // `includes` check for those would otherwise shadow it.
    if (expression === EXTRACT_SCRIPT) return PAGE as unknown as T;
    if (expression === 'location.href') return PAGE.url as unknown as T;
    if (expression === 'document.readyState') return 'complete' as unknown as T;
    return '' as unknown as T; // EXTRACT_TEXT etc.
  }
  async click(p: Point): Promise<void> {
    this.clicks.push(p);
  }
  async hover(): Promise<void> {}
  async drag(): Promise<void> {}
  async type(t: string): Promise<void> {
    this.typed.push(t);
  }
  async pressKey(): Promise<void> {}
  async selectAll(): Promise<void> {}
  async scrollBy(): Promise<void> {}
  async select(): Promise<void> {}
  async uploadFiles(): Promise<void> {}
  async navigate(url: string): Promise<void> {
    this.navigations.push(url);
  }
  async currentUrl(): Promise<string> {
    return PAGE.url;
  }
  async waitForSettle(): Promise<void> {}
  async goBack(): Promise<void> {}
  async listTabs(): Promise<[]> {
    return [];
  }
  async newTab(): Promise<void> {}
  async switchTab(): Promise<void> {}
  async closeTab(): Promise<void> {}
}

/** Replays a fixed script of tool calls, one per step. */
class ScriptedLlm implements LlmClient {
  readonly provider = 'fake';
  private i = 0;
  readonly requests: LlmRequest[] = [];
  constructor(private readonly script: Array<Record<string, unknown>>) {}
  complete(_req: LlmRequest): Promise<LlmResult> {
    this.requests.push(_req);
    const input = this.script[this.i++] ?? {
      kind: 'done',
      success: false,
      summary: 'script exhausted',
    };
    const usage: AgentUsage = { tokensIn: 10, tokensOut: 5 };
    return Promise.resolve({
      toolCall: { id: `call_${this.i}`, name: 'act', input },
      stopReason: 'tool',
      usage,
    });
  }
}

/** Every piece of text in a request, for "the model was told X" assertions. */
function allText(request: LlmRequest): string {
  return request.messages
    .map((m) => (m.role === 'assistant' ? JSON.stringify(m.toolCalls ?? []) : m.content))
    .join('\n');
}

class FakeMemory implements MemoryStore {
  steps: unknown[] = [];
  /** Prior turns of the conversation under test, in stored form. */
  thread: ThreadMessage[] = [];
  appendedTurns: Array<{ user: string; assistant: string; status: string }> = [];
  finished?: { status: string; summary: string };
  siteContexts: string[] = [];
  started?: { task: string; mode?: string; model?: string };
  async loadContext(domain?: string): Promise<string> {
    if (domain) this.siteContexts.push(domain);
    return domain ? `site preference for ${domain}` : '';
  }
  async loadThread(): Promise<ThreadMessage[]> {
    return this.thread;
  }
  async appendThreadTurn(
    _threadId: string,
    turn: { user: string; assistant: string; status: 'done' | 'error' | 'stopped' },
  ): Promise<void> {
    this.appendedTurns.push(turn);
  }
  async listThreads(): Promise<[]> {
    return [];
  }
  async startRun(
    _id: string,
    task: string,
    _startedAt: string,
    metadata?: { mode?: 'ask' | 'agent'; model?: string },
  ): Promise<void> {
    this.started = { task, ...metadata };
  }
  async appendStep(_id: string, step: unknown): Promise<void> {
    this.steps.push(step);
  }
  async finishRun(_id: string, o: { status: string; summary: string }): Promise<void> {
    this.finished = { status: o.status, summary: o.summary };
  }
  async rememberFact(): Promise<void> {}
  async learnSkill(): Promise<void> {}
  async getSettings(): Promise<Record<string, never>> {
    return {};
  }
  async setSettings(): Promise<void> {}
}

function run(script: Array<Record<string, unknown>>, humanInput = 'ok') {
  const driver = new FakeDriver();
  const memory = new FakeMemory();
  const events: AgentEvent[] = [];
  const abort = new AbortController();
  let n = 0;
  const llm = new ScriptedLlm(script);
  const now = (): string => new Date(1700000000000 + n++ * 1000).toISOString();
  return {
    driver,
    memory,
    events,
    promise: runAgent(
      {
        sessionId: 's1',
        threadId: 'thread1',
        profileId: 'p1',
        task: 'search for shoes',
        runId: 's1',
        llmConfig: { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'x' },
        config: resolveConfig({ maxSteps: 6 }),
      },
      {
        driver,
        llm,
        memory,
        emit: (e) => events.push(e),
        waitForInput: async () => humanInput,
        signal: abort.signal,
        now,
        sleep: async () => {},
      },
    ),
    abort,
    llm,
  };
}

test('runs a type+submit then finishes done, emitting the expected event arc', async () => {
  const { driver, memory, events, promise } = run([
    { kind: 'type', id: 0, text: 'shoes', submit: true },
    { kind: 'click', id: 1 },
    { kind: 'done', success: true, summary: 'searched for shoes' },
  ]);
  await promise;

  assert.deepEqual(driver.typed, ['shoes']);
  // Two clicks: focusing the search field before typing, then the "Go" button.
  assert.equal(driver.clicks.length, 2);
  assert.deepEqual(driver.clicks[0], { x: 100, y: 40 }); // focus searchbox [0]
  assert.deepEqual(driver.clicks[1], { x: 320, y: 40 }); // click button [1]

  const types = events.map((e) => e.type);
  assert.equal(types[0], 'run.started');
  assert.ok(types.includes('step.action'));
  const finished = events.find((e) => e.type === 'run.finished');
  assert.ok(finished && finished.type === 'run.finished');
  assert.equal(finished.status, 'done');
  assert.equal(finished.result, 'searched for shoes');
  assert.equal(memory.finished?.status, 'done');
});

test('Ask mode injects bounded prior conversation and persists run metadata', async () => {
  const driver = new FakeDriver();
  const memory = new FakeMemory();
  memory.thread = [
    { role: 'user', content: 'My name is Ada.', ts: 'T1' },
    { role: 'assistant', content: 'Nice to meet you, Ada.', ts: 'T2', status: 'done' },
  ];
  const events: AgentEvent[] = [];
  const requests: LlmRequest[] = [];
  const llm: LlmClient = {
    provider: 'fake-chat',
    async complete(request): Promise<LlmResult> {
      requests.push(request);
      return {
        text: 'Your name is Ada.',
        stopReason: 'stop',
        usage: { tokensIn: 20, tokensOut: 5 },
      };
    },
  };
  let n = 0;
  await runAgent(
    {
      sessionId: 'ask-2',
      profileId: 'p1',
      task: 'What is my name?',
      runId: 'ask-2',
      threadId: 'thread1',
      llmConfig: { provider: 'anthropic', model: 'claude-test', apiKey: 'x' },
      config: resolveConfig({ mode: 'ask' }),
    },
    {
      driver,
      llm,
      memory,
      emit: (event) => events.push(event),
      waitForInput: async () => '',
      signal: new AbortController().signal,
      now: () => new Date(1700000000000 + n++ * 1000).toISOString(),
    },
  );

  assert.deepEqual(memory.started, {
    task: 'What is my name?',
    mode: 'ask',
    model: 'claude-test',
  });
  assert.equal(requests.length, 1);
  // Prior turns arrive as REAL alternating messages, not a transcript pasted into one user string.
  assert.deepEqual(
    requests[0]!.messages.map((m) => [m.role, 'content' in m ? m.content : '']),
    [
      ['user', 'My name is Ada.'],
      ['assistant', 'Nice to meet you, Ada.'],
      ['user', 'What is my name?'],
    ],
  );
  assert.equal(memory.finished?.summary, 'Your name is Ada.');
  // The exchange is written back, so the NEXT message can see it.
  assert.deepEqual(memory.appendedTurns, [
    { user: 'What is my name?', assistant: 'Your name is Ada.', status: 'done' },
  ]);
  const finished = events.find((event) => event.type === 'run.finished');
  assert.ok(finished && finished.type === 'run.finished' && finished.status === 'done');
});

test('a bad element index does not crash — it is fed back and the run continues', async () => {
  const { events, promise } = run([
    { kind: 'click', id: 99 }, // no such element
    { kind: 'done', success: true, summary: 'ok' },
  ]);
  await promise;
  const finished = events.find((e) => e.type === 'run.finished');
  assert.ok(finished && finished.type === 'run.finished' && finished.status === 'done');
});

test('Agent mode receives prior conversation and refreshes site-scoped memory', async () => {
  const { promise, memory, llm } = run([
    { kind: 'done', success: true, summary: 'You like violet.' },
  ]);
  memory.thread = [
    { role: 'user', content: 'I like violet.', ts: 'T1' },
    { role: 'assistant', content: 'I will remember that.', ts: 'T2', status: 'done' },
  ];
  await promise;
  const first = llm.requests[0]!.messages;
  assert.equal(first[0]?.role, 'user');
  assert.match(allText(llm.requests[0]!), /I like violet/);
  assert.match(allText(llm.requests[0]!), /site preference for example\.test/);
  assert.deepEqual(memory.siteContexts, ['example.test']);
});

test('done with success=false is an error, not a green successful completion', async () => {
  const { promise, memory, events } = run([
    { kind: 'done', success: false, summary: 'The requested control is unavailable.' },
  ]);
  await promise;
  const finished = events.find((event) => event.type === 'run.finished');
  assert.ok(finished?.type === 'run.finished');
  assert.equal(finished.status, 'error');
  assert.equal(finished.error, 'The requested control is unavailable.');
  assert.equal(memory.finished?.status, 'error');
});

test('multi-page extracts remain in a bounded evidence ledger after clicking Next', async () => {
  class PaginatedDriver extends FakeDriver {
    page = 1;
    override async evaluate<T>(expression: string): Promise<T> {
      if (expression === EXTRACT_SCRIPT) {
        return { ...PAGE, url: `https://example.test/page/${this.page}` } as unknown as T;
      }
      if (expression === 'location.href')
        return `https://example.test/page/${this.page}` as unknown as T;
      return (this.page === 1 ? 'PAGE ONE: Ada, 10' : 'PAGE TWO: Grace, 20') as unknown as T;
    }
    override async currentUrl(): Promise<string> {
      return `https://example.test/page/${this.page}`;
    }
    override async click(point: Point): Promise<void> {
      await super.click(point);
      if (point.x === 320 && point.y === 40) this.page = 2;
    }
  }

  const driver = new PaginatedDriver();
  const memory = new FakeMemory();
  const llm = new ScriptedLlm([
    { kind: 'extract', description: 'page one rows' },
    { kind: 'click', id: 1 },
    { kind: 'extract', description: 'page two rows' },
    { kind: 'done', success: true, summary: 'Ada 10; Grace 20' },
  ]);
  await runAgent(
    {
      sessionId: 'pages',
      profileId: 'p1',
      task: 'collect every row across pages',
      runId: 'pages',
      llmConfig: { provider: 'anthropic', model: 'claude-test', apiKey: 'x' },
      config: resolveConfig({ maxSteps: 6 }),
    },
    {
      driver,
      llm,
      memory,
      emit: () => {},
      waitForInput: async () => '',
      signal: new AbortController().signal,
      now: () => new Date().toISOString(),
      sleep: async () => {},
    },
  );
  assert.match(allText(llm.requests[2]!), /PAGE ONE: Ada, 10/);
  assert.match(allText(llm.requests[3]!), /PAGE ONE: Ada, 10/);
  assert.match(allText(llm.requests[3]!), /PAGE TWO: Grace, 20/);
});

test('stops cleanly when aborted before finishing', async () => {
  const { promise, abort, events } = run([
    { kind: 'wait', ms: 0 },
    { kind: 'wait', ms: 0 },
  ]);
  abort.abort();
  await promise;
  const finished = events.find((e) => e.type === 'run.finished');
  assert.ok(finished && finished.type === 'run.finished' && finished.status === 'stopped');
});

test('browser_config open_settings opens chrome://settings in a background tab, exempt from drift rollback', async () => {
  // open_settings must open the vetted URL in a SEPARATE BACKGROUND tab (never navigate the current
  // one) and the run must NOT be rolled back by the post-action drift check (browser_config is exempt).
  class SettingsDriver extends FakeDriver {
    tabs: Array<{ url: string; background: boolean }> = [];
    override async newTab(url?: string, opts?: { background?: boolean }): Promise<void> {
      this.tabs.push({ url: url ?? '', background: opts?.background === true });
    }
  }
  const driver = new SettingsDriver();
  const memory = new FakeMemory();
  const events: AgentEvent[] = [];
  const abort = new AbortController();
  let n = 0;
  const llm = new ScriptedLlm([
    { kind: 'browser_config', op: 'open_settings', value: 'appearance' },
    { kind: 'done', success: true, summary: 'opened appearance settings' },
  ]);
  await runAgent(
    {
      sessionId: 's1',
      profileId: 'p1',
      task: 'open appearance settings',
      runId: 's1',
      llmConfig: { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'x' },
      config: resolveConfig({ maxSteps: 4 }),
    },
    {
      driver,
      llm,
      memory,
      emit: (e) => events.push(e),
      waitForInput: async () => 'ok',
      signal: abort.signal,
      now: () => new Date(1700000000000 + n++ * 1000).toISOString(),
      sleep: async () => {},
    },
  );
  assert.ok(
    driver.tabs.some((t) => t.url === 'chrome://settings/appearance' && t.background),
    'should open the vetted settings URL in a background tab',
  );
  assert.ok(
    !driver.navigations.includes('chrome://settings/appearance'),
    'must NOT navigate the current tab to chrome://settings',
  );
  const finished = events.find((e) => e.type === 'run.finished');
  assert.ok(finished && finished.type === 'run.finished');
  assert.equal(finished.status, 'done'); // NOT error: browser_config is exempt from the drift rollback
  assert.ok(!/drift/i.test(finished.error ?? ''));
});

test('browser_config hard-blocks a fingerprint settings area without navigating', async () => {
  class SettingsDriver extends FakeDriver {
    override async currentUrl(): Promise<string> {
      return this.navigations.at(-1) ?? PAGE.url;
    }
  }
  const driver = new SettingsDriver();
  const memory = new FakeMemory();
  const events: AgentEvent[] = [];
  const abort = new AbortController();
  let n = 0;
  const llm = new ScriptedLlm([
    { kind: 'browser_config', op: 'open_settings', value: 'languages' }, // fingerprint area
    { kind: 'done', success: true, summary: 'stopped' },
  ]);
  await runAgent(
    {
      sessionId: 's1',
      profileId: 'p1',
      task: 'change languages',
      runId: 's1',
      llmConfig: { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'x' },
      config: resolveConfig({ maxSteps: 4 }),
    },
    {
      driver,
      llm,
      memory,
      emit: (e) => events.push(e),
      waitForInput: async () => 'ok',
      signal: abort.signal,
      now: () => new Date(1700000000000 + n++ * 1000).toISOString(),
      sleep: async () => {},
    },
  );
  assert.equal(driver.navigations.length, 0, 'a blocked fingerprint area must never navigate');
});

test('browser_config clears every cookie through the native driver operation', async () => {
  class ConfigDriver extends FakeDriver {
    commands: unknown[] = [];
    async browserConfig(command: unknown): Promise<string> {
      this.commands.push(command);
      return 'cleared all cookies';
    }
  }
  const driver = new ConfigDriver();
  const memory = new FakeMemory();
  const events: AgentEvent[] = [];
  const llm = new ScriptedLlm([
    { kind: 'browser_config', op: 'clear_all_cookies' },
    { kind: 'done', success: true, summary: 'all cookies cleared' },
  ]);
  await runAgent(
    {
      sessionId: 's1',
      profileId: 'p1',
      task: 'clear all cookies',
      runId: 's1',
      llmConfig: { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'x' },
      config: resolveConfig({ maxSteps: 4 }),
    },
    {
      driver,
      llm,
      memory,
      emit: (event) => events.push(event),
      waitForInput: async () => 'ok',
      signal: new AbortController().signal,
      now: () => new Date().toISOString(),
      sleep: async () => {},
    },
  );
  assert.deepEqual(driver.commands, [{ op: 'clear_all_cookies' }]);
  assert.equal(events.find((event) => event.type === 'run.finished')?.type, 'run.finished');
});

test('normal interactions may stay within vetted settings pages but unsafe internal drift is blocked', async () => {
  class SettingsInteractionDriver extends FakeDriver {
    url = PAGE.url;
    driftTo = 'chrome://settings/appearance?search=theme';
    override async evaluate<T>(expression: string): Promise<T> {
      if (expression === EXTRACT_SCRIPT) {
        return { ...PAGE, url: this.url, title: 'Settings' } as unknown as T;
      }
      if (expression === 'location.href') return this.url as unknown as T;
      return super.evaluate<T>(expression);
    }
    override async currentUrl(): Promise<string> {
      return this.url;
    }
    override async newTab(url?: string): Promise<void> {
      this.url = url ?? 'about:blank';
    }
    override async type(text: string): Promise<void> {
      await super.type(text);
      this.url = this.driftTo;
    }
  }

  const execute = async (driftTo: string): Promise<AgentEvent[]> => {
    const driver = new SettingsInteractionDriver();
    driver.driftTo = driftTo;
    const events: AgentEvent[] = [];
    await runAgent(
      {
        sessionId: 's1',
        profileId: 'p1',
        task: 'search appearance settings',
        runId: 's1',
        llmConfig: { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'x' },
        config: resolveConfig({ maxSteps: 4 }),
      },
      {
        driver,
        llm: new ScriptedLlm([
          { kind: 'browser_config', op: 'open_settings', value: 'appearance' },
          { kind: 'type', id: 0, text: 'theme', clear: true },
          { kind: 'done', success: true, summary: 'finished settings task' },
        ]),
        memory: new FakeMemory(),
        emit: (event) => events.push(event),
        waitForInput: async () => 'ok',
        signal: new AbortController().signal,
        now: () => new Date().toISOString(),
        sleep: async () => {},
      },
    );
    return events;
  };

  const safe = await execute('chrome://settings/appearance?search=theme');
  const safeFinish = safe.find((event) => event.type === 'run.finished');
  assert.ok(safeFinish?.type === 'run.finished' && safeFinish.status === 'done');

  const unsafe = await execute('chrome://settings/languages');
  const unsafeFinish = unsafe.find((event) => event.type === 'run.finished');
  assert.ok(unsafeFinish?.type === 'run.finished' && unsafeFinish.status === 'error');
  assert.match(unsafeFinish.error ?? '', /Navigation policy blocked page drift/);
});

test('secure human handoff types a password without leaking it to events, memory, or model history', async () => {
  const secret = 'correct horse battery staple';
  const { promise, driver, memory, events, llm } = run(
    [
      { kind: 'ask', question: 'Enter your password', sensitive: true, targetId: 2 },
      { kind: 'done', success: true, summary: 'signed in' },
    ],
    secret,
  );
  await promise;

  assert.ok(driver.typed.includes(secret), 'the trusted driver receives the secret');
  assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(memory.steps), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(llm.requests), new RegExp(secret));
  assert.match(JSON.stringify(memory.steps), /REDACTED/);
});
