import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BadRequestException,
  GatewayTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type {
  AgentChargeRequest,
  AgentChargeResult,
  AgentSpendService,
} from '../billing/agent-spend.service';
import type { AgentPrincipal } from './agent-auth.guard';
import { AgentLlmService } from './agent-llm.service';
import { AgentRefusalException } from './agent-refusal';

/** The spender every test bills to, unless it is testing what happens when it may not. */
const PRINCIPAL: AgentPrincipal = { userId: 'user-1', teamId: 'team-1', tier: 'plus' };

/**
 * Stands in for `AgentSpendService`, recording what it was asked to charge. The arithmetic is the
 * billing module's own concern and tested there; what matters here is WHICH figures the proxy hands
 * over — that is where the under-metering lived.
 */
class FakeSpend {
  readonly charges: AgentChargeRequest[] = [];
  priced = true;
  affordable = true;
  balanceCents = 500;
  requiredCents = 2;

  estimateMicros(args: { tokensIn: number; maxTokensOut: number }): number | undefined {
    return this.priced ? args.tokensIn * 2 + args.maxTokensOut : undefined;
  }

  async canAfford(): Promise<{ ok: boolean; balanceCents: number; requiredCents: number }> {
    return {
      ok: this.affordable,
      balanceCents: this.balanceCents,
      requiredCents: this.requiredCents,
    };
  }

  async charge(request: AgentChargeRequest): Promise<AgentChargeResult> {
    this.charges.push(request);
    return {
      priced: true,
      costMicros: 100,
      chargedCents: 0,
      pendingMicros: 100,
      unpaidCents: 0,
    };
  }

  async listUsage(): Promise<[]> {
    return [];
  }
}

function createService(
  values: Record<string, unknown> = {},
  spend: FakeSpend = new FakeSpend(),
): AgentLlmService {
  const config = { get: (key: string): unknown => values[key] } as unknown as ConfigService;
  return new AgentLlmService(config, spend as unknown as AgentSpendService);
}

