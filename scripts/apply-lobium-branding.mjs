#!/usr/bin/env node
/**
 * DESIGN-TIME brand REGENERATOR. Run this when the brand art changes — rarely — never as a build step.
 *
 * It renders every Lobium brand raster from the masters under apps/desktop/src/assets/brand/ and
 * writes them, byte-for-byte, into the COMMITTED overlay at lobium/branding/overlay/ (mirroring the
 * Chromium-tree-relative path each asset must land at) plus lobium/branding/BRANDING. Those checked-in
 * files are the source of truth the build consumes; the build-time stager (lobium/stage-branding.mjs)
 * copies them into a Chromium checkout with NO Playwright, so a clean checkout + build always ships
 * Lobium branding. See lobium/stage-branding.mjs for why staging had to be split off from rendering.
 *
 * This script therefore:
 *   - renders the theme product_logo_* / favicon / wordmark / version-page rasters + the linux .xpm
 *     into lobium/branding/overlay/... (design-time; needs Playwright),
 *   - assembles the multi-size Windows chrome.ico (previously MISSING from every branding pass, so the
 *     Windows taskbar/exe kept the stock Chromium ball) into the same overlay,
 *   - writes lobium/branding/BRANDING (COMPANY_FULLNAME=The Lobium Authors, PRODUCT_FULLNAME=Lobium, …),
 *   - refreshes the launcher embeds (packages/engine-runner/src/runners/*-data.ts) and
 *     apps/desktop/public/favicon.png and the Tauri desktop icon set.
 *
 * It NO LONGER writes into a Chromium checkout. The string/NTP/BRANDING patching of a live tree that
 * used to live here now lives in lobium/stage-branding.mjs, which runs at build time. Keeping the two
 * apart is the whole point: rendering is a rare Playwright step, staging must be a deterministic
 * prerequisite of every reproducible build.
 *
 * Usage: npm run apply:lobium-branding    (or: node scripts/apply-lobium-branding.mjs)
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

// Derived from this file's own location, NOT from the working directory. `resolve('.')` meant every
// path below silently rebased onto wherever the caller happened to be. The script has one correct
// root and it is the repository, so it resolves that for itself.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The committed overlay: every rendered binary lands here at its Chromium-tree-relative path, and
// lobium/stage-branding.mjs mirrors this directory into a checkout verbatim.
const OVERLAY_DIR = resolve(ROOT, 'lobium/branding/overlay');
const BRANDING_OUT = resolve(ROOT, 'lobium/branding/BRANDING');
const MAIN_ICON = resolve(ROOT, 'apps/desktop/src/assets/brand/icon.png');
const SITE_LOGO = resolve(ROOT, 'apps/desktop/src/assets/brand/site-logo.png');
const NTP_MASTER = resolve(ROOT, 'apps/desktop/src/assets/brand/browser-logo.png');
const NTP_AD = resolve(ROOT, 'apps/desktop/src/assets/brand/ad.png');
const PUBLIC_FAVICON = resolve(ROOT, 'apps/desktop/public/favicon.png');
const EMBED_DIR = resolve(ROOT, 'packages/engine-runner/src/runners');
const ACCENT = '#7c3aed';
// Tab/window glyph and version-page favicon are a dark lobster, matching the shipped tab icon.
const MONO_DARK = '#1f2430';

// The BRANDING file Chromium's version_info reads (branding_path_component stays "chromium", so the
// build reads chrome/app/theme/chromium/BRANDING, which the stager overwrites with THIS). PRODUCT_*
// here is what `chrome --version` and chrome://version print.
const BRANDING_CONTENTS = [
  'COMPANY_FULLNAME=The Lobium Authors',
  'COMPANY_SHORTNAME=Lobium',
  'PRODUCT_FULLNAME=Lobium',
  'PRODUCT_SHORTNAME=Lobium',
  'PRODUCT_INSTALLER_FULLNAME=Lobium Installer',
  'PRODUCT_INSTALLER_SHORTNAME=Lobium Installer',
  'COPYRIGHT=Copyright @LASTCHANGE_YEAR@ The Lobium Authors. All rights reserved.',
  'MAC_BUNDLE_ID=com.lobster.lobium',
  'MAC_CREATOR_CODE=Lb24',
  'MAC_TEAM_ID=',
  '',
].join('\n');

async function ensureDir(path) {
  await mkdir(dirname(path), { recursive: true });
}

function pngBufferFromDataUrl(dataUrl) {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  return Buffer.from(base64, 'base64');
}

function imageDataUrl(path) {
  const bytes = Buffer.from(readFileSync(path));
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function overlay(relPath) {
  return resolve(OVERLAY_DIR, relPath);
}

async function renderIcon(page, { sourceDataUrl, size, mono, monoColor = ACCENT }) {
  return page.evaluate(
    async ({ sourceDataUrl: src, size: targetSize, mono: monoMode, red }) => {
      const image = new Image();
      image.src = src;
      await image.decode();

      const scratch = document.createElement('canvas');
      scratch.width = image.naturalWidth;
      scratch.height = image.naturalHeight;
      const scratchCtx = scratch.getContext('2d');
      if (!scratchCtx) throw new Error('2D canvas context unavailable');
      scratchCtx.drawImage(image, 0, 0);
      const pixels = scratchCtx.getImageData(0, 0, scratch.width, scratch.height);

      let minX = scratch.width;
      let minY = scratch.height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < scratch.height; y += 1) {
        for (let x = 0; x < scratch.width; x += 1) {
          const alpha = pixels.data[(y * scratch.width + x) * 4 + 3] ?? 0;
          if (alpha > 8) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
      }

      if (maxX < minX || maxY < minY) {
        minX = 0;
        minY = 0;
        maxX = scratch.width - 1;
        maxY = scratch.height - 1;
      }

      const cropWidth = maxX - minX + 1;
      const cropHeight = maxY - minY + 1;
      const side = Math.max(cropWidth, cropHeight);
      const crop = document.createElement('canvas');
      crop.width = side;
      crop.height = side;
      const cropCtx = crop.getContext('2d');
      if (!cropCtx) throw new Error('2D canvas context unavailable');
      cropCtx.clearRect(0, 0, side, side);
      cropCtx.drawImage(image, -minX + (side - cropWidth) / 2, -minY + (side - cropHeight) / 2);

      const out = document.createElement('canvas');
      out.width = targetSize;
      out.height = targetSize;
      const outCtx = out.getContext('2d');
      if (!outCtx) throw new Error('2D canvas context unavailable');
      outCtx.imageSmoothingEnabled = true;
      outCtx.imageSmoothingQuality = 'high';
      outCtx.drawImage(crop, 0, 0, targetSize, targetSize);

      if (monoMode) {
        const channels = red.replace('#', '').match(/.{2}/g);
        if (!channels) throw new Error(`Invalid mono color ${red}`);
        const [r, g, b] = channels.map((value) => Number.parseInt(value, 16));
        const data = outCtx.getImageData(0, 0, targetSize, targetSize);
        for (let i = 0; i < data.data.length; i += 4) {
          if ((data.data[i + 3] ?? 0) > 0) {
            const luma =
              0.2126 * (data.data[i] ?? 0) +
              0.7152 * (data.data[i + 1] ?? 0) +
              0.0722 * (data.data[i + 2] ?? 0);
            const shade = 0.28 + 0.72 * (luma / 255);
            data.data[i] = Math.round(r * shade);
            data.data[i + 1] = Math.round(g * shade);
            data.data[i + 2] = Math.round(b * shade);
          }
        }
        outCtx.putImageData(data, 0, 0);
      }

      return out.toDataURL('image/png');
    },
    { sourceDataUrl, size, mono, red: monoColor },
  );
}

// Raw cropped+squared RGBA at `size`, used to encode uncompressed DIB entries for the Windows .ico.
// Same crop/scale as renderIcon(), but returns pixels instead of a PNG so the ICO writer can build
// 32-bit BGRA bitmaps directly.
async function renderRGBA(page, { sourceDataUrl, size }) {
  const flat = await page.evaluate(
    async ({ src, targetSize }) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const scratch = document.createElement('canvas');
      scratch.width = image.naturalWidth;
      scratch.height = image.naturalHeight;
      const sc = scratch.getContext('2d');
      sc.drawImage(image, 0, 0);
      const px = sc.getImageData(0, 0, scratch.width, scratch.height);
      let minX = scratch.width;
      let minY = scratch.height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < scratch.height; y += 1) {
        for (let x = 0; x < scratch.width; x += 1) {
          if ((px.data[(y * scratch.width + x) * 4 + 3] ?? 0) > 8) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < minX) {
        minX = 0;
        minY = 0;
        maxX = scratch.width - 1;
        maxY = scratch.height - 1;
      }
      const cw = maxX - minX + 1;
      const ch = maxY - minY + 1;
      const side = Math.max(cw, ch);
      const crop = document.createElement('canvas');
      crop.width = side;
      crop.height = side;
      const cc = crop.getContext('2d');
      cc.clearRect(0, 0, side, side);
      cc.drawImage(image, -minX + (side - cw) / 2, -minY + (side - ch) / 2);
      const out = document.createElement('canvas');
      out.width = targetSize;
      out.height = targetSize;
      const oc = out.getContext('2d');
      oc.imageSmoothingEnabled = true;
      oc.imageSmoothingQuality = 'high';
      oc.drawImage(crop, 0, 0, targetSize, targetSize);
      return Array.from(oc.getImageData(0, 0, targetSize, targetSize).data);
    },
    { src: sourceDataUrl, targetSize: size },
  );
  return Uint8ClampedArray.from(flat);
}

async function renderMonoXpm(page, sourceDataUrl) {
  const rows = await page.evaluate(
    async ({ sourceDataUrl: src }) => {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = 32;
          canvas.height = 32;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('2D canvas context unavailable'));
            return;
          }
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(image, 0, 0, 32, 32);
          const data = ctx.getImageData(0, 0, 32, 32);
          const lines = [];
          for (let y = 0; y < 32; y += 1) {
            let line = '';
            for (let x = 0; x < 32; x += 1) {
              line += (data.data[(y * 32 + x) * 4 + 3] ?? 0) > 24 ? 'R' : ' ';
            }
            lines.push(line);
          }
          resolve(lines);
        };
        image.onerror = reject;
        image.src = src;
      });
    },
    { sourceDataUrl },
  );

  return [
    '/* XPM */',
    'static char * product_logo_32_xpm[] = {',
    '"32 32 2 1",',
    '"  c None",',
    `"R c ${ACCENT}",`,
    ...rows.map((row) => `"${row}",`),
    '};',
    '',
  ].join('\n');
}

