#!/usr/bin/env node
/**
 * Faithful reproduction of CreepJS's getPixelMods(), the check that produces
 * `CanvasRenderingContext2D.getImageData -> "pixel data modified"`.
 *
 * Transcribed from creep.js L2913-2992. It is a KNOWN-INPUT FIDELITY test:
 *
 *   for each of 64 pixels on an 8x8 canvas:
 *     fillStyle = rgba(random, random, random, 255); fillRect(x, y, 1, 1)
 *     read it back with getImageData(x, y, 1, 1)
 *   any pixel whose readback differs from what was written -> mods.pixels -> lie
 *
 * Isolating it here matters because the full CreepJS run takes ~16s, reports one bit, and cannot be
 * iterated against. This gives the exact per-channel diff count in about a second, so a fix can be
 * measured rather than guessed at.
 *
 *   LOBSTER_LOBIUM_BIN=<chrome> node ci/validation/creepjs-pixelmods-probe.mjs
 *
 * Also reports the same measurement for LARGE canvases, because that is the other half of the
 * question: a fix is only interesting if the canvas hash still varies per profile after it.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveFingerprint } from '@lobster/fingerprint';
import {
  buildGpuArgs,
  buildLobiumConfig,
  cdpEvaluate,
  lobiumConfigArg,
  resolveLobiumBinary,
  withCdpSession,
  writeLobiumConfig,
} from '@lobster/engine-runner';

const LOBIUM = process.env.LOBSTER_LOBIUM_BIN || resolveLobiumBinary();
if (!LOBIUM) {
  console.error('no Lobium binary; set LOBSTER_LOBIUM_BIN');
  process.exit(2);
}

/** CreepJS's own test, transcribed. Returns the diff count over 64 known-input pixels. */
const PIXEL_MODS = `(() => {
  const len = 8, alpha = 255;
  const opts = { willReadFrequently: true, desynchronized: true };
  const c1 = document.createElement('canvas');
  const c2 = document.createElement('canvas');
  const x1 = c1.getContext('2d', opts);
  const x2 = c2.getContext('2d', opts);
  c1.width = len; c1.height = len; c2.width = len; c2.height = len;
  const pattern1 = [], pattern2 = [];
  for (let x = 0; x < len; x++) for (let y = 0; y < len; y++) {
    const r = ~~(Math.random() * 256), g = ~~(Math.random() * 256), b = ~~(Math.random() * 256);
    const colors = r + ', ' + g + ', ' + b + ', ' + alpha;
    x1.fillStyle = 'rgba(' + colors + ')';
    x1.fillRect(x, y, 1, 1);
    pattern1.push(colors);
  }
  for (let x = 0; x < len; x++) for (let y = 0; y < len; y++) {
    const d = x1.getImageData(x, y, 1, 1).data;
    const colors = d[0] + ', ' + d[1] + ', ' + d[2] + ', ' + d[3];
    x2.fillStyle = 'rgba(' + colors + ')';
    x2.fillRect(x, y, 1, 1);
    pattern2.push(colors);
  }
  let diffs = 0;
  const channels = new Set();
  for (let i = 0; i < pattern1.length; i++) {
    if (pattern1[i] !== pattern2[i]) {
      diffs++;
      const a = pattern1[i].split(','), b = pattern2[i].split(',');
      channels.add(['r','g','b','a'].filter((_, k) => a[k] !== b[k]).join(''));
    }
  }

  // The OTHER condition in the same if(): a cleared canvas must read all-zero.
  const c3 = document.createElement('canvas');
  c3.width = 50; c3.height = 50;
  const x3 = c3.getContext('2d', opts);
  x3.font = '35px sans-serif';
  x3.fillText('\\u{1F47E}', 0, 37);
  x3.clearRect(0, 0, c3.width, c3.height);
  const clearedMax = Math.max(...x3.getImageData(0, 0, 8, 8).data);

  // Does a REAL fingerprint canvas still vary? Hash the 50x50 text render CreepJS itself uses.
  const c4 = document.createElement('canvas');
  c4.width = 50; c4.height = 50;
  const x4 = c4.getContext('2d', opts);
  x4.font = '50px sans-serif';
  x4.fillText('A', 7, 37);
  const uri = c4.toDataURL();
  let h = 0;
  for (let i = 0; i < uri.length; i++) { h = ((h << 5) - h + uri.charCodeAt(i)) | 0; }

  return {
    knownInputDiffs: diffs,
    knownInputTotal: 64,
    channels: [...channels],
    clearedMax,
    wouldCreepJsFlag: diffs > 0 || clearedMax > 0,
    textCanvasHash: (h >>> 0).toString(16),
  };
})()`;

async function readCdp(dir, n = 200) {
  for (let i = 0; i < n; i++) {
    try {
      const [p, path] = (await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n');
      if (Number(p) > 0 && path) return `ws://127.0.0.1:${Number(p)}${path.trim()}`;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no cdp endpoint');
}

async function measure(seed, noise) {
  const fp = deriveFingerprint(seed, { os: 'windows', engine: 'lobium' });
  const dir = await mkdtemp(join(tmpdir(), 'pixmods-'));
  const cfg = await writeLobiumConfig(dir, buildLobiumConfig(fp, { seed, hardwareNoise: noise }));
  const server = createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>p</title><body></body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const proc = spawn(
    LOBIUM,
    [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      `--user-data-dir=${dir}`, lobiumConfigArg(cfg), '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', ...buildGpuArgs({ mode: 'software' }),
    ],
    { stdio: 'ignore' },
  );
  try {
    const ws = await readCdp(dir);
    return await withCdpSession(
      ws,
      async (session) => {
        await session.send('Page.navigate', { url });
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 200));
          const ready = await cdpEvaluate(session, `document.readyState`).catch(() => null);
          if (ready === 'complete') break;
        }
        return await cdpEvaluate(session, PIXEL_MODS);
      },
      { timeoutMs: 60_000 },
    );
  } finally {
    proc.kill('SIGKILL');
    server.close();
    await new Promise((r) => setTimeout(r, 200));
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const ON = { webgl: true, canvas: true, audio: true, clientRects: false };
const OFF = { webgl: true, canvas: false, audio: true, clientRects: false };

const rows = [];
rows.push({ label: 'canvas noise ON  seed A', ...(await measure('pixmods-a', ON)) });
rows.push({ label: 'canvas noise ON  seed B', ...(await measure('pixmods-b', ON)) });
rows.push({ label: 'canvas noise OFF seed A', ...(await measure('pixmods-a', OFF)) });

console.log('');
for (const r of rows) {
  console.log(
    `${r.label.padEnd(24)} knownInputDiffs=${String(r.knownInputDiffs).padStart(2)}/64  ` +
      `clearedMax=${r.clearedMax}  creepJsFlags=${r.wouldCreepJsFlag ? 'YES' : 'no '}  ` +
      `textHash=${r.textCanvasHash}  channels=${r.channels.join('|') || '-'}`,
  );
}
const [a, b, off] = rows;
console.log('');
console.log(`unlinkable (seed A vs B text hash differ): ${a.textCanvasHash !== b.textCanvasHash}`);
console.log(`farble actually applied (ON vs OFF differ): ${a.textCanvasHash !== off.textCanvasHash}`);
