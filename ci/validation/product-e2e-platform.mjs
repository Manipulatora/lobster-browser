import { win32 } from 'node:path';

/** Resolve the product-representative display mode without treating DISPLAY as a Windows concept. */
export function resolveProductE2eHeadful(platform = process.platform, env = process.env) {
  if (env.LOBSTER_HEADFUL === '1') return true;
  if (env.LOBSTER_HEADFUL === '0') return false;
  return platform === 'win32' || Boolean(env.DISPLAY);
}

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function normalizedWindowsPath(path) {
  return win32
    .normalize(path)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

/**
 * Validate the Windows half of the font-isolation launch contract.
 *
 * Windows Chromium uses DirectWrite, not fontconfig. The native browser process receives the exact
 * measurable family allowlist plus the provisioned pack directory through lobium-fp.json; the
 * runtime font-isolation gate separately proves that DirectWrite actually enforces that allowlist.
 */
export function validateWindowsFontIsolationConfig(
  config,
  sourceFontPackDir,
  userDataDir,
  expectedFamilies,
  expectedFallbackFamilies,
  packId,
) {
  if (!sameStringArray(config.fonts, expectedFamilies)) {
    throw new Error(
      'Windows native config does not carry the requested DirectWrite family allowlist',
    );
  }
  if (!sameStringArray(config.fontFallbackFamilies, expectedFallbackFamilies)) {
    throw new Error('Windows native config does not carry the ordered persona fallback families');
  }
  const stageRoot = win32.join(userDataDir, 'native-font-packs');
  const configuredStage =
    typeof config.fontPackDir === 'string' ? normalizedWindowsPath(config.fontPackDir) : '';
  const relativeStage = win32.relative(normalizedWindowsPath(stageRoot), configuredStage);
  if (
    !configuredStage ||
    configuredStage === normalizedWindowsPath(sourceFontPackDir) ||
    !/^[0-9a-f]{64}$/.test(relativeStage) ||
    relativeStage.includes('\\') ||
    relativeStage.includes('/')
  ) {
    throw new Error(
      `Windows native config fontPackDir is not a content-keyed persona stage: got ${config.fontPackDir ?? '(missing)'}`,
    );
  }
  return {
    mode: 'directwrite',
    packId,
    requestedFamilies: expectedFamilies,
    configuredFamilies: config.fonts,
    fontPackDir: config.fontPackDir,
    sourceFontPackDir,
    fallbackFamilies: config.fontFallbackFamilies,
    directWriteContractConfigured: true,
  };
}
