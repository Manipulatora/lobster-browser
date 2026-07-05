import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hasFontPersona, writeFontConfig } from './fonts.js';

test('hasFontPersona: windows bundled, linux/macos fall through to host', () => {
  assert.equal(hasFontPersona('windows'), true);
  assert.equal(hasFontPersona('linux'), false);
  assert.equal(hasFontPersona('macos'), false);
});

test('writeFontConfig writes a private fontconfig exposing ONLY the persona dir (no /etc/fonts)', async () => {
  const udd = await mkdtemp(join(tmpdir(), 'fonts-'));
  try {
    const conf = await writeFontConfig(udd, 'windows', '/opt/lobium/fonts');
    assert.equal(conf, join(udd, 'lobium-fonts.conf'));
    const xml = await readFile(conf, 'utf8');
    // The persona dir is the ONLY <dir>, and there is NO <include> of the system config → host fonts hidden.
    assert.match(xml, /<dir>\/opt\/lobium\/fonts\/windows<\/dir>/);
    assert.doesNotMatch(xml, /<include/);
    assert.doesNotMatch(xml, /etc\/fonts/);
    // Private, per-profile cache dir (so no jitter / no writes to a shared cache).
    assert.match(xml, new RegExp(`<cachedir>${udd}/fc-cache</cachedir>`));
    // Scan-renames the metric-compatible faces to the Windows persona names.
    assert.match(xml, /Liberation Sans<\/string>.*Arial<\/string>/s);
    assert.match(xml, /Liberation Serif<\/string>.*Times New Roman<\/string>/s);
    assert.match(xml, /Liberation Mono<\/string>.*Courier New<\/string>/s);
    // Generic aliases point into the persona set.
    assert.match(xml, /sans-serif<\/family><prefer><family>Arial/);
  } finally {
    await rm(udd, { recursive: true, force: true });
  }
});

test('writeFontConfig returns undefined for an OS with no bundle (host fonts kept)', async () => {
  const udd = await mkdtemp(join(tmpdir(), 'fonts-'));
  try {
    assert.equal(await writeFontConfig(udd, 'linux', '/opt/lobium/fonts'), undefined);
  } finally {
    await rm(udd, { recursive: true, force: true });
  }
});
