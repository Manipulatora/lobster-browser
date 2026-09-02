import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConfigService } from '@nestjs/config';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type PutObjectCommandInput,
  type S3Client,
} from '@aws-sdk/client-s3';

import { BlobQuotaExceededError, BlobVersionConflictError } from './blob-store';
import { S3BlobStore } from './s3-blob-store';

/**
 * Unit tests for S3BlobStore's versioning + conflict logic against a FAKE S3 client — no network.
 * The fake reproduces the one S3 behaviour the store's atomicity rests on: a PutObject with
 * `If-None-Match: *` fails with HTTP 412 `PreconditionFailed` when the object already exists,
 * so only one writer can ever create a given `<key>/<version>.enc` object.
 */
class FakeS3Client {
  readonly objects = new Map<string, { body: Buffer; lastModified: Date }>();
  /** Every PutObject input the store issued, so tests can assert the request itself. */
  readonly puts: PutObjectCommandInput[] = [];
  /** Small page size so ListObjectsV2 pagination (ContinuationToken) is actually exercised. */
  private readonly pageSize = 2;

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const { Key, Body, IfNoneMatch } = command.input;
      this.puts.push(command.input);
      if (IfNoneMatch === '*' && this.objects.has(Key!)) {
        throw Object.assign(
          new Error('At least one of the pre-conditions you specified did not hold'),
          {
            name: 'PreconditionFailed',
            $metadata: { httpStatusCode: 412 },
          },
        );
      }
      this.objects.set(Key!, { body: Buffer.from(Body as Buffer), lastModified: new Date() });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const stored = this.objects.get(command.input.Key!);
      if (!stored) {
        throw Object.assign(new Error('NoSuchKey'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 },
        });
      }
      return {
        Body: { transformToByteArray: async () => new Uint8Array(stored.body) },
        LastModified: stored.lastModified,
      };
    }
    if (command instanceof ListObjectsV2Command) {
      const { Prefix, ContinuationToken } = command.input;
      const matching = [...this.objects.keys()].filter((k) => k.startsWith(Prefix ?? '')).sort();
      const start = ContinuationToken ? Number(ContinuationToken) : 0;
      const page = matching.slice(start, start + this.pageSize);
      const isTruncated = start + this.pageSize < matching.length;
      return {
        Contents: page.map((Key) => ({ Key, Size: this.objects.get(Key)!.body.length })),
        IsTruncated: isTruncated,
        NextContinuationToken: isTruncated ? String(start + this.pageSize) : undefined,
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      const keys = (command.input.Delete?.Objects ?? []).map((o) => o.Key!);
      this.deletes.push(keys);
      for (const key of keys) this.objects.delete(key);
      return {};
    }
    throw new Error(`FakeS3Client: unhandled command ${command?.constructor?.name}`);
  }

  /** Every DeleteObjects batch the store issued, so tests can assert what was pruned and when. */
  readonly deletes: string[][] = [];
}

function makeStore(env: Record<string, string> = {}): { store: S3BlobStore; s3: FakeS3Client } {
  const values: Record<string, string> = { S3_BUCKET: 'test-bucket', ...env };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService;
  const s3 = new FakeS3Client();
  return { store: new S3BlobStore(config, s3 as unknown as S3Client), s3 };
}

const meta = { teamId: 'team-1', profileId: 'p1' };

test('put assigns monotonically increasing versions and getLatest/head read them back', async () => {
  const { store } = makeStore();

  const first = await store.put('team-1/p1', Buffer.from('v1-bytes'), meta);
  assert.equal(first.version, 1);
  const second = await store.put('team-1/p1', Buffer.from('v2-bytes'), meta);
  assert.equal(second.version, 2);

  const latest = await store.getLatest('team-1/p1');
  assert.equal(latest?.version, 2);
  assert.equal(latest?.bytes.toString(), 'v2-bytes');
  assert.ok(latest?.updatedAt, 'updatedAt is populated from the object LastModified');

  const head = await store.head('team-1/p1');
  assert.equal(head?.version, 2);
});