/** Drain a streamed body the way the controller does, returning the bytes the client would see. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const received: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received.push(decoder.decode(value));
  }
  return received.join('');
}

function modelCatalog(): { data: Array<Record<string, unknown>> } {
  return {
    data: [
      {
        id: 'openai/tool-model',
        name: 'Tool Model',
        context_length: 128_000,
        supported_parameters: ['max_tokens', 'tools', 'tool_choice', 'reasoning'],
        architecture: { output_modalities: ['text'] },
        reasoning: { supported_efforts: ['low', 'medium', 'unsupported'] },
      },
      {
        id: 'openai/ask-model',
        name: 'Ask Model',
        supported_parameters: ['max_tokens'],
        architecture: { output_modalities: ['text'] },
      },
      {
        id: 'openai/unbounded-model',
        name: 'Unbounded Model',
        supported_parameters: ['temperature'],
        architecture: { output_modalities: ['text'] },
      },
      {
        id: 'anthropic/mandatory-thinking',
        name: 'Mandatory Thinking',
        supported_parameters: ['max_tokens', 'tools', 'tool_choice', 'reasoning'],
        architecture: { output_modalities: ['text'] },
        reasoning: { mandatory: true, supported_efforts: ['high'] },
      },
      {
        id: 'google/image-only',
        name: 'Image Only',
        supported_parameters: ['max_tokens'],
        architecture: { output_modalities: ['image'] },
      },
    ],
  };
}

test('model roster separates Ask compatibility from Agent tool capability', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(modelCatalog()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  try {
    const service = createService({ OPENROUTER_API_KEY: 'server-secret' });
    const result = await service.listModels();
    assert.equal(result.stale, false);
    assert.equal(
      result.models.some((model) => model.id === 'google/image-only'),
      false,
    );
    assert.equal(
      result.models.some((model) => model.id === 'openai/unbounded-model'),
      false,
    );

    const agent = result.models.find((model) => model.id === 'openai/tool-model');
    assert.equal(agent?.available, true);
    assert.equal(agent?.agentCapable, true);
    assert.deepEqual(agent?.efforts, ['low', 'medium']);

    const ask = result.models.find((model) => model.id === 'openai/ask-model');
    assert.equal(ask?.available, true);
    assert.equal(ask?.agentCapable, false);
    assert.deepEqual(ask?.efforts, []);

    const mandatory = result.models.find((model) => model.id === 'anthropic/mandatory-thinking');
    assert.equal(mandatory?.agentCapable, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('model roster does not invent selectable fallback models without a configured key', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('must not fetch');
  }) as typeof fetch;
  try {
    const result = await createService().listModels();
    assert.equal(result.stale, true);
    assert.deepEqual(result.models, []);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('managed completion gates incompatible models and normalizes Claude tool choice', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  let completionBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify(modelCatalog()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    completionBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: 'answer' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const service = createService({ OPENROUTER_API_KEY: 'server-secret' });
    await service.listModels();
    await assert.rejects(
      service.chatCompletion(
        {
          model: 'openai/ask-model',
          messages: [],
          tools: [{ type: 'function' }],
          tool_choice: 'required',
        },
        PRINCIPAL,
      ),
      BadRequestException,
    );
    await assert.rejects(
      service.chatCompletion({ model: 'openai/not-real', messages: [] }, PRINCIPAL),
      BadRequestException,
    );
    assert.equal(calls, 1);

    const claudeResult = await service.chatCompletion(
      {
        model: 'anthropic/mandatory-thinking',
        messages: [],
        tools: [{ type: 'function' }],
        tool_choice: { type: 'function', function: { name: 'act' } },
        reasoning: { effort: 'medium' },
      },
      PRINCIPAL,
    );
    assert.equal(claudeResult.status, 200);
    assert.equal(completionBody.tool_choice, 'auto');
    assert.equal(calls, 2);

    const askResult = await service.chatCompletion(
      { model: 'openai/ask-model', messages: [{ role: 'user', content: 'hello' }] },
      PRINCIPAL,
    );
    assert.equal(askResult.status, 200);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test('managed completion has a hard timeout and aborts on caller cancellation', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify(modelCatalog()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }) as typeof fetch;
  try {
    const service = createService({
      OPENROUTER_API_KEY: 'server-secret',
      AGENT_UPSTREAM_TIMEOUT_MS: 5,
    });
    await service.listModels();
    await assert.rejects(
      service.chatCompletion({ model: 'openai/tool-model', messages: [] }, PRINCIPAL),
      GatewayTimeoutException,
    );

    const cancellation = new AbortController();
    cancellation.abort();
    await assert.rejects(
      service.chatCompletion(
        { model: 'openai/tool-model', messages: [] },
        PRINCIPAL,
        cancellation.signal,
      ),
      /upstream OpenRouter request failed/,
    );
    assert.equal(calls, 2, 'pre-cancelled requests must not start another upstream fetch');
  } finally {
    globalThis.fetch = original;
  }
});

test('upstream error logs retain codes but never provider messages', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify(modelCatalog()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        error: { code: 'provider_error', message: 'secret prompt must not be logged' },
      }),
      {
        status: 400,
        headers: { 'content-type': 'application/json', 'x-request-id': 'request-123' },
      },
    );
  }) as typeof fetch;
  try {
    const service = createService({ OPENROUTER_API_KEY: 'server-secret' });
    const warnings: string[] = [];
    (service as unknown as { logger: { warn: (message: string) => void } }).logger = {
      warn: (message: string): void => {
        warnings.push(message);
      },
    };
    await service.listModels();
    const result = await service.chatCompletion(
      { model: 'openai/ask-model', messages: [{ role: 'user', content: 'private input' }] },
      PRINCIPAL,
    );
    assert.equal(result.status, 400);
    assert.match(warnings.join('\n'), /provider_error/);
    assert.match(warnings.join('\n'), /request-123/);
    assert.doesNotMatch(warnings.join('\n'), /secret prompt|private input/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a streamed completion pipes SSE through untouched and still meters usage', async () => {
  const original = globalThis.fetch;
  let forwarded: Record<string, unknown> = {};
  const frames = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":21,"completion_tokens":6,"cost":0.00042,"prompt_tokens_details":{"cached_tokens":5}}}\n\n',
    'data: [DONE]\n\n',
  ];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('/models')) {
      return new Response(JSON.stringify(modelCatalog()), { status: 200 });
    }
    forwarded = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof fetch;

  try {
    const spend = new FakeSpend();
    const service = createService({ OPENROUTER_API_KEY: 'server-key' }, spend);
    const { status, stream } = await service.chatCompletionStream(
      { model: 'openai/ask-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
      PRINCIPAL,
    );
    assert.equal(status, 200);
    assert.ok(stream);

    // Usage must be requested, or a streamed run would silently go unbilled.
    assert.deepEqual(forwarded.stream_options, { include_usage: true });
    assert.deepEqual(forwarded.usage, { include: true });
    assert.equal(forwarded.stream, true);

    // Bytes reach the client exactly as they arrived — the proxy must not reshape frames.
    assert.equal(await drain(stream!), frames.join(''));

    assert.equal(spend.charges.length, 1);
    const [charge] = spend.charges;
    // Input, cached input and output are carried SEPARATELY: they are billed at three different
    // rates, so a single summed figure cannot be priced.
    assert.equal(charge.tokensIn, 21);
    assert.equal(charge.tokensOut, 6);
    assert.equal(charge.cachedIn, 5);
    assert.equal(charge.providerCostUsd, 0.00042);
    assert.equal(charge.teamId, 'team-1');
    assert.equal(charge.userId, 'user-1');
  } finally {
    globalThis.fetch = original;
  }
});

test('a streamed answer whose usage chunk never arrives is still charged for', async () => {
  const original = globalThis.fetch;
  // No usage frame and no [DONE]: the shape of an upstream that truncated, or a run the panel
  // closed part-way. The generation happened and the provider billed us for it.
  const frames = [
    'data: {"choices":[{"delta":{"content":"0123456789012345"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"0123456789012345"}}]}\n\n',
  ];
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/models')) {
      return new Response(JSON.stringify(modelCatalog()), { status: 200 });
    }
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof fetch;

  try {
    const spend = new FakeSpend();
    const service = createService({ OPENROUTER_API_KEY: 'server-key' }, spend);
    const { stream } = await service.chatCompletionStream(
      { model: 'openai/ask-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
      PRINCIPAL,
    );
    await drain(stream!);

    assert.equal(spend.charges.length, 1, 'an unmeasured stream must not be served for free');
    const [charge] = spend.charges;
    // 32 delta characters at four characters per token, counted once each — a rolling re-scan
    // would bill the same frames several times over.
    assert.equal(charge.tokensOut, 8);
    assert.ok(charge.tokensIn > 0, 'the prompt estimate stands in for the missing input figure');
    assert.equal(charge.providerCostUsd, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('a client that walks away mid-stream is charged for what was generated', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/models')) {
      return new Response(JSON.stringify(modelCatalog()), { status: 200 });
    }
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"abcd"}}]}\n\n'),
          );
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof fetch;

  try {
    const spend = new FakeSpend();
    const service = createService({ OPENROUTER_API_KEY: 'server-key' }, spend);
    const { stream } = await service.chatCompletionStream(
      { model: 'openai/ask-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
      PRINCIPAL,
    );
    const reader = stream!.getReader();
    await reader.read();
    await reader.cancel();

    assert.equal(spend.charges.length, 1, 'a closed panel is not a refund');
    assert.equal(spend.charges[0].tokensOut, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('a non-2xx upstream that reports usage is charged for the generation it billed us', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/models')) {
      return new Response(JSON.stringify(modelCatalog()), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        error: { code: 'upstream_cutoff' },
        usage: { prompt_tokens: 400, completion_tokens: 120, cost: 0.0031 },
      }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const spend = new FakeSpend();
    const service = createService({ OPENROUTER_API_KEY: 'server-key' }, spend);
    const result = await service.chatCompletion(
      { model: 'openai/ask-model', messages: [{ role: 'user', content: 'hi' }] },
      PRINCIPAL,
    );
    assert.equal(result.status, 502);
    assert.equal(spend.charges.length, 1);
    assert.equal(spend.charges[0].tokensOut, 120);
    assert.equal(spend.charges[0].providerCostUsd, 0.0031);
  } finally {
    globalThis.fetch = original;
  }
});

test('a failure that generated nothing is charged for nothing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/models')) {
      return new Response(JSON.stringify(modelCatalog()), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429 });
  }) as typeof fetch;

  try {
    const spend = new FakeSpend();
    const service = createService({ OPENROUTER_API_KEY: 'server-key' }, spend);
    const result = await service.chatCompletion(
      { model: 'openai/ask-model', messages: [{ role: 'user', content: 'hi' }] },
      PRINCIPAL,
    );
    assert.equal(result.status, 429);
    assert.deepEqual(spend.charges, []);
  } finally {
    globalThis.fetch = original;
  }
});

test('a team that cannot afford the next call is refused before the upstream is contacted', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/models')) {
      return new Response(JSON.stringify(modelCatalog()), { status: 200 });
    }
    throw new Error('an unaffordable call must never reach the provider');
  }) as typeof fetch;

  try {
    const spend = new FakeSpend();
    spend.affordable = false;
    spend.balanceCents = 3;
    spend.requiredCents = 11;
    const service = createService({ OPENROUTER_API_KEY: 'server-key' }, spend);
    await assert.rejects(
      service.chatCompletion(
        { model: 'openai/ask-model', messages: [{ role: 'user', content: 'hi' }] },
        PRINCIPAL,
      ),
      (error: unknown) => {
        assert.ok(error instanceof AgentRefusalException);
        // 402, not 403: an empty wallet is a top-up, not an upgrade, and the panel branches on it.
        assert.equal(error.getStatus(), 402);
        assert.equal(error.body.reason, 'insufficient_credit');
        assert.equal(error.body.balanceCents, 3);
        assert.equal(error.body.requiredCents, 11);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('a model with no known price is refused rather than served at a guessed rate', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/models')) {
      return new Response(JSON.stringify(modelCatalog()), { status: 200 });
    }
    throw new Error('an unpriced model must never reach the provider');
  }) as typeof fetch;

  try {
    const spend = new FakeSpend();
    spend.priced = false;
    const service = createService({ OPENROUTER_API_KEY: 'server-key' }, spend);
    await assert.rejects(
      service.chatCompletion(
        { model: 'openai/ask-model', messages: [{ role: 'user', content: 'hi' }] },
        PRINCIPAL,
      ),
      (error: unknown) => {
        assert.ok(error instanceof AgentRefusalException);
        assert.equal(error.body.reason, 'model_unpriced');
        assert.equal(error.body.model, 'openai/ask-model');
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('a client cannot switch its own billing off through the forwarded body', async () => {
  const original = globalThis.fetch;
  let forwarded: Record<string, unknown> = {};
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes('/models')) {
      return new Response(JSON.stringify(modelCatalog()), { status: 200 });
    }
    forwarded = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 1 } }), {
      status: 200,
    });
  }) as typeof fetch;

  try {
    const service = createService({ OPENROUTER_API_KEY: 'server-key' });
    await service.chatCompletion(
      {
        model: 'openai/ask-model',
        messages: [{ role: 'user', content: 'hi' }],
        usage: { include: false },
        max_tokens: 1_000_000,
      },
      PRINCIPAL,
    );
    assert.deepEqual(forwarded.usage, { include: true });
    assert.equal(forwarded.max_tokens, 8192);
  } finally {
    globalThis.fetch = original;
  }
});

test('a streamed request for a model outside the roster is refused before any bytes flow', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/models')) {
      return new Response(JSON.stringify(modelCatalog()), { status: 200 });
    }
    throw new Error('upstream must not be contacted for a disallowed model');
  }) as typeof fetch;
  try {
    const service = createService({ OPENROUTER_API_KEY: 'server-key' });
    await assert.rejects(
      service.chatCompletionStream(
        { model: 'evil/model', messages: [{ role: 'user', content: 'hi' }], stream: true },
        PRINCIPAL,
      ),
      BadRequestException,
    );
  } finally {
    globalThis.fetch = original;
  }
});

/** Silences the service's logger and records what it said, so a test can assert on the loud line. */
function captureLogs(service: AgentLlmService): { warn: string[]; error: string[] } {
  const captured = { warn: [] as string[], error: [] as string[] };
  (
    service as unknown as {
      logger: { warn: (m: string) => void; error: (m: string) => void; log: (m: string) => void };
    }
  ).logger = {
    warn: (message: string): void => void captured.warn.push(message),
    error: (message: string): void => void captured.error.push(message),
    log: (): void => {},
  };
  return captured;
}

