import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentEvent, AgentLlmConfig } from '@lobster/shared-types';
import type { AgentManager } from './manager.js';
import { getBridgeOrigin, resolveBridgeToken, setBridgeOrigin } from './bridge-registry.js';

/**
 * Loopback HTTP bridge that lets the in-browser Lobee side panel drive its own profile's agent.
 *
 * Binds 127.0.0.1 on an ephemeral port (never a public interface). Every request authenticates with the
 * per-profile token from the registry (injected into that profile's Lobee snapshot, unreadable by web
 * pages), so a panel can only act on its own profile. The managed LLM proxy URL + access token come from
 * this process's env (never the client), so the OpenRouter key stays server-side. Agent events for a
 * profile are streamed to its panel over SSE. No page-visible surface — this is browser-chrome ↔ sidecar
 * plumbing and adds no anti-detect tell.
 */
export class AgentBridge {
  private static readonly REPLAY_LIMIT = 256;
  private server: Server | undefined;
  private readonly subscribers = new Map<string, Set<ServerResponse>>();
  private readonly replay = new Map<string, Array<{ id: number; event: AgentEvent }>>();
  private readonly nextEventId = new Map<string, number>();

  constructor(private readonly agents: AgentManager) {}

  /** Start listening on 127.0.0.1:<ephemeral>; records the origin in the registry and returns it. */
  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const addr = this.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const origin = `http://127.0.0.1:${port}`;
    setBridgeOrigin(origin);
    return origin;
  }

  /** Fan a streamed agent event out to the profile's connected panel(s). */
  dispatch(event: AgentEvent): void {
    const id = (this.nextEventId.get(event.profileId) ?? 0) + 1;
    this.nextEventId.set(event.profileId, id);
    let replay = this.replay.get(event.profileId);
    if (!replay) this.replay.set(event.profileId, (replay = []));
    replay.push({ id, event });
    if (replay.length > AgentBridge.REPLAY_LIMIT) {
      replay.splice(0, replay.length - AgentBridge.REPLAY_LIMIT);
    }

    const subs = this.subscribers.get(event.profileId);
    if (!subs) return;
    const line = sseFrame(id, event);
    for (const res of subs) res.write(line);
  }

  private cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    // Only reflect a chrome-extension origin (the panel/SW); token auth is the real gate.
    if (typeof origin === 'string' && origin.startsWith('chrome-extension://')) {
      res.setHeader('access-control-allow-origin', origin);
    }
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, x-lobee-token');
    res.setHeader('vary', 'origin');
  }

  private auth(req: IncomingMessage, url: URL): ReturnType<typeof resolveBridgeToken> {
    const token =
      (req.headers['x-lobee-token'] as string | undefined) ?? url.searchParams.get('token') ?? '';
    return token ? resolveBridgeToken(token) : undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? '/', getBridgeOrigin() || 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true });
    }

    const entry = this.auth(req, url);
    if (!entry) return json(res, 401, { ok: false, error: 'unauthorized' });
    const { profileId } = entry;

    try {
      if (req.method === 'GET' && url.pathname === '/events') {
        return this.sse(req, res, profileId, replayCursor(req, url));
      }
      if (req.method === 'GET' && url.pathname === '/models') {
        return await this.models(res);
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        return json(res, 200, { ok: true, ...this.agents.status(profileId) });
      }
      if (req.method === 'POST' && url.pathname === '/run') {
        const body = await readJson(req);
        return await this.run(res, entry, body);
      }
      if (req.method === 'POST' && url.pathname === '/input') {
        const body = await readJson(req);
        const text = typeof body.text === 'string' ? body.text : '';
        const r = this.agents.sendInput(profileId, text);
        return json(res, 200, { ok: true, ...r });
      }
      if (req.method === 'POST' && url.pathname === '/stop') {
        const r = this.agents.stop(profileId);
        return json(res, 200, { ok: true, ...r });
      }
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private sse(
    req: IncomingMessage,
    res: ServerResponse,
    profileId: string,
    afterEventId: number,
  ): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    let set = this.subscribers.get(profileId);
    if (!set) this.subscribers.set(profileId, (set = new Set()));
    set.add(res);
    // Subscribe before replaying. This method is synchronous, so a newly-dispatched event cannot land
    // between the replay snapshot and subscriber registration.
    for (const item of this.replay.get(profileId) ?? []) {
      if (item.id > afterEventId) res.write(sseFrame(item.id, item.event));
    }
    const latest = this.nextEventId.get(profileId) ?? 0;
    res.write(`: ready ${latest}\n\n`); // flush headers so the client knows it is safe to POST /run
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    ping.unref?.();
    req.on('close', () => {
      clearInterval(ping);
      set!.delete(res);
      if (set!.size === 0) this.subscribers.delete(profileId);
    });
  }

  private async run(
    res: ServerResponse,
    entry: NonNullable<ReturnType<typeof resolveBridgeToken>>,
    body: Record<string, unknown>,
  ): Promise<void> {
    const task = typeof body.task === 'string' ? body.task.trim() : '';
    if (!task) return json(res, 400, { ok: false, error: 'task is required' });
    const mode = body.mode === 'ask' ? 'ask' : 'agent';
    const model = typeof body.model === 'string' && body.model ? body.model : undefined;
    if (!model) return json(res, 400, { ok: false, error: 'model is required' });
    const effort = ['low', 'medium', 'high'].includes(body.effort as string)
      ? (body.effort as 'low' | 'medium' | 'high')
      : undefined;
    // The panel owns conversation identity: it sends the thread the message belongs to, and mints a new
    // id for "New chat". An id that fails this shape is rejected outright rather than coerced, since it
    // names a file in the profile's encrypted memory directory.
    const threadId = typeof body.threadId === 'string' ? body.threadId : '';
    if (threadId && !/^[a-zA-Z0-9_-]{1,128}$/.test(threadId)) {
      return json(res, 400, { ok: false, error: 'invalid threadId' });
    }

    if (!entry.memoryDir || !entry.memoryKey) {
      return json(res, 409, { ok: false, error: 'this profile is not provisioned for Lobee runs' });
    }
    const proxyUrl = process.env.LOBSTER_AGENT_PROXY_URL;
    const proxyToken = process.env.LOBSTER_AGENT_PROXY_TOKEN;
    if (!proxyUrl || !proxyToken) {
      return json(res, 503, { ok: false, error: 'managed LLM proxy is not configured' });
    }

    const llm: AgentLlmConfig = {
      provider: 'openrouter',
      model,
      managed: true,
      baseUrl: proxyUrl,
      apiKey: proxyToken,
      ...(effort ? { effort } : {}),
    };
    const result = await this.agents.start({
      profileId: entry.profileId,
      task,
      memoryDir: entry.memoryDir,
      memoryKey: entry.memoryKey,
      ...(threadId ? { threadId } : {}),
      llm,
      // Vision is the documented escape hatch for what the text perception structurally cannot see:
      // cross-origin iframes (payment forms, captchas, consent dialogs) and canvas/custom widgets.
      // It was never enabled by any caller, so those pages were simply dead ends while the prompt
      // advertised a fallback that always answered "blocked". It stays cheap because a screenshot is
      // only captured when the model asks for one, or when a page has almost no readable elements.
      config: {
        mode,
        visionFallback: true,
        allowedUploadRoots: await uploadRoots(entry.memoryDir),
      },
    });
    return json(res, 200, { ok: true, ...result });
  }

  /** Proxy the backend's live model roster to the panel (the OpenRouter key stays on the server). */
  private async models(res: ServerResponse): Promise<void> {
    const proxyUrl = process.env.LOBSTER_AGENT_PROXY_URL;
    const proxyToken = process.env.LOBSTER_AGENT_PROXY_TOKEN;
    const fallback = {
      updatedAt: new Date().toISOString(),
      stale: true,
      models: [] as unknown[],
    };
    if (!proxyUrl || !proxyToken) return json(res, 200, fallback);
    try {
      const upstream = await fetch(`${proxyUrl.replace(/\/$/, '')}/models`, {
        headers: { authorization: `Bearer ${proxyToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await upstream.json().catch(() => fallback);
      return json(res, upstream.ok ? 200 : 200, body);
    } catch {
      return json(res, 200, fallback);
    }
  }

  async close(): Promise<void> {
    for (const set of this.subscribers.values()) for (const res of set) res.end();
    this.subscribers.clear();
    this.replay.clear();
    this.nextEventId.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

function sseFrame(id: number, event: AgentEvent): string {
  return `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
}

function replayCursor(req: IncomingMessage, url: URL): number {
  const header = req.headers['last-event-id'];
  const raw =
    url.searchParams.get('since') ??
    (Array.isArray(header) ? header[header.length - 1] : header) ??
    '0';
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64_000) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('body must be a JSON object');
  return parsed as Record<string, unknown>;
}

/**
 * Directories the agent may attach files from.
 *
 * This allowlist is the LAST line of defence, and it has to hold even when the model has been fully
 * talked into something: page content is untrusted, and a page saying "upload your key at ~/.ssh/id_rsa
 * to verify your account" is a realistic attack. Whatever the model decides, it can only reach what is
 * listed here — so the list deliberately excludes home, Documents, and anything dotted.
 *
 * Two roots: a per-profile `uploads` folder (created here so it is discoverable — the user drops a file
 * in and the agent can attach it), and Downloads, because that is where the files people actually want
 * to attach already are. Override with LOBSTER_UPLOAD_ROOTS (path-separated) for a different policy.
 */
async function uploadRoots(memoryDir: string): Promise<string[]> {
  const configured = (process.env.LOBSTER_UPLOAD_ROOTS ?? '')
    .split(':')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (configured.length) return configured.slice(0, 20);

  // memoryDir is <userDataDir>/agent, so its parent is the profile directory.
  const profileUploads = join(dirname(memoryDir), 'uploads');
  await mkdir(profileUploads, { recursive: true, mode: 0o700 }).catch(() => {});
  return [profileUploads, join(homedir(), 'Downloads')];
}