async function writeRenderedPng(page, sourceDataUrl, path, size, mono = false, monoColor = ACCENT) {
  await ensureDir(path);
  const dataUrl = await renderIcon(page, { sourceDataUrl, size, mono, monoColor });
  await writeFile(path, pngBufferFromDataUrl(dataUrl));
}

// Composes the horizontal chrome://version wordmark (lobster mark + "Lobium") into a
// non-square width×height canvas, tinted to `color`. renderIcon() squares its output,
// which is wrong for a wordmark, so this is a dedicated composer. Used for
// IDR_PRODUCT_LOGO / IDR_PRODUCT_LOGO_WHITE (light = dark ink, dark mode = white).
async function renderVersionLogo(page, { sourceDataUrl, width, height, color }) {
  const dataUrl = await page.evaluate(
    async ({ src, w, h, col }) => {
      const image = new Image();
      image.src = src;
      await image.decode();

      const scratch = document.createElement('canvas');
      scratch.width = image.naturalWidth;
      scratch.height = image.naturalHeight;
      const sc = scratch.getContext('2d');
      sc.drawImage(image, 0, 0);
      const px = sc.getImageData(0, 0, scratch.width, scratch.height);
      let minX = scratch.width;
      let minY = scratch.height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < scratch.height; y += 1) {
        for (let x = 0; x < scratch.width; x += 1) {
          if ((px.data[(y * scratch.width + x) * 4 + 3] ?? 0) > 8) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < minX) {
        minX = 0;
        minY = 0;
        maxX = scratch.width - 1;
        maxY = scratch.height - 1;
      }
      const cw = maxX - minX + 1;
      const ch = maxY - minY + 1;

      const icon = document.createElement('canvas');
      icon.width = cw;
      icon.height = ch;
      const ic = icon.getContext('2d');
      ic.drawImage(image, -minX, -minY);
      const idata = ic.getImageData(0, 0, cw, ch);
      const [r, g, b] = col
        .replace('#', '')
        .match(/.{2}/g)
        .map((v) => Number.parseInt(v, 16));
      for (let i = 0; i < idata.data.length; i += 4) {
        if ((idata.data[i + 3] ?? 0) > 0) {
          const luma =
            0.2126 * (idata.data[i] ?? 0) +
            0.7152 * (idata.data[i + 1] ?? 0) +
            0.0722 * (idata.data[i + 2] ?? 0);
          const shade = 0.35 + 0.65 * (luma / 255);
          idata.data[i] = Math.round(r * shade);
          idata.data[i + 1] = Math.round(g * shade);
          idata.data[i + 2] = Math.round(b * shade);
        }
      }
      ic.putImageData(idata, 0, 0);

      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const o = out.getContext('2d');
      o.imageSmoothingEnabled = true;
      o.imageSmoothingQuality = 'high';
      const iconH = Math.round(h * 0.94);
      const iconW = Math.round((iconH * cw) / ch);
      o.drawImage(icon, 0, Math.round((h - iconH) / 2), iconW, iconH);
      const gap = Math.round(h * 0.16);
      const fontPx = Math.round(h * 0.6);
      o.fillStyle = col;
      o.font = `700 ${fontPx}px Arial, "Helvetica Neue", sans-serif`;
      o.textBaseline = 'middle';
      o.fillText('Lobium', iconW + gap, Math.round(h * 0.56));
      return out.toDataURL('image/png');
    },
    { src: sourceDataUrl, w: width, h: height, col: color },
  );
  return dataUrl;
}

