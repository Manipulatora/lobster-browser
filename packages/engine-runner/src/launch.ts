import type { Fingerprint, LaunchParams } from '@lobster/shared-types';
import { toEnginePlaywrightProxy } from '@lobster/proxy';
import { buildGpuArgs } from './gpu.js';
import { buildProxyHardeningArgs } from './proxy-hardening.js';

function chromeWebRtcFlagPolicy(params: LaunchParams): string {
  switch (params.webrtcPolicy) {
    case 'disabled':
    case 'proxy_only':
    case 'disable_non_proxied_udp':
      return 'disable_non_proxied_udp';
    case 'default_public_interface_only':
      return 'default_public_interface_only';
    case undefined:
      return params.proxy ? 'disable_non_proxied_udp' : 'default_public_interface_only';
  }
  return params.proxy ? 'disable_non_proxied_udp' : 'default_public_interface_only';
}

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
    // Size the window to the AVAILABLE area (screen minus taskbar/menu bar), i.e. a maximized window —
    // NOT the full screen. Otherwise outerHeight == screen.height > screen.availHeight, an incoherence
    // (a real window can't be taller than the available work area). availWidth/Height come from the
    // coherent persona.
    `--window-size=${fingerprint.screen.availWidth},${fingerprint.screen.availHeight}`,
    // WebRTC leak protection. Chrome already hides the private IP behind mDNS (.local candidates);
    // the real risk is the PUBLIC IP leaking via a STUN/srflx candidate that bypasses the proxy.
    // With a proxy we force `disable_non_proxied_udp`: WebRTC may only use paths it can route through
    // the proxy, so it can never reach a STUN server directly and the real public IP cannot leak
    // (WebRTC IP == proxy IP — the §6 coherence bar). Without a proxy we still restrict enumeration
    // to the default public interface so multi-homed hosts don't expose extra interfaces.
    `--force-webrtc-ip-handling-policy=${chromeWebRtcFlagPolicy(params)}`,
    // GPU policy. Default (`auto`, no env) emits nothing and preserves prior behavior; on a GPU host
    // set LOBSTER_GPU=gpu so the deep WebGL surfaces render on the real driver instead of silently
    // degrading to SwiftShader/llvmpipe (a headless tell — see gpu.ts / roadmap RG-0).
    ...buildGpuArgs(),
    // PROX-7/8: when proxied, disable QUIC/AsyncDns so UDP/DoH cannot bypass the tunnel.
    ...buildProxyHardeningArgs(params.proxy),
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
  /**
   * The high-entropy `fullVersionList` (returned by `navigator.userAgentData.getHighEntropyValues`).
   * MUST be set: if omitted, Chromium fills it with the REAL engine build (e.g. `152.0.7928.0`), which
   * leaks the true version and contradicts a spoofed UA — a hard lie a detector reads directly.
   */
  fullVersionList: Array<{ brand: string; version: string }>;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  /**
   * `bitness` + `wow64` MUST be set. If omitted, the CDP-overridden main frame returns an EMPTY bitness
   * from getHighEntropyValues(['bitness']) while native workers return "64" — a window-vs-worker UA-CH
   * split (and real Chrome never returns empty bitness). All catalog personas are 64-bit, non-WoW64.
   */
  bitness: string;
  wow64: boolean;
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
  // fullVersionList: each real brand carries the full build (uaFullVersion); the GREASE brand keeps its
  // own version padded to a build shape. Real brands are those whose brand version equals the UA major
  // (Chromium/Google Chrome = "152"); GREASE ("Not_A Brand" = "24") differs. This mirrors exactly what
  // Chrome returns, so getHighEntropyValues(['fullVersionList']) agrees with the UA instead of leaking
  // the engine's own build.
  const major = nav.uaFullVersion.split('.')[0];
  const fullVersionList = nav.uaBrands.map((b) => ({
    brand: b.brand,
    version: b.version === major ? nav.uaFullVersion : `${b.version}.0.0.0`,
  }));
  const emulation: CdpEmulation = {
    userAgent: nav.userAgent,
    acceptLanguage: fp.locale.acceptLanguage,
    platform: nav.platform,
    userAgentMetadata: {
      brands: nav.uaBrands,
      fullVersion: nav.uaFullVersion,
      fullVersionList,
      platform: nav.uaPlatform,
      platformVersion: nav.uaPlatformVersion,
      architecture: fp.arch === 'arm64' ? 'arm' : 'x86',
      model: nav.uaModel ?? '',
      mobile: nav.uaMobile,
      bitness: '64',
      wow64: false,
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
