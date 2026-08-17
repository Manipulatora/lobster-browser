import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  detectUnloadableUserExtensions,
  downloadChromeWebStoreCrx,
  extensionLaunchArgs,
  extractExtensionZip,
  LOBEE_EXTENSION_ID,
  parseChromeWebStoreId,
  prepareProfileExtensions,
  verifyCrx3,
} from './extensions.js';

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function protoBytes(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
}

function idFromKey(key: Buffer): string {
  return createHash('sha256')
    .update(key)
    .digest()
    .subarray(0, 16)
    .toString('hex')
    .replace(/[0-9a-f]/g, (hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)));
}

function crxIdBytes(id: string): Buffer {
  return Buffer.from(
    id
      .split('')
      .map((letter) => (letter.charCodeAt(0) - 97).toString(16))
      .join(''),
    'hex',
  );
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries: Array<{ name: string; contents: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const contents = Buffer.from(entry.contents);
    const crc = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, contents);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + contents.length;
  }
  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}

function signedCrxFixture(): { crx: Buffer; id: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const id = idFromKey(spki);
  const zip = storedZip([
    { name: 'manifest.json', contents: '{"manifest_version":3,"name":"Fixture","version":"1"}' },
    { name: 'worker.js', contents: 'console.log("fixture")' },
  ]);
  const signedHeader = protoBytes(1, crxIdBytes(id));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeader.length);
  const signature = sign(
    'sha256',
    Buffer.concat([Buffer.from('CRX3 SignedData\0'), length, signedHeader, zip]),
    privateKey,
  );
  const proof = Buffer.concat([protoBytes(1, spki), protoBytes(2, signature)]);
  const header = Buffer.concat([protoBytes(2, proof), protoBytes(10_000, signedHeader)]);
  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0);
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return { crx: Buffer.concat([prefix, header, zip]), id };
}

test('parseChromeWebStoreId accepts official URLs and bare ids only', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  assert.equal(parseChromeWebStoreId(id), id);
  assert.equal(parseChromeWebStoreId(`https://chromewebstore.google.com/detail/name/${id}`), id);
  assert.equal(parseChromeWebStoreId(`https://chrome.google.com/webstore/detail/${id}`), id);
  assert.equal(parseChromeWebStoreId(`https://example.test/detail/${id}`), undefined);
  assert.equal(parseChromeWebStoreId('http://chromewebstore.google.com/detail/nope'), undefined);
  assert.throws(
    () => extensionLaunchArgs(['/profiles/has,comma/ext']),
    /cannot be represented safely/,
  );
});

test('Chrome Web Store downloader enforces redirect host and byte limits', async () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  await assert.rejects(
    () =>
      downloadChromeWebStoreCrx(id, {
        fetch: async () =>
          new Response(null, { status: 302, headers: { location: 'https://evil.example/crx' } }),
      }),
    /disallowed URL/,
  );
  await assert.rejects(
    () =>
      downloadChromeWebStoreCrx(id, {
        maxCrxBytes: 4,
        fetch: async () => new Response('12345', { status: 200 }),
      }),
    /exceeds 4 bytes/,
  );
});

test('a proxied profile never downloads an extension from the host address', async () => {
  // The install runs inside the launch path, seconds before a proxied session opens for the same
  // profile: an unrouted GET here links the host IP to a named extension id at a known time, which
  // is precisely the correlation the product exists to prevent. It is cached per machine, so the
  // leak is once-per-extension and effectively invisible.
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  const seen: Array<Record<string, unknown>> = [];
  await downloadChromeWebStoreCrx(id, {
    proxyUrl: 'http://user:pass@proxy.example:8080',
    fetch: async (_url, init) => {
      seen.push(init as Record<string, unknown>);
      return new Response('crx', { status: 200 });
    },
  });
  assert.equal(seen.length, 1);
  assert.ok(
    seen[0]?.dispatcher,
    'the request must carry a proxy dispatcher, not the default route',
  );

  // Fail closed: an unusable proxy route refuses the install rather than reaching for the direct one.
  await assert.rejects(
    () =>
      downloadChromeWebStoreCrx(id, {
        proxyUrl: 'not-a-proxy-url',
        fetch: async () => new Response('crx', { status: 200 }),
      }),
    /refusing to download extension/,
  );
});