/** A catalog answer plus one upstream failure of the caller's choosing. */
function stubUpstream(status: number, body: unknown): typeof fetch {
  return (async (input: unknown) => {
    if (String(input).includes('/models')) {
      return new Response(JSON.stringify(modelCatalog()), { status: 200 });
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'or-req-9' },
    });
  }) as typeof fetch;
}

test('a rejected OPERATOR key is not the caller’s agent token going stale', async () => {
  const original = globalThis.fetch;
  // What OpenRouter actually answers to a revoked or deleted key. The caller's agent token never
  // reaches OpenRouter, so this 401 cannot be about it — but passed through verbatim it was
  // indistinguishable from the proxy's own 401, and the sidecar spent its one retry re-minting a
  // token that was never the problem before telling the user their credential was rejected.
  globalThis.fetch = stubUpstream(401, {
    error: { code: 'invalid_api_key', message: 'No auth credentials found' },
  });

  try {
    const spend = new FakeSpend();
    const service = createService({ OPENROUTER_API_KEY: 'server-key-placeholder' }, spend);
    await service.listModels();
    const logs = captureLogs(service);
    const result = await service.chatCompletion(
      { model: 'openai/ask-model', messages: [{ role: 'user', content: 'hi' }] },
      PRINCIPAL,
    );

    // 401/402/403 belong to THIS proxy's own decisions. An upstream credential failure must not be
    // able to wear one of them, or the client cannot tell whose credential was refused.
    assert.equal(result.status, 503);
    const body = result.body as {
      error: { code: string; message: string };
      operatorFault: boolean;
      reason: string;
    };
    assert.equal(body.error.code, 'upstream_unavailable');
    assert.equal(body.operatorFault, true);
    assert.equal(body.reason, 'operator_key_rejected');
    assert.equal(
      body.error.message,
      'Lobee is temporarily unavailable — this is on our side, not yours; nothing was charged.',
    );
    // Not "the model credential was rejected", and not a word about the user's own credential.
    assert.doesNotMatch(JSON.stringify(body), /credential was rejected|your (token|key)/i);
    // The provider's own sentence is not forwarded: OpenRouter quotes the operator's key URL in it.
    assert.doesNotMatch(JSON.stringify(body), /No auth credentials found/);
    // Nothing generated, nothing charged.
    assert.deepEqual(spend.charges, []);
    // And the operator hears about it, loudly — nobody else can end this outage.
    assert.match(logs.error.join('\n'), /OPERATOR_FAULT reason=operator_key_rejected/);
    assert.match(logs.error.join('\n'), /OPENROUTER_API_KEY/);
  } finally {
    globalThis.fetch = original;
  }
});

