#!/usr/bin/env node
// Tests for the engine archive gate.
//
// The gate's whole value is in what it REJECTS, and a gate is only as good as its negative cases —
// one that has only ever been run against a good artifact is indistinguishable from `exit 0`. So
// these build synthetic runtimes, tamper with them in the exact ways the four real incidents
// tampered with the real ones, and assert the gate says no.
//
// tar.gz rather than zip because it needs no writer dependency (tar is 512-byte headers and raw
// bodies), and because the Linux artifact is a tarball — the path that had no coverage at all.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const GATE = join(HERE, 'engine-archive-gate.mjs');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** One 512-byte ustar header plus the padded body. */
function tarEntry(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii'); // mode
  header.write('0000000\0', 108, 8, 'ascii'); // uid
  header.write('0000000\0', 116, 8, 'ascii'); // gid
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii'); // mtime — fixed, for reproducibility
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder (spaces)
  header.write('0', 156, 1, 'ascii'); // type: regular file
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, pad]);
}

/**
 * Build a synthetic runtime archive with a self-consistent LOBSTER_ENGINE.json, then apply an
 * optional mutation so the marker and the contents disagree in a chosen way.
 */
function buildArchive(dir, { files, platform = 'linux-x64', tamper = null, markerPatch = {} }) {
  const payload = files.map(([path, text]) => {
    const body = Buffer.from(text, 'utf8');
    return { path, bytes: body.length, sha256: sha(body), body };
  });

  const sorted = [...payload].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash('sha256');
  for (const f of sorted) h.update(`${f.path}\t${f.bytes}\t${f.sha256}\n`, 'utf8');

  const marker = {
    schemaVersion: 2,
    engine: 'lobium',
    platform,
    chrome: platform === 'win-x64' ? 'chrome.exe' : 'chrome',
    version: '152.0.7977.42',
    provenance: {
      lobsterRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      lobsterWorkingTreeDirty: false,
      capabilities: [
        'device-frame',
        ...(platform === 'win-x64' ? ['font-isolation'] : []),
        'canvas-farbling',
      ],
    },
    artifacts: {
      algorithm: 'sha256',
      treeSha256: h.digest('hex'),
      files: sorted.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    },
    ...markerPatch,
  };

  // The mutation happens AFTER the marker is computed, which is precisely the real failure: an
  // attestation that describes a tree the archive no longer contains.
  let emitted = payload;
  if (tamper === 'modify') {
    emitted = payload.map((f) =>
      f.path === 'chrome' ? { ...f, body: Buffer.from('TAMPERED BINARY', 'utf8') } : f,
    );
  } else if (tamper === 'remove') {
    emitted = payload.filter((f) => f.path !== 'chrome');
  } else if (tamper === 'add') {
    emitted = [...payload, { path: 'backdoor.dll', body: Buffer.from('extra', 'utf8') }];
  }

  const parts = [];
  for (const f of emitted) parts.push(tarEntry(f.path, f.body));
  parts.push(tarEntry('LOBSTER_ENGINE.json', Buffer.from(JSON.stringify(marker, null, 2), 'utf8')));
  parts.push(Buffer.alloc(1024)); // two zero blocks terminate a tar

  const out = join(dir, 'runtime.tar.gz');
  writeFileSync(out, gzipSync(Buffer.concat(parts)));
  return out;
}

function runGate(archive, extra = []) {
  try {
    const stdout = execFileSync('node', [GATE, archive, ...extra], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const GOOD = [
  ['chrome', 'ELF-ish engine bytes'],
  ['icudtl.dat', 'locale data'],
  ['fonts/font-pack.manifest.json', '{"families":[]}'],
];

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-gate-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a self-consistent archive passes', () => {
  withTmp((dir) => {
    const archive = buildArchive(dir, { files: GOOD });
    const { code, stdout } = runGate(archive);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /ENGINE ARCHIVE GATE: PASSED/);
    assert.match(stdout, /tree hash matches attestation/);
  });
});

test('a MODIFIED file is caught, and named', () => {
  // Incident (1): the source was patched, the shipped binary was not.
  withTmp((dir) => {
    const archive = buildArchive(dir, { files: GOOD, tamper: 'modify' });
    const { code, stdout } = runGate(archive);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /TREE MISMATCH/);
    assert.match(stdout, /file differs from attestation: chrome/);
  });
});

test('a REMOVED file is caught', () => {
  withTmp((dir) => {
    const archive = buildArchive(dir, { files: GOOD, tamper: 'remove' });
    const { code, stdout } = runGate(archive);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /attested file absent from archive: chrome/);
  });
});

