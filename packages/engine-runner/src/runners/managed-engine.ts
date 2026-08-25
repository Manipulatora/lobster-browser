import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Private desktop -> sidecar contract for the manifest entry that is allowed to occupy the managed
 * per-user runtime. The desktop publishes these before it starts the sidecar, even when first-run
 * provisioning has not happened yet. They are intentionally distinct from the operator-facing
 * LOBSTER_ENGINE_* download overrides: Node consumes the resolved expectation, never a URL.
 */
export const MANAGED_ENGINE_VERSION_ENV = 'LOBSTER_INTERNAL_MANAGED_ENGINE_VERSION';
export const MANAGED_ENGINE_SHA256_ENV = 'LOBSTER_INTERNAL_MANAGED_ENGINE_SHA256';
/** Set only on Windows when Rust published LOBSTER_LOBIUM_BIN for the managed per-user runtime. */
export const MANAGED_ENGINE_BIN_ORIGIN_ENV = 'LOBSTER_INTERNAL_LOBIUM_BIN_ORIGIN';

const INSTALLED_SOURCE_STAMP = '.lobium-engine-version';
const SHA256_LOWER_HEX = /^[0-9a-f]{64}$/;

export interface ManagedEngineResolverOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  isExecutableFile?: (path: string) => boolean;
  readFile?: (path: string) => Buffer;
}

/** The origin marker is part of the Windows-only canonical-runtime attestation contract. */
export function isManagedLobiumBinPublication(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && env[MANAGED_ENGINE_BIN_ORIGIN_ENV] === 'managed';
}

function defaultExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The one product-managed Windows location. Dev overrides are resolved separately. */
export function managedLobiumBinaryPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = homedir(),
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return undefined;
  const localAppData = env.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
  return join(localAppData, 'lobster', 'lobium', 'chrome.exe');
}

/** Exact bytes the Rust provisioner writes beside the archive it verified. */
export function expectedManagedEngineStamp(
  env: NodeJS.ProcessEnv = process.env,
): Buffer | undefined {
  const version = env[MANAGED_ENGINE_VERSION_ENV];
  const sha256 = env[MANAGED_ENGINE_SHA256_ENV];
  if (
    !version ||
    version.length > 256 ||
    version.includes('\r') ||
    version.includes('\n') ||
    !sha256 ||
    !SHA256_LOWER_HEX.test(sha256)
  ) {
    return undefined;
  }
  return Buffer.from(`version=${version}\nsha256=${sha256}\n`, 'utf8');
}

/**
 * Resolve the canonical per-user engine only when its source stamp is byte-for-byte the manifest
 * expectation inherited from the desktop. A present chrome.exe is not evidence: same-version Lobium
 * archives can contain different patches, and first-run provisioning swaps the whole runtime.
 */
export function resolveManagedLobiumBinary(
  options: ManagedEngineResolverOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const expected = expectedManagedEngineStamp(env);
  if (!expected) return undefined;
  const binary = managedLobiumBinaryPath(
    env,
    options.homeDir ?? homedir(),
    options.platform ?? process.platform,
  );
  if (!binary || !(options.isExecutableFile ?? defaultExecutableFile)(binary)) return undefined;

  let installed: Buffer;
  try {
    installed = (options.readFile ?? ((path) => readFileSync(path)))(
      join(dirname(binary), INSTALLED_SOURCE_STAMP),
    );
  } catch {
    return undefined;
  }
  return installed.equals(expected) ? binary : undefined;
}
