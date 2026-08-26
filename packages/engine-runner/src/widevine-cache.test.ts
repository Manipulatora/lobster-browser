import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { captureWidevineToCache, seedWidevineFromCache, widevineCacheDir } from './widevine-cache.js';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A CDM directory as the component updater leaves it: a version dir plus the ready marker. */
function writeCdm(root: string): void {
  mkdirSync(join(root, 'WidevineCdm', '4.10.3050.0', '_platform_specific', 'linux_x64'), {
    recursive: true,
  });
  writeFileSync(
    join(root, 'WidevineCdm', '4.10.3050.0', '_platform_specific', 'linux_x64', 'libwidevinecdm.so'),
    'not-the-real-cdm',
  );
  // The marker is a FILE holding an absolute path, which is the whole reason seeding needs care.
  writeFileSync(
    join(root, 'WidevineCdm', 'latest-component-updated-widevine-cdm'),
    JSON.stringify({ Path: join(root, 'WidevineCdm', '4.10.3050.0') }),
  );
  writeFileSync(join(root, 'WidevineCdm', '4.10.3050.0', 'manifest.json'), '{"version":"4.10.3050.0"}');
}

test('a seeded profile receives the cached CDM before it launches', () => {
  const cache = tmp('wv-cache-');
  const profile = tmp('wv-profile-');
  try {
    writeCdm(cache);
    const env = { LOBSTER_WIDEVINE_CACHE: join(cache, 'WidevineCdm') } as NodeJS.ProcessEnv;
    assert.equal(seedWidevineFromCache(profile, env), true);
    assert.ok(existsSync(join(profile, 'WidevineCdm', '4.10.3050.0')));
    assert.ok(existsSync(join(profile, 'WidevineCdm', 'latest-component-updated-widevine-cdm')));
  } finally {
    rmSync(cache, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a profile that already has a CDM is left alone', () => {
  const cache = tmp('wv-cache-');
  const profile = tmp('wv-profile-');
  try {
    writeCdm(cache);
    mkdirSync(join(profile, 'WidevineCdm'), { recursive: true });
    const env = { LOBSTER_WIDEVINE_CACHE: join(cache, 'WidevineCdm') } as NodeJS.ProcessEnv;
    // Overwriting a profile's own CDM could replace a newer component with an older cached one.
    assert.equal(seedWidevineFromCache(profile, env), false);
    assert.deepEqual(readdirSync(join(profile, 'WidevineCdm')), []);
  } finally {
    rmSync(cache, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a half-written download is never cached or seeded', () => {
  const cache = tmp('wv-cache-');
  const donor = tmp('wv-donor-');
  const profile = tmp('wv-profile-');
  try {
    // A version directory with NO ready marker is exactly what an interrupted update leaves behind.
    mkdirSync(join(donor, 'WidevineCdm', '4.10.3050.0'), { recursive: true });
    const env = { LOBSTER_WIDEVINE_CACHE: join(cache, 'WidevineCdm') } as NodeJS.ProcessEnv;
    assert.equal(captureWidevineToCache(donor, env), false);
    assert.equal(seedWidevineFromCache(profile, env), false);
    assert.equal(existsSync(join(profile, 'WidevineCdm')), false);
  } finally {
    for (const d of [cache, donor, profile]) rmSync(d, { recursive: true, force: true });
  }
});

test('the cache is captured once and not overwritten by later profiles', () => {
  const cache = tmp('wv-cache-');
  const donor = tmp('wv-donor-');
  try {
    writeCdm(donor);
    const env = { LOBSTER_WIDEVINE_CACHE: join(cache, 'WidevineCdm') } as NodeJS.ProcessEnv;
    assert.equal(captureWidevineToCache(donor, env), true);
    // Second call is a no-op: re-copying on every profile close would be pure IO for no change.
    assert.equal(captureWidevineToCache(donor, env), false);
  } finally {
    rmSync(cache, { recursive: true, force: true });
    rmSync(donor, { recursive: true, force: true });
  }
});

test('the cache lives outside any profile, so profiles cannot poison each other', () => {
  const dir = widevineCacheDir({ HOME: '/home/someone' } as NodeJS.ProcessEnv);
  assert.ok(!dir.includes('profiles'), dir);
  assert.ok(dir.includes('lobster'), dir);
});

test('seeding repoints the marker at the new profile, not the one it was copied from', () => {
  const donor = tmp('wv-donor-');
  const cache = tmp('wv-cache-');
  const profile = tmp('wv-profile-');
  try {
    writeCdm(donor);
    const env = { LOBSTER_WIDEVINE_CACHE: join(cache, 'WidevineCdm') } as NodeJS.ProcessEnv;
    assert.equal(captureWidevineToCache(donor, env), true);
    // The donor is GONE before the fresh profile is seeded, which is the case that exposed the bug:
    // a seeded profile appeared to work only while the directory it was copied from still existed.
    rmSync(donor, { recursive: true, force: true });
    assert.equal(seedWidevineFromCache(profile, env), true);

    const marker = JSON.parse(
      readFileSync(join(profile, 'WidevineCdm', 'latest-component-updated-widevine-cdm'), 'utf8'),
    ) as { Path: string };
    assert.equal(marker.Path, join(profile, 'WidevineCdm', '4.10.3050.0'));
    assert.ok(!marker.Path.includes('wv-donor-'), `marker still points at the donor: ${marker.Path}`);
    assert.ok(existsSync(marker.Path), 'the path the marker names must exist');
  } finally {
    for (const d of [donor, cache, profile]) rmSync(d, { recursive: true, force: true });
  }
});

test('a cached CDM whose payload never arrived is refused rather than seeded', () => {
  const cache = tmp('wv-cache-');
  const profile = tmp('wv-profile-');
  try {
    // Marker and version directory present, but no manifest.json: the shape a truncated copy leaves.
    mkdirSync(join(cache, 'WidevineCdm', '4.10.3050.0'), { recursive: true });
    writeFileSync(join(cache, 'WidevineCdm', 'latest-component-updated-widevine-cdm'), '{}');
    const env = { LOBSTER_WIDEVINE_CACHE: join(cache, 'WidevineCdm') } as NodeJS.ProcessEnv;
    assert.equal(seedWidevineFromCache(profile, env), false);
    assert.equal(existsSync(join(profile, 'WidevineCdm')), false);
  } finally {
    for (const d of [cache, profile]) rmSync(d, { recursive: true, force: true });
  }
});
