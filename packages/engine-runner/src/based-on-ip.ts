import type { StartProfileParams } from '@lobster/shared-types';

/**
 * The persona knobs the editor binds to the proxy exit IP, named the way the editor names them.
 * Only EXPLICIT `based_ip` selections count: a legacy profile that predates the mode fields carries
 * `undefined` and keeps its best-effort behavior.
 */
export function basedOnIpPersonaKnobs(params: StartProfileParams): string[] {
  const overrides = params.fingerprintOverrides;
  const knobs: string[] = [];
  if (overrides?.languageMode === 'based_ip') knobs.push('languages');
  if (overrides?.timezoneMode === 'based_ip') knobs.push('timezone');
  if (overrides?.geolocationMode === 'based_ip') knobs.push('geolocation');
  return knobs;
}

/**
 * Refuse a Based-on-IP persona that has no IP to be based on. Without a proxy there is no exit
 * address to resolve, so the launch would quietly fall back to the seed-derived locale/timezone and
 * to this machine's real geolocation while the editor still shows "Based on IP" — the persona is
 * then bound to the operator's own country instead of the one the profile claims, and nothing in the
 * UI says so. The editor warns about this at save time; the launch is where it becomes a refusal.
 */
export function assertBasedOnIpHasProxy(params: StartProfileParams, subject: string): void {
  if (params.proxy) return;
  const knobs = basedOnIpPersonaKnobs(params);
  if (knobs.length === 0) return;
  throw new Error(
    `refusing to launch ${subject} ${params.profileId}: ${knobs.join(', ')} ` +
      `${knobs.length === 1 ? 'is' : 'are'} set to Based on IP, but the profile has no proxy — ` +
      'there is no exit IP to derive them from, so the persona would keep its seed-derived locale ' +
      "and this machine's real geolocation. Attach a proxy, or set those knobs manually.",
  );
}
