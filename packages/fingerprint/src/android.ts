import type {
  AndroidDeviceFingerprint,
  AndroidFingerprint,
  EngineKind,
  FingerprintSeed,
  NavigatorFingerprint,
} from '@lobster/shared-types';
import { DEVICE_MEMORY_VALUES, languagesToAcceptLanguage } from './coherence.js';
import { ANDROID_TEMPLATE, ENGINE_CHROME, chromeVersionForms } from './pools.js';
import { SeededRandom } from './prng.js';

export interface DeriveAndroidOptions {
  /** Android Lobium and Chromium-for-Android are both Chromium-family. Kept for API symmetry. */
  engine: EngineKind;
  browserVersion?: string;
}

function buildBrands(major: string): NavigatorFingerprint['uaBrands'] {
  return [
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
    { brand: 'Not_A Brand', version: '24' },
  ];
}

function buildAndroidUserAgent(androidVersion: string, model: string, reducedVersion: string): string {
  return `Mozilla/5.0 (Linux; Android ${androidVersion}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reducedVersion} Mobile Safari/537.36`;
}

function androidMetadata(device: (typeof ANDROID_TEMPLATE.devices)[number]): AndroidDeviceFingerprint {
  return {
    brand: device.brand,
    manufacturer: device.manufacturer,
    model: device.model,
    device: device.device,
    androidVersion: device.androidVersion,
    apiLevel: device.apiLevel,
    buildId: device.buildId,
    buildFingerprint: device.buildFingerprint,
    formFactor: 'phone',
    cpuAbi: 'arm64-v8a',
  };
}

/**
 * Derive an Android fingerprint from the Android-only catalog. This is intentionally separate from
 * `deriveFingerprint`: desktop profiles remain Windows/macOS/Linux-only, while Android can be tested
 * and persisted for the future APK/device runner without becoming a fake desktop launch target.
 */
export function deriveAndroidFingerprint(
  seed: FingerprintSeed,
  opts: DeriveAndroidOptions,
): AndroidFingerprint {
  void opts.engine;
  const rng = new SeededRandom(seed);
  const device = rng.pick(ANDROID_TEMPLATE.devices);
  const ver = chromeVersionForms(opts.browserVersion ?? ENGINE_CHROME.full);
  const primaryLocale = 'en-US';
  const languages = [primaryLocale, 'en'];

  return {
    os: 'android',
    arch: 'arm64',
    android: androidMetadata(device),
    navigator: {
      userAgent: buildAndroidUserAgent(device.androidVersion, device.model, ver.reduced),
      platform: ANDROID_TEMPLATE.platform,
      languages,
      hardwareConcurrency: device.hardwareConcurrency,
      deviceMemory: device.deviceMemory,
      maxTouchPoints: device.maxTouchPoints,
      uaBrands: buildBrands(ver.major),
      uaPlatform: ANDROID_TEMPLATE.uaPlatform,
      uaPlatformVersion: `${device.androidVersion}.0.0`,
      uaMobile: true,
      uaFullVersion: ver.full,
      uaModel: device.model,
    },
    screen: {
      width: device.screen.width,
      height: device.screen.height,
      availWidth: device.screen.width,
      availHeight: device.screen.height,
      availLeft: 0,
      availTop: 0,
      colorDepth: 24,
      devicePixelRatio: device.screen.dpr,
    },
    webgl: { ...device.webgl },
    locale: {
      timezone: 'America/New_York',
      locale: primaryLocale,
      acceptLanguage: languagesToAcceptLanguage(languages),
    },
    fonts: [...ANDROID_TEMPLATE.fonts],
  };
}

const CHROME_UA_BRANDS = new Set(['Google Chrome', 'Chromium']);

function isGreaseBrand(brand: string): boolean {
  return /not.{0,4}a.{0,4}brand/i.test(brand);
}

function chromeMajorFromUserAgent(ua: string): string | null {
  const m = /Chrome\/(\d+)\./.exec(ua);
  return m ? (m[1] ?? null) : null;
}

function baseLanguage(locale: string): string {
  return locale.split('-')[0] ?? locale;
}

/**
 * Android-specific coherence gate. It checks the mobile form-factor chain that the desktop coherence
 * validator deliberately rejects: Android UA token, Sec-CH-UA model/platform, touch, portrait CSS
 * screen, mobile GPU backend, Android fonts, and sane CPU/RAM buckets.
 */
