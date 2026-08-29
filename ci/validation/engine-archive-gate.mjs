#!/usr/bin/env node
// Engine archive gate — prove a PUBLISHED artifact is the tree we think it is, before it ships.
//
//   node ci/validation/engine-archive-gate.mjs out/lobium-win-x64-152.0.7977.42.zip
//   node ci/validation/engine-archive-gate.mjs <archive> --expect-revision HEAD
//   node ci/validation/engine-archive-gate.mjs <archive> --check-manifest        # + engine-manifest.json
//   node ci/validation/engine-archive-gate.mjs <archive> --check-url             # + the URL really serves it
//
// WHY THIS EXISTS
//
// Four separate incidents in four days, every one of them the same shape — the ARTIFACT and the
// TREE disagreed, and nothing checked:
//
//   1. An engine archive was published that did not contain the device-frame code, because the
//      linker dropped an unreferenced object. The source was patched; the binary was not.
//   2. An installer was built pinning an engine digest that a later rebuild had superseded.
//   3. engine-manifest.json named a URL that 404'd.
//   4. The two installers were published under each other's filenames.
//
// Each was found by hand, after the fact. The packaging script already computes everything needed
// to catch all four (a per-file ledger, a tree hash, the source revision, the capability set) and
// writes it into LOBSTER_ENGINE.json inside the runtime — but that marker travels INSIDE the
// archive, so until now nothing re-read it from the outside and compared it to what was being
// shipped. That is this gate: it opens the archive as a consumer would, recomputes the ledger from
// the bytes actually in it, and refuses anything that does not match its own attestation.
//
// It deliberately hashes the ARCHIVE CONTENTS rather than trusting the archive's own bytes to be
// reproducible. Compress-Archive and most zip writers embed timestamps, so two archives of one tree
// differ byte-for-byte while being identical as trees. The TREE hash is the version-independent
// anchor; the archive digest is what the manifest pins, and both are checked here.
import { createHash } from 'node:crypto';
import { createReadStream, writeFileSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MARKER = 'LOBSTER_ENGINE.json';
const MANIFEST_PATH = join(ROOT, 'apps/desktop/src-tauri/resources/engine-manifest.json');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);
const note = (msg) => notes.push(msg);

// ---------------------------------------------------------------------------------------------
// Archive readers. Both stream: the runtime is ~1 GB extracted, so nothing is held in memory
// beyond one entry's hash state.
// ---------------------------------------------------------------------------------------------

/** Magic bytes, not the extension. A release asset can be renamed or served without one. */
async function detectForm(path) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
    if (buf[0] === 0x1f && buf[1] === 0x8b) return 'tar.gz';
    return null;
  } finally {
    await fh.close();
  }
}

function hashStream(stream) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    let bytes = 0;
    stream.on('data', (c) => {
      bytes += c.length;
      h.update(c);
    });
    stream.on('end', () => resolve({ sha256: h.digest('hex'), bytes }));
    stream.on('error', reject);
  });
}

async function readZip(path, onEntry) {
  await new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) return zip.readEntry(); // directory
        zip.openReadStream(entry, async (e2, stream) => {
          if (e2) return reject(e2);
          try {
            const { sha256, bytes } = await hashStream(stream);
            await onEntry(entry.fileName, bytes, sha256);
            zip.readEntry();
          } catch (e3) {
            reject(e3);
          }
        });
      });
      zip.readEntry();
    });
  });
}

/**
 * Streaming tar reader.
 *
 * A STATE MACHINE over the gunzip stream, deliberately not a "buffer the entry, then hash it" loop.
 * The Linux artifact is a ~270 MB tar.gz whose `chrome` entry alone is ~200 MB; accumulating an
 * entry body with repeated `Buffer.concat` re-copies the whole accumulated body on every chunk,
 * which is quadratic in entry size and turns the Linux archive into minutes of copying or an OOM.
 * Here the body is never held: each chunk is fed straight into the entry's hash and dropped, so
 * peak memory is one chunk plus one 512-byte header regardless of how large the archive is.
 *
 * Handles regular files, directories, and the GNU long-name records a deep path produces.
 */
