import { createInterface } from 'node:readline';
import type { AgentEvent, SidecarNotification, SidecarRequest } from '@lobster/shared-types';
import { dispatch } from './rpc.js';
import { AgentManager } from './agent/manager.js';
import { AgentBridge } from './agent/bridge.js';
import { CompositeRunner } from './runners/composite.js';
import { buildLaunchers } from './runners/default-launchers.js';
import { buildDevShmArgs } from './dev-shm.js';

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
  let bridge: AgentBridge | undefined;
  const emitAgentEvent = (event: AgentEvent): void => {
    const line: SidecarNotification<AgentEvent> = { notify: 'agent', event };
    process.stdout.write(JSON.stringify(line) + '\n');
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

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let req: SidecarRequest;
    try {
      req = JSON.parse(trimmed) as SidecarRequest;
    } catch {
      process.stdout.write(
        JSON.stringify({
          id: 'unknown',
          ok: false,
          error: { code: 'bad_json', message: 'invalid JSON' },
        }) + '\n',
      );
      continue;
    }

    const res = await dispatch(runner, req, { agents });
    process.stdout.write(JSON.stringify(res) + '\n');
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`engine-runner fatal: ${String(e)}\n`);
  process.exit(1);
});
