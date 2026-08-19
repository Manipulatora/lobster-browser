import { createInterface } from 'node:readline';
import type { AgentEvent, SidecarNotification, SidecarRequest } from '@lobster/shared-types';
import { dispatch } from './rpc.js';
import { AgentManager } from './agent/manager.js';
import { AgentBridge } from './agent/bridge.js';
import { CompositeRunner } from './runners/composite.js';
import { buildLaunchers } from './runners/default-launchers.js';
import { buildDevShmArgs } from './dev-shm.js';
import { createSemaphore } from './semaphore.js';

/** How many profile launches may be in flight at once (spawn + proxy probe + CDP endpoint wait). */
const DEFAULT_MAX_CONCURRENT_LAUNCHES = 8;

function maxConcurrentLaunches(): number {
  const configured = Number(process.env.LOBSTER_MAX_CONCURRENT_LAUNCHES);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_CONCURRENT_LAUNCHES;
}

/** Requests that spawn a browser, and are therefore the ones worth rationing. */
function isLaunchMethod(method: string): boolean {
  return method === 'startProfile' || method === 'launch';
}

/**
 * Sidecar entry point. Reads newline-delimited JSON {@link SidecarRequest}s on stdin and
 * writes {@link import('@lobster/shared-types').SidecarResponse}s on stdout — the stable
 * contract with the Rust desktop core (see docs/OPERATIONS.md (§4)).
 */
async function main(): Promise<void> {
  // Wire the direct native Lobium launcher when a binary is provisioned; missing Lobium reports a clear
  // error. Headless/sandbox behavior is env-configurable for servers/containers.
  const runner = new CompositeRunner(
    await buildLaunchers({
      headless: process.env.LOBSTER_HEADLESS === '1',
      extraArgs: [
        ...(process.env.LOBSTER_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
        ...buildDevShmArgs(),
      ],
    }),
  );
  // Per-profile web agent. `agent.start` returns immediately and the run streams AgentEvents as
  // out-of-band notification lines (no `id`) — the Rust reader routes any line carrying `notify` to a
  // broadcast channel instead of the request/response map. The manager resolves a profile's live CDP
  // endpoint from the runner's status, so an agent only attaches to an already-launched window.
  // One write call per line. Requests are handled concurrently, so a response that reached stdout in
  // several writes could be split by another handler's line; a single write of the whole line is what
  // keeps the newline-delimited framing intact for the Rust reader.
  const writeLine = (payload: unknown): void => {
    process.stdout.write(JSON.stringify(payload) + '\n');
  };

  let bridge: AgentBridge | undefined;
  const emitAgentEvent = (event: AgentEvent): void => {
    const line: SidecarNotification<AgentEvent> = { notify: 'agent', event };
    writeLine(line);
    // Also stream to the in-browser Lobee panel (if any) over the loopback bridge.
    bridge?.dispatch(event);
  };
  const agents = new AgentManager({
    resolveWs: async (profileId) => {
      const status = await runner.status({ profileId });
      return status.running.find((r) => r.profileId === profileId)?.ws;
    },
    emit: emitAgentEvent,
  });

  // Loopback bridge so the Lobee side panel can start/stream runs for its own profile. Best-effort:
  // if it can't bind, side-panel runs are simply unavailable; stdio-driven (desktop) runs still work.
  bridge = new AgentBridge(agents);
  try {
    const origin = await bridge.start();
    console.error(`[lobee-bridge] listening on ${origin}`);
  } catch (err) {
    console.error(`[lobee-bridge] failed to start: ${err instanceof Error ? err.message : err}`);
    bridge = undefined;
  }

  const rl = createInterface({ input: process.stdin });

  // Launching a profile takes seconds (proxy reachability, spawn, DevToolsActivePort wait). Handling
  // requests one at a time made that latency serial across the whole product: starting the second of
  // a hundred profiles waited for the first browser to be up, and a status poll or agent call issued
  // meanwhile waited behind both — past the desktop core's 90s per-call deadline on a large fleet.
  // Responses carry the request id and the Rust reader routes them by id, so out-of-order completion
  // is already part of the contract; what must stay bounded is how many browsers start at once.
  const launches = createSemaphore(maxConcurrentLaunches());
  const inFlight = new Set<Promise<void>>();

  const handle = async (req: SidecarRequest): Promise<void> => {
    const run = () => dispatch(runner, req, { agents });
    writeLine(isLaunchMethod(req.method) ? await launches.run(run) : await run());
  };

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let req: SidecarRequest;
    try {
      req = JSON.parse(trimmed) as SidecarRequest;
    } catch {
      writeLine({
        id: 'unknown',
        ok: false,
        error: { code: 'bad_json', message: 'invalid JSON' },
      });
      continue;
    }

    const task = handle(req)
      .catch((err: unknown) => {
        // `dispatch` reports its own failures; this only covers a handler that broke before it.
        writeLine({
          id: req.id ?? 'unknown',
          ok: false,
          error: { code: 'internal', message: err instanceof Error ? err.message : String(err) },
        });
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  }
  // stdin closed: give the launches still in flight their chance to answer before the process ends.
  await Promise.allSettled([...inFlight]);
}

main().catch((e: unknown) => {
  process.stderr.write(`engine-runner fatal: ${String(e)}\n`);
  process.exit(1);
});
