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

/*
 * `assertBasedOnIpHasProxy` was removed on 2026-08-21.
 *
 * It refused to launch any profile whose language/timezone/geolocation were set to Based on IP
 * while no proxy was attached. Because the profile editor DEFAULTS all three to Based on IP
 * (profileDraft.ts createProfileDraft), that made every profile created with the default settings
 * unlaunchable until a proxy was added — the single most common failure users hit.
 *
 * The premise was wrong: a direct profile does have an exit IP, this machine's. Both launch paths
 * now resolve Based-on-IP against it via `deriveGeoFromDirectIp`, which keeps the persona coherent
 * (locale/timezone/geolocation all agree with the address traffic actually leaves from) instead of
 * refusing. `basedOnIpPersonaKnobs` above is still used to decide when proxy geo is mandatory.
 */