test('every put requests server-side encryption and tags no team/profile topology', async () => {
  const { store, s3 } = makeStore();
  await store.put('team-1/p1', Buffer.from('v1'), meta);

  assert.equal(s3.puts.length, 1);
  assert.equal(
    s3.puts[0]!.ServerSideEncryption,
    'AES256',
    'a bucket policy denying unencrypted PUTs must accept our writes',
  );
  // The object key already carries <teamId>/<profileId>; repeating it in metadata only widened what
  // a caller with bucket-listing rights learns without decrypting a byte.
  assert.equal(s3.puts[0]!.Metadata, undefined);
});

test('getLatest and head return null for a key that has never been stored', async () => {
  const { store } = makeStore();
  assert.equal(await store.getLatest('team-1/never'), null);
  assert.equal(await store.head('team-1/never'), null);
});

test('put with a stale expectedVersion throws BlobVersionConflictError without writing', async () => {
  const { store, s3 } = makeStore();
  await store.put('team-1/p1', Buffer.from('v1'), meta);

  await assert.rejects(
    () => store.put('team-1/p1', Buffer.from('stale'), { ...meta, expectedVersion: 0 }),
    (err: unknown) => {
      assert.ok(err instanceof BlobVersionConflictError);
      assert.equal(err.expectedVersion, 0);
      assert.equal(err.actualVersion, 1);
      return true;
    },
  );
  // The losing write never created an object.
  assert.equal(s3.objects.size, 1);
  assert.equal((await store.getLatest('team-1/p1'))?.bytes.toString(), 'v1');
});

test('two racing conditional puts at the same base: exactly one wins, one gets a conflict (CAS via If-None-Match)', async () => {
  const { store } = makeStore();

  // Fire both without awaiting between them so they interleave: both read version 0 and pass the
  // precondition, then both attempt to CREATE `<key>/1.enc`. S3's `If-None-Match: *` admits only
  // one creator; the loser surfaces as a version conflict — never a silent clobber.
  const results = await Promise.allSettled([
    store.put('team-1/p1', Buffer.from('racer-a'), { ...meta, expectedVersion: 0 }),
    store.put('team-1/p1', Buffer.from('racer-b'), { ...meta, expectedVersion: 0 }),
  ]);

  const winners = results.filter((r) => r.status === 'fulfilled');
  const conflicts = results.filter(
    (r) => r.status === 'rejected' && r.reason instanceof BlobVersionConflictError,
  );
  assert.equal(winners.length, 1, 'exactly one racing push must succeed');
  assert.equal(conflicts.length, 1, 'exactly one racing push must lose with a version conflict');

  // The store settled at version 1 — the single winner's bytes.
  const latest = await store.getLatest('team-1/p1');
  assert.equal(latest?.version, 1);
});

test('two racing UNconditional puts both succeed: the loser retries onto the next version', async () => {
  const { store } = makeStore();

  const results = await Promise.all([
    store.put('team-1/p1', Buffer.from('a'), meta),
    store.put('team-1/p1', Buffer.from('b'), meta),
  ]);

  // Both writes landed, on distinct versions (one retried after losing the create race).
  assert.deepEqual(results.map((r) => r.version).sort(), [1, 2]);
  assert.equal((await store.head('team-1/p1'))?.version, 2);
});

test('expectedVersion 0 means "must not exist yet" and succeeds on a fresh key', async () => {
  const { store } = makeStore();
  const result = await store.put('team-1/new', Buffer.from('first'), {
    ...meta,
    expectedVersion: 0,
  });
  assert.equal(result.version, 1);
});

test('versions beyond one list page are found (pagination) and keys are namespaced by S3_KEY_PREFIX', async () => {
  const { store, s3 } = makeStore({ S3_KEY_PREFIX: 'blobs' });

  // 5 versions > the fake's page size of 2, so currentVersion must walk continuation tokens.
  for (let i = 0; i < 5; i += 1) {
    await store.put('team-1/p1', Buffer.from(`v${i + 1}`), meta);
  }
  assert.equal((await store.head('team-1/p1'))?.version, 5);
  assert.equal((await store.getLatest('team-1/p1'))?.bytes.toString(), 'v5');
  assert.ok(
    s3.objects.has('blobs/team-1/p1/5.enc'),
    'objects live under the configured key prefix',
  );
});

