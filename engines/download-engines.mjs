#!/usr/bin/env node
// Download & cache the pinned browser engines (Camoufox + ungoogled-chromium) for this platform.
//
// Engines are large and are NEVER committed — this script fetches them into engines/bin/ on first run.
// Default is a DRY RUN (prints what it would fetch); pass --download to actually download.
//
// Day 0: resolver + platform detection + safe dry-run. The exact asset URLs + sha256 hashes are
// confirmed and wired in ticket T-002; until then --download errors loudly rather than guessing.

import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, 'bin');

function detectPlatform() {
  const platform = process.platform; // 'win32' | 'darwin' | 'linux'
  const arch = process.arch; // 'x64' | 'arm64'
  return { platform, arch };
}

function resolveAssetUrl(engine, version, { platform, arch }) {
  if (version.startsWith('CONFIRM')) {
    throw new Error(
      `[engines] ${engine} version is not pinned yet ("${version}"). ` +
        `Confirm the release, asset name, and sha256 in ticket T-002 and update engines/versions.json.`,
    );
  }
  // Confirmed patterns are filled in during T-002, e.g.:
  //   camoufox: https://github.com/daijro/camoufox/releases/download/v<version>/camoufox-<version>-<os>.<ext>
  throw new Error(
    `[engines] asset URL resolver for ${engine} on ${platform}/${arch} is pending T-002.`,
  );
}

async function main() {
  const download = process.argv.includes('--download');
  const versions = JSON.parse(await readFile(join(here, 'versions.json'), 'utf8'));
  const plat = detectPlatform();
  await mkdir(BIN, { recursive: true });

  for (const engine of ['camoufox', 'ungoogled-chromium']) {
    const spec = versions[engine];
    const version = spec?.version ?? 'unknown';
    process.stdout.write(`\n=== ${engine} @ ${version} (${plat.platform}/${plat.arch}) ===\n`);
    if (!download) {
      process.stdout.write(`  DRY RUN — would download into ${BIN}. Pass --download to fetch.\n`);
      continue;
    }
    const url = resolveAssetUrl(engine, version, plat);
    process.stdout.write(`  downloading ${url} ...\n`);
    // Day: T-002 implements the actual streamed download + sha256 verify + extract here.
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