test('an exhausted OPERATOR balance is an outage, not the customer’s empty wallet', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = stubUpstream(402, {
    error: { code: 'insufficient_credits', message: 'Insufficient credits. Add more using ...' },
  });

  try {
    const spend = new FakeSpend();
    const service = createService({ OPENROUTER_API_KEY: 'server-key-placeholder' }, spend);
    await service.listModels();
    const logs = captureLogs(service);
    const result = await service.chatCompletion(
      { model: 'openai/ask-model', messages: [{ role: 'user', content: 'hi' }] },
      PRINCIPAL,
    );

    // A 402 from OpenRouter is the OPERATOR's account, and the customer's wallet is irrelevant to
    // it. Passed through, it reached the panel as "Your Credit has run out — top up", which invoices
    // the operator's unpaid bill to a customer who owes nothing.
    assert.equal(result.status, 503, 'the upstream 402 must not survive as a customer-facing 402');
    const serialised = JSON.stringify(result.body);
    assert.doesNotMatch(serialised, /insufficient_credit\b/);
    assert.doesNotMatch(serialised, /top up/i);
    assert.match(serialised, /"reason":"operator_out_of_funds"/);
    assert.deepEqual(spend.charges, []);
    assert.match(logs.error.join('\n'), /OPERATOR_FAULT reason=operator_out_of_funds/);
  } finally {
    globalThis.fetch = original;
  }
});