// ---- Windows .ico writer -------------------------------------------------------------------------
// The ICO container is a 6-byte ICONDIR + N × 16-byte ICONDIRENTRY + N image payloads. Each payload
// is either an uncompressed 32-bit DIB or a whole PNG. We use DIB for <=128 (widest compatibility
// with rc.exe / the Windows shell) and PNG for 256 (the conventional encoding at that size). This
// file overwrites the stock chrome/app/theme/chromium/win/chromium.ico, which chrome_exe.rc already
// points IDR_MAINFRAME at for the non-branded build — so no .rc change is needed.
function bmpDibEntry(width, height, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(width, 4); // biWidth
  header.writeInt32LE(height * 2, 8); // biHeight — XOR bitmap + AND mask stacked
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  // XOR bitmap: bottom-up rows, BGRA.
  const xor = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const dstRow = height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const s = (y * width + x) * 4;
      const d = (dstRow * width + x) * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }
  // 1-bpp AND mask, rows padded to a 32-bit boundary, bottom-up. Left all-zero: the 32-bit alpha
  // channel carries transparency on every Windows the engine targets.
  const andStride = Math.ceil(width / 32) * 4;
  const andMask = Buffer.alloc(andStride * height);
  return Buffer.concat([header, xor, andMask]);
}

function assembleIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type = icon
  dir.writeUInt16LE(entries.length, 4);
  const dirEntries = [];
  const payloads = [];
  let offset = 6 + entries.length * 16;
  for (const e of entries) {
    const de = Buffer.alloc(16);
    de.writeUInt8(e.size >= 256 ? 0 : e.size, 0); // width (0 => 256)
    de.writeUInt8(e.size >= 256 ? 0 : e.size, 1); // height (0 => 256)
    de.writeUInt8(0, 2); // palette color count
    de.writeUInt8(0, 3); // reserved
    de.writeUInt16LE(1, 4); // color planes
    de.writeUInt16LE(32, 6); // bits per pixel
    de.writeUInt32LE(e.data.length, 8); // bytes in resource
    de.writeUInt32LE(offset, 12); // offset from file start
    dirEntries.push(de);
    payloads.push(e.data);
    offset += e.data.length;
  }
  return Buffer.concat([dir, ...dirEntries, ...payloads]);
}

