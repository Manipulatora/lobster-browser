/**
 * Launch one exact fingerprint through the shipping native Lobium launcher.
 *
 * Detector/oracle harnesses often need a pre-derived fingerprint rather than the profile service's
 * seed-only derivation. They must still use the product transport around that fingerprint: verified
 * persona-specific font staging, the native config channel, runtime-bound resources, launch flags,
 * locale environment, capability checks, and process-tree cleanup. Keeping that bridge here avoids
 * each harness growing a subtly different hand-written `spawn(chrome, ...)` path.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCdpEmulation,
  buildDevShmArgs,
  buildFingerprintInitScript,
  buildLaunchOptions,
  createLobiumLauncher,
} from '@lobster/engine-runner';

/**
 * @param {{
 *   bin: string,
 *   profileId: string,
 *   fingerprint: object,
 *   fingerprintSeed: string,
 *   headless?: boolean,
 *   fingerprintPolicy?: object,
 *   webrtcPolicy?: string,
 *   isMobileProfile?: boolean,
 *   mobileFormFactor?: 'phone' | 'tablet',
 *   noSandbox?: boolean,
 *   extraArgs?: string[],
 * }} options
 */
export async function launchNativePersona({
  bin,
  profileId,
  fingerprint,
  fingerprintSeed,
  headless = true,
  fingerprintPolicy,
  webrtcPolicy,
  isMobileProfile = false,
  mobileFormFactor,
  noSandbox = true,
  extraArgs = [],
  /**
   * Keep the probe hermetic by cutting background networking, component updates and sync.
   *
   * DEFAULT TRUE, because most harnesses want a browser that does not talk to Google mid-measurement.
   * But those switches CHANGE THE SURFACE UNDER TEST, and the product passes none of them: the
   * Widevine CDM is delivered by the component updater, so a probe that disables it can never observe
   * Widevine working no matter what the build does. Any harness asserting product behaviour must pass
   * false here.
   */
  hermeticNetwork = true,
}) {
  if (!bin) throw new Error('a Lobium binary is required');
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-native-probe-'));
  const options = buildLaunchOptions({
    profileId,
    engine: 'lobium',
    userDataDir,
    fingerprint,
    ...(webrtcPolicy ? { webrtcPolicy } : {}),
    headless,
  });
  const context = {
    profileId,
    engine: 'lobium',
    fingerprint,
    fingerprintSeed,
    ...(fingerprintPolicy ? { fingerprintPolicy } : {}),
    ...(webrtcPolicy ? { webrtcPolicy } : {}),
    ...(isMobileProfile ? { isMobileProfile: true } : {}),
    ...(mobileFormFactor ? { mobileFormFactor } : {}),
    options,
    // The native launcher does not consume these legacy compatibility fields, but LaunchContext
    // carries them and keeping them accurate makes this adapter safe for instrumentation wrappers.
    emulation: buildCdpEmulation(fingerprint),
    initScript: buildFingerprintInitScript(fingerprint),
  };
  const launcher = createLobiumLauncher({
    executablePath: bin,
    headless,
    extraArgs: [
      ...(noSandbox ? ['--no-sandbox'] : []),
      ...buildDevShmArgs(),
      ...(hermeticNetwork
        ? ['--disable-background-networking', '--disable-component-update', '--disable-sync']
        : []),
      ...extraArgs,
    ],
  });

  let handle;
  try {
    handle = await launcher(context);
  } catch (error) {
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    throw error;
  }

  let closed = false;
  return {
    ...handle,
    userDataDir,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await handle.close();
      } finally {
        await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      }
    },
  };
}
