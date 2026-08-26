import type {
  FingerprintLaunchPolicy,
  HardwareNoisePolicy,
  MediaDeviceProfile,
  RendererPolicy,
  StartProfileParams,
  WebRtcPolicy,
} from '@lobster/shared-types';

/**
 * The launch policy every start path resolves from the profile's persona settings.
 *
 * Desktop and emulated-Android launches feed the SAME native config channel, so they must resolve the
 * user's WebRTC / hardware-noise / media-device choices identically — a policy that is only honored on
 * one path is an anti-detect setting the UI shows but the engine never receives.
 */

const DEFAULT_HARDWARE_NOISE: HardwareNoisePolicy = {
  webgl: true,
  canvas: true,
  audio: true,
  clientRects: false,
};

const DEFAULT_MEDIA_DEVICES: MediaDeviceProfile = {
  cameras: 1,
  microphones: 1,
  speakers: 2,
  stableDeviceIds: true,
};

const DEFAULT_RENDERER_POLICY: RendererPolicy = { mode: 'host' };

/**
 * The policy a launch is judged against when the caller supplied none.
 *
 * Only `requiredLobiumCapabilities` reads it, and only to decide which native hooks the build must
 * have. It names the DEFAULTS a real profile gets, so a policy-less launch is held to the same
 * standard as a product one rather than to the whole capability contract — the contract includes
 * font-isolation, which is Windows-only by design, so requiring all of it made a policy-less launch
 * impossible on Linux and macOS.
 */
export const DEFAULT_CAPABILITY_PROBE_POLICY: FingerprintLaunchPolicy = {
  renderer: DEFAULT_RENDERER_POLICY,
  webrtc: 'disable_non_proxied_udp',
  hardwareNoise: DEFAULT_HARDWARE_NOISE,
  mediaDevices: DEFAULT_MEDIA_DEVICES,
};

export function resolveWebRtcPolicy(params: StartProfileParams): WebRtcPolicy {
  const requested = params.fingerprintOverrides?.webrtc;
  const mode = params.fingerprintOverrides?.webrtcMode;
  if (mode === 'based_ip') {
    return params.proxy ? 'proxy_only' : 'default_public_interface_only';
  }
  if (mode === 'real') return 'default_public_interface_only';
  if (requested) {
    if (
      requested !== 'default_public_interface_only' &&
      requested !== 'disable_non_proxied_udp' &&
      requested !== 'proxy_only' &&
      requested !== 'disabled'
    ) {
      throw new Error(`invalid WebRTC policy "${String(requested)}"`);
    }
    return requested;
  }
  return params.proxy ? 'disable_non_proxied_udp' : 'default_public_interface_only';
}

export function validateLaunchPolicy(policy: FingerprintLaunchPolicy): void {
  const renderer = policy.renderer;
  if (
    renderer.mode !== 'host' &&
    renderer.mode !== 'normalized_host' &&
    renderer.mode !== 'validated_preset'
  ) {
    throw new Error(`invalid renderer policy "${String((renderer as RendererPolicy).mode)}"`);
  }
  if (renderer.mode === 'validated_preset' && renderer.presetId.trim() === '') {
    throw new Error('validated renderer preset requires a non-empty presetId');
  }
  for (const [surface, enabled] of Object.entries(policy.hardwareNoise)) {
    if (typeof enabled !== 'boolean') {
      throw new Error(`hardware-noise policy ${surface} must be boolean`);
    }
  }
  for (const [kind, count] of Object.entries({
    cameras: policy.mediaDevices.cameras,
    microphones: policy.mediaDevices.microphones,
    speakers: policy.mediaDevices.speakers,
  })) {
    // Very large values can make the native enumerateDevices hook allocate thousands of objects and
    // are never a plausible consumer machine. Validate at the untyped IPC boundary.
    if (!Number.isInteger(count) || count < 0 || count > 16) {
      throw new Error(`mediaDevices.${kind} must be an integer in 0-16 (got ${String(count)})`);
    }
  }
  if (typeof policy.mediaDevices.stableDeviceIds !== 'boolean') {
    throw new Error('mediaDevices.stableDeviceIds must be boolean');
  }
}

/**
 * Resolve the profile's persona overrides into a validated launch policy.
 *
 * `renderer` pins the renderer policy for callers that own it themselves (the Android persona always
 * carries a device-catalog GPU, so a host/normalized_host override from the desktop editor must not
 * reach a phone launch); everything else comes from the profile.
 */
export function resolveLaunchPolicy(
  params: StartProfileParams,
  opts: { renderer?: RendererPolicy } = {},
): FingerprintLaunchPolicy {
  const policy: FingerprintLaunchPolicy = {
    renderer: opts.renderer ?? params.fingerprintOverrides?.renderer ?? DEFAULT_RENDERER_POLICY,
    webrtc: resolveWebRtcPolicy(params),
    hardwareNoise: {
      ...DEFAULT_HARDWARE_NOISE,
      ...params.fingerprintOverrides?.hardwareNoise,
    },
    mediaDevices: {
      ...DEFAULT_MEDIA_DEVICES,
      ...params.fingerprintOverrides?.mediaDevices,
    },
  };
  validateLaunchPolicy(policy);
  if (policy.webrtc === 'proxy_only' && !params.proxy) {
    throw new Error('WebRTC proxy_only policy requires a configured proxy');
  }
  if (policy.webrtc === 'default_public_interface_only' && params.proxy) {
    throw new Error(
      'WebRTC default_public_interface_only is unsafe with a proxy because host ICE may bypass it',
    );
  }
  return policy;
}