test('keys are isolated: writing one stream never affects another', async () => {
  const { store } = makeStore();
  await store.put('team-1/p1', Buffer.from('p1'), meta);
  await store.put('team-1/p2', Buffer.from('p2'), { teamId: 'team-1', profileId: 'p2' });
  assert.equal((await store.head('team-1/p1'))?.version, 1);
  assert.equal((await store.getLatest('team-1/p2'))?.bytes.toString(), 'p2');
});

test('only the newest BLOB_RETAIN_VERSIONS objects survive a put; the one just created never goes', async () => {
  const { store, s3 } = makeStore({ BLOB_RETAIN_VERSIONS: '2' });
  for (let i = 1; i <= 4; i += 1) {
    await store.put('team-1/p1', Buffer.from(`v${i}`), meta);
  }

  assert.deepEqual([...s3.objects.keys()].sort(), ['team-1/p1/3.enc', 'team-1/p1/4.enc']);
  // Pruning is a delete of what fell out of the window, issued after the create it follows.
  assert.deepEqual(s3.deletes, [['team-1/p1/1.enc'], ['team-1/p1/2.enc']]);
  assert.equal((await store.head('team-1/p1'))?.version, 4, 'numbering is never rewound');
  assert.equal((await store.getLatest('team-1/p1'))?.bytes.toString(), 'v4');
});

test('a put that would take the team over its quota is refused before the PUT is issued', async () => {
  const { store, s3 } = makeStore();
  await store.put('team-1/p1', Buffer.alloc(6), meta);
  await store.put('team-1/p2', Buffer.alloc(3), { teamId: 'team-1', profileId: 'p2' });
  const putsBefore = s3.puts.length;

  await assert.rejects(
    () =>
      store.put('team-1/p3', Buffer.alloc(2), {
        teamId: 'team-1',
        profileId: 'p3',
        teamQuotaBytes: 10,
      }),
    (err: unknown) => {
      assert.ok(err instanceof BlobQuotaExceededError);
      assert.equal(err.usedBytes, 9);
      assert.equal(err.quotaBytes, 10);
      assert.equal(err.requestedBytes, 2);
      return true;
    },
  );
  assert.equal(s3.puts.length, putsBefore, 'the refused write never reached S3');
});

test('the quota measures live bytes across the team prefix: latest object per key, history and other teams excluded', async () => {
  const { store } = makeStore({ BLOB_RETAIN_VERSIONS: '5', S3_KEY_PREFIX: 'blobs' });
  await store.put('team-1/p1', Buffer.alloc(6), meta);
  await store.put('team-1/p2', Buffer.alloc(3), { teamId: 'team-1', profileId: 'p2' });
  await store.put('team-2/p1', Buffer.alloc(100), { teamId: 'team-2', profileId: 'p1' });

  // p1's 6 live bytes are replaced: 3 (p2) + 7 = 10 fits, though 6 + 7 + 3 objects now exist.
  await store.put('team-1/p1', Buffer.alloc(7), { ...meta, teamQuotaBytes: 10 });
  // 7 (p1 live) + 4 does not.
  await assert.rejects(
    () =>
      store.put('team-1/p2', Buffer.alloc(4), {
        teamId: 'team-1',
        profileId: 'p2',
        teamQuotaBytes: 10,
      }),
    BlobQuotaExceededError,
  );
});

test('deleteAll removes every version of a key and nothing else, and is idempotent', async () => {
  const { store, s3 } = makeStore({ BLOB_RETAIN_VERSIONS: '5' });
  await store.put('team-1/p1', Buffer.from('a'), meta);
  await store.put('team-1/p1', Buffer.from('b'), meta);
  await store.put('team-1/p2', Buffer.from('c'), { teamId: 'team-1', profileId: 'p2' });

  await store.deleteAll('team-1/p1');
  assert.equal(await store.head('team-1/p1'), null);
  assert.deepEqual([...s3.objects.keys()], ['team-1/p2/1.enc']);
  await store.deleteAll('team-1/p1');
  await store.deleteAll('team-1/never');
});
