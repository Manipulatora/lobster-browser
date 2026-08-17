import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConfigService } from '@nestjs/config';

import { FilesystemBlobStore } from './blob/filesystem-blob-store';
import { InMemoryBlobStore } from './blob/in-memory-blob-store';
import { S3BlobStore } from './blob/s3-blob-store';
import { resolveBlobStore } from './profiles.module';

function fakeConfig(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

test('resolveBlobStore refuses to boot in production with no durable store configured', () => {
  // The failure being guarded is a deployment that promises durability while the store is a Map
  // that empties on restart. Neither S3 nor a directory means there is nothing to promise with.
  assert.throws(
    () => resolveBlobStore(fakeConfig({ NODE_ENV: 'production' })),
    /no durable blob storage configured/,
  );
});

test('resolveBlobStore binds the filesystem store when a path is configured', () => {
  // A directory on the server is a first-class production choice: the client encrypts before upload,
  // so the store only owes durability and atomicity.
  const store = resolveBlobStore(
    fakeConfig({ NODE_ENV: 'production', BLOB_STORE_PATH: '/var/lib/lobster/blobs' }),
  );
  assert.ok(store instanceof FilesystemBlobStore);
});

test('S3 wins over a filesystem path when both are set, so a migration has one obvious direction', () => {
  const store = resolveBlobStore(
    fakeConfig({
      NODE_ENV: 'production',
      S3_BUCKET: 'lobster-profiles',
      S3_REGION: 'eu-central-1',
      BLOB_STORE_PATH: '/var/lib/lobster/blobs',
    }),
  );
  assert.ok(store instanceof S3BlobStore);
});

test('production can still run ephemeral, but only when an operator wrote it down', () => {
  const store = resolveBlobStore(
    fakeConfig({ NODE_ENV: 'production', ALLOW_EPHEMERAL_BLOB_STORE: '1' }),
  );
  assert.ok(store instanceof InMemoryBlobStore);
});

test('resolveBlobStore binds S3 when a bucket is configured', () => {
  const store = resolveBlobStore(
    fakeConfig({
      NODE_ENV: 'production',
      S3_BUCKET: 'lobster-profiles',
      S3_REGION: 'eu-central-1',
    }),
  );
  assert.ok(store instanceof S3BlobStore);
});

test('resolveBlobStore falls back to the in-memory store outside production', () => {
  assert.ok(resolveBlobStore(fakeConfig({ NODE_ENV: 'test' })) instanceof InMemoryBlobStore);
});
