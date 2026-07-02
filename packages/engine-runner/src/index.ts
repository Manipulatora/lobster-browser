import { createInterface } from 'node:readline';
import type { SidecarRequest } from '@lobster/shared-types';
import { dispatch } from './rpc.js';
import { NotImplementedRunner } from './runner.js';

/**
 * Sidecar entry point. Reads newline-delimited JSON {@link SidecarRequest}s on stdin and
 * writes {@link import('@lobster/shared-types').SidecarResponse}s on stdout — the stable
 * contract with the Rust desktop core (see docs/contracts/sidecar-ipc.md).
 */
async function main(): Promise<void> {
  const runner = new NotImplementedRunner();
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
