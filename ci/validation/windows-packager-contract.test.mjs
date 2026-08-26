import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  ARTIFACT_TREE_ALGORITHM,
  assertExactFontFamilies,
  assertExactFontScannerProvenance,
  buildArtifactLedger,
  buildFontFamilyInventory,
  FONT_PACK_MANIFEST,
  LOBIUM_CAPABILITY_CONTRACT_VERSION,
  parseFontScannerFamilies,
  verifyFontPack,
  verifyFontPackWithScanner,
  verifyLobiumRuntime,
  WINDOWS_REQUIRED_CAPABILITIES,
} from '../../scripts/verify-lobium-runtime.mjs';

const root = new URL('../../', import.meta.url);
const rootPath = fileURLToPath(root);
const read = async (path) =>
  (await import('node:fs/promises')).readFile(new URL(path, root), 'utf8');
const execFileAsync = promisify(execFile);

function marker(artifacts) {
  return {
    schemaVersion: 2,
    engine: 'lobium',
    platform: 'win-x64',
    chrome: 'chrome.exe',
    fonts: null,
    fontInventory: null,
    version: '152.0.7977.42',
    packagedAt: '2026-08-23T00:00:00Z',
    provenance: {
      chromiumRef: '152.0.7977.42',
      chromiumCommit: 'a'.repeat(40),
      lobsterRevision: 'b'.repeat(40),
      lobsterWorkingTreeDirty: false,
      buildArgsSha256: 'c'.repeat(64),
      capabilityContractVersion: LOBIUM_CAPABILITY_CONTRACT_VERSION,
      capabilities: [...WINDOWS_REQUIRED_CAPABILITIES],
    },
    artifacts,
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'lobium-runtime-ledger-'));
  await mkdir(join(dir, 'locales'));
  await writeFile(join(dir, 'chrome.exe'), 'browser');
  await writeFile(join(dir, 'chrome.dll'), 'implementation');
  await writeFile(join(dir, '152.0.7977.42.manifest'), 'assembly');
  await writeFile(join(dir, 'locales', 'en-US.pak'), 'locale');
  const artifacts = await buildArtifactLedger(dir);
  await writeFile(
    join(dir, 'LOBSTER_ENGINE.json'),
    `${JSON.stringify(marker(artifacts), null, 2)}\n`,
  );
  return dir;
}

async function fontPackFixture(dir) {
  dir ??= await mkdtemp(join(tmpdir(), 'lobium-font-pack-'));
  const file = join(dir, 'files', 'OpenSans-Regular.ttf');
  const bytes = Buffer.from('synthetic Open Sans face');
  await mkdir(join(dir, 'files'), { recursive: true });
  await writeFile(file, bytes);
  const manifest = {
    version: 1,
    packId: 'lobster-open-fonts-test',
    files: [
      {
        path: 'files/OpenSans-Regular.ttf',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        families: ['Open Sans'],
        license: 'OFL-1.1',
      },
    ],
    personas: Object.fromEntries(
      ['windows', 'macos', 'linux', 'android'].map((persona) => [
        persona,
        { families: ['Open Sans'], physicalFamilies: ['Open Sans'] },
      ]),
    ),
    licenses: [
      {
        family: 'Open Sans',
        license: 'OFL-1.1',
        licenseUrl: 'https://example.invalid/OFL.txt',
      },
    ],
  };
  const manifestPath = join(dir, FONT_PACK_MANIFEST);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, file, manifest, manifestPath };
}