export function validateAndroidFingerprintCoherence(fp: AndroidFingerprint): string[] {
  const issues: string[] = [];
  const nav = fp.navigator;
  const ua = nav.userAgent;

  if (fp.os !== 'android') issues.push(`Android fingerprint has non-Android OS "${fp.os}"`);
  if (fp.arch !== 'arm64') issues.push(`Android fingerprint arch must be arm64, got "${fp.arch}"`);
  if (fp.android.cpuAbi !== 'arm64-v8a') {
    issues.push(`Android CPU ABI must be arm64-v8a, got "${fp.android.cpuAbi}"`);
  }
  if (!ua.includes(`Android ${fp.android.androidVersion}`)) {
    issues.push(
      `User-Agent does not include Android version ${fp.android.androidVersion}: ${ua}`,
    );
  }
  if (!ua.includes(fp.android.model)) {
    issues.push(`User-Agent does not include Android model "${fp.android.model}": ${ua}`);
  }
  if (!/Mobile Safari\/537\.36/.test(ua)) {
    issues.push(`Android Chrome UA must include Mobile Safari/537.36: ${ua}`);
  }
  if (nav.uaPlatform !== 'Android') {
    issues.push(`Sec-CH-UA-Platform must be "Android", got "${nav.uaPlatform}"`);
  }
  if (nav.uaModel !== fp.android.model) {
    issues.push(
      `Sec-CH-UA-Model (${nav.uaModel ?? ''}) does not match Android model (${fp.android.model})`,
    );
  }
  if (!nav.uaPlatformVersion.startsWith(`${fp.android.androidVersion}.`)) {
    issues.push(
      `Sec-CH-UA-Platform-Version (${nav.uaPlatformVersion}) does not match Android ${fp.android.androidVersion}`,
    );
  }
  if (!nav.uaMobile) issues.push('Android uaMobile must be true');
  if (nav.maxTouchPoints < 1) {
    issues.push(`Android maxTouchPoints must be >0, got ${nav.maxTouchPoints}`);
  }
  if (!/^Linux arm/.test(nav.platform)) {
    issues.push(`Android navigator.platform should be Linux arm*, got "${nav.platform}"`);
  }

  const chromeMajor = chromeMajorFromUserAgent(ua);
  if (chromeMajor) {
    const chromeBrand = nav.uaBrands.find((b) => CHROME_UA_BRANDS.has(b.brand));
    if (!chromeBrand) {
      issues.push('Sec-CH-UA has no Chrome/Chromium brand for Android Chrome');
    } else if (chromeBrand.version !== chromeMajor) {
      issues.push(
        `Sec-CH-UA brand version (${chromeBrand.version}) does not match UA major (${chromeMajor})`,
      );
    }
    const foreign = nav.uaBrands.find(
      (b) => !CHROME_UA_BRANDS.has(b.brand) && !isGreaseBrand(b.brand),
    );
    if (foreign) {
      issues.push(`Sec-CH-UA advertises a non-Chrome brand "${foreign.brand}"`);
    }
    const fullMajor = nav.uaFullVersion.split('.')[0] ?? '';
    if (!nav.uaFullVersion || fullMajor !== chromeMajor) {
      issues.push(
        `uaFullVersion (${nav.uaFullVersion}) major does not match UA major (${chromeMajor})`,
      );
    }
  }

  if (nav.languages[0] !== fp.locale.locale) {
    issues.push(
      `navigator.languages[0] (${nav.languages[0]}) does not match locale (${fp.locale.locale})`,
    );
  }
  if (!fp.locale.acceptLanguage.startsWith(fp.locale.locale)) {
    issues.push(
      `Accept-Language (${fp.locale.acceptLanguage}) does not lead with locale (${fp.locale.locale})`,
    );
  }
  if (baseLanguage(nav.languages[0] ?? '') !== baseLanguage(fp.locale.locale)) {
    issues.push('navigator language and locale base language disagree');
  }

  if (!DEVICE_MEMORY_VALUES.includes(nav.deviceMemory)) {
    issues.push(
      `navigator.deviceMemory (${nav.deviceMemory}) is not a spec value (one of ${DEVICE_MEMORY_VALUES.join('/')})`,
    );
  } else if (nav.deviceMemory < 2 || nav.deviceMemory > 8) {
    issues.push(`Android deviceMemory (${nav.deviceMemory}) is outside the plausible 2-8 GB bucket`);
  }
  if (
    !Number.isInteger(nav.hardwareConcurrency) ||
    nav.hardwareConcurrency < 4 ||
    nav.hardwareConcurrency > 12
  ) {
    issues.push(
      `Android hardwareConcurrency (${nav.hardwareConcurrency}) is outside the plausible 4-12 range`,
    );
  }

  if (fp.screen.availWidth > fp.screen.width || fp.screen.availHeight > fp.screen.height) {
    issues.push('Android screen avail dimensions exceed physical CSS dimensions');
  }
  if (fp.android.formFactor === 'phone' && fp.screen.width >= fp.screen.height) {
    issues.push(`Android phone screen must be portrait by default: ${fp.screen.width}x${fp.screen.height}`);
  }
  if (fp.screen.width < 320 || fp.screen.width > 600 || fp.screen.height < 600 || fp.screen.height > 1100) {
    issues.push(`Android phone CSS screen is outside expected bounds: ${fp.screen.width}x${fp.screen.height}`);
  }
  if (fp.screen.colorDepth !== 24) {
    issues.push(`Android colorDepth should be 24, got ${fp.screen.colorDepth}`);
  }
  if (fp.screen.devicePixelRatio < 1 || fp.screen.devicePixelRatio > 4) {
    issues.push(`Android devicePixelRatio (${fp.screen.devicePixelRatio}) is outside the plausible [1,4] range`);
  }

  const webglText = `${fp.webgl.vendor} ${fp.webgl.renderer}`;
  if (/Direct3D|Metal Renderer/i.test(fp.webgl.renderer)) {
    issues.push(`Android WebGL must not use desktop GPU backends: ${fp.webgl.renderer}`);
  }
  if (/SwiftShader|llvmpipe|Software|Microsoft Basic Render/i.test(webglText)) {
    issues.push(`Android WebGL uses a software renderer: ${webglText}`);
  }
  if (!/OpenGL ES|Vulkan/i.test(fp.webgl.renderer)) {
    issues.push(`Android WebGL renderer should expose a mobile GLES/Vulkan backend: ${fp.webgl.renderer}`);
  }
  if (!/Qualcomm|Adreno|ARM|Mali|PowerVR/i.test(webglText)) {
    issues.push(`Android WebGL renderer/vendor is not a mobile GPU family: ${webglText}`);
  }

  if (!fp.fonts.some((font) => /Roboto|Noto Sans/i.test(font))) {
    issues.push('Android fonts must include Roboto/Noto Sans');
  }
  if (fp.fonts.some((font) => /Segoe UI|Calibri|Helvetica Neue|San Francisco/i.test(font))) {
    issues.push('Android fonts include desktop-only families');
  }

  return issues;
}
