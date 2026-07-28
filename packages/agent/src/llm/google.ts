import type { LlmClient, LlmRequest, LlmResult, LlmToolCall } from './types.js';
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
    const parts: Array<Record<string, unknown>> = [{ text: req.user }];
    for (const image of req.images ?? []) {
      parts.push({ inlineData: { mimeType: image.mediaType, data: image.data } });
    }
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts }],
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
        toolCall = { name: part.functionCall.name, input: part.functionCall.args ?? {} };
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
