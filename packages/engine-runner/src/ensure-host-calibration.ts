/**
 * Ensure a persisted host-calibration profile exists (HC-1/HC-3 first-run path).
 *
 * When `LOBSTER_HOST_CALIBRATION_FILE` points at an existing valid profile, returns it.
 * Otherwise launches a short unspoofed Lobium/Chromium probe, normalizes + validates, and
 * persists the result. Catalog fallback remains if probing is unavailable (no binary / headless CI).
 */

import { homedir, platform as nodePlatform } from 'node:os';
import { join } from 'node:path';
import type { CpuArch, HostCalibrationProfile, OsFamily } from '@lobster/shared-types';
import {
  hostCalibrationIssues,
  loadHostCalibration,
  persistHostCalibration,
  resolveHostCalibrationPath,
} from './host-calibration-store.js';
import {
  normalizeHostCalibrationSnapshot,
  type HostCalibrationRawSnapshot,
} from './host-calibration-probe.js';
import { allowProvisionalSoftwareGpu } from './gpu.js';

export interface EnsureHostCalibrationOptions {
  /** Override path (defaults to LOBSTER_HOST_CALIBRATION_FILE or app-data default). */
  path?: string;
  os?: OsFamily;
  arch?: CpuArch;
  /**
   * Optional probe implementation (tests inject a fake). When omitted and no file exists,
   * returns undefined rather than launching a browser — callers that need a live probe
   * should pass `probe` or use the CI host-calibration-e2e harness.
   */
  probe?: () => Promise<HostCalibrationRawSnapshot>;
}

/** Default on-disk path when the env var is unset (desktop first-run). */
export function defaultHostCalibrationPath(): string {
  const base =
    process.env.LOBSTER_APP_DATA?.trim() ||
    join(homedir(), '.local', 'share', 'com.lobster.browser');
  return join(base, 'host-calibration.json');
}

function detectOs(): OsFamily {
  const p = nodePlatform();
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  return 'linux';
}

function detectArch(): CpuArch {
  return process.arch === 'arm64' ? 'arm64' : 'x86_64';
}

export interface EnsureHostCalibrationResult {
  path: string;
  profile: HostCalibrationProfile | undefined;
  /** `loaded` | `probed` | `missing` */
  source: 'loaded' | 'probed' | 'missing';
}

// Keyed by the file being written. The probe spawns a real unspoofed browser and ends in a
// read-modify-write of that file, and the sidecar handles requests concurrently, so two callers
// asking for the same calibration must share one capture instead of racing two browsers into it.
const inFlight = new Map<string, Promise<EnsureHostCalibrationResult>>();

/**
 * Load or (when a probe is supplied) capture + persist the host calibration profile.
 */
export function ensureHostCalibration(
  opts: EnsureHostCalibrationOptions = {},
): Promise<EnsureHostCalibrationResult> {
  const path = opts.path ?? resolveHostCalibrationPath() ?? defaultHostCalibrationPath();
  const running = inFlight.get(path);
  if (running) return running;
  const started = resolveHostCalibration(path, opts).finally(() => {
    inFlight.delete(path);
  });
  inFlight.set(path, started);
  return started;
}

async function resolveHostCalibration(
  path: string,
  opts: EnsureHostCalibrationOptions,
): Promise<EnsureHostCalibrationResult> {
  const existing = await loadHostCalibration(path);
  if (existing) {
    const issues = hostCalibrationIssues(existing, {
      allowSoftwareRenderer: allowProvisionalSoftwareGpu(),
    });
    if (issues.length === 0) {
      return { path, profile: existing, source: 'loaded' };
    }
  }

  if (!opts.probe) {
    return { path, profile: undefined, source: 'missing' };
  }

  const raw = await opts.probe();
  const profile = normalizeHostCalibrationSnapshot(raw, {
    os: opts.os ?? detectOs(),
    arch: opts.arch ?? detectArch(),
  });

  // Validate BEFORE persisting. A freshly probed snapshot used to be written to disk unchecked
  // while only a previously loaded one was validated, so a host that produces an invalid profile
  // cached it and then failed on every subsequent launch with the same error — and the cache made
  // it look permanent rather than like a bad capture. Refusing to persist keeps the failure
  // transient and self-correcting.
  const issues = hostCalibrationIssues(profile, {
    allowSoftwareRenderer: allowProvisionalSoftwareGpu(),
  });
  if (issues.length > 0) {
    throw new Error(
      `refusing to persist an invalid host calibration probed into ${path}: ${issues.join('; ')}`,
    );
  }

  await persistHostCalibration(path, profile);
  return { path, profile, source: 'probed' };
}
