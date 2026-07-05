import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hasFontPersona, writeFontConfig } from './fonts.js';

test('hasFontPersona: EVERY OS is bundled so non-Windows personas cannot leak host fonts', () => {
  assert.equal(hasFontPersona('windows'), true);
  assert.equal(hasFontPersona('macos'), true);
  assert.equal(hasFontPersona('linux'), true);
});

test('macOS persona renames to Mac system font names (Helvetica/Times/Courier), no host leak', async () => {
  const udd = await mkdtemp(join(tmpdir(), 'fonts-mac-'));
  try {
    const conf = await writeFontConfig(udd, 'macos', '/opt/lobium/fonts');
    const xml = await readFile(conf, 'utf8');
    assert.match(xml, /<dir>\/opt\/lobium\/fonts\/macos<\/dir>/);
    assert.doesNotMatch(xml, /etc\/fonts/);
    assert.match(xml, /Liberation Sans<\/string>.*Helvetica<\/string>/s);
    assert.match(xml, /sans-serif<\/family><prefer><family>Helvetica/);
  } finally {
    await rm(udd, { recursive: true, force: true });
  }
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

test('linux persona keeps DejaVu/Liberation names (real Linux fonts) but restricted to the bundle', async () => {
  const udd = await mkdtemp(join(tmpdir(), 'fonts-lin-'));
  try {
    const conf = await writeFontConfig(udd, 'linux', '/opt/lobium/fonts');
    assert.equal(conf, join(udd, 'lobium-fonts.conf'));
    const xml = await readFile(conf, 'utf8');
    assert.match(xml, /<dir>\/opt\/lobium\/fonts\/linux<\/dir>/);
    assert.doesNotMatch(xml, /etc\/fonts/);
    assert.match(xml, /sans-serif<\/family><prefer><family>DejaVu Sans/);
  } finally {
    await rm(udd, { recursive: true, force: true });
  }
});
