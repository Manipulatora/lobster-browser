#!/usr/bin/env node
/**
 * Apply Lobster/Lobium brand assets end-to-end:
 * - Desktop masters (mono icon, Tauri PNG sizes)
 * - Chromium theme product_logo_* / favicon assets
 * - NTP wordmark image (not plain text)
 * - BRANDING + user-visible Chrome/Google/Chromium → Lobium strings
 *
 * Usage: npm run apply:lobium-branding
 * Env: LOBIUM_CHROMIUM_SRC / CHROMIUM_SRC (default /home/ivyhfx/lobium-build/src)
 */
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve('.');
const CHROMIUM_SRC =
  process.env.LOBIUM_CHROMIUM_SRC || process.env.CHROMIUM_SRC || '/home/ivyhfx/lobium-build/src';
const MAIN_ICON = resolve(ROOT, 'apps/desktop/src/assets/brand/icon.png');
const PURPLE_ICON = resolve(ROOT, 'apps/desktop/src/assets/brand/icon.png');
const WORDMARK = resolve(ROOT, 'apps/desktop/src/assets/brand/site-logo.png');
const WORDMARK_HZ = resolve(ROOT, 'apps/desktop/src/assets/brand/site-logo.png');
// NTP brand images: master (on the search box) + profile_branding sub-brand (under the search box).
// Both already background-transparent (see scripts/make-brand-transparent.mjs).
const NTP_MASTER = resolve(ROOT, 'apps/desktop/src/assets/brand/browser-logo.png');
const NTP_PROFILE_BRANDING = resolve(ROOT, 'apps/desktop/src/assets/brand/ad.png');
const MONO_ICON = resolve(ROOT, 'apps/desktop/src/assets/brand/lobster-icon-mono-dark.png');
const LEGACY_MONO_ICON = resolve(ROOT, 'apps/desktop/src/assets/brand/octium-browser-icon-mono.png');
const PUBLIC_MONO_ICON = resolve(ROOT, 'apps/desktop/public/octium-browser-icon-mono.png');
const PUBLIC_FAVICON = resolve(ROOT, 'apps/desktop/public/lobster-icon-purple.png');
const PUBLIC_ICON = resolve(ROOT, 'apps/desktop/public/lobster-icon.png');
const RED = '#7c3aed'; // primary violet (brand accent)
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

