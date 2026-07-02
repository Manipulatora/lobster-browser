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
 * Build the init script for the JS-safe navigator surfaces. IMPORTANT: this deliberately does NOT
 * touch canvas/WebGL/AudioContext/TLS — those deep surfaces are handled natively by the engine.
 * Overriding them from JS is detectable, so we never do it here (see MASTER_PLAN §5).
 */
export function buildFingerprintInitScript(fp: Fingerprint): string {
  const nav = fp.navigator;
  const spec = {
    languages: nav.languages,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
  };
  return [
    '(() => {',
    `  const s = ${JSON.stringify(spec)};`,
    '  const def = (obj, prop, value) =>',
    '    Object.defineProperty(obj, prop, { get: () => value, configurable: true });',
    '  def(navigator, "languages", Object.freeze([...s.languages]));',
    '  def(navigator, "hardwareConcurrency", s.hardwareConcurrency);',
    '  def(navigator, "deviceMemory", s.deviceMemory);',
    '  def(navigator, "platform", s.platform);',
    '  def(navigator, "maxTouchPoints", s.maxTouchPoints);',
    '})();',
  ].join('\n');
}
