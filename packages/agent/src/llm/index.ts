import type { AgentLlmConfig } from '@lobster/shared-types';
import type { LlmClient } from './types.js';
import { AnthropicClient } from './anthropic.js';
import { GoogleClient } from './google.js';
import { OpenAiCompatibleClient } from './openai-compatible.js';

export type { LlmClient, LlmRequest, LlmResult, LlmTool, LlmToolCall } from './types.js';
export { listModels } from './models.js';
export type { ListModelsConfig } from './models.js';
export { AnthropicClient } from './anthropic.js';
export { GoogleClient } from './google.js';
export { OpenAiCompatibleClient } from './openai-compatible.js';

/**
 * Build the LLM client from its {@link AgentLlmConfig}. Managed mode routes through the backend proxy
 * (server holds the OpenRouter key + meters); BYOK builds a small direct raw-fetch client per provider.
 */
export function createLlmClient(config: AgentLlmConfig): LlmClient {
  if (config.managed) return managedClient(config);
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicClient({
        apiKey: requireKey(config, 'anthropic'),
        baseUrl: providerBaseUrl(config.baseUrl, 'https://api.anthropic.com', [
          'api.anthropic.com',
        ]),
        ...(config.model ? { model: config.model } : {}),
      });
    case 'openai':
      return compatible(config, 'https://api.openai.com/v1');
    case 'openrouter':
      return compatible(config, 'https://openrouter.ai/api/v1');
    case 'xai':
      return compatible(config, 'https://api.x.ai/v1');
    case 'google':
      if (config.managed)
        throw new Error('managed LLM mode is unavailable: no authenticated proxy is configured');
      return new GoogleClient({
        apiKey: requireKey(config, 'google'),
        model: config.model,
        baseUrl: providerBaseUrl(
          config.baseUrl,
          'https://generativelanguage.googleapis.com/v1beta',
          ['generativelanguage.googleapis.com'],
        ),
      });
    default: {
      const exhaustive: never = config.provider;
      throw new Error(`unknown LLM provider ${String(exhaustive)}`);
    }
  }
}

/**
 * Managed mode: talk to the backend agent-LLM proxy (OpenAI-compatible) with the proxy access token —
 * NOT an OpenRouter key. The server holds the real key and meters usage, so no provider credential ever
 * reaches the sidecar/desktop. `baseUrl` + `apiKey` are injected by the trusted desktop core (from
 * config/env), never by the model, so the model cannot redirect the token elsewhere.
 */
function managedClient(config: AgentLlmConfig): LlmClient {
  if (!config.baseUrl) throw new Error('managed mode requires the backend proxy baseUrl');
  if (!config.apiKey) throw new Error('managed mode requires the backend proxy access token');
  return new OpenAiCompatibleClient({
    provider: 'managed',
    apiKey: config.apiKey,
    baseUrl: managedBaseUrl(config.baseUrl),
    model: config.model,
  });
}

/** Validate the managed proxy base URL: https (or http on loopback for dev), no credentials/query/hash. */
function managedBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('invalid managed proxy base URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('managed proxy base URL must be https (or http on localhost)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('managed proxy base URL must not contain credentials, query, or fragments');
  }
  return url.toString().replace(/\/$/, '');
}

function compatible(config: AgentLlmConfig, baseUrl: string): LlmClient {
  if (config.managed)
    throw new Error('managed LLM mode is unavailable: no authenticated proxy is configured');
  const allowedHosts: Record<string, string[]> = {
    openai: ['api.openai.com'],
    openrouter: ['openrouter.ai'],
    xai: ['api.x.ai'],
  };
  return new OpenAiCompatibleClient({
    provider: config.provider,
    apiKey: requireKey(config, config.provider),
    baseUrl: providerBaseUrl(config.baseUrl, baseUrl, allowedHosts[config.provider] ?? []),
    model: config.model,
  });
}

/** Prevent an untrusted RPC caller from redirecting a provider credential to an arbitrary endpoint. */
function providerBaseUrl(
  override: string | undefined,
  fallback: string,
  allowedHosts: string[],
): string {
  const value = override ?? fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('invalid LLM provider base URL');
  }
  if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(
      `LLM base URL host is not approved for this provider: ${url.hostname || value}`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('LLM base URL must not contain credentials, query parameters, or fragments');
  }
  return url.toString().replace(/\/$/, '');
}

function requireKey(config: AgentLlmConfig, provider: string): string {
  if (config.managed) {
    throw new Error(`managed mode routes ${provider} through the backend proxy, not a direct key`);
  }
  if (!config.apiKey) throw new Error(`${provider} BYOK requires an API key`);
  return config.apiKey;
}
