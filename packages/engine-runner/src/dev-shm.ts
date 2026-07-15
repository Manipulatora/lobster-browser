import { statfsSync } from 'node:fs';

/**
 * Below this size Chromium's multi-process shared-memory allocations can exhaust Docker's small
 * default /dev/shm. On a normal host, keeping anonymous shared memory in tmpfs avoids routing large
 * renderer/GPU buffers through the disk-backed temporary directory.
 */
export const MIN_CHROMIUM_DEV_SHM_BYTES = 512 * 1024 * 1024;

export interface DevShmArgsOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Injectable for tests. `null` models an unavailable/unreadable /dev/shm. */
  availableBytes?: number | null;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function availableDevShmBytes(): number | undefined {
  try {
    const stats = statfsSync('/dev/shm');
    const bytes = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Select Chromium's /dev/shm workaround only when it is actually needed.
 *
 * `--disable-dev-shm-usage` is a stability workaround for small container shm mounts; it moves
 * anonymous shared-memory files to the temporary directory. It is not a sandbox requirement. The
 * packaged VPS has a 24 GiB tmpfs, so adding it merely because `--no-sandbox` is required sends large
 * compositor/WebGL buffers to disk and needlessly slows renderer IPC.
 *
 * `LOBSTER_DISABLE_DEV_SHM_USAGE=1|0` remains an explicit operational override. If the mount cannot be
 * inspected we retain Chromium's conservative workaround.
 */
export function buildDevShmArgs(opts: DevShmArgsOptions = {}): string[] {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux') return [];

  const env = opts.env ?? process.env;
  const override = (env.LOBSTER_DISABLE_DEV_SHM_USAGE ?? '').trim().toLowerCase();
  if (TRUE_VALUES.has(override)) return ['--disable-dev-shm-usage'];
  if (FALSE_VALUES.has(override)) return [];

  const available =
    opts.availableBytes === null ? undefined : (opts.availableBytes ?? availableDevShmBytes());
  return available !== undefined && available >= MIN_CHROMIUM_DEV_SHM_BYTES
    ? []
    : ['--disable-dev-shm-usage'];
}