test('verifyCrx3 verifies public-key-derived id and archive signature', () => {
  const { crx, id } = signedCrxFixture();
  const verified = verifyCrx3(crx, id);
  assert.equal(verified.id, id);
  assert.equal(verified.zip.subarray(0, 2).toString(), 'PK');
  const tampered = Buffer.from(crx);
  const tamperIndex = tampered.length - 23;
  tampered[tamperIndex] = (tampered[tamperIndex] ?? 0) ^ 1;
  assert.throws(() => verifyCrx3(tampered, id), /signature verification failed/);
  assert.throws(
    () => verifyCrx3(crx, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    /signed extension id does not match/,
  );
});

test('extractExtensionZip rejects traversal and extracts a valid manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-zip-'));
  try {
    const good = join(root, 'good');
    await extractExtensionZip(
      storedZip([
        { name: 'manifest.json', contents: '{"manifest_version":3,"name":"x","version":"1"}' },
      ]),
      good,
    );
    assert.equal(JSON.parse(await readFile(join(good, 'manifest.json'), 'utf8')).name, 'x');
    await assert.rejects(
      () =>
        extractExtensionZip(
          storedZip([
            { name: '../escape', contents: 'bad' },
            { name: 'manifest.json', contents: '{"manifest_version":3}' },
          ]),
          join(root, 'bad'),
        ),
      /invalid relative path|unsafe extension archive|escapes destination/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepareProfileExtensions downloads once, caches, unpacks per profile, and skips disabled refs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-prepare-'));
  const { crx, id } = signedCrxFixture();
  let calls = 0;
  const fixtureFetch: typeof fetch = async () => {
    calls += 1;
    return new Response(crx, { status: 200 });
  };
  const options = {
    cacheDir: join(root, 'cache'),
    fetch: fixtureFetch,
    webStoreDownloadUrl: () => 'https://clients2.google.com/service/update2/crx?fixture=true',
  };
  try {
    const refs = [
      { source: 'chrome_web_store' as const, enabled: true, id },
      {
        source: 'chrome_web_store' as const,
        enabled: false,
        id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ];
    const paths = await prepareProfileExtensions(refs, join(root, 'profile-a'), options);
    assert.equal(paths.length, 1);
    assert.equal(calls, 1);
    assert.deepEqual(extensionLaunchArgs(paths), [
      `--disable-extensions-except=${paths[0]}`,
      `--load-extension=${paths[0]}`,
    ]);
    await prepareProfileExtensions(refs, join(root, 'profile-b'), {
      ...options,
      fetch: async () => {
        throw new Error('cache should be used');
      },
    });
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local unpacked extensions are snapshotted and symlinks fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-local-'));
  try {
    const source = join(root, 'source');
    await mkdir(source);
    await writeFile(
      join(source, 'manifest.json'),
      '{"manifest_version":3,"name":"Local","version":"1"}',
    );
    const [snapshot] = await prepareProfileExtensions(
      [{ source: 'unpacked', enabled: true, path: source }],
      join(root, 'profile'),
    );
    assert.ok(snapshot);
    assert.match(await readFile(join(snapshot, 'manifest.json'), 'utf8'), /Local/);
    await symlink('/etc/passwd', join(source, 'escape'));
    await assert.rejects(
      () =>
        prepareProfileExtensions(
          [{ source: 'unpacked', enabled: true, path: source }],
          join(root, 'profile-2'),
        ),
      /contains symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('detectUnloadableUserExtensions names browser-installed extensions only', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'ext-unloadable-'));
  try {
    // Nothing to read yet on a fresh profile — a diagnostic must never fail a launch.
    assert.deepEqual(await detectUnloadableUserExtensions(userDataDir), []);

    await mkdir(join(userDataDir, 'Default'), { recursive: true });
    // Locations as Chromium writes them: 1 = kInternal (installed by the user from inside the browser,
    // the ones --disable-extensions-except silently drops), 8 = kCommandLine (ours), 5 = kComponent.
    await writeFile(
      join(userDataDir, 'Default', 'Preferences'),
      JSON.stringify({
        extensions: {
          settings: {
            gighmmpiobklfepjocnamgkkbiglidom: {
              location: 1,
              manifest: { name: 'AdBlock — block ads across the web', version: '6.44.0' },
            },
            aikjogmpaoaookmacnkbenekcnkjlkmi: { location: 1 },
            [LOBEE_EXTENSION_ID]: { location: 8, manifest: { name: 'Lobee', version: '1' } },
            mhjfbmdgcfjbbpaeojofohoefgiehjai: {
              location: 5,
              manifest: { name: 'Chromium PDF Viewer', version: '1' },
            },
          },
        },
      }),
    );

    assert.deepEqual(await detectUnloadableUserExtensions(userDataDir), [
      {
        id: 'gighmmpiobklfepjocnamgkkbiglidom',
        name: 'AdBlock — block ads across the web',
        version: '6.44.0',
      },
      { id: 'aikjogmpaoaookmacnkbenekcnkjlkmi' },
    ]);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
