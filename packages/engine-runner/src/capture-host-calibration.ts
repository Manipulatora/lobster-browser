import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostCalibrationRawSnapshot } from './host-calibration-probe.js';
import { buildHostCalibrationProbeScript } from './host-calibration-probe.js';
import { readDevToolsEndpoint } from './devtools-endpoint.js';
import { withCdpSession, cdpEvaluate } from './cdp-client.js';
import { buildGpuArgs } from './gpu.js';
import { buildDevShmArgs } from './dev-shm.js';
import { resolveLobiumBinary } from './runners/lobium-launcher.js';
import { signalProcessTree } from './process-tree.js';

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalProcessTree(child, 'SIGKILL');
}

/**
 * Capture the unmodified host surfaces with the exact Lobium executable before a profile config is
 * applied. The control connection is the project's first-party CDP client (no automation fork); no
 * emulation or init script is used — just a single `Runtime.evaluate` of the read-only probe.
 */
export async function captureHostCalibrationRawSnapshot(): Promise<HostCalibrationRawSnapshot> {
  const executablePath = resolveLobiumBinary();
  if (!executablePath) {
    throw new Error('cannot capture host calibration: Lobium binary is unavailable');
  }

  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-host-calibration-'));
  const headless = process.env.LOBSTER_HOST_CALIBRATION_HEADFUL === '0';
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    ...buildDevShmArgs(),
    ...(process.env.LOBSTER_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    ...buildGpuArgs(),
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];
  const child = spawn(executablePath, args, {
    detached: process.platform !== 'win32',
    env: process.env,
    stdio: 'ignore',
    windowsHide: true,
  });

  try {
    const { ws } = await readDevToolsEndpoint(userDataDir);
    // The probe is a self-invoking async IIFE (`(async () => {...})()`) yielding the snapshot;
    // Runtime.evaluate with awaitPromise resolves it. Runs in the initial about:blank page target —
    // WebGL/canvas/font reads work there and the probe touches no [SecureContext]-only surfaces.
    return await withCdpSession(
      ws,
      (session) =>
        cdpEvaluate<HostCalibrationRawSnapshot>(session, buildHostCalibrationProbeScript()),
      { timeoutMs: 30_000 },
    );
  } finally {
    terminate(child);
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