test('our own billing refusal still says insufficient_credit, and still says 402', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).includes('/models')) {
      return new Response(JSON.stringify(modelCatalog()), { status: 200 });
    }
    throw new Error('an unaffordable call must never reach the provider');
  }) as typeof fetch;

  try {
    const spend = new FakeSpend();
    spend.affordable = false;
    spend.balanceCents = 1;
    spend.requiredCents = 9;
    const service = createService({ OPENROUTER_API_KEY: 'server-key-placeholder' }, spend);
    await assert.rejects(
      service.chatCompletion(
        { model: 'openai/ask-model', messages: [{ role: 'user', content: 'hi' }] },
        PRINCIPAL,
      ),
      (error: unknown) => {
        // The half that must NOT change: a wallet WE computed as empty is still the customer's own
        // product state, with a top-up as its next action. Only the provider's 402 was ever a lie.
        assert.ok(error instanceof AgentRefusalException);
        assert.equal(error.getStatus(), 402);
        assert.equal(error.body.reason, 'insufficient_credit');
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('a streamed call hits the same translation before a single byte is written', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = stubUpstream(401, { error: { message: 'User not found.' } });

  try {
    const service = createService({ OPENROUTER_API_KEY: 'server-key-placeholder' });
    await service.listModels();
    captureLogs(service);
    const { status, stream, body } = await service.chatCompletionStream(
      { model: 'openai/ask-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
      PRINCIPAL,
    );

    // The failure branch is the one where there is no stream to pipe, so the status line is still
    // ours to choose; the piping path itself is untouched.
    assert.equal(stream, null);
    assert.equal(status, 503);
    assert.equal((body as { operatorFault: boolean }).operatorFault, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('an upstream 403 that is about the request is not reported as an operator outage', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = stubUpstream(403, {
    error: { code: 'moderation', message: 'This request was flagged by the provider.' },
  });

  try {
    const service = createService({ OPENROUTER_API_KEY: 'server-key-placeholder' });
    await service.listModels();
    const logs = captureLogs(service);
    const result = await service.chatCompletion(
      { model: 'openai/ask-model', messages: [{ role: 'user', content: 'hi' }] },
      PRINCIPAL,
    );

    // Still not a 403 — that status is `planRequired`'s, and returning it here would have put an
    // "upgrade your package" screen in front of a moderation decision. But it is not an outage
    // either, so it is neither logged as one nor latched as one.
    assert.equal(result.status, 502);
    assert.equal((result.body as { operatorFault: boolean }).operatorFault, false);
    assert.deepEqual(logs.error, []);
  } finally {
    globalThis.fetch = original;
  }
});

test('a backend with no operator key says so to its operator, not to its users', async () => {
  const service = createService({});
  const logs = captureLogs(service);

  // Boot: named, prominent, and NOT fatal — this key powers one module, and failing the whole
  // process would take sign-in, profile sync and billing down with it (and fail the readiness probe
  // systemd's ExecStartPost polls).
  service.onModuleInit();
  assert.match(logs.warn.join('\n'), /OPENROUTER_API_KEY is not set/);
  assert.match(logs.warn.join('\n'), /DISABLED/);

  // First request: the user gets one honest sentence, and the variable name stays in the journal.
  await assert.rejects(
    service.chatCompletion(
      { model: 'openai/ask-model', messages: [{ role: 'user', content: 'hi' }] },
      PRINCIPAL,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.equal(
        error.message,
        'Lobee is temporarily unavailable — this is on our side, not yours; nothing was charged.',
      );
      assert.doesNotMatch(error.message, /OPENROUTER_API_KEY/);
      return true;
    },
  );
  assert.match(logs.error.join('\n'), /OPERATOR_FAULT reason=key_missing/);
});

test('a generation the OPERATOR’s key ran out under is not billed to the customer', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = stubUpstream(403, {
    error: { code: 'key_limit', message: 'Key limit exceeded (total limit).' },
    usage: { prompt_tokens: 900, completion_tokens: 240, cost: 0.004 },
  });

  try {
    const spend = new FakeSpend();
    const service = createService({ OPENROUTER_API_KEY: 'server-key-placeholder' }, spend);
    await service.listModels();
    captureLogs(service);
    const result = await service.chatCompletion(
      { model: 'openai/ask-model', messages: [{ role: 'user', content: 'hi' }] },
      PRINCIPAL,
    );

    assert.equal(result.status, 503);
    assert.match(JSON.stringify(result.body), /"reason":"operator_key_limited"/);
    // The usual rule meters a part-generated answer the provider billed us for. Here it is waived on
    // purpose: the user is being told "nothing was charged", and that has to be true, not nearly
    // true. It is the operator's ceiling that stopped this, and the operator eats the fraction.
    assert.deepEqual(spend.charges, []);
  } finally {
    globalThis.fetch = original;
  }
});
