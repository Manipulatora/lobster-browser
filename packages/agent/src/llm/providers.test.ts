import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchWithRetry } from './http.js';
import { createLlmClient } from './index.js';
import type { LlmRequest } from './types.js';

const request: LlmRequest = {
  model: 'model-test',
  system: 'system',
  messages: [{ role: 'user', content: 'page' }],
  tools: [{ name: 'act', description: 'act', inputSchema: { type: 'object' } }],
  forceTool: 'act',
  maxTokens: 100,
};

test('OpenAI-compatible providers map forced tool calls and usage', async () => {
  const original = globalThis.fetch;
  let seenUrl = '';
  let seenHeaders: RequestInit['headers'];
  globalThis.fetch = (async (input, init) => {
    seenUrl = String(input);
    seenHeaders = init?.headers;
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: { tool_calls: [{ function: { name: 'act', arguments: '{"kind":"wait"}' } }] },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const client = createLlmClient({
      provider: 'openai',
      model: 'model-test',
      apiKey: 'sk-private',
    });
    const result = await client.complete(request);
    assert.equal(seenUrl, 'https://api.openai.com/v1/chat/completions');
    assert.match(JSON.stringify(seenHeaders), /Bearer sk-private/);
    assert.deepEqual(result.toolCall?.input, { kind: 'wait' });
    assert.deepEqual(result.usage, { tokensIn: 12, tokensOut: 3, cachedTokensIn: 4 });
  } finally {
    globalThis.fetch = original;
  }
});

test('OpenAI Ask mode omits an empty tool contract', async () => {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: 'openai answer' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const client = createLlmClient({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'openai-private',
    });
    const result = await client.complete({ ...request, tools: [], forceTool: '' });
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, undefined);
    assert.equal(result.text, 'openai answer');
    assert.equal(result.stopReason, 'stop');
  } finally {
    globalThis.fetch = original;
  }
});

