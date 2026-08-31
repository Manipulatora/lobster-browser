#!/usr/bin/env node
/**
 * Generate apps/desktop/src/assets/brand/lobster-mark.png — the profile avatar's lobster
 * silhouette — from the NTP wordmark master.
 *
 * The output is a MASK, not a picture: 128x128, fully transparent canvas, every opaque pixel
 * forced to pure white with its alpha preserved. The CSS that consumes it (`mask-image` on
 * `.profile-mark__square::after` in components.css) reads only the alpha channel and paints its
 * own colour through it, which is what lets ONE asset serve every per-profile tint on the ramp.
 *
 * The crop box isolates the lobster from the wordmark (the lettering to its right is cut away),
 * and the silhouette is centred at ~88% of the side so the 22%-radius rounded square it sits in
 * never clips a claw.
 *
 * Rendered through Playwright's bundled Chromium like apply-lobium-branding.mjs does — the repo
 * has no native image library, and a real browser canvas is the same rasteriser the asset is
 * ultimately displayed by.
 *
 * Usage: node scripts/gen-lobster-mark.mjs
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Rooted at the repository via this file's own location, never the caller's cwd — same reasoning
// as apply-lobium-branding.mjs.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(ROOT, 'lobium/assets/ntp-icons/lobster_wordmark.png');
const OUT = resolve(ROOT, 'apps/desktop/src/assets/brand/lobster-mark.png');

/** The lobster inside the wordmark master: left, top, right, bottom in source pixels. */
const CROP = { left: 435, top: 33, right: 764, bottom: 336 }; // 329x303
/** Output canvas side. Displayed at 24px, so 128 leaves headroom for any HiDPI factor in use. */
const SIZE = 128;
/** How much of the side the silhouette's larger dimension spans. */
const FILL = 0.88;

const sourceDataUrl = `data:image/png;base64,${readFileSync(SOURCE).toString('base64')}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const pngDataUrl = await page.evaluate(
  async ({ src, crop, size, fill }) => {
    const img = new Image();
    img.src = src;
    await img.decode();

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Scale the crop so its LARGER dimension spans `fill` of the side, and centre it. Smoothing
    // stays on: the softened edge pixels become partial alpha, which is exactly the antialiasing
    // the mask needs at 24px.
    const cropW = crop.right - crop.left;
    const cropH = crop.bottom - crop.top;
    const scale = (size * fill) / Math.max(cropW, cropH);
    const drawW = cropW * scale;
    const drawH = cropH * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      img,
      crop.left,
      crop.top,
      cropW,
      cropH,
      (size - drawW) / 2,
      (size - drawH) / 2,
      drawW,
      drawH,
    );

    // Force every pixel's RGB to pure white, alpha untouched. The source art is red; leaving its
    // colour in would make the asset LOOK correct in a viewer while smuggling a colour the mask
    // consumer never reads — and would break the day anything draws it as an image instead.
    const data = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < data.data.length; i += 4) {
      data.data[i] = 255;
      data.data[i + 1] = 255;
      data.data[i + 2] = 255;
    }
    ctx.putImageData(data, 0, 0);
    return canvas.toDataURL('image/png');
  },
  { src: sourceDataUrl, crop: CROP, size: SIZE, fill: FILL },
);
await browser.close();

writeFileSync(OUT, Buffer.from(pngDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
console.log(`wrote ${OUT}`);