async function readTarGz(path, onEntry, wanted = null) {
  const octal = (buf) => {
    const s = buf.toString('ascii').replace(/\0.*$/, '').trim();
    return s ? parseInt(s, 8) : 0;
  };

  let header = Buffer.alloc(0); // at most 512 bytes, only while reading a header
  let longName = null;
  let entry = null; // { name, size, remaining, pad, hash, capture }
  let captured = null; // bytes of `wanted`, when asked for

  const gunzip = createGunzip();
  createReadStream(path).pipe(gunzip);

  for await (const chunk of gunzip) {
    let offset = 0;
    while (offset < chunk.length) {
      if (entry) {
        // ---- inside an entry body: consume, hash, never retain ----
        const take = Math.min(entry.remaining + entry.pad, chunk.length - offset);
        const slice = chunk.subarray(offset, offset + take);
        const bodyBytes = Math.min(entry.remaining, slice.length);
        if (bodyBytes > 0) {
          const body = slice.subarray(0, bodyBytes);
          entry.hash.update(body);
          if (entry.capture) entry.capture.push(Buffer.from(body));
          entry.remaining -= bodyBytes;
        }
        entry.pad -= slice.length - bodyBytes;
        offset += take;
        if (entry.remaining === 0 && entry.pad === 0) {
          if (entry.type === 'L') {
            longName = Buffer.concat(entry.capture).toString('utf8').replace(/\0.*$/, '');
          } else {
            if (entry.capture) captured = Buffer.concat(entry.capture).toString('utf8');
            await onEntry(entry.name, entry.size, entry.hash.digest('hex'));
          }
          entry = null;
        }
        continue;
      }

      // ---- reading a 512-byte header ----
      const need = 512 - header.length;
      const take = Math.min(need, chunk.length - offset);
      header = header.length
        ? Buffer.concat([header, chunk.subarray(offset, offset + take)])
        : Buffer.from(chunk.subarray(offset, offset + take));
      offset += take;
      if (header.length < 512) break;

      if (header.every((b) => b === 0)) {
        header = Buffer.alloc(0); // end-of-archive padding
        continue;
      }
      const size = octal(header.subarray(124, 136));
      const type = String.fromCharCode(header[156]);
      let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      if (longName && type !== 'L') {
        name = longName;
        longName = null;
      }
      const isFile = type === '0' || type === '\0';
      const wantThis = type === 'L' || (isFile && wanted !== null && name.replace(/\\/g, '/') === wanted);
      entry = {
        name,
        size,
        type,
        remaining: size,
        pad: (512 - (size % 512)) % 512,
        hash: createHash('sha256'),
        capture: wantThis ? [] : null,
      };
      header = Buffer.alloc(0);
      // A zero-length entry completes immediately; the loop above never sees it.
      if (entry.remaining === 0 && entry.pad === 0) {
        if (type === 'L') longName = '';
        else {
          if (entry.capture) captured = '';
          if (isFile) await onEntry(entry.name, 0, entry.hash.digest('hex'));
        }
        entry = null;
      }
    }
  }
  return captured;
}

// ---------------------------------------------------------------------------------------------
// Ledger reconstruction, matching scripts/package-lobium-runtime.ps1 exactly.
//
// Get-ArtifactLedger sorts forward-slash relative paths ordinally, excludes the marker itself, and
// hashes the UTF-8 of "<path>\t<bytes>\t<sha256>\n" concatenated over every file. Reproducing that
// formula here (rather than trusting the number in the file) is the point: it is what detects a
// truncated copy, an extra file, or a swapped binary.
// ---------------------------------------------------------------------------------------------

function ledgerTreeHash(files) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash('sha256');
  for (const f of sorted) h.update(`${f.path}\t${f.bytes}\t${f.sha256}\n`, 'utf8');
  return h.digest('hex');
}