test('managed/OpenRouter emits caching fields; BYOK-direct OpenAI must NOT (would 400)', async () => {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: { tool_calls: [{ function: { name: 'act', arguments: '{}' } }] },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const cachingReq: LlmRequest = {
    ...request,
    model: 'anthropic/claude-sonnet-5',
    cachePrefix: true,
    sessionId: 'run-1',
    effort: 'medium',
  };
  const systemContent = (): unknown => (body.messages as Array<{ content: unknown }>)[0]?.content;
  try {
    // Managed proxy (→ OpenRouter): system becomes a cache_control content array; session_id + provider pin present.
    const managed = createLlmClient({
      provider: 'openrouter',
      managed: true,
      model: 'anthropic/claude-sonnet-5',
      baseUrl: 'http://127.0.0.1:8790/agent/llm',
      apiKey: 'proxy-tok',
    });
    await managed.complete(cachingReq);
    const sys = systemContent() as Array<{ cache_control?: unknown }>;
    assert.ok(
      Array.isArray(sys) && sys[0]?.cache_control,
      'managed system block should carry cache_control',
    );
    assert.equal(body.session_id, 'run-1');
    assert.deepEqual(body.provider, { order: ['anthropic'] });
    assert.equal(body.tool_choice, 'auto', 'Claude thinking requires automatic tool selection');
    assert.deepEqual(body.reasoning, { effort: 'medium' });
    assert.equal(body.reasoning_effort, undefined);

    // BYOK-direct OpenAI: NONE of the OpenRouter-only fields (they would 400); system stays a plain string.
    const openai = createLlmClient({ provider: 'openai', model: 'gpt-x', apiKey: 'sk-x' });
    await openai.complete({ ...cachingReq, model: 'gpt-x' });
    assert.equal(typeof systemContent(), 'string');
    assert.equal(body.session_id, undefined);
    assert.equal(body.provider, undefined);
    assert.equal(body.reasoning, undefined);
    assert.equal(body.reasoning_effort, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('direct OpenAI/xAI use native reasoning effort only for supported model families', async () => {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: { tool_calls: [{ function: { name: 'act', arguments: '{}' } }] },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const openai = createLlmClient({ provider: 'openai', model: 'gpt-5.1', apiKey: 'sk-x' });
    await openai.complete({ ...request, model: 'gpt-5.1', effort: 'medium' });

    const nonReasoningOpenAi = createLlmClient({
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: 'sk-x',
    });
    await nonReasoningOpenAi.complete({ ...request, model: 'gpt-4.1', effort: 'high' });

    const xai = createLlmClient({ provider: 'xai', model: 'grok-4.5', apiKey: 'xai-x' });
    await xai.complete({ ...request, model: 'grok-4.5', effort: 'low' });

    const olderXai = createLlmClient({ provider: 'xai', model: 'grok-4', apiKey: 'xai-x' });
    await olderXai.complete({ ...request, model: 'grok-4', effort: 'high' });

    assert.equal(bodies[0]?.reasoning, undefined);
    assert.equal(bodies[0]?.reasoning_effort, 'medium');
    assert.equal(bodies[1]?.reasoning, undefined);
    assert.equal(bodies[1]?.reasoning_effort, undefined);
    assert.equal(bodies[2]?.reasoning, undefined);
    assert.equal(bodies[2]?.reasoning_effort, 'low');
    assert.equal(bodies[3]?.reasoning, undefined);
    assert.equal(bodies[3]?.reasoning_effort, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('OpenAI pro reasoning models only receive their supported high effort value', async () => {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {} }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const client = createLlmClient({ provider: 'openai', model: 'o3-pro', apiKey: 'sk-x' });
    await client.complete({ ...request, model: 'o3-pro', effort: 'medium' });
    await client.complete({ ...request, model: 'o3-pro', effort: 'high' });
    assert.equal(bodies[0]?.reasoning_effort, undefined);
    assert.equal(bodies[1]?.reasoning_effort, 'high');
  } finally {
    globalThis.fetch = original;
  }
});

test('managed backend timeouts are not retried into a multi-minute client hang', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: 'upstream OpenRouter request timed out' }), {
      status: 504,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const managed = createLlmClient({
      provider: 'openrouter',
      managed: true,
      model: 'openai/tool-model',
      baseUrl: 'https://proxy.example/agent/llm',
      apiKey: 'proxy-token',
    });
    await assert.rejects(
      managed.complete({ ...request, model: 'openai/tool-model' }),
      /managed 504: upstream OpenRouter request timed out/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('Google adapter keeps the API key out of the URL and maps function calls', async () => {
  const original = globalThis.fetch;
  let seenUrl = '';
  let seenHeaders: RequestInit['headers'];
  globalThis.fetch = (async (input, init) => {
    seenUrl = String(input);
    seenHeaders = init?.headers;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'act',
                    args: { kind: 'done', success: true, summary: 'ok' },
                  },
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const client = createLlmClient({
      provider: 'google',
      model: 'gemini-test',
      apiKey: 'google-private',
    });
    const result = await client.complete(request);
    assert.doesNotMatch(seenUrl, /google-private/);
    assert.match(JSON.stringify(seenHeaders), /google-private/);
    assert.equal(result.toolCall?.name, 'act');
    assert.equal(result.stopReason, 'tool');
  } finally {
    globalThis.fetch = original;
  }
});

test('Anthropic and Google Ask mode omit empty tool contracts', async () => {
  const original = globalThis.fetch;
  const bodies: Record<string, Record<string, unknown>> = {};
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const provider = url.includes('anthropic.com') ? 'anthropic' : 'google';
    bodies[provider] = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (provider === 'anthropic') {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'anthropic answer' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 4, output_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ text: 'google answer' }] },
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const askRequest: LlmRequest = { ...request, tools: [], forceTool: '' };
  try {
    const anthropic = createLlmClient({
      provider: 'anthropic',
      model: 'claude-test',
      apiKey: 'anthropic-private',
    });
    await anthropic.complete(request);
    assert.deepEqual(bodies.anthropic?.tool_choice, { type: 'auto' });

    const anthropicResult = await anthropic.complete(askRequest);
    assert.equal(bodies.anthropic?.tools, undefined);
    assert.equal(bodies.anthropic?.tool_choice, undefined);
    assert.equal(anthropicResult.text, 'anthropic answer');
    assert.equal(anthropicResult.stopReason, 'stop');

    const google = createLlmClient({
      provider: 'google',
      model: 'gemini-test',
      apiKey: 'google-private',
    });
    const googleResult = await google.complete(askRequest);
    assert.equal(bodies.google?.tools, undefined);
    assert.equal(bodies.google?.toolConfig, undefined);
    assert.equal(googleResult.text, 'google answer');
    assert.equal(googleResult.stopReason, 'stop');
  } finally {
    globalThis.fetch = original;
  }
});

test('provider credential redirect is blocked; managed mode routes through the proxy', () => {
  // BYOK: an untrusted base-URL override cannot redirect a provider credential off its approved host.
  assert.throws(
    () =>
      createLlmClient({
        provider: 'openai',
        model: 'x',
        apiKey: 'secret',
        baseUrl: 'https://evil.example/v1',
      }),
    /not approved/,
  );
  // Managed mode is now supported, but fails closed without a proxy base URL + access token.
  assert.throws(
    () => createLlmClient({ provider: 'openrouter', model: 'x', managed: true }),
    /requires the backend proxy baseUrl/,
  );
  assert.throws(
    () =>
      createLlmClient({
        provider: 'openrouter',
        model: 'x',
        managed: true,
        baseUrl: 'https://proxy.example/agent/llm',
      }),
    /requires the backend proxy access token/,
  );
  // A non-https, non-loopback proxy URL is rejected (no plaintext token egress to a remote host).
  assert.throws(
    () =>
      createLlmClient({
        provider: 'openrouter',
        model: 'x',
        managed: true,
        baseUrl: 'http://proxy.example/agent/llm',
        apiKey: 'proxy-token',
      }),
    /must be https/,
  );
  // A well-formed managed config builds a client that uses the proxy token, never a provider key.
  const client = createLlmClient({
    provider: 'openrouter',
    model: 'x',
    managed: true,
    baseUrl: 'https://proxy.example/agent/llm',
    apiKey: 'proxy-token',
  });
  assert.equal(client.provider, 'managed');
});

test('HTTP helper retries a per-attempt timeout but honors caller cancellation', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    if (calls > 1) return new Response('ok', { status: 200 });
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(init.signal?.reason ?? new Error('aborted')),
        { once: true },
      );
    });
  }) as typeof fetch;
  try {
    const response = await fetchWithRetry(
      'https://api.openai.com/test',
      {},
      {
        attempts: 2,
        timeoutMs: 1,
      },
    );
    assert.equal(await response.text(), 'ok');
    assert.equal(calls, 2);

    const caller = new AbortController();
    caller.abort(new Error('caller stopped'));
    await assert.rejects(
      fetchWithRetry('https://api.openai.com/test', {}, { signal: caller.signal }),
      /caller stopped/,
    );
    assert.equal(calls, 2, 'an already-aborted caller must not start another request');
  } finally {
    globalThis.fetch = original;
  }
});