async function writeWindowsIco(page, sourceDataUrl, path) {
  const dibSizes = [16, 24, 32, 48, 64, 128];
  const entries = [];
  for (const size of dibSizes) {
    const rgba = await renderRGBA(page, { sourceDataUrl, size });
    entries.push({ size, data: bmpDibEntry(size, size, rgba) });
  }
  // 256 as PNG (the standard large-size encoding).
  const png256 = pngBufferFromDataUrl(
    await renderIcon(page, { sourceDataUrl, size: 256, mono: false }),
  );
  entries.push({ size: 256, data: png256 });
  await ensureDir(path);
  await writeFile(path, assembleIco(entries));
}

async function writeFileIfChanged(path, contents) {
  await ensureDir(path);
  if (existsSync(path)) {
    const prev = await readFile(path, 'utf8');
    if (prev === contents) return false;
  }
  await writeFile(path, contents, 'utf8');
  return true;
}

async function writeBrandEmbed(fileName, exportName, sourcePath) {
  const base64 = Buffer.from(await readFile(sourcePath)).toString('base64');
  const source = sourcePath.replace(`${ROOT}/`, '');
  await writeFileIfChanged(
    resolve(EMBED_DIR, fileName),
    // Emitted pre-wrapped because that is what Prettier produces and `npm run format:check` is a
    // CI gate: a base64 PNG always exceeds printWidth, so the assignment is always broken onto its
    // own line.
    `// Generated by scripts/apply-lobium-branding.mjs from ${source}. Do not edit.\n` +
      `export const ${exportName} =\n  '${base64}';\n`,
  );
}