async function renderIcon(page, { sourceDataUrl, size, mono, monoColor = RED }) {
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

async function renderMonoXpm(page, sourceDataUrl) {
  const rows = await page.evaluate(async ({ sourceDataUrl: src }) => {
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
  }, { sourceDataUrl });

  return [
    '/* XPM */',
    'static char * product_logo_32_xpm[] = {',
    '"32 32 2 1",',
    '"  c None",',
    `"R c ${RED}",`,
    ...rows.map((row) => `"${row}",`),
    '};',
    '',
  ].join('\n');
}

async function writeRenderedPng(page, sourceDataUrl, path, size, mono = false, monoColor = RED) {
  await ensureDir(path);
  const dataUrl = await renderIcon(page, { sourceDataUrl, size, mono, monoColor });
  await writeFile(path, pngBufferFromDataUrl(dataUrl));
}

async function replaceInFile(path, transforms) {
  if (!existsSync(path)) return false;
  let text = await readFile(path, 'utf8');
  const before = text;
  for (const [pattern, replacement] of transforms) {
    text = text.replace(pattern, replacement);
  }
  if (text !== before) await writeFile(path, text, 'utf8');
  return text !== before;
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

async function patchNativeBrandingFiles() {
  if (!existsSync(CHROMIUM_SRC)) {
    console.warn(`Chromium source not found at ${CHROMIUM_SRC}; skipped native source patching.`);
    return;
  }

  // Theme BRANDING — used for installer/window metadata (must not stay "Chromium").
  await writeFileIfChanged(
    resolve(CHROMIUM_SRC, 'chrome/app/theme/chromium/BRANDING'),
    [
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
    ].join('\n'),
  );

  // NTP brand images: master (on the search box) + profile_branding (under the search box).
  const ntpIconsDir = resolve(CHROMIUM_SRC, 'chrome/browser/resources/new_tab_page/icons');
  if (existsSync(NTP_MASTER)) {
    await copyFile(NTP_MASTER, resolve(ntpIconsDir, 'lobium_master.png'));
  }
  if (existsSync(NTP_PROFILE_BRANDING)) {
    await copyFile(NTP_PROFILE_BRANDING, resolve(ntpIconsDir, 'profile_branding.png'));
  }

  const iconsBuildGn = resolve(ntpIconsDir, 'BUILD.gn');
  if (existsSync(iconsBuildGn)) {
    let gn = await readFile(iconsBuildGn, 'utf8');
    if (!gn.includes('lobium_master.png')) {
      gn = gn.replace(
        'input_files = [',
        'input_files = [\n    "lobium_master.png",\n    "profile_branding.png",',
      );
      await writeFile(iconsBuildGn, gn, 'utf8');
    }
  }

  // Force-write NTP logo template to use the brand image (every new tab).
  const logoHtml = [
    '${this.showLogo_ ? html`',
    '  <div id="logo" aria-label="Lobium">',
    '    <img id="logoImage" src="icons/lobium_master.png" alt="Lobium" draggable="false">',
    '  </div>',
    "` : ''}",
    '${this.showDoodle_ ? html`',
    '  <div id="doodle" title="${this.doodle_!.description}">',
    '    <div id="imageDoodle" ?hidden="${!this.imageDoodle_}"',
    '        tabindex="${this.imageDoodleTabIndex_}" @click="${this.onImageClick_}"',
    '        @keydown="${this.onImageKeydown_}">',
    '      <div id="imageContainer">',
    '        <img id="image" src="${this.imageUrl_}" @load="${this.onImageLoad_}">',
    '      </div>',
    '      <cr-button id="shareButton" title="$i18n{shareDoodle}"',
    '          @click="${this.onShareButtonClick_}">',
    '        <div id="shareButtonIcon"></div>',
    '      </cr-button>',
    '    </div>',
    '  </div>',
    "` : ''}",
    '${this.showShareDialog_ ? html`',
    '  <ntp-doodle-share-dialog .title="${this.doodle_!.description}"',
    '      .url="${this.doodle_!.image!.shareUrl}"',
    '      @close="${this.onShareDialogClose_}" @share="${this.onShare_}">',
    '  </ntp-doodle-share-dialog>',
    "` : ''}",
    '',
  ].join('\n');
  await writeFile(
    resolve(CHROMIUM_SRC, 'chrome/browser/resources/new_tab_page/logo.html'),
    logoHtml,
  );

  // Patch logo.css #logo block to display the wordmark image.
  await replaceInFile(resolve(CHROMIUM_SRC, 'chrome/browser/resources/new_tab_page/logo.css'), [
    [
      /#logo \{[\s\S]*?\}\n\n:host\(\[single-colored\]\) #logo[\s\S]*?\n\}/,
      `#logo {
  background: none;
  forced-color-adjust: none;
  height: auto;
  width: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto;
}

#logoImage {
  display: block;
  width: auto;
  height: auto;
  max-width: min(440px, 74vw);
  max-height: 260px;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
}

:host([single-colored]) #logo,
:host(:not([single-colored])) #logo {
  -webkit-mask-image: none;
  background-image: none;
}`,
    ],
  ]);

  // Sub-brand image (profile_branding.png) directly under the search box on the NTP. Idempotent:
  // only inserts when the marker id is not already present.
  const appHtmlPath = resolve(CHROMIUM_SRC, 'chrome/browser/resources/new_tab_page/app.html');
  if (existsSync(appHtmlPath)) {
    let appHtml = await readFile(appHtmlPath, 'utf8');
    if (!appHtml.includes('id="lobiumSubBrand"')) {
      // Insert right after the #searchboxContainer closes (the `</div>` before the action-chips block).
      appHtml = appHtml.replace(
        /(\n {2}<\/div>\n)( {2}\$\{this\.lazyRender_ && this\.ntpNextFeaturesEnabled_)/,
        `$1  <!-- Lobium: sub-brand image directly under the search box (profile_branding.png). -->\n  <div id="lobiumSubBrand" ?hidden="\${!this.logoEnabled_}">\n    <img src="icons/profile_branding.png" alt="" draggable="false">\n  </div>\n$2`,
      );
      await writeFile(appHtmlPath, appHtml, 'utf8');
    }
  }
  const appCssPath = resolve(CHROMIUM_SRC, 'chrome/browser/resources/new_tab_page/app.css');
  if (existsSync(appCssPath)) {
    let appCss = await readFile(appCssPath, 'utf8');
    if (!appCss.includes('#lobiumSubBrand')) {
      appCss +=
        '\n/* Lobium: sub-brand image (profile_branding.png) directly under the search box. */\n' +
        '#lobiumSubBrand {\n  display: flex;\n  justify-content: center;\n  align-items: center;\n' +
        '  margin: 4px auto 16px;\n  width: var(--ntp-search-box-width, min(337px, 80vw));\n}\n' +
        '#lobiumSubBrand[hidden] {\n  display: none;\n}\n' +
        '#lobiumSubBrand img {\n  display: block;\n  width: 100%;\n  height: auto;\n' +
        '  max-width: var(--ntp-search-box-width, min(337px, 80vw));\n  object-fit: contain;\n' +
        '  user-select: none;\n  -webkit-user-drag: none;\n}\n';
      await writeFile(appCssPath, appCss, 'utf8');
    }
  }

  // NOTE: We deliberately do NOT disable shortcuts / one-google-bar or rewrite the omnibox / Web Store
  // strings. The product intent is a stock-Chrome NTP with only the brand images swapped — real
  // "Add shortcut" tiles, real search text ("Search Google or type a URL"), real Web Store. Those
  // transforms were removed; app.ts / generated_resources.grd stay pristine.

  const stringFiles = [
    'chrome/app/chromium_strings.grd',
    'chrome/app/settings_chromium_strings.grdp',
    'chrome/app/google_chrome_strings.grd',
    'chrome/app/settings_google_chrome_strings.grdp',
  ].map((file) => resolve(CHROMIUM_SRC, file));
  for (const file of stringFiles) {
    await replaceInFile(file, [
      [/\bGoogle Chrome\b/g, 'Lobium'],
      [/\bChrome\b/g, 'Lobium'],
      [/\bChromium\b/g, 'Lobium'],
      // Prior branding pass used Lobster as product name — normalize to Lobium in chrome UI.
      [/\bLobster for Testing\b/g, 'Lobium for Testing'],
      [/\bLobster\b/g, 'Lobium'],
    ]);
  }
}

async function main() {
  if (!existsSync(MAIN_ICON)) {
    throw new Error(`Missing primary icon: ${MAIN_ICON}`);
  }
  if (!existsSync(PURPLE_ICON)) {
    throw new Error(`Missing purple icon: ${PURPLE_ICON}`);
  }

  const sourceDataUrl = imageDataUrl(MAIN_ICON);
  const purpleDataUrl = imageDataUrl(PURPLE_ICON);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  try {
    await writeRenderedPng(page, sourceDataUrl, MONO_ICON, 448, true);
    await writeRenderedPng(page, sourceDataUrl, PUBLIC_MONO_ICON, 448, true);
    await ensureDir(PUBLIC_FAVICON);
    await copyFile(PURPLE_ICON, PUBLIC_FAVICON);
    await copyFile(MAIN_ICON, PUBLIC_ICON);

    for (const [file, size] of [
      ['apps/desktop/src-tauri/icons/icon.png', 512],
      ['apps/desktop/src-tauri/icons/128x128.png', 128],
      ['apps/desktop/src-tauri/icons/128x128@2x.png', 256],
      ['apps/desktop/src-tauri/icons/64x64.png', 64],
      ['apps/desktop/src-tauri/icons/32x32.png', 32],
    ]) {
      await writeRenderedPng(page, sourceDataUrl, resolve(ROOT, file), size, false);
    }

    if (existsSync(CHROMIUM_SRC)) {
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
        await writeRenderedPng(page, sourceDataUrl, resolve(CHROMIUM_SRC, file), size, false);
      }

      // Wordmark-style name logos (toolbar / about).
      const nameTargets = [
        ['chrome/app/theme/default_100_percent/chromium/product_logo_name_22.png', 22],
        ['chrome/app/theme/default_200_percent/chromium/product_logo_name_22.png', 44],
      ];
      for (const [file, size] of nameTargets) {
        // Prefer horizontal wordmark when available; fall back to icon.
        const src = existsSync(WORDMARK_HZ) ? imageDataUrl(WORDMARK_HZ) : sourceDataUrl;
        await writeRenderedPng(page, src, resolve(CHROMIUM_SRC, file), size, false);
      }

      // Mono / white name logos.
      const whiteNameTargets = [
        ['chrome/app/theme/default_100_percent/chromium/product_logo_name_22_white.png', 22],
        ['chrome/app/theme/default_200_percent/chromium/product_logo_name_22_white.png', 44],
        ['chrome/app/theme/chromium/product_logo_22_mono.png', 22],
      ];
      for (const [file, size] of whiteNameTargets) {
        await writeRenderedPng(page, sourceDataUrl, resolve(CHROMIUM_SRC, file), size, true);
      }

      // Tab / NTP favicons — dark monochrome lobster (global, not first-tab-only).
      const monoSrc = existsSync(MONO_ICON) ? MONO_ICON : LEGACY_MONO_ICON;
      const monoDataUrl = imageDataUrl(monoSrc);
      const faviconTargets = [
        ['chrome/app/theme/default_100_percent/common/favicon_ntp.png', 16],
        ['chrome/app/theme/default_200_percent/common/favicon_ntp.png', 32],
      ];
      for (const [file, size] of faviconTargets) {
        await writeRenderedPng(page, monoDataUrl, resolve(CHROMIUM_SRC, file), size, false);
      }

      // Also stamp purple into out/ product_logo copies used at runtime without full rebuild.
      const outDir = resolve(CHROMIUM_SRC, 'out/Lobium');
      if (existsSync(outDir)) {
        for (const [name, size] of [
          ['product_logo_48.png', 48],
          ['product_logo_128.png', 128],
          ['product_logo_256.png', 256],
        ]) {
          const dest = resolve(outDir, name);
          if (existsSync(dest) || existsSync(dirname(dest))) {
            await writeRenderedPng(page, sourceDataUrl, dest, size, false);
          }
        }
      }

      const xpmPath = resolve(CHROMIUM_SRC, 'chrome/app/theme/chromium/linux/product_logo_32.xpm');
      await ensureDir(xpmPath);
      await writeFile(
        xpmPath,
        await renderMonoXpm(page, await renderIcon(page, { sourceDataUrl, size: 32, mono: true })),
        'utf8',
      );
    }
  } finally {
    await browser.close();
  }

  await patchNativeBrandingFiles();
  console.log(`Applied Lobium/Lobster branding assets. Chromium source: ${CHROMIUM_SRC}`);
  console.log(`Primary icon: ${MAIN_ICON}`);
  console.log(`Purple tab icon: ${PURPLE_ICON}`);
  console.log(`Wordmark: ${WORDMARK}`);
}

await main();