/** Strip the single top-level directory the archive nests everything under. */
function stripPrefix(entries) {
  const tops = new Set(entries.map((e) => e.path.split('/')[0]));
  if (tops.size !== 1) return { prefix: null, entries };
  const prefix = [...tops][0];
  // Only strip if it really is a directory prefix (every path is under it and has more segments).
  if (!entries.every((e) => e.path.startsWith(`${prefix}/`))) return { prefix: null, entries };
  return {
    prefix,
    entries: entries.map((e) => ({ ...e, path: e.path.slice(prefix.length + 1) })),
  };
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------

async function main() {
  // Flags that CONSUME the next argument. Without this list the positional scan can pick a flag's
  // VALUE as the archive: `--json out.json runtime.zip` made `out.json` the archive, because the
  // old guard special-cased only `--expect-revision`. `indexOf` was wrong for a second reason —
  // it finds the FIRST occurrence, so a repeated argument checked the wrong predecessor.
  const VALUE_FLAGS = new Set(['--expect-revision', '--json']);
  let archivePath = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) i += 1; // skip its value
      continue;
    }
    archivePath = a;
    break;
  }
  if (!archivePath) {
    console.error(
      'usage: engine-archive-gate.mjs <archive> [--expect-revision <rev>] [--json <path>]\n' +
        '                              [--check-manifest] [--check-url] [--require-attestation]',
    );
    process.exit(2);
  }

  const info = await stat(archivePath).catch(() => null);
  if (!info) {
    console.error(`archive not found: ${archivePath}`);
    process.exit(2);
  }

  const form = await detectForm(archivePath);
  if (!form) {
    fail(`${basename(archivePath)}: not a zip or gzip archive (magic bytes say neither)`);
    return report();
  }

  console.log(`archive   ${basename(archivePath)}`);
  console.log(`form      ${form}`);
  console.log(`bytes     ${info.size.toLocaleString()}`);

  // The digest the manifest pins and the download verifies.
  const archiveSha = (await hashStream(createReadStream(archivePath))).sha256;
  console.log(`sha256    ${archiveSha}`);
  summary = { archive: basename(archivePath), form, bytes: info.size, sha256: archiveSha };

  // 1. Walk the archive, hashing every entry.
  const entries = [];
  let markerRaw = null;
  const onEntry = async (name, bytes, sha256) => {
    const path = name.replace(/\\/g, '/');
    entries.push({ path, bytes, sha256 });
  };
  const reader = form === 'zip' ? readZip : readTarGz;
  await reader(archivePath, onEntry);

  if (entries.length === 0) {
    fail('archive contains no files');
    return report();
  }

  const { prefix, entries: rel } = stripPrefix(entries);
  console.log(`entries   ${rel.length} files${prefix ? ` under ${prefix}/` : ' (no common prefix)'}`);

  // 2. The marker must be present — it is the artifact's own attestation.
  const markerEntry = rel.find((e) => e.path === MARKER);
  if (!markerEntry) {
    fail(`${MARKER} is missing from the archive: the artifact carries no provenance at all`);
    return report();
  }

  // Re-read just the marker's bytes for parsing.
  markerRaw = await extractOne(archivePath, form, prefix ? `${prefix}/${MARKER}` : MARKER);
  let marker;
  try {
    marker = JSON.parse(markerRaw);
  } catch (e) {
    fail(`${MARKER} is not valid JSON: ${e.message}`);
    return report();
  }

  // WHICH CONTRACT DOES THIS ARTIFACT CLAIM?
  //
  // The Windows packager writes schemaVersion 2: a full per-file ledger, a tree hash, the source
  // revision and the capability set. The LINUX packager (scripts/package-lobium-runtime.sh) still
  // writes the original minimal marker — engine/platform/chrome/fonts/packagedAt and nothing else.
  //
  // Holding a v1 artifact to the v2 contract would hard-fail EVERY Linux archive, which would break
  // the documented Linux publish command and get this gate switched off within a day. A gate nobody
  // can run protects nothing. So the artifact is held to the contract IT DECLARES: v2 is verified in
  // full and blocks on any discrepancy; v1 is reported as unattested and does not block, with the
  // message naming exactly what the packager must emit to become enforceable.
  //
  // --require-attestation makes v1 a failure, for CI that has already upgraded both packagers.
  const hasAttestation = Number(marker.schemaVersion) >= 2 || Boolean(marker.artifacts?.treeSha256);
  console.log(`schema    ${marker.schemaVersion ?? 1}${hasAttestation ? '' : ' (no ledger - unattested)'}`);
  console.log(`version   ${marker.version ?? '(absent)'}`);
  console.log(`platform  ${marker.platform}`);
  console.log(`revision  ${marker.provenance?.lobsterRevision ?? '(absent)'}`);
  summary.platform = marker.platform;
  summary.version = marker.version;
  summary.revision = marker.provenance?.lobsterRevision ?? null;
  summary.capabilities = marker.provenance?.capabilities ?? [];

  // The archive must NAME a platform, and must actually CONTAIN an engine.
  //
  // Both were fail-open. A marker with no `platform` sailed through here and then through the
  // --platform cross-check in bump-engine-version.mjs, which only compares when the field is
  // present -- so the one case the cross-check exists to stop (a digest landing in the wrong
  // platform entry) was exactly the case it waved past. And nothing checked that the thing being
  // published is an engine at all: an archive of documentation with a valid marker passed.
  if (!marker.platform) {
    fail(`${MARKER} declares no platform, so nothing can tell which manifest entry it belongs to`);
  }
  const engineName = marker.chrome || (marker.platform === 'win-x64' ? 'chrome.exe' : 'chrome');
  if (!rel.some((e) => e.path === engineName)) {
    fail(`the archive contains no ${engineName}: this is not an engine runtime`);
  }

  // 3. THE TREE CHECK. Recompute the ledger from the archive's real contents.
  const payload = rel.filter((e) => e.path !== MARKER);
  const recomputed = ledgerTreeHash(payload);
  const claimed = marker.artifacts?.treeSha256;
  if (!claimed) {
    const msg =
      `${MARKER} carries no artifacts.treeSha256, so the contents cannot be checked against any ` +
      `attestation. This is the schema scripts/package-lobium-runtime.sh still writes; the Windows ` +
      `packager emits schemaVersion 2 with artifacts{treeSha256,files[]} and provenance{...}. ` +
      `Recomputed tree hash of what IS in the archive: ${recomputed}`;
    if (flag('require-attestation')) fail(msg);
    else note(`UNATTESTED — ${msg}`);
  } else if (recomputed !== claimed) {
    fail(
      `TREE MISMATCH: archive contents hash ${recomputed}, but ${MARKER} attests ${claimed}. ` +
        `The archive is not the tree that was packaged.`,
    );
  } else {
    note(`tree hash matches attestation (${payload.length} files)`);
  }

  // 4. Per-file cross-check, which names WHICH file drifted rather than only that one did.
  const byPath = new Map(payload.map((e) => [e.path, e]));
  const attested = marker.artifacts?.files ?? [];
  const missing = attested.filter((f) => !byPath.has(f.path));
  const extra = payload.filter((e) => !attested.some((f) => f.path === e.path));
  const changed = attested.filter((f) => {
    const got = byPath.get(f.path);
    return got && (got.sha256 !== f.sha256 || Number(got.bytes) !== Number(f.bytes));
  });
  // Only meaningful when there IS an attested file list. With an empty one every file in the
  // archive reads as "extra", which would fail every v1 artifact for the crime of containing files.
  if (attested.length > 0) {
    for (const f of missing.slice(0, 10)) fail(`attested file absent from archive: ${f.path}`);
    for (const e of extra.slice(0, 10)) fail(`unattested file present in archive: ${e.path}`);
    for (const f of changed.slice(0, 10)) fail(`file differs from attestation: ${f.path}`);
  }
  if (missing.length + extra.length + changed.length === 0 && attested.length > 0) {
    note(`all ${attested.length} attested files match byte-for-byte`);
  }

  // 5. Provenance must name a real, CLEAN revision of this repo. A dirty tree means the source that
  //    produced these bytes was never committed, so no one can ever reproduce or audit them.
  const rev = marker.provenance?.lobsterRevision;
  if (!rev) {
    const msg = 'provenance.lobsterRevision is absent — the artifact cannot be traced to a commit';
    if (hasAttestation || flag('require-attestation')) fail(msg);
    else note(`UNATTESTED — ${msg}`);
  } else {
    const type = git(['cat-file', '-t', rev]);
    if (type !== 'commit') {
      fail(`provenance.lobsterRevision ${rev} is not a commit in this repository`);
    } else {
      note(`revision ${rev.slice(0, 12)} exists in this repository`);
      const expect = value('expect-revision');
      if (expect) {
        const want = git(['rev-parse', expect]);
        if (want && want !== git(['rev-parse', rev])) {
          fail(`archive was built from ${rev.slice(0, 12)}, but --expect-revision ${expect} is ${want.slice(0, 12)}`);
        } else if (want) {
          note(`built from the expected revision (${expect})`);
        }
      }
    }
  }
  if (marker.provenance?.lobsterWorkingTreeDirty === true) {
    fail('packaged from a DIRTY working tree: these bytes correspond to no commit and cannot be reproduced');
  }

  // 6. The capability set — incident (1). A runtime missing a native hook must never be publishable,
  //    even if every hash is internally consistent.
  const caps = marker.provenance?.capabilities ?? [];
  const isWin = marker.platform === 'win-x64';
  const required = [
    ...(isWin ? ['font-isolation'] : []),
    'device-frame', // Linux and Windows both, since the patch was widened.
  ];
  for (const cap of required) {
    if (caps.includes(cap)) continue;
    const msg = `capability '${cap}' is absent from the packaged engine (${caps.length} declared)`;
    // Only meaningful when the marker declares capabilities at all. A v1 marker declaring none is
    // silent about capabilities, not asserting their absence — treating silence as absence would
    // fail every Linux archive for a property it never claimed to describe.
    if (hasAttestation || flag('require-attestation')) fail(msg);
    else note(`UNATTESTED — ${msg}`);
  }
  if (caps.length) note(`${caps.length} native capabilities declared, including ${required.join(', ')}`);

  // 7. Manifest agreement — incidents (2), (3) and (4).
  if (flag('check-manifest')) {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
    const entry = manifest.platforms?.[marker.platform];
    if (!entry) {
      fail(`engine-manifest.json has no entry for platform '${marker.platform}'`);
    } else {
      if (entry.version !== marker.version) {
        fail(`manifest pins version ${entry.version} for ${marker.platform}, archive is ${marker.version}`);
      }
      if (entry.sha256?.toLowerCase() !== archiveSha) {
        fail(
          `manifest pins sha256 ${entry.sha256} for ${marker.platform}, but THIS archive is ${archiveSha}. ` +
            `Publishing now would ship bytes the manifest rejects.`,
        );
      } else {
        note('manifest digest matches this archive');
      }
      // Incident (4): the URL must name the platform and version it actually serves.
      const url = entry.url ?? '';
      if (!url.includes(marker.platform)) {
        fail(`manifest URL for ${marker.platform} does not name that platform: ${url}`);
      }
      if (!url.includes(marker.version)) {
        fail(`manifest URL for ${marker.platform} does not name version ${marker.version}: ${url}`);
      }
      if (entry.stale) {
        fail(`manifest marks ${marker.platform} stale — do not ship: ${entry.stale}`);
      }
    }
  }

  // 8. Incident (3): the URL must actually serve these bytes. Network, so opt-in.
  if (flag('check-url')) {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
    const url = manifest.platforms?.[marker.platform]?.url;
    if (!url) {
      fail('--check-url: no URL in the manifest for this platform');
    } else {
      try {
        const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
        if (!res.ok) {
          fail(`published URL returns HTTP ${res.status}: ${url}`);
        } else {
          const len = Number(res.headers.get('content-length') ?? 0);
          if (len && len !== info.size) {
            fail(`published URL serves ${len} bytes, this archive is ${info.size}: ${url}`);
          } else {
            note(`URL reachable and length agrees (${url})`);
          }
        }
      } catch (e) {
        fail(`could not reach ${url}: ${e.message}`);
      }
    }
  }

  report();
}