function generateTauriIcons() {
  const result = spawnSync(
    'npx',
    ['tauri', 'icon', 'src/assets/brand/icon.png', '-o', 'src-tauri/icons'],
    {
      cwd: resolve(ROOT, 'apps/desktop'),
      stdio: 'inherit',
      env: process.env,
    },
  );
  if (result.status !== 0) {
    // Non-fatal: the Tauri icon set is a desktop-app concern, not engine branding, and its toolchain
    // (npx tauri) may be absent on a design box that only needs to regenerate the overlay. Warn and
    // continue so the committed overlay + BRANDING still regenerate.
    console.warn(
      `WARN: Tauri icon generation skipped (exit ${result.status ?? 'unknown'}; is @tauri-apps/cli installed?).`,
    );
  }
}

async function main() {
  for (const master of [MAIN_ICON, SITE_LOGO, NTP_MASTER, NTP_AD]) {
    if (!existsSync(master)) throw new Error(`Missing brand master: ${master}`);
  }

  const sourceDataUrl = imageDataUrl(MAIN_ICON);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  try {
    await writeRenderedPng(page, sourceDataUrl, PUBLIC_FAVICON, 32, false);

    // Color product logos (window / about / linux desktop).
    const colorTargets = [
      ['chrome/app/theme/chromium/product_logo_16.png', 16],
      ['chrome/app/theme/chromium/product_logo_24.png', 24],
      ['chrome/app/theme/chromium/product_logo_48.png', 48],
      ['chrome/app/theme/chromium/product_logo_64.png', 64],
      ['chrome/app/theme/chromium/product_logo_128.png', 128],
      ['chrome/app/theme/chromium/product_logo_256.png', 256],
      ['chrome/app/theme/chromium/linux/product_logo_24.png', 24],
      ['chrome/app/theme/chromium/linux/product_logo_48.png', 48],
      ['chrome/app/theme/chromium/linux/product_logo_64.png', 64],
      ['chrome/app/theme/chromium/linux/product_logo_128.png', 128],
      ['chrome/app/theme/chromium/linux/product_logo_256.png', 256],
      ['chrome/app/theme/default_100_percent/chromium/product_logo_16.png', 16],
      ['chrome/app/theme/default_100_percent/chromium/product_logo_32.png', 32],
      ['chrome/app/theme/default_200_percent/chromium/product_logo_16.png', 32],
      ['chrome/app/theme/default_200_percent/chromium/product_logo_32.png', 64],
    ];
    for (const [file, size] of colorTargets) {
      await writeRenderedPng(page, sourceDataUrl, overlay(file), size, false);
    }

    // Tab / window title icon (IDR_PRODUCT_LOGO_16). On Linux this loads from the linux/ subdir, which
    // the color targets above MISS. Render it as a MONO-DARK lobster (the requested tab icon).
    const monoDarkTargets = [
      ['chrome/app/theme/chromium/linux/product_logo_16.png', 16],
      ['chrome/app/theme/default_100_percent/chromium/linux/product_logo_16.png', 16],
      ['chrome/app/theme/default_200_percent/chromium/linux/product_logo_16.png', 32],
    ];
    for (const [file, size] of monoDarkTargets) {
      await writeRenderedPng(page, sourceDataUrl, overlay(file), size, true, MONO_DARK);
    }

    // Wordmark-style name logos (toolbar / about), from the horizontal site logo.
    const nameTargets = [
      ['chrome/app/theme/default_100_percent/chromium/product_logo_name_22.png', 22],
      ['chrome/app/theme/default_200_percent/chromium/product_logo_name_22.png', 44],
    ];
    const siteLogoDataUrl = imageDataUrl(SITE_LOGO);
    for (const [file, size] of nameTargets) {
      await writeRenderedPng(page, siteLogoDataUrl, overlay(file), size, false);
    }

    // Mono / white name logos.
    const whiteNameTargets = [
      ['chrome/app/theme/default_100_percent/chromium/product_logo_name_22_white.png', 22],
      ['chrome/app/theme/default_200_percent/chromium/product_logo_name_22_white.png', 44],
      ['chrome/app/theme/chromium/product_logo_22_mono.png', 22],
    ];
    for (const [file, size] of whiteNameTargets) {
      await writeRenderedPng(page, sourceDataUrl, overlay(file), size, true);
    }

    // NTP tab favicon — mono-dark lobster to match the tab/window icon.
    const faviconTargets = [
      ['chrome/app/theme/default_100_percent/common/favicon_ntp.png', 16],
      ['chrome/app/theme/default_200_percent/common/favicon_ntp.png', 32],
    ];
    for (const [file, size] of faviconTargets) {
      await writeRenderedPng(page, sourceDataUrl, overlay(file), size, true, MONO_DARK);
    }

    // chrome://version top-right logo (IDR_PRODUCT_LOGO / _WHITE) under components/resources: the
    // lobster + "Lobium" wordmark, dark ink for light mode, white for dark, at 100%/200%.
    const versionLogoTargets = [
      ['components/resources/default_100_percent/chromium/product_logo.png', 171, 32, MONO_DARK],
      ['components/resources/default_100_percent/chromium/product_logo_white.png', 171, 32, '#ffffff'],
      ['components/resources/default_200_percent/chromium/product_logo.png', 342, 64, MONO_DARK],
      ['components/resources/default_200_percent/chromium/product_logo_white.png', 342, 64, '#ffffff'],
    ];
    for (const [file, w, h, color] of versionLogoTargets) {
      const target = overlay(file);
      await ensureDir(target);
      const dataUrl = await renderVersionLogo(page, { sourceDataUrl, width: w, height: h, color });
      await writeFile(target, pngBufferFromDataUrl(dataUrl));
    }

    // chrome://version favicon (IDR_PRODUCT_FAVICON) — mono-dark lobster.
    const versionFaviconTargets = [
      ['components/resources/default_100_percent/chromium/favicon_product.png', 16],
      ['components/resources/default_200_percent/chromium/favicon_product.png', 32],
    ];
    for (const [file, size] of versionFaviconTargets) {
      await writeRenderedPng(page, sourceDataUrl, overlay(file), size, true, MONO_DARK);
    }

    // Linux desktop-entry glyph (.xpm) — a mono violet lobster.
    const xpmPath = overlay('chrome/app/theme/chromium/linux/product_logo_32.xpm');
    await ensureDir(xpmPath);
    await writeFile(
      xpmPath,
      await renderMonoXpm(page, await renderIcon(page, { sourceDataUrl, size: 32, mono: true })),
      'utf8',
    );

    // Windows taskbar / .exe icon — the multi-size chrome.ico that every prior branding pass MISSED,
    // which is why Windows kept showing the stock Chromium ball.
    await writeWindowsIco(
      page,
      sourceDataUrl,
      overlay('chrome/app/theme/chromium/win/chromium.ico'),
    );
  } finally {
    await browser.close();
  }

  // The committed BRANDING the stager copies over chrome/app/theme/chromium/BRANDING.
  await writeFileIfChanged(BRANDING_OUT, BRANDING_CONTENTS);

  generateTauriIcons();
  await writeBrandEmbed('brand-icon-data.ts', 'BRAND_ICON_PNG_BASE64', MAIN_ICON);
  await writeBrandEmbed('browser-logo-data.ts', 'BROWSER_LOGO_PNG_BASE64', NTP_MASTER);
  await writeBrandEmbed('brand-ad-data.ts', 'BRAND_AD_PNG_BASE64', NTP_AD);

  console.log(`Regenerated Lobium branding overlay: ${OVERLAY_DIR}`);
  console.log(`Wrote BRANDING: ${BRANDING_OUT}`);
  console.log('Overlay + BRANDING are the committed source of truth; the build stages them via');
  console.log('lobium/stage-branding.mjs (no Playwright). Rebuild the engine to ship them.');
}

await main();
