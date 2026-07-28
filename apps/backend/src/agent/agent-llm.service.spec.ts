import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BadRequestException, GatewayTimeoutException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { AgentLlmService } from './agent-llm.service';

function createService(values: Record<string, unknown> = {}): AgentLlmService {
  const config = { get: (key: string): unknown => values[key] } as unknown as ConfigService;
  return new AgentLlmService(config);
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
      service.chatCompletion({
        model: 'openai/ask-model',
        messages: [],
        tools: [{ type: 'function' }],
        tool_choice: 'required',
      }),
      BadRequestException,
    );
    await assert.rejects(
      service.chatCompletion({ model: 'openai/not-real', messages: [] }),
      BadRequestException,
    );
    assert.equal(calls, 1);

    const claudeResult = await service.chatCompletion({
      model: 'anthropic/mandatory-thinking',
      messages: [],
      tools: [{ type: 'function' }],
      tool_choice: { type: 'function', function: { name: 'act' } },
      reasoning: { effort: 'medium' },
    });
    assert.equal(claudeResult.status, 200);
    assert.equal(completionBody.tool_choice, 'auto');
    assert.equal(calls, 2);

    const askResult = await service.chatCompletion({
      model: 'openai/ask-model',
      messages: [{ role: 'user', content: 'hello' }],
    });
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
      service.chatCompletion({ model: 'openai/tool-model', messages: [] }),
      GatewayTimeoutException,
    );

    const cancellation = new AbortController();
    cancellation.abort();
    await assert.rejects(
      service.chatCompletion({ model: 'openai/tool-model', messages: [] }, cancellation.signal),
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
    const result = await service.chatCompletion({
      model: 'openai/ask-model',
      messages: [{ role: 'user', content: 'private input' }],
    });
    assert.equal(result.status, 400);
    assert.match(warnings.join('\n'), /provider_error/);
    assert.match(warnings.join('\n'), /request-123/);
    assert.doesNotMatch(warnings.join('\n'), /secret prompt|private input/);
  } finally {
    globalThis.fetch = original;
  }
});
