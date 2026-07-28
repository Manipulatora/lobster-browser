import type { AgentLlmProvider } from '@lobster/shared-types';

/**
 * Discover the chat models a BYOK key can actually use. Doubles as a key VALIDATOR: an invalid/empty
 * key makes the provider's models endpoint return 401/403, which we surface as an error so the UI can
 * tell the user the key is bad before a run starts. Managed ("API") mode does NOT use this — it offers
 * a curated list (Opus 4.8 / Sonnet 5), so no provider round-trip or key is needed.
 */
export interface ListModelsConfig {
  provider: AgentLlmProvider;
  apiKey: string;
  baseUrl?: string;
}

interface OpenAiCompatibleModel {
  id?: string;
  /**
   * OpenRouter publishes the request parameters supported by at least one route for each model.
   * First-party `/models` endpoints generally do not, so this is intentionally optional.
   */
  supported_parameters?: string[];
}

// A web agent needs ordinary text generation plus structured tool calls. Provider model catalogs also
// contain embeddings, media generators, speech/realtime endpoints, safety classifiers, and specialist
// APIs that cannot satisfy that contract. Keep obviously incompatible families out of the selector.
const CLEARLY_NON_AGENT_MODEL =
  /(?:embed|dall[.-]?e|image|imagen|video|veo|sora|audio|voice|realtime|live|transcrib|whisper|tts|speech|moderation|rerank|guard|safety|search-preview|deep-research|instruct|codex|computer-use|operator)/i;

export async function listModels(config: ListModelsConfig): Promise<string[]> {
  if (!config.apiKey) throw new Error('an API key is required to list models');
  switch (config.provider) {
    case 'anthropic':
      return anthropicModels(config.apiKey);
    case 'openai':
      return openAiCompatModels(
        config.apiKey,
        'https://api.openai.com/v1',
        /^(?:gpt-|chatgpt-|o\d)/i,
      );
    case 'openrouter':
      return openAiCompatModels(config.apiKey, 'https://openrouter.ai/api/v1', null, true);
    case 'xai':
      return openAiCompatModels(config.apiKey, 'https://api.x.ai/v1', /^grok-/i);
    case 'google':
      return googleModels(config.apiKey);
    default: {
      const exhaustive: never = config.provider;
      throw new Error(`unknown provider ${String(exhaustive)}`);
    }
  }
}

async function anthropicModels(apiKey: string): Promise<string[]> {
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) throw new Error(await keyError('Anthropic', res));
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  return rank(
    (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string =>
        Boolean(id && id.startsWith('claude') && !CLEARLY_NON_AGENT_MODEL.test(id)),
      ),
  );
}

async function openAiCompatModels(
  apiKey: string,
  baseUrl: string,
  filter: RegExp | null,
  requireAgentParameters = false,
): Promise<string[]> {
  const res = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(await keyError('provider', res));
  const json = (await res.json()) as { data?: OpenAiCompatibleModel[] };
  const ids = (json.data ?? [])
    .filter((model) => {
      const id = model.id;
      if (!id || CLEARLY_NON_AGENT_MODEL.test(id) || (filter && !filter.test(id))) return false;
      if (!requireAgentParameters) return true;

      // OpenRouter is the only supported catalog that exposes capability metadata. Requiring the
      // complete request contract prevents BYOK users from selecting a chat-only model that will
      // inevitably reject the agent's tools/tool_choice/max_tokens payload.
      const parameters = new Set(model.supported_parameters ?? []);
      return (
        parameters.has('tools') && parameters.has('tool_choice') && parameters.has('max_tokens')
      );
    })
    .map((model) => model.id as string);
  return rank(ids);
}

async function googleModels(apiKey: string): Promise<string[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`,
  );
  if (!res.ok) throw new Error(await keyError('Google AI', res));
  const json = (await res.json()) as {
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  };
  const ids = (json.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => (m.name ?? '').replace(/^models\//, ''))
    .filter((id) => id.startsWith('gemini') && !CLEARLY_NON_AGENT_MODEL.test(id));
  return rank(ids);
}

async function keyError(label: string, res: Response): Promise<string> {
  if (res.status === 401 || res.status === 403)
    return `${label} rejected the API key (invalid or unauthorized)`;
  let detail = res.statusText;
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    detail = j.error?.message ?? detail;
  } catch {
    /* keep statusText */
  }
  return `${label} model list failed (${res.status}): ${detail}`;
}

/** Sort so the strongest/most-common models surface first, then alphabetical; de-duplicated. */
function rank(ids: string[]): string[] {
  const priority = /(opus|sonnet|gpt-4o|gpt-4\.1|o3|o4|gemini-2\.5|gemini-2\.0|grok-4|grok-3)/i;
  const seen = new Set<string>();
  const unique = ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  return unique.sort((a, b) => {
    const pa = priority.test(a) ? 0 : 1;
    const pb = priority.test(b) ? 0 : 1;
    return pa !== pb ? pa - pb : a.localeCompare(b);
  });
}