/** Pull a single entry's bytes out, without holding the whole archive. */
async function extractOne(archivePath, form, wanted) {
  if (form === 'zip') {
    return await new Promise((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (err, zip) => {
        if (err) return reject(err);
        let found = null;
        zip.on('error', reject);
        zip.on('end', () => resolve(found));
        zip.on('entry', (entry) => {
          if (entry.fileName.replace(/\\/g, '/') !== wanted) return zip.readEntry();
          zip.openReadStream(entry, (e2, stream) => {
            if (e2) return reject(e2);
            const bufs = [];
            stream.on('data', (c) => bufs.push(c));
            stream.on('end', () => {
              found = Buffer.concat(bufs).toString('utf8');
              zip.readEntry();
            });
            stream.on('error', reject);
          });
        });
        zip.readEntry();
      });
    });
  }
  // readTarGz captures `wanted` in the SAME pass it hashes, so reading the marker costs no extra
  // decompression. This used to walk the whole archive to set a PLACEHOLDER sentinel and then gunzip
  // and re-scan all ~270 MB a second time purely to read one small JSON file.
  return await readTarGz(archivePath, async () => {}, wanted);
}

/**
 * Machine-readable summary, for callers that must ACT on what the archive declares rather than
 * re-derive it. `bump-engine-version.mjs` uses it to cross-check `--platform`: the archive says
 * which platform it is, and a mismatch there is how a Windows digest lands in the Linux entry.
 */
let summary = {};

function report() {
  const jsonPath = value('json');
  if (jsonPath) {
    summary.ok = failures.length === 0;
    summary.failures = failures;
    writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }
  console.log('');
  for (const n of notes) console.log(`  ok    ${n}`);
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log('');
  if (failures.length) {
    console.log(`ENGINE ARCHIVE GATE: FAILED (${failures.length} problem${failures.length === 1 ? '' : 's'})`);
    process.exit(1);
  }
  console.log('ENGINE ARCHIVE GATE: PASSED');
}

await main();
