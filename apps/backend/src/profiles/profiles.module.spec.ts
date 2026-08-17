import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConfigService } from '@nestjs/config';

import { InMemoryBlobStore } from './blob/in-memory-blob-store';
import { S3BlobStore } from './blob/s3-blob-store';
import { resolveBlobStore } from './profiles.module';

function fakeConfig(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

test('resolveBlobStore refuses to boot in production without an S3 bucket', () => {
  assert.throws(
    () => resolveBlobStore(fakeConfig({ NODE_ENV: 'production' })),
    /S3_BUCKET is required in production/,
  );
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
