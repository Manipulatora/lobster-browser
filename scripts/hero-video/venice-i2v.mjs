import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const [model, duration, promptPath, referencePath, outputPath] = process.argv.slice(2);
if (!model || !duration || !promptPath || !referencePath || !outputPath) {
  throw new Error(
    'Usage: node venice-i2v.mjs MODEL DURATION PROMPT_FILE REFERENCE_IMAGE OUTPUT_FILE',
  );
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});
rl.stdoutMuted = true;
rl._writeToOutput = function _writeToOutput() {};
const apiKey = await new Promise((resolve) => rl.question('', (value) => resolve(value.trim())));
rl.close();
if (!apiKey) throw new Error('No API key was provided.');

const prompt = (await fs.readFile(promptPath, 'utf8')).trim();
const reference = await fs.readFile(referencePath);
const extension = path.extname(referencePath).toLowerCase();
const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png';
const imageUrl = `data:${mime};base64,${reference.toString('base64')}`;
const base = 'https://api.venice.ai/api/v1';
const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

async function jsonRequest(endpoint, body) {
  const response = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(`${endpoint} returned ${response.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

const quote = await jsonRequest('/video/quote', { model, duration, audio: false });
console.log(`QUOTE_USD ${quote.quote}`);

const queued = await jsonRequest('/video/queue', {
  model,
  prompt,
  duration,
  audio: false,
  image_url: imageUrl,
});
const queueId = queued.queue_id ?? queued.id;
if (!queueId) throw new Error(`Queue response has no queue id: ${JSON.stringify(queued)}`);
console.log(`QUEUED ${queueId}`);

let videoBuffer;
let polls = 0;
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  polls += 1;
  const response = await fetch(`${base}/video/retrieve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, queue_id: queueId, delete_media_on_completion: true }),
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok) {
    throw new Error(`/video/retrieve returned ${response.status}: ${await response.text()}`);
  }
  if (contentType.includes('video/mp4')) {
    videoBuffer = Buffer.from(await response.arrayBuffer());
    console.log(`RETRIEVED_INLINE ${videoBuffer.length}`);
    break;
  }
  const status = await response.json();
  console.log(`POLL ${polls} ${status.status ?? 'UNKNOWN'} ${status.execution_duration ?? ''}`);
  if (String(status.status).toUpperCase() === 'COMPLETED') {
    const downloadUrl = queued.download_url ?? status.download_url ?? status.url;
    if (!downloadUrl) throw new Error('Video completed without an inline body or download URL.');
    const download = await fetch(downloadUrl);
    if (!download.ok) throw new Error(`Download returned ${download.status}`);
    videoBuffer = Buffer.from(await download.arrayBuffer());
    console.log(`RETRIEVED_URL ${videoBuffer.length}`);
    break;
  }
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, videoBuffer);
console.log(`SAVED ${outputPath} ${videoBuffer.length}`);
