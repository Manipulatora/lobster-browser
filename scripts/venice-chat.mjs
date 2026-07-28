#!/usr/bin/env node
/**
 * Venice AI smoke test — OpenAI-compatible /chat/completions.
 *
 * Usage (from repo root):
 *   node --env-file=.env scripts/venice-chat.mjs
 *   npm run venice:chat
 *
 * Docs: https://docs.venice.ai
 */
import OpenAI from 'openai';

const VENICE_BASE_URL = 'https://api.venice.ai/api/v1';
const VENICE_MODEL = 'zai-org-glm-5-2';

function createVeniceClient() {
  const apiKey = process.env.VENICE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing VENICE_API_KEY. Copy .env.example to .env and set your key, then run with --env-file=.env',
    );
  }

  return new OpenAI({
    apiKey,
    baseURL: VENICE_BASE_URL,
  });
}

async function main() {
  const client = createVeniceClient();

  const response = await client.chat.completions.create({
    model: VENICE_MODEL,
    messages: [
      { role: 'system', content: 'Reply in one short sentence.' },
      { role: 'user', content: 'Say hello and confirm you are working.' },
    ],
    max_tokens: 64,
  });

  const text = response.choices[0]?.message?.content?.trim() ?? '(empty)';
  console.log(`model: ${response.model ?? VENICE_MODEL}`);
  console.log(`reply: ${text}`);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