async function writeManifest(path, manifest) {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function fontInventoryAttestation(manifest) {
  return {
    ...buildFontFamilyInventory(manifest),
    scanner: {
      product: 'fontconfig-fc-scan',
      version: 'fontconfig version 2.18.3',
      executableSha256: 'd'.repeat(64),
    },
  };
}

test('Windows packager validates before a transactional non-overlapping swap', async () => {
  const [packager, nativeCapabilities, verifier] = await Promise.all([
    read('scripts/package-lobium-runtime.ps1'),
    read('lobium/src/lobium_capabilities.cc'),
    read('scripts/verify-lobium-runtime.mjs'),
  ]);

  assert.match(packager, /Resolve-CanonicalPath \$src -MustExist/);
  assert.match(packager, /Test-PathContains \$src \$OutDir/);
  assert.match(packager, /Test-PathContains \$OutDir \$src/);
  assert.match(packager, /Test-PathContains \$OutDir \$repoRoot/);
  assert.match(packager, /Assert-NoReparsePathComponents \$OutDir 'output'/);
  assert.match(packager, /Test-PathContains \$repoRoot \$OutDir/);
  assert.match(packager, /Test-PathContains \$repoDist \$OutDir/);
  assert.match(packager, /\$outLeaf -notmatch/);
  assert.doesNotMatch(packager, /Remove-Item[^\n]*\$OutDir/);

  const preflight = packager.indexOf('$sourceCapabilities = Read-CapabilityManifest');
  const fontPreflight = packager.indexOf('Assert-FontPack $FontPack $runtimeVerifier $FontScanner');
  const staging = packager.indexOf('New-Item -ItemType Directory -Path $staging');
  const copiedFontCheck = packager.indexOf(
    'Assert-FontPack $fontsOut $runtimeVerifier $FontScanner',
  );
  const oldMove = packager.indexOf('Move-Item -LiteralPath $OutDir -Destination $backup');
  const newMove = packager.indexOf('Move-Item -LiteralPath $staging -Destination $OutDir');
  assert.ok(preflight >= 0 && preflight < staging && staging < oldMove && oldMove < newMove);
  assert.ok(fontPreflight >= 0 && fontPreflight < staging);
  assert.ok(staging < copiedFontCheck && copiedFontCheck < oldMove);
  assert.match(packager, /Move-Item -LiteralPath \$backup -Destination \$OutDir/);
  assert.match(packager, /previous output remains at '\$backup'/);

  // Chromium's --version handling is POSIX-only. On Windows, exact version identity comes from the
  // executable's PE VERSIONINFO while Lobium brand/semantic identity comes from the native manifest.
  assert.match(packager, /function Read-PeProductVersion/);
  assert.match(packager, /Get-Item -LiteralPath \$Chrome -ErrorAction Stop/);
  assert.match(packager, /\$file\.VersionInfo\.ProductVersion/);
  assert.match(packager, /Read-PeProductVersion \$sourceChrome/);
  assert.match(packager, /Read-PeProductVersion \$stagedChrome/);
  assert.match(packager, /\$stagedVersion -ne \$version/);
  assert.doesNotMatch(packager, /Invoke-BrowserProbe[^\r\n]*['"]--version['"]/);
  assert.match(packager, /Read-CapabilityManifest \$sourceChrome/);
  assert.match(packager, /Read-CapabilityManifest \$stagedChrome/);

  const requiredBlock = /\$requiredCapabilities = @\(([\s\S]*?)\n\s*\)/.exec(packager)?.[1];
  assert.ok(requiredBlock, 'could not parse the packager capability list');
  const required = [...requiredBlock.matchAll(/'([a-z0-9-]+)'/g)].map((match) => match[1]);
  const portable = [...nativeCapabilities.matchAll(/^\s*"([a-z0-9-]+)",\s*$/gm)].map(
    (match) => match[1],
  );
  const platform = [...nativeCapabilities.matchAll(/names\.push_back\("([a-z0-9-]+)"\);/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(required, [...portable, ...platform]);
  assert.deepEqual(required, [...WINDOWS_REQUIRED_CAPABILITIES]);

  assert.match(packager, /schemaVersion = 2/);
  assert.match(packager, /buildArgsSha256/);
  assert.match(packager, /chromiumCommit/);
  assert.match(packager, /artifacts = \$artifactLedger/);
  assert.match(packager, /Get-ChildItem -LiteralPath \$RuntimeDir -Recurse -File -Force -Name/);
  assert.doesNotMatch(packager, /\.FullName\.Substring\(\$prefix\.Length\)/);
  assert.match(packager, /fontInventory = \$\(if \(\$fontsProvisioned\)/);
  assert.match(packager, /verify-lobium-runtime\.mjs/);
  assert.match(packager, /node \$Verifier --font-pack \$Path --font-scanner \$Scanner --json/);
  assert.match(packager, /-FontScanner <fc-scan executable> is mandatory/);
  assert.match(packager, /\$runtimeVerifier \$staging --font-scanner \$FontScanner/);
  assert.match(
    verifier,
    /execFileAsync\(\s*scanner\.executable,\s*\['--format', '%\{family\}\\\\n', absolute\]/,
  );
  assert.match(verifier, /executableSha256: await sha256File\(scanner\.executable\)/);
  assert.doesNotMatch(verifier, /execFileAsync\([\s\S]{0,300}shell:\s*true/);
  assert.match(packager, /-Include \*\.ttf, \*\.ttc, \*\.otf -Recurse/);
  assert.doesNotMatch(packager, /\*\.otc/);
  assert.doesNotMatch(packager, /\.lobium-engine-version/);
});

test(
  'engine probe reads a stream the browser left empty',
  { skip: process.platform !== 'win32' },
  async () => {
    const packager = await read('scripts/package-lobium-runtime.ps1');

    // Get-Content -Raw returns $null - not an empty string - for a zero-byte file, so .Trim() on
    // its result throws. cmd redirection creates both streams whether or not the child writes to
    // them, which makes Test-Path look like a guard while never being one. A clean capability probe
    // writes its manifest to stdout and NOTHING to stderr, so the packager failed exactly when the
    // engine behaved correctly and survived only when Crashpad emitted transient noise. The same
    // defect on the stdout read broke the error path itself: a probe that printed nothing died with
    // a null-method error instead of the intended "<label> probe failed" diagnosis.
    assert.doesNotMatch(packager, /Get-Content[^\n]*-Raw[^\n]*\)\.Trim\(\)/);
    assert.match(packager, /function Read-ProbeStream/);
    assert.match(packager, /\$value = Read-ProbeStream \$stdout/);
    assert.match(packager, /\$errorText = Read-ProbeStream \$stderr/);

    const dir = await mkdtemp(join(tmpdir(), 'lobium-probe-stream-'));
    try {
      const start = packager.indexOf('function Read-ProbeStream {');
      const end = packager.indexOf('function Invoke-BrowserProbe {');
      assert.ok(start >= 0 && end > start, 'could not isolate the probe stream reader');

      const empty = join(dir, 'empty.txt');
      const padded = join(dir, 'padded.txt');
      const absent = join(dir, 'absent.txt');
      await writeFile(empty, '');
      await writeFile(padded, '  {"product":"Lobium"}  \r\n');

      const quote = (value) => value.replaceAll("'", "''");
      const harness = join(dir, 'probe-stream-harness.ps1');
      await writeFile(
        harness,
        `$ErrorActionPreference = 'Stop'\n` +
          `${packager.slice(start, end)}\n` +
          `$empty = Read-ProbeStream '${quote(empty)}'\n` +
          `$padded = Read-ProbeStream '${quote(padded)}'\n` +
          `$missing = Read-ProbeStream '${quote(absent)}'\n` +
          `@{\n` +
          `  empty = $empty\n` +
          `  emptyType = $empty.GetType().Name\n` +
          `  padded = $padded\n` +
          `  missing = $missing\n` +
          `} | ConvertTo-Json -Compress\n`,
      );

      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness],
        { encoding: 'utf8' },
      );
      const observed = JSON.parse(stdout.replace(/^\uFEFF/, ''));
      // A zero-byte stream must read back as an empty string, not $null: .GetType() on the result
      // is what proves the reader never hands a null onward to the probe's own string operations.
      assert.equal(observed.emptyType, 'String');
      assert.equal(observed.empty, '');
      assert.equal(observed.missing, '');
      assert.equal(observed.padded, '{"product":"Lobium"}');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('pending Windows publication guidance cannot select the stale unversioned runtime', async () => {
  const [manifest, operations] = await Promise.all([
    read('apps/desktop/src-tauri/resources/engine-manifest.json').then(JSON.parse),
    read('docs/OPERATIONS.md'),
  ]);
  // Two legal states, and the test must pin whichever one the manifest is actually in. A test that
  // only understands the pending state starts failing the moment the artifact ships, which trains
  // people to delete it rather than read it.
  const pending = manifest['win-x64Pending'];
  const published = manifest.platforms?.['win-x64'];
  assert.ok(
    Boolean(pending) !== Boolean(published),
    'win-x64 must be either pending or published, never both and never neither: a pending block' +
      ' left beside a published entry tells the reader to go and do what has already been done.',
  );

  if (published) {
    // Published: the entry has to stand on its own terms.
    assert.ok(/^[0-9]+([.][0-9]+){3}$/.test(published.version), published.version);
    assert.match(published.sha256, /^[0-9a-f]{64}$/);
    assert.ok(published.url.startsWith('https://'));
    assert.ok(
      published.url.includes(published.version),
      'the URL must name its own version, or a later bump can silently serve the old archive',
    );
  } else {
    const guidance = manifest['win-x64Pending']?.howToClear;
    assert.equal(typeof guidance, 'string');
    assert.match(guidance, /-FontPack <verified-font-pack>/);
    assert.match(guidance, /-FontScanner <fc-scan\.exe>/);
    assert.match(guidance, /exact declared-versus-scanned family sets/);
    assert.match(guidance, /each persona[\s\S]*selected multi-family TTC/);
    assert.match(guidance, /verify-lobium-runtime\.mjs --font-scanner <fc-scan\.exe>/);
    assert.match(guidance, /no-pack runtime is local\/degraded only and must not be published/);
    assert.match(guidance, /-OutDir dist-win\/lobium-runtime-152\.0\.7977\.42/);
    assert.match(guidance, /verify-lobium-runtime\.mjs/);
    assert.match(guidance, /lobium-win-x64-152\.0\.7977\.42\.zip/);
    assert.match(guidance, /extract into a new verification directory/);
    assert.match(guidance, /download its final public URL and require the same SHA-256/);
    assert.doesNotMatch(guidance, /compress dist-win\/lobium-runtime to lobium-win-x64\.zip/);
  }

  const packaging = operations.slice(
    operations.indexOf('#### Packaging the Windows engine runtime'),
    operations.indexOf('> **The packaged sidecar could not start'),
  );
  assert.match(
    packaging,
    /-SourceDir \$src -OutDir \$out -FontPack \$fontPack -FontScanner \$fontScanner/,
  );
  assert.match(packaging, /--font-pack \$fontPack --font-scanner \$fontScanner/);
  assert.match(packaging, /exact equality[\s\S]*complete `fc-scan`[\s\S]*TTC companion/);
  assert.match(packaging, /Omitting\s+`-FontPack` is supported only for local diagnosis/);
  assert.match(packaging, /do not\s+publish that runtime as the production `win-x64` engine/);
});

test(
  'PowerShell preflight and overlap failures preserve an existing output',
  { skip: process.platform !== 'win32' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lobium-packager-safety-'));
    const source = join(dir, 'build', 'Lobium');
    const release = join(dir, 'release');
    const output = join(release, 'lobium-runtime-test');
    const sentinel = join(output, 'keep-me.txt');
    const invalidFontPack = join(dir, 'invalid-font-pack');
    const script = join(rootPath, 'scripts', 'package-lobium-runtime.ps1');
    try {
      await mkdir(source, { recursive: true });
      await mkdir(output, { recursive: true });
      await mkdir(join(invalidFontPack, 'files'), { recursive: true });
      await writeFile(join(source, 'chrome.exe'), 'not a real executable');
      await writeFile(sentinel, 'original output');
      await writeFile(join(invalidFontPack, FONT_PACK_MANIFEST), '{}\n');

      await assert.rejects(
        execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            script,
            '-SourceDir',
            source,
            '-OutDir',
            output,
            '-FontPack',
            invalidFontPack,
          ],
          { encoding: 'utf8' },
        ),
        (error) => {
          assert.match(`${error.stdout ?? ''}${error.stderr ?? ''}`, /-FontScanner .* mandatory/);
          return true;
        },
      );
      assert.equal(await readFile(sentinel, 'utf8'), 'original output');

      // This reaches the actual PowerShell-to-Node font preflight before Chromium probing. Its
      // failure must not create staging, move the old output, or consume the source font directory.
      await assert.rejects(
        execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            script,
            '-SourceDir',
            source,
            '-OutDir',
            output,
            '-FontPack',
            invalidFontPack,
            '-FontScanner',
            process.execPath,
          ],
          { encoding: 'utf8' },
        ),
        (error) => {
          assert.match(
            `${error.stdout ?? ''}${error.stderr ?? ''}`,
            /font pack verification failed.*unsupported manifest version/s,
          );
          return true;
        },
      );
      assert.equal(await readFile(sentinel, 'utf8'), 'original output');
      assert.equal(await readFile(join(invalidFontPack, FONT_PACK_MANIFEST), 'utf8'), '{}\n');

      await assert.rejects(
        execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            script,
            '-SourceDir',
            source,
            '-OutDir',
            output,
          ],
          { encoding: 'utf8' },
        ),
        (error) => {
          assert.match(
            `${error.stdout ?? ''}${error.stderr ?? ''}`,
            /required runtime\/build file is missing/,
          );
          return true;
        },
      );
      assert.equal(await readFile(sentinel, 'utf8'), 'original output');
      assert.deepEqual(await readdir(release), ['lobium-runtime-test']);

      await assert.rejects(
        execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            script,
            '-SourceDir',
            source,
            '-OutDir',
            source,
          ],
          { encoding: 'utf8' },
        ),
        (error) => {
          assert.match(
            `${error.stdout ?? ''}${error.stderr ?? ''}`,
            /refusing overlapping Lobium package paths/,
          );
          return true;
        },
      );
      assert.equal(await readFile(join(source, 'chrome.exe'), 'utf8'), 'not a real executable');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('v1 font-pack verifier enforces the physical, persona, and license ledgers', async (t) => {
  await t.test(
    'structural verification accepts the producer shape and CLI requires a scanner',
    async () => {
      const pack = await fontPackFixture();
      try {
        const manifest = await verifyFontPack(pack.dir);
        assert.equal(manifest.packId, 'lobster-open-fonts-test');
        await assert.rejects(
          verifyFontPackWithScanner(pack.dir, process.execPath),
          /unsupported version string/,
        );

        await assert.rejects(
          execFileAsync(
            process.execPath,
            [
              fileURLToPath(new URL('../../scripts/verify-lobium-runtime.mjs', import.meta.url)),
              '--font-pack',
              pack.dir,
            ],
            { encoding: 'utf8' },
          ),
          (error) => {
            assert.equal(error.code, 2);
            assert.match(error.stderr, /--font-scanner <fc-scan-executable>/);
            return true;
          },
        );
      } finally {
        await rm(pack.dir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    'scanner output is exact and rejects missing, duplicate, or empty families',
    async () => {
      assert.deepEqual(parseFontScannerFamilies('face.ttf', 'Open Sans\n'), ['Open Sans']);
      assert.deepEqual(assertExactFontFamilies('face.ttf', ['Open Sans'], ['Open Sans']), [
        'Open Sans',
      ]);
      assert.throws(
        () => assertExactFontFamilies('face.ttf', ['Open Sans'], ['Fabricated Sans']),
        /scanned family inventory differs/,
      );
      assert.throws(
        () => parseFontScannerFamilies('face.ttf', 'Open Sans\nOpen Sans\n'),
        /duplicate family/,
      );
      assert.throws(
        () => parseFontScannerFamilies('face.ttf', 'Open Sans\n\n'),
        /empty family line/,
      );

      const scanner = {
        product: 'fontconfig-fc-scan',
        version: 'fontconfig version 2.18.3',
        executableSha256: 'a'.repeat(64),
      };
      assert.deepEqual(assertExactFontScannerProvenance(scanner, { ...scanner }), scanner);
      assert.throws(
        () =>
          assertExactFontScannerProvenance(scanner, {
            ...scanner,
            executableSha256: 'b'.repeat(64),
          }),
        /font scanner provenance differs from the packaging attestation: executableSha256/,
      );
    },
  );

  await t.test('rejects modified, missing, empty, and undeclared font bytes', async () => {
    const pack = await fontPackFixture();
    try {
      await writeFile(pack.file, 'tampered');
      await assert.rejects(verifyFontPack(pack.dir), /failed SHA-256 verification/);

      await writeFile(pack.file, 'synthetic Open Sans face');
      await writeFile(join(pack.dir, 'files', 'undeclared.otf'), 'extra face');
      await assert.rejects(
        verifyFontPack(pack.dir),
        /ledger mismatch \(undeclared: files\/undeclared\.otf/,
      );
      await rm(join(pack.dir, 'files', 'undeclared.otf'));

      await writeFile(pack.file, '');
      await assert.rejects(verifyFontPack(pack.dir), /declared font .* is empty/);
      await rm(pack.file);
      await assert.rejects(verifyFontPack(pack.dir), /declared font .* is absent or unreadable/);
    } finally {
      await rm(pack.dir, { recursive: true, force: true });
    }
  });

  await t.test('rejects unsafe, duplicate, and unsupported declared paths', async () => {
    const pack = await fontPackFixture();
    try {
      pack.manifest.files[0].path = 'files/../escape.ttf';
      await writeManifest(pack.manifestPath, pack.manifest);
      await assert.rejects(verifyFontPack(pack.dir), /file entry 0 path is unsafe/);

      pack.manifest.files[0].path = 'files/CON.ttf';
      await writeManifest(pack.manifestPath, pack.manifest);
      await assert.rejects(verifyFontPack(pack.dir), /reserved Windows device name/);

      pack.manifest.files[0].path = 'files/OpenSans-Regular.otc';
      await writeManifest(pack.manifestPath, pack.manifest);
      await assert.rejects(verifyFontPack(pack.dir), /not an allowed font below files/);

      pack.manifest.files[0].path = 'files/OpenSans-Regular.ttf';
      pack.manifest.files.push({
        ...pack.manifest.files[0],
        path: 'files/opensans-regular.TTF',
      });
      await writeManifest(pack.manifestPath, pack.manifest);
      await assert.rejects(verifyFontPack(pack.dir), /duplicate font path/);
    } finally {
      await rm(pack.dir, { recursive: true, force: true });
    }
  });

  await t.test('rejects font-like files outside the supported DirectWrite set', async () => {
    const pack = await fontPackFixture();
    try {
      await writeFile(join(pack.dir, 'files', 'undeclared.otc'), 'OpenType collection');
      await assert.rejects(verifyFontPack(pack.dir), /font file uses an unsupported extension/);
    } finally {
      await rm(pack.dir, { recursive: true, force: true });
    }
  });

  await t.test('requires every persona physical family to be real and covered', async () => {
    const pack = await fontPackFixture();
    try {
      pack.manifest.personas.windows.physicalFamilies = ['Fabricated Sans'];
      await writeManifest(pack.manifestPath, pack.manifest);
      await assert.rejects(verifyFontPack(pack.dir), /physical family is not backed/);

      pack.manifest.personas.windows.physicalFamilies = ['Open Sans'];
      for (const persona of Object.values(pack.manifest.personas)) {
        persona.physicalFamilies = ['Open Sans'];
      }
      delete pack.manifest.personas.android.physicalFamilies;
      await writeManifest(pack.manifestPath, pack.manifest);
      await assert.rejects(
        verifyFontPack(pack.dir),
        /android persona physicalFamilies is empty or absent/,
      );
    } finally {
      await rm(pack.dir, { recursive: true, force: true });
    }
  });

  await t.test('requires persona selections to include every family exposed by a TTC', async () => {
    const pack = await fontPackFixture();
    try {
      pack.manifest.files[0].families.push('Open Sans Companion');
      pack.manifest.licenses.push({
        family: 'Open Sans Companion',
        license: pack.manifest.files[0].license,
        licenseUrl: 'https://example.invalid/LICENSE',
      });
      for (const persona of Object.values(pack.manifest.personas)) {
        persona.physicalFamilies = ['Open Sans', 'Open Sans Companion'];
      }
      pack.manifest.personas.windows.physicalFamilies = ['Open Sans'];
      await writeManifest(pack.manifestPath, pack.manifest);
      await assert.rejects(
        verifyFontPack(pack.dir),
        /windows persona selects only part of multi-family font/,
      );
    } finally {
      await rm(pack.dir, { recursive: true, force: true });
    }
  });

  await t.test('requires exact physical-family license coverage and identifiers', async () => {
    const pack = await fontPackFixture();
    try {
      pack.manifest.licenses = [];
      await writeManifest(pack.manifestPath, pack.manifest);
      await assert.rejects(verifyFontPack(pack.dir), /licenses are absent or malformed/);

      pack.manifest.licenses = [
        {
          family: 'Open Sans',
          license: 'Apache-2.0',
          licenseUrl: 'https://example.invalid/LICENSE',
        },
      ];
      await writeManifest(pack.manifestPath, pack.manifest);
      await assert.rejects(verifyFontPack(pack.dir), /license identifier .* does not match/);

      pack.manifest.licenses[0].family = 'Unrelated Sans';
      await writeManifest(pack.manifestPath, pack.manifest);
      await assert.rejects(verifyFontPack(pack.dir), /license family coverage mismatch/);
    } finally {
      await rm(pack.dir, { recursive: true, force: true });
    }
  });

  await t.test('rejects links and Windows reparse points anywhere in the pack', async () => {
    const pack = await fontPackFixture();
    const target = await mkdtemp(join(tmpdir(), 'lobium-font-link-target-'));
    try {
      await symlink(
        target,
        join(pack.dir, 'linked-directory'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await assert.rejects(
        verifyFontPack(pack.dir),
        /links or reparse points are not allowed|Windows reparse point/,
      );
    } finally {
      await rm(pack.dir, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });
});

test('runtime verifier binds a provisioned marker to the internal font-pack contract', async () => {
  const dir = await fixture();
  try {
    const pack = await fontPackFixture(join(dir, 'fonts'));
    const path = join(dir, 'LOBSTER_ENGINE.json');
    const fontInventory = fontInventoryAttestation(pack.manifest);
    const withFonts = marker(await buildArtifactLedger(dir));
    withFonts.fonts = `fonts/${FONT_PACK_MANIFEST}`;
    withFonts.fontInventory = fontInventory;
    await writeFile(path, `${JSON.stringify(withFonts, null, 2)}\n`);
    await verifyLobiumRuntime(dir);
    const { stdout: attestedOutput } = await execFileAsync(
      process.execPath,
      [fileURLToPath(new URL('../../scripts/verify-lobium-runtime.mjs', import.meta.url)), dir],
      { encoding: 'utf8' },
    );
    assert.match(attestedOutput, /^attested Lobium /);
    assert.match(attestedOutput, /font bytes not rescanned/);

    const missingAttestation = marker(await buildArtifactLedger(dir));
    missingAttestation.fonts = `fonts/${FONT_PACK_MANIFEST}`;
    await writeFile(path, `${JSON.stringify(missingAttestation, null, 2)}\n`);
    await assert.rejects(verifyLobiumRuntime(dir), /inventory attestation is absent/);

    pack.manifest.personas.windows.physicalFamilies = ['Fabricated Sans'];
    await writeManifest(pack.manifestPath, pack.manifest);
    const internallyInvalid = marker(await buildArtifactLedger(dir));
    internallyInvalid.fonts = `fonts/${FONT_PACK_MANIFEST}`;
    internallyInvalid.fontInventory = fontInventory;
    await writeFile(path, `${JSON.stringify(internallyInvalid, null, 2)}\n`);
    await assert.rejects(verifyLobiumRuntime(dir), /physical family is not backed/);

    pack.manifest.files[0].families = ['Fabricated Sans'];
    for (const persona of Object.values(pack.manifest.personas)) {
      persona.physicalFamilies = ['Fabricated Sans'];
    }
    pack.manifest.licenses[0].family = 'Fabricated Sans';
    await writeManifest(pack.manifestPath, pack.manifest);
    const declarationTamper = marker(await buildArtifactLedger(dir));
    declarationTamper.fonts = `fonts/${FONT_PACK_MANIFEST}`;
    declarationTamper.fontInventory = fontInventory;
    await writeFile(path, `${JSON.stringify(declarationTamper, null, 2)}\n`);
    await assert.rejects(
      verifyLobiumRuntime(dir),
      /font-family inventory differs from the packaging attestation/,
    );

    internallyInvalid.fonts = null;
    internallyInvalid.fontInventory = null;
    internallyInvalid.artifacts = await buildArtifactLedger(dir);
    await writeFile(path, `${JSON.stringify(internallyInvalid, null, 2)}\n`);
    await assert.rejects(
      verifyLobiumRuntime(dir),
      /font pack is present but marker\.fonts records no/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime artifact ledger detects modified and added package bytes', async () => {
  const dir = await fixture();
  try {
    const verified = await verifyLobiumRuntime(dir);
    assert.equal(verified.artifacts.algorithm, ARTIFACT_TREE_ALGORITHM);
    assert.equal(verified.artifacts.files.length, 4);

    // On the release host, execute the actual Windows PowerShell 5.1 ledger function in isolation
    // and compare it with the independent Node implementation used after packaging. Non-Windows CI
    // still exercises the verifier and the static transaction contract above.
    if (process.platform === 'win32') {
      const packager = await read('scripts/package-lobium-runtime.ps1');
      const start = packager.indexOf('function Get-ArtifactLedger {');
      const end = packager.indexOf('# Locate the build output');
      assert.ok(start >= 0 && end > start, 'could not isolate the PowerShell ledger function');
      const harness = join(dir, 'ledger-harness.ps1');
      const escapedDir = dir.replaceAll("'", "''");
      await writeFile(
        harness,
        `$ErrorActionPreference = 'Stop'\n` +
          `$markerName = 'LOBSTER_ENGINE.json'\n` +
          `$artifactAlgorithm = '${ARTIFACT_TREE_ALGORITHM}'\n` +
          `$utf8NoBom = New-Object System.Text.UTF8Encoding($false)\n` +
          `${packager.slice(start, end)}\n` +
          `(Get-ArtifactLedger -RuntimeDir '${escapedDir}') | ConvertTo-Json -Depth 8\n`,
      );
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness],
        { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
      );
      const fromPowerShell = JSON.parse(stdout.replace(/^\uFEFF/, ''));
      // The harness was created inside the fixture after its marker. Exclude it from the measured
      // ledger, recompute the aggregate, then require exact cross-language agreement.
      const files = fromPowerShell.files.filter((file) => file.path !== 'ledger-harness.ps1');
      const canonical = files
        .map((file) => `${file.path}\t${file.bytes}\t${file.sha256}\n`)
        .join('');
      const { createHash } = await import('node:crypto');
      fromPowerShell.files = files;
      fromPowerShell.treeSha256 = createHash('sha256').update(canonical).digest('hex');
      assert.deepEqual(fromPowerShell, verified.artifacts);
      await rm(harness);
    }

    await writeFile(join(dir, 'chrome.dll'), 'tampered implementation');
    await assert.rejects(
      verifyLobiumRuntime(dir),
      /artifact file set, size, or SHA-256 differs from the marker/,
    );

    await writeFile(join(dir, 'chrome.dll'), 'implementation');
    await writeFile(join(dir, 'unexpected.dll'), 'extra');
    await assert.rejects(
      verifyLobiumRuntime(dir),
      /artifact file set, size, or SHA-256 differs from the marker/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime marker refuses unsafe or fabricated artifact provenance', async () => {
  const dir = await fixture();
  try {
    const path = join(dir, 'LOBSTER_ENGINE.json');
    const artifacts = await buildArtifactLedger(dir);
    artifacts.files[0].path = '../outside.dll';
    await writeFile(path, `${JSON.stringify(marker(artifacts), null, 2)}\n`);
    await assert.rejects(verifyLobiumRuntime(dir), /artifact 0 path is unsafe/);

    const fabricated = marker(await buildArtifactLedger(dir));
    fabricated.provenance.chromiumCommit = 'not-a-commit';
    await writeFile(path, `${JSON.stringify(fabricated, null, 2)}\n`);
    await assert.rejects(verifyLobiumRuntime(dir), /build provenance is absent or malformed/);

    const incomplete = marker(await buildArtifactLedger(dir));
    incomplete.provenance.capabilities.pop();
    await writeFile(path, `${JSON.stringify(incomplete, null, 2)}\n`);
    await assert.rejects(verifyLobiumRuntime(dir), /capability set differs/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
