import assert from 'node:assert/strict';
import test from 'node:test';

import type { CookieImportDraft } from '@lobster/shared-types';

import { InMemoryProfilesRepository } from './in-memory-profiles.repository';
import type { SafeCookieImportMetadata } from './profiles.repository';

const extensions = [
  {
    source: 'chrome_web_store' as const,
    enabled: true,
    id: 'abcdefghijklmnop',
    name: 'Example extension',
    url: 'https://chromewebstore.google.com/detail/example/abcdefghijklmnop',
  },
];

test('in-memory profile repository round-trips all non-secret desktop metadata', async () => {
  const repository = new InMemoryProfilesRepository();
  const created = await repository.create({
    ownerTeamId: 'team-1',
    name: 'Metadata profile',
    engine: 'lobium',
    os: 'windows',
    osVersion: 'Windows 11 23H2',
    fingerprintSeed: '0123456789abcdef0123456789abcdef',
    fingerprintOverrides: { navigator: { hardwareConcurrency: 8 } },
    proxyId: 'proxy-1',
    templateId: 'template-1',
    cookiesImport: {
      mode: 'merge',
      source: 'file',
      fileName: 'cookies.txt',
      parsedCount: 4,
      errors: [{ line: 2, message: 'invalid domain' }],
    },
    extensions,
    tags: ['ecom'],
    folder: 'Work',
    notes: 'non-secret notes',
  });

  assert.equal(created.osVersion, 'Windows 11 23H2');
  assert.equal(created.proxyId, 'proxy-1');
  assert.equal(created.templateId, 'template-1');
  assert.deepEqual(created.cookiesImport, {
    mode: 'merge',
    source: 'file',
    fileName: 'cookies.txt',
    parsedCount: 4,
    errors: [{ line: 2, message: 'invalid domain' }],
  });
  assert.deepEqual(created.extensions, extensions);

  const updated = await repository.update('team-1', created.id, {
    osVersion: 'Windows 11 24H2',
    proxyId: 'proxy-2',
    templateId: 'template-2',
    cookiesImport: { mode: 'empty', parsedCount: 0 },
    extensions: [{ source: 'unpacked', enabled: false, name: 'Local extension' }],
  });
  assert.equal(updated?.osVersion, 'Windows 11 24H2');
  assert.equal(updated?.proxyId, 'proxy-2');
  assert.equal(updated?.templateId, 'template-2');
  assert.deepEqual(updated?.cookiesImport, { mode: 'empty', parsedCount: 0 });
  assert.deepEqual(updated?.extensions, [
    { source: 'unpacked', enabled: false, name: 'Local extension' },
  ]);
  assert.deepEqual(updated?.fingerprintOverrides, {
    navigator: { hardwareConcurrency: 8 },
  });
  assert.deepEqual(updated?.tags, ['ecom']);
  assert.equal(updated?.folder, 'Work');
  assert.equal(updated?.notes, 'non-secret notes');
});

test('repository strips raw cookie text even when a direct caller bypasses DTO validation', async () => {
  const repository = new InMemoryProfilesRepository();
  const unsafeCookieDraft: CookieImportDraft = {
    mode: 'replace',
    source: 'plain_text',
    rawText: 'session=super-secret',
    parsedCount: 1,
  };

  const created = await repository.create({
    ownerTeamId: 'team-1',
    name: 'Sanitized',
    engine: 'lobium',
    os: 'linux',
    fingerprintSeed: 'seed',
    cookiesImport: unsafeCookieDraft as SafeCookieImportMetadata,
    tags: [],
  });

  assert.deepEqual(created.cookiesImport, {
    mode: 'replace',
    source: 'plain_text',
    parsedCount: 1,
  });
  assert.equal((created.cookiesImport as CookieImportDraft).rawText, undefined);
});
