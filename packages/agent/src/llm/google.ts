import type { LlmClient, LlmMessage, LlmRequest, LlmResult, LlmToolCall } from './types.js';
import { fetchWithRetry } from './http.js';

export class GoogleClient implements LlmClient {
  readonly provider = 'google';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(opts: { apiKey: string; baseUrl?: string; model: string }) {
    if (!opts.apiKey) throw new Error('Google BYOK requires an API key');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(
      /\/$/,
      '',
    );
    this.defaultModel = opts.model;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const model = encodeURIComponent(req.model || this.defaultModel);
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGoogleContents(req.messages),
      ...(req.tools.length
        ? {
            tools: [
              {
                functionDeclarations: req.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                })),
              },
            ],
            toolConfig: {
              functionCallingConfig: req.forceTool
                ? { mode: 'ANY', allowedFunctionNames: [req.forceTool] }
                : { mode: 'AUTO' },
            },
          }
        : {}),
      generationConfig: { maxOutputTokens: req.maxTokens },
    };
    const response = await fetchWithRetry(
      `${this.baseUrl}/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
      },
      { ...(req.signal ? { signal: req.signal } : {}) },
    );
    if (!response.ok) throw new Error(`google ${response.status}: ${await safeError(response)}`);
    const json = (await response.json()) as GoogleResponse;
    const candidate = json.candidates?.[0];
    let toolCall: LlmToolCall | undefined;
    let text = '';
    for (const part of candidate?.content?.parts ?? []) {
      if (!toolCall && part.functionCall?.name) {
        // Google correlates a response to a call BY NAME rather than by id, so the neutral id is the
        // name — round-tripping it through `toGoogleContents` reproduces exactly what Google expects.
        toolCall = {
          id: part.functionCall.name,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        };
      }
      if (part.text) text += part.text;
    }
    const usage = json.usageMetadata ?? {};
    return {
      ...(toolCall ? { toolCall } : {}),
      ...(text ? { text } : {}),
      stopReason: normalizeStop(candidate?.finishReason, Boolean(toolCall)),
      usage: {
        tokensIn: usage.promptTokenCount ?? 0,
        tokensOut: usage.candidatesTokenCount ?? 0,
        ...(usage.cachedContentTokenCount !== undefined
          ? { cachedTokensIn: usage.cachedContentTokenCount }
          : {}),
      },
    };
  }
}

/**
 * Map the neutral message list onto Google's `contents`.
 *
 * Three shape differences matter: the assistant role is spelled `model`; a tool result is a
 * `functionResponse` part inside a **user** turn; and the response is matched to its call by NAME, not
 * by an id — so we look back for the call this result answers and reuse that name. Consecutive results
 * merge into one turn, mirroring the Anthropic rule.
 */
function toGoogleContents(messages: readonly LlmMessage[]): Array<Record<string, unknown>> {
  const out: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];
  /** Call id → tool name, so a later result can be addressed the way Google requires. */
  const callNames = new Map<string, string>();

  for (const message of messages) {
    if (message.role === 'tool') {
      const name = callNames.get(message.toolCallId) ?? message.toolCallId;
      const part = {
        functionResponse: { name, response: { result: message.content } },
      };
      const last = out.at(-1);
      if (last?.role === 'user' && last.parts.every((p) => 'functionResponse' in p)) {
        last.parts.push(part);
      } else {
        out.push({ role: 'user', parts: [part] });
      }
      continue;
    }
    if (message.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      if (message.content?.trim()) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        callNames.set(call.id, call.name);
        parts.push({ functionCall: { name: call.name, args: call.input } });
      }
      if (parts.length) out.push({ role: 'model', parts });
      continue;
    }
    const parts: Array<Record<string, unknown>> = [{ text: message.content }];
    for (const image of message.images ?? []) {
      parts.push({ inlineData: { mimeType: image.mediaType, data: image.data } });
    }
    out.push({ role: 'user', parts });
  }
  return out;
}

interface GoogleResponse {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: { name?: string; args?: Record<string, unknown> };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

function normalizeStop(reason: string | undefined, hasToolCall: boolean): string {
  if (reason === 'STOP') return hasToolCall ? 'tool' : 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'SAFETY' || reason === 'BLOCKLIST' || reason === 'PROHIBITED_CONTENT')
    return 'refusal';
  return reason?.toLowerCase() ?? 'unknown';
}

async function safeError(response: Response): Promise<string> {
  try {
    const json = (await response.json()) as { error?: { message?: string } };
    return json.error?.message ?? response.statusText;
  } catch {
    return response.statusText;
  }
}
