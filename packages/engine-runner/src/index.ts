import { createInterface } from 'node:readline';
import type { SidecarRequest } from '@lobster/shared-types';
import { dispatch } from './rpc.js';
import { CompositeRunner } from './runners/composite.js';
import { buildLaunchers } from './runners/default-launchers.js';

/**
 * Sidecar entry point. Reads newline-delimited JSON {@link SidecarRequest}s on stdin and
 * writes {@link import('@lobster/shared-types').SidecarResponse}s on stdout — the stable
 * contract with the Rust desktop core (see docs/contracts/sidecar-ipc.md).
 */
async function main(): Promise<void> {
  // Wire the direct native Lobium launcher when a binary is provisioned; missing Lobium reports a clear
  // error. Headless/sandbox behavior is env-configurable for servers/containers.
  const runner = new CompositeRunner(
    await buildLaunchers({
      headless: process.env.LOBSTER_HEADLESS === '1',
      extraArgs:
        process.env.LOBSTER_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
    }),
  );
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

    const res = await dispatch(runner, req);
    process.stdout.write(JSON.stringify(res) + '\n');
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`engine-runner fatal: ${String(e)}\n`);
  process.exit(1);
});
