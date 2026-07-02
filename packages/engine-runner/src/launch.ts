import type { Fingerprint, LaunchParams } from '@lobster/shared-types';
import { toEnginePlaywrightProxy } from '@lobster/proxy';

/** Options for launching a persistent browser context (patchright / Playwright compatible). */
export interface PersistentLaunchOptions {
  userDataDir: string;
  headless: boolean;
  args: string[];
  proxy?: { server: string; username?: string; password?: string };
}

/**
 * Build the persistent-context launch options for an engine launch. Pure & deterministic so it can
 * be unit-tested without a real browser. The live runner (T-002b) passes the result to
 * patchright `launchPersistentContext`.
 */
export function buildLaunchOptions(params: LaunchParams): PersistentLaunchOptions {
  const { fingerprint } = params;
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    `--lang=${fingerprint.locale.locale}`,
    `--window-size=${fingerprint.screen.width},${fingerprint.screen.height}`,
    // WebRTC leak protection. Chrome already hides the private IP behind mDNS (.local candidates);
    // the real risk is the PUBLIC IP leaking via a STUN/srflx candidate that bypasses the proxy.
    // With a proxy we force `disable_non_proxied_udp`: WebRTC may only use paths it can route through
    // the proxy, so it can never reach a STUN server directly and the real public IP cannot leak
    // (WebRTC IP == proxy IP — the §6 coherence bar). Without a proxy we still restrict enumeration
    // to the default public interface so multi-homed hosts don't expose extra interfaces.
    `--force-webrtc-ip-handling-policy=${
      params.proxy ? 'disable_non_proxied_udp' : 'default_public_interface_only'
    }`,
  ];
  const options: PersistentLaunchOptions = {
    userDataDir: params.userDataDir,
    headless: params.headless ?? false,
    args,
  };
  if (params.proxy) options.proxy = toEnginePlaywrightProxy(params.proxy);
  return options;
}

/** UA Client Hints metadata for CDP `Emulation.setUserAgentOverride`. */
export interface UserAgentMetadata {
  brands: Array<{ brand: string; version: string }>;
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
}

/**
 * JS-safe emulation applied via CDP. Deliberately limited to value-substitution surfaces
 * (UA/UA-CH, timezone, locale, geolocation). It NEVER includes canvas/WebGL/audio/TLS — those deep
 * surfaces are handled natively by Lobium (best-effort on the interim Chromium).
 */
export interface CdpEmulation {
  userAgent: string;
  acceptLanguage: string;
  platform: string;
  userAgentMetadata: UserAgentMetadata;
  timezoneId: string;
  locale: string;
  geolocation?: { latitude: number; longitude: number; accuracy: number };
}

export function buildCdpEmulation(fp: Fingerprint): CdpEmulation {
  const nav = fp.navigator;
  const emulation: CdpEmulation = {
    userAgent: nav.userAgent,
    acceptLanguage: fp.locale.acceptLanguage,
    platform: nav.platform,
    userAgentMetadata: {
      brands: nav.uaBrands,
      fullVersion: nav.uaFullVersion,
      platform: nav.uaPlatform,
      platformVersion: nav.uaPlatformVersion,
      architecture: fp.arch === 'arm64' ? 'arm' : 'x86',
      model: '',
      mobile: nav.uaMobile,
    },
    timezoneId: fp.locale.timezone,
    locale: fp.locale.locale,
  };
  if (fp.locale.geolocation) emulation.geolocation = fp.locale.geolocation;
  return emulation;
}

/**
 * Build the main-world init script for the JS-only navigator surfaces that **no CDP override owns**:
 * `deviceMemory` and `maxTouchPoints`.
 *
 * The UA string, platform, UA-CH, hardwareConcurrency, timezone, locale, languages and geolocation
 * are all applied authoritatively by `applyCdpFingerprint` via dedicated CDP overrides — and CDP
 * pins some of those as **non-configurable** own properties. Redefining a non-configurable property
 * throws, so we (a) never touch the CDP-owned surfaces here and (b) wrap each `def` in try/catch so
 * one failure can't abort the rest (the bug that used to leave `deviceMemory` undefined).
 *
 * IMPORTANT: this deliberately does NOT touch canvas/WebGL/AudioContext/TLS — those deep surfaces are
 * native (Lobium). Overriding them from JS is detectable, so we never do it here (see MASTER_PLAN §5).
 *
 * Interim-engine caveat: patchright neutralizes main-world script injection for stealth, so these two
 * surfaces are effectively best-effort on the interim Chromium and become authoritative on Lobium
 * (which sets them natively). The CDP `Emulation.*` overrides in `applyCdpFingerprint` are global and
 * apply regardless; only these JS-injection surfaces carry the caveat.
 */
export function buildFingerprintInitScript(fp: Fingerprint): string {
  const nav = fp.navigator;
  const spec = {
    deviceMemory: nav.deviceMemory,
    maxTouchPoints: nav.maxTouchPoints,
  };
  return [
    '(() => {',
    `  const s = ${JSON.stringify(spec)};`,
    '  const def = (obj, prop, value) => {',
    '    try {',
    '      Object.defineProperty(obj, prop, { get: () => value, configurable: true });',
    '    } catch (_) {',
    '      /* CDP already owns this surface as a non-configurable property — leave it. */',
    '    }',
    '  };',
    '  def(navigator, "deviceMemory", s.deviceMemory);',
    '  def(navigator, "maxTouchPoints", s.maxTouchPoints);',
    '})();',
  ].join('\n');
}