test('an ADDED file is caught', () => {
  // The direction that matters most: something in the shipped runtime that no one attested to.
  withTmp((dir) => {
    const archive = buildArchive(dir, { files: GOOD, tamper: 'add' });
    const { code, stdout } = runGate(archive);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /unattested file present in archive: backdoor\.dll/);
  });
});

test('a missing native capability blocks publication', () => {
  // Incident (1) again, in the form the capability contract can see directly.
  withTmp((dir) => {
    const archive = buildArchive(dir, {
      files: GOOD,
      markerPatch: {
        provenance: {
          lobsterRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
          lobsterWorkingTreeDirty: false,
          capabilities: ['canvas-farbling'], // device-frame absent
        },
      },
    });
    const { code, stdout } = runGate(archive);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /capability 'device-frame' is absent/);
  });
});

test('a dirty working tree blocks publication', () => {
  withTmp((dir) => {
    const archive = buildArchive(dir, {
      files: GOOD,
      markerPatch: {
        provenance: {
          lobsterRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
          lobsterWorkingTreeDirty: true,
          capabilities: ['device-frame', 'canvas-farbling'],
        },
      },
    });
    const { code, stdout } = runGate(archive);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /DIRTY working tree/);
  });
});

test('an unknown revision blocks publication', () => {
  withTmp((dir) => {
    const archive = buildArchive(dir, {
      files: GOOD,
      markerPatch: {
        provenance: {
          lobsterRevision: '0'.repeat(40),
          lobsterWorkingTreeDirty: false,
          capabilities: ['device-frame', 'canvas-farbling'],
        },
      },
    });
    const { code, stdout } = runGate(archive);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /is not a commit in this repository/);
  });
});

test('an archive with no provenance marker at all is refused', () => {
  withTmp((dir) => {
    // A plain tarball of the runtime, as an ad-hoc `tar czf` would produce.
    const body = Buffer.from('engine', 'utf8');
    const out = join(dir, 'runtime.tar.gz');
    writeFileSync(out, gzipSync(Buffer.concat([tarEntry('chrome', body), Buffer.alloc(1024)])));
    const { code, stdout } = runGate(out);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /LOBSTER_ENGINE\.json is missing/);
  });
});

test('a LINUX-shaped v1 marker is reported unattested but does NOT block the publish', () => {
  // scripts/package-lobium-runtime.sh writes engine/platform/chrome/fonts/packagedAt and nothing
  // else — no ledger, no provenance, no capabilities. The gate is wired into bump-engine-version as
  // a mandatory step, so holding a v1 artifact to the v2 contract would refuse every Linux publish
  // and the gate would simply be switched off. Hold each artifact to the contract IT declares.
  withTmp((dir) => {
    const body = Buffer.from('engine bytes', 'utf8');
    const marker = {
      engine: 'lobium',
      platform: 'linux-x64',
      chrome: 'chrome',
      fonts: 'fonts/font-pack.manifest.json',
      packagedAt: '2026-08-29T00:00:00Z',
    };
    const out = join(dir, 'runtime.tar.gz');
    writeFileSync(
      out,
      gzipSync(
        Buffer.concat([
          tarEntry('chrome', body),
          tarEntry('LOBSTER_ENGINE.json', Buffer.from(JSON.stringify(marker, null, 2), 'utf8')),
          Buffer.alloc(1024),
        ]),
      ),
    );
    const { code, stdout } = runGate(out);
    assert.equal(code, 0, `a v1 Linux archive must not be blocked:
${stdout}`);
    assert.match(stdout, /UNATTESTED/, 'it must say plainly that nothing was verified');
    assert.match(stdout, /package-lobium-runtime.sh/, 'and name what has to change to fix it');
  });
});

test('--require-attestation turns an unattested archive into a failure', () => {
  // The escape hatch must be closable once both packagers emit schemaVersion 2.
  withTmp((dir) => {
    const marker = { engine: 'lobium', platform: 'linux-x64', chrome: 'chrome' };
    const out = join(dir, 'runtime.tar.gz');
    writeFileSync(
      out,
      gzipSync(
        Buffer.concat([
          tarEntry('chrome', Buffer.from('x', 'utf8')),
          tarEntry('LOBSTER_ENGINE.json', Buffer.from(JSON.stringify(marker), 'utf8')),
          Buffer.alloc(1024),
        ]),
      ),
    );
    const { code, stdout } = runGate(out, ['--require-attestation']);
    assert.equal(code, 1, stdout);
  });
});

test('a file that is not an archive is refused on its magic bytes', () => {
  withTmp((dir) => {
    const out = join(dir, 'not-an-archive.zip');
    writeFileSync(out, Buffer.from('<!doctype html><title>404 Not Found</title>', 'utf8'));
    const { code, stdout } = runGate(out);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /not a zip or gzip archive/);
  });
});
