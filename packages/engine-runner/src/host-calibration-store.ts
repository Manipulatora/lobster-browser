import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateHostCalibrationProfile } from '@lobster/fingerprint';
import type { HostCalibrationProfile } from '@lobster/shared-types';

/**
 * Persisted host-calibration store (HC-3).
 *
 * The desktop first-run flow captures the real machine once (`probeHostCalibration` + OS/font APIs) and
 * persists the resulting {@link HostCalibrationProfile} here. From then on `startProfile` loads it and
 * makes **host-calibrated derivation the default** — every profile inherits the real GPU/screen/fonts and
 * only the farbling + safe surfaces vary. The catalog (`pools.ts`) stays as the fallback when no host
 * profile has been captured (e.g. CI/headless).
 *
 * The path is resolved from `LOBSTER_HOST_CALIBRATION_FILE`; when unset, host calibration is simply not
 * the default and the catalog path is used (so existing CI/tests are unchanged).
 */

/** Resolve the persisted host-calibration file path from the environment (undefined = feature off). */
export function resolveHostCalibrationPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const p = env.LOBSTER_HOST_CALIBRATION_FILE?.trim();
  return p && p.length > 0 ? p : undefined;
}

/** Persist a captured host profile (owner-only 0600) after validating it. Throws on an invalid host. */
export async function persistHostCalibration(
  path: string,
  profile: HostCalibrationProfile,
): Promise<void> {
  const issues = validateHostCalibrationProfile(profile);
  if (issues.length > 0) {
    throw new Error(
      `refusing to persist an invalid host calibration (${issues.length}): ${issues.join('; ')}`,
    );
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Load a persisted host profile, or return undefined when the file is absent/unreadable/invalid JSON.
 * Never throws for a missing file — an uncalibrated install simply falls back to the catalog path.
 */
export async function loadHostCalibration(
  path: string | undefined,
): Promise<HostCalibrationProfile | undefined> {
  if (!path) return undefined;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as HostCalibrationProfile;
  } catch {
    return undefined;
  }
}
