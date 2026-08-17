import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';

import { BlobVersionConflictError } from './blob-store';
import { FilesystemBlobStore } from './filesystem-blob-store';

async function store(): Promise<{ store: FilesystemBlobStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'blobstore-test-'));
  const config = { get: (k: string) => (k === 'BLOB_STORE_PATH' ? root : undefined) };
  return { store: new FilesystemBlobStore(config as unknown as ConfigService), root };
}

const META = { teamId: 'team-1', profileId: 'p1' };

test('put assigns monotonically increasing versions and getLatest/head read them back', async () => {
  const { store: s, root } = await store();
  assert.deepEqual(await s.put('team-1/p1', Buffer.from('v1'), META), { version: 1 });
  assert.deepEqual(await s.put('team-1/p1', Buffer.from('v2'), META), { version: 2 });

  const latest = await s.getLatest('team-1/p1');
  assert.equal(latest?.version, 2);
  assert.equal(latest?.bytes.toString(), 'v2');
  assert.ok(latest?.updatedAt, 'a write timestamp is recorded');
  assert.deepEqual(await s.head('team-1/p1'), { version: 2 });
  await rm(root, { recursive: true, force: true });
});

test('every version is retained, so a point-in-time restore is possible', async () => {
  const { store: s, root } = await store();
  for (const body of ['one', 'two', 'three']) {
    await s.put('team-1/p1', Buffer.from(body), META);
  }
  // The in-memory store keeps only the latest; this one keeps the history on purpose.
  assert.equal((await readFile(join(root, 'team-1', 'p1', 'v0000000001.blob'))).toString(), 'one');
  assert.equal((await readFile(join(root, 'team-1', 'p1', 'v0000000003.blob'))).toString(), 'three');
  await rm(root, { recursive: true, force: true });
});

test('getLatest and head return null for a key that has never been stored', async () => {
  const { store: s, root } = await store();
  assert.equal(await s.getLatest('team-1/never'), null);
  assert.equal(await s.head('team-1/never'), null);
  await rm(root, { recursive: true, force: true });
});

test('put with a stale expectedVersion throws BlobVersionConflictError without writing', async () => {
  const { store: s, root } = await store();
  await s.put('team-1/p1', Buffer.from('v1'), META);
  await s.put('team-1/p1', Buffer.from('v2'), META);

  await assert.rejects(
    () => s.put('team-1/p1', Buffer.from('stale'), { ...META, expectedVersion: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof BlobVersionConflictError);
      assert.equal(err.expectedVersion, 1);
      assert.equal(err.actualVersion, 2);
      return true;
    },
  );
  // Nothing was written: the loser's bytes must not be anywhere.
  assert.equal((await s.getLatest('team-1/p1'))?.bytes.toString(), 'v2');
  assert.deepEqual(await s.head('team-1/p1'), { version: 2 });
  await rm(root, { recursive: true, force: true });
});

test('expectedVersion 0 means "must not exist yet"', async () => {
  const { store: s, root } = await store();
  assert.deepEqual(await s.put('team-1/fresh', Buffer.from('first'), { ...META, expectedVersion: 0 }), {
    version: 1,
  });
  await assert.rejects(
    () => s.put('team-1/fresh', Buffer.from('again'), { ...META, expectedVersion: 0 }),
    BlobVersionConflictError,
  );
  await rm(root, { recursive: true, force: true });
});

test('two racing conditional puts at the same base: exactly one wins', async () => {
  const { store: s, root } = await store();
  await s.put('team-1/p1', Buffer.from('base'), META);

  // Both target version 2. The filesystem's link() is the arbiter, so this holds across processes,
  // not just within one event loop.
  const results = await Promise.allSettled([
    s.put('team-1/p1', Buffer.from('racer-a'), { ...META, expectedVersion: 1 }),
    s.put('team-1/p1', Buffer.from('racer-b'), { ...META, expectedVersion: 1 }),
  ]);
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1, 'exactly one writer may win');
  assert.equal(lost.length, 1, 'the other must be told it conflicted');
  assert.ok((lost[0] as PromiseRejectedResult).reason instanceof BlobVersionConflictError);
  assert.equal((await s.head('team-1/p1'))?.version, 2, 'no version was skipped');
  await rm(root, { recursive: true, force: true });
});

test('many racing unconditional puts all succeed with distinct, gapless versions', async () => {
  const { store: s, root } = await store();
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => s.put('team-1/busy', Buffer.from(`b${i}`), META)),
  );
  const versions = results.map((r) => r.version).sort((a, b) => a - b);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6], 'no version is reused or skipped');
  await rm(root, { recursive: true, force: true });
});

test('deleteAll removes every version and is idempotent', async () => {
  const { store: s, root } = await store();
  await s.put('team-1/p1', Buffer.from('v1'), META);
  await s.put('team-1/p1', Buffer.from('v2'), META);

  await s.deleteAll('team-1/p1');
  assert.equal(await s.getLatest('team-1/p1'), null);
  // Idempotent: a key with nothing stored is a no-op, not an error.
  await s.deleteAll('team-1/p1');
  await s.deleteAll('team-1/never-existed');
  await rm(root, { recursive: true, force: true });
});

test('a key segment that would escape the root is refused', async () => {
  const { store: s, root } = await store();
  for (const key of ['team-1/../../etc', '../escape', 'team-1//p1/..', 'team-1/.']) {
    await assert.rejects(
      () => s.put(key, Buffer.from('x'), META),
      /unsafe blob key segment|must have at least one segment/,
      `${key} must be refused`,
    );
  }
  await rm(root, { recursive: true, force: true });
});

test('a stray non-version file in the key directory is ignored, not read as a blob', async () => {
  const { store: s, root } = await store();
  await s.put('team-1/p1', Buffer.from('real'), META);
  // An editor backup, a partial copy, anything an operator might leave behind.
  await writeFile(join(root, 'team-1', 'p1', 'v0000000009.blob.bak'), 'not a version');
  await writeFile(join(root, 'team-1', 'p1', 'notes.txt'), 'not a version');

  assert.equal((await s.head('team-1/p1'))?.version, 1, 'only vNNNNNNNNNN.blob counts');
  assert.equal((await s.getLatest('team-1/p1'))?.bytes.toString(), 'real');
  await rm(root, { recursive: true, force: true });
});

test('bytes survive exactly, including binary that is not valid UTF-8', async () => {
  const { store: s, root } = await store();
  // Encrypted blobs are arbitrary bytes; a store that round-trips through a string would corrupt them.
  const payload = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0x00, 0xc3, 0x28]);
  await s.put('team-1/binary', payload, META);
  assert.deepEqual((await s.getLatest('team-1/binary'))?.bytes, payload);
  await rm(root, { recursive: true, force: true });
});
