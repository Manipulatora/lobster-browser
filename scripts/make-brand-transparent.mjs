#!/usr/bin/env node
/**
 * Produce transparent-background brand PNGs for the Lobium NTP.
 *
 *  - profile_branding.png  ← lobium-browser-branding.png  (near-white bg flood-filled to transparent)
 *  - master brand (NTP logo) is verified already-transparent (lobster-ntp-hero.png) and copied through.
 *
 * Background removal is a corner flood-fill (BFS) with tolerance, so only the connected background is
 * cleared — interior brand pixels that happen to be light are preserved. Edges are feathered so the
 * logo does not get a hard alpha ring on a light NTP.
 *
 * Usage: node scripts/make-brand-transparent.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ROOT = resolve('.');
const SRC = resolve(ROOT, 'apps/desktop/src/assets/brand');
const SUBBRAND_SRC = resolve(SRC, 'lobium-browser-branding.png');
const MASTER_SRC = resolve(SRC, 'lobster-ntp-hero.png');
const PROFILE_BRANDING_OUT = resolve(SRC, 'profile_branding.png');
const MASTER_OUT = resolve(SRC, 'lobium-ntp-master-transparent.png');

function dataUrl(path) {
  return `data:image/png;base64,${Buffer.from(readFileSync(path)).toString('base64')}`;
}

async function floodFillTransparent(page, srcDataUrl, tolerance) {
  return page.evaluate(
    async ({ src, tol }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const w = c.width;
      const h = c.height;
      const im = ctx.getImageData(0, 0, w, h);
      const d = im.data;
      const idx = (x, y) => (y * w + x) * 4;

      // Seed from the four corners; treat their average as the background colour.
      const seeds = [
        [0, 0],
        [w - 1, 0],
        [0, h - 1],
        [w - 1, h - 1],
      ];
      let br = 0;
      let bg = 0;
      let bb = 0;
      for (const [x, y] of seeds) {
        const i = idx(x, y);
        br += d[i];
        bg += d[i + 1];
        bb += d[i + 2];
      }
      br /= seeds.length;
      bg /= seeds.length;
      bb /= seeds.length;

      const near = (i) => {
        const dr = d[i] - br;
        const dg = d[i + 1] - bg;
        const db = d[i + 2] - bb;
        return dr * dr + dg * dg + db * db <= tol * tol;
      };

      const visited = new Uint8Array(w * h);
      const stack = [];
      for (const [x, y] of seeds) {
        const p = y * w + x;
        if (!visited[p] && near(idx(x, y))) {
          visited[p] = 1;
          stack.push(p);
        }
      }
      while (stack.length) {
        const p = stack.pop();
        const x = p % w;
        const y = (p - x) / w;
        d[idx(x, y) + 3] = 0; // clear alpha
        const nbrs = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ];
        for (const [nx, ny] of nbrs) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const np = ny * w + nx;
          if (visited[np]) continue;
          if (near(idx(nx, ny))) {
            visited[np] = 1;
            stack.push(np);
          }
        }
      }

      // Feather: any still-opaque pixel adjacent to a cleared one gets partial alpha proportional to
      // how close it is to the background colour, softening the cut edge.
      const out = new Uint8ClampedArray(d);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = idx(x, y);
          if (d[i + 3] === 0) continue;
          let bordersCleared = false;
          for (const [nx, ny] of [
            [x - 1, y],
            [x + 1, y],
            [x, y - 1],
            [x, y + 1],
          ]) {
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (d[idx(nx, ny) + 3] === 0) {
              bordersCleared = true;
              break;
            }
          }
          if (bordersCleared) {
            const dr = d[i] - br;
            const dg = d[i + 1] - bg;
            const db = d[i + 2] - bb;
            const dist = Math.sqrt(dr * dr + dg * dg + db * db);
            const a = Math.max(0, Math.min(255, Math.round((dist / (tol * 2)) * 255)));
            out[i + 3] = Math.min(d[i + 3], a);
          }
        }
      }
      ctx.putImageData(new ImageData(out, w, h), 0, 0);

      // Report how much became transparent so the caller can sanity-check.
      let transp = 0;
      for (let i = 3; i < out.length; i += 4) if (out[i] < 5) transp++;
      return { dataUrl: c.toDataURL('image/png'), transpPct: Math.round((100 * transp * 4) / out.length) };
    },
    { src: srcDataUrl, tol: tolerance },
  );
}

async function writePng(path, dataUrlPng) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(dataUrlPng.replace(/^data:image\/png;base64,/, ''), 'base64'));
}

async function main() {
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await b.newPage();
  try {
    // Sub-brand: remove the near-white background.
    const sub = await floodFillTransparent(page, dataUrl(SUBBRAND_SRC), 40);
    await writePng(PROFILE_BRANDING_OUT, sub.dataUrl);
    console.log(`profile_branding.png  ← lobium-browser-branding.png  (transparent ${sub.transpPct}%)`);

    // Master brand: already transparent; flood-fill is a no-op safety pass (tolerance small).
    const master = await floodFillTransparent(page, dataUrl(MASTER_SRC), 24);
    await writePng(MASTER_OUT, master.dataUrl);
    console.log(`lobium-ntp-master-transparent.png ← lobster-ntp-hero.png (transparent ${master.transpPct}%)`);
  } finally {
    await b.close();
  }
}

await main();
