#!/usr/bin/env node
/**
 * Build packages/fingerprint/src/catalog.generated.ts from verified sources.
 *
 * Fonts: Microsoft Learn + Apple Support (live fetch); Linux from verified Ubuntu package JSON.
 * Android: Google Play supported_devices.csv (live fetch).
 * WebGL: packages/fingerprint/data/webgl-renderers.verified.json (PCI IDs / Apple product IDs / Linux Mesa).
 *
 * Invented GPU model lists without deviceId/source are rejected.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = resolve(ROOT, 'packages/fingerprint/src/catalog.generated.ts');
const WEBGL_FILE = resolve(ROOT, 'packages/fingerprint/data/webgl-renderers.verified.json');
const LINUX_FONTS_FILE = resolve(ROOT, 'packages/fingerprint/data/linux-fonts.verified.json');

const SOURCES = {
  windows10Fonts: 'https://learn.microsoft.com/en-us/typography/fonts/windows_10_font_list',
  windows11Fonts: 'https://learn.microsoft.com/en-us/typography/fonts/windows_11_font_list',
  macOSVenturaFonts: 'https://support.apple.com/en-us/HT213266',
  macOSSonomaFonts: 'https://support.apple.com/en-us/108939',
  macOSSequoiaFonts: 'https://support.apple.com/en-us/120414',
  macOSTahoeFonts: 'https://support.apple.com/en-us/122869',
  googlePlaySupportedDevices: 'https://storage.googleapis.com/play_public/supported_devices.csv',
  webglVerifiedJson: 'packages/fingerprint/data/webgl-renderers.verified.json',
  linuxFontsVerifiedJson: 'packages/fingerprint/data/linux-fonts.verified.json',
};

const D3D11_CAPS = {
  maxTextureSize: 16384,
  maxCubeMapTextureSize: 16384,
  maxRenderbufferSize: 16384,
  maxViewportDims: [16384, 16384],
  maxVertexAttribs: 16,
  maxVertexUniformVectors: 4096,
  maxFragmentUniformVectors: 1024,
  maxVaryingVectors: 30,
  maxTextureImageUnits: 16,
  maxVertexTextureImageUnits: 16,
  maxCombinedTextureImageUnits: 32,
  aliasedLineWidthRange: [1, 1],
  aliasedPointSizeRange: [1, 1024],
};

const METAL_CAPS = {
  maxTextureSize: 16384,
  maxCubeMapTextureSize: 16384,
  maxRenderbufferSize: 16384,
  maxViewportDims: [16384, 16384],
  maxVertexAttribs: 16,
  maxVertexUniformVectors: 1024,
  maxFragmentUniformVectors: 1024,
  maxVaryingVectors: 31,
  maxTextureImageUnits: 16,
  maxVertexTextureImageUnits: 16,
  maxCombinedTextureImageUnits: 32,
  aliasedLineWidthRange: [1, 1],
  aliasedPointSizeRange: [1, 511],
};

/** Typical Chrome-on-Linux Mesa/OpenGL caps (host-calibrated path still preferred in production). */
const MESA_CAPS = {
  maxTextureSize: 16384,
  maxCubeMapTextureSize: 16384,
  maxRenderbufferSize: 16384,
  maxViewportDims: [16384, 16384],
  maxVertexAttribs: 16,
  maxVertexUniformVectors: 4096,
  maxFragmentUniformVectors: 1024,
  maxVaryingVectors: 30,
  maxTextureImageUnits: 16,
  maxVertexTextureImageUnits: 16,
  maxCombinedTextureImageUnits: 32,
  aliasedLineWidthRange: [1, 1],
  aliasedPointSizeRange: [1, 8191],
};

async function fetchBytes(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchText(url) {
  const bytes = await fetchBytes(url);
  return new TextDecoder().decode(bytes).replace(/^\ufeff/, '');
}

function decodeHtml(raw) {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ \*$/g, '')
    .replace(/\*$/g, '')
    .trim();
}

function uniqueSorted(values) {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'en'),
  );
}

function extractWindowsFonts(html) {
  const names = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => decodeHtml(m[1]));
    if (cells[1]) names.push(cells[1]);
  }
  return uniqueSorted(names);
}

/** Apple Support font pages list typefaces as plain lines / table cells. */
function extractAppleSupportFonts(html) {
  const names = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
      decodeHtml(m[1]),
    );
    if (cells[0] && /^[A-Za-z0-9]/.test(cells[0]) && cells[0].length < 80) {
      // Skip section headers
      if (/^Fonts |^Installed|^Document|^Downloadable|^Typeface|^Name$/i.test(cells[0])) continue;
      names.push(cells[0]);
    }
  }
  // Also pull list items that look like font family names
  for (const m of html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const text = decodeHtml(m[1]);
    if (
      text &&
      text.length > 1 &&
      text.length < 60 &&
      /^[A-Za-z]/.test(text) &&
      !/^(Learn more|See also|Get support)/i.test(text)
    ) {
      names.push(text.split(/\s{2,}/)[0]);
    }
  }
  return uniqueSorted(names);
}

function decodeDeviceCsv(bytes) {
  const isUtf16Le =
    bytes.length > 3 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[1] === 0 && bytes[3] === 0));
  return new TextDecoder(isUtf16Le ? 'utf-16le' : 'utf-8').decode(bytes).replace(/^\ufeff/, '');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizedCell(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTabletAndroid(text) {
  return (
    /\b(tab|tablet|pad|matepad|mediapad)\b/i.test(text) ||
    /\bA301LV\b/i.test(text) ||
    /\bLenovo Tab\b/i.test(text)
  );
}

function isNonHandheldAndroid(text) {
  return /\b(tv|chromebook|box|stick|projector|watch|wear|car|auto|glass)\b/i.test(text);
}

function isConsumerPhoneBrand(brand) {
  return /Google|Samsung|Xiaomi|Redmi|POCO|OnePlus|OPPO|vivo|Honor|Motorola|Sony|ASUS|Asus|Nothing|realme|Nokia|TCL|ZTE|Lenovo|Huawei|HUAWEI|Infinix|TECNO|Fairphone|Sharp|Kyocera|CAT|Blackview|Ulefone|Doogee/i.test(
    brand,
  );
}

function androidEntry(row, formFactor) {
  const [brand, marketingName, device, model] = row.map(normalizedCell);
  const label = marketingName
    ? `${brand} ${marketingName}${model ? ` (${model})` : ''}`
    : `${brand}${model ? ` (${model})` : ''}`;
  return { label: label.trim(), brand, marketingName, device, model, formFactor };
}

function phonePriority(label) {
  const current = /Pixel|Galaxy S2[0-9]|Galaxy Z|Xiaomi 1[1-5]|iPhone/i.test(label) ? 0 : 1;
  const brandRank =
    [
      'Google',
      'Samsung',
      'Xiaomi',
      'Redmi',
      'POCO',
      'OnePlus',
      'OPPO',
      'vivo',
      'Honor',
      'Motorola',
      'Sony',
      'ASUS',
      'Asus',
      'Nothing',
      'realme',
      'Nokia',
      'TCL',
      'ZTE',
      'Lenovo',
    ].findIndex((brand) => label.startsWith(brand)) + 1 || 99;
  return `${current.toString().padStart(2, '0')}:${brandRank.toString().padStart(2, '0')}:${label}`;
}

function tabletPriority(label) {
  if (/Galaxy Tab A9\+|Lenovo (Tab 5G|A301LV)|Xiaomi Pad 6/i.test(label)) return `-1:${label}`;
  const current =
    /Galaxy Tab (S[789]|A9|A8)|Pixel Tablet|Xiaomi Pad [567]|OnePlus Pad|Lenovo Tab (P|M|5G)|MatePad|MagicPad|Nokia T\d/i.test(
      label,
    )
      ? 0
      : 1;
  return `${current}:${label}`;
}

function extractAndroidModels(csvText) {
  const rows = parseCsv(csvText)
    .slice(1)
    .filter((row) => row.length >= 4)
    .map((row) => row.slice(0, 4));
  const phones = [];
  const tablets = [];
  const seenPhones = new Set();
  const seenTablets = new Set();

  for (const row of rows) {
    const [brand, marketingName, device, model] = row.map(normalizedCell);
    const text = `${brand} ${marketingName} ${device} ${model}`;
    if (isNonHandheldAndroid(text) && !isTabletAndroid(text)) continue;
    if (isTabletAndroid(text)) {
      const entry = androidEntry(row, 'tablet');
      if (entry.label.length > 1 && !seenTablets.has(entry.label)) {
        seenTablets.add(entry.label);
        tablets.push(entry);
      }
      continue;
    }
    if (!isConsumerPhoneBrand(brand)) continue;
    const entry = androidEntry(row, 'mobile');
    if (entry.label.length > 1 && !seenPhones.has(entry.label)) {
      seenPhones.add(entry.label);
      phones.push(entry);
    }
  }

  // Keep the full filtered consumer set (no arbitrary brand-starving cap). Sort for UX only.
  return {
    phones: phones.sort((a, b) => phonePriority(a.label).localeCompare(phonePriority(b.label))),
    tablets: tablets.sort((a, b) =>
      tabletPriority(a.label).localeCompare(tabletPriority(b.label)),
    ),
  };
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/\(r\)|\(tm\)|[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function literal(value) {
  return JSON.stringify(value);
}

function renderStringArray(name, values) {
  return `export const ${name} = [\n${values.map((value) => `  ${literal(value)},`).join('\n')}\n] satisfies readonly string[];\n`;
}

function renderAndroidArray(name, values) {
  return `export const ${name}: AndroidDeviceCatalogEntry[] = [\n${values
    .map(
      (entry) =>
        `  { label: ${literal(entry.label)}, brand: ${literal(entry.brand)}, marketingName: ${literal(entry.marketingName)}, device: ${literal(entry.device)}, model: ${literal(entry.model)}, formFactor: ${literal(entry.formFactor)} },`,
    )
    .join('\n')}\n];\n`;
}

function assertVerifiedRenderer(entry, os) {
  if (!entry.deviceId) throw new Error(`${os} renderer missing deviceId: ${entry.label}`);
  if (!entry.source) throw new Error(`${os} renderer missing source: ${entry.label}`);
  if (!entry.label) throw new Error(`${os} renderer missing label`);
  if (!['NVIDIA', 'Intel', 'AMD', 'Apple'].includes(entry.vendorFamily)) {
    throw new Error(`${os} renderer bad vendorFamily: ${entry.vendorFamily}`);
  }
}

function loadVerifiedWebgl(raw) {
  const windows = [];
  const macosIntel = [];
  const macosArm = [];
  const linux = [];
  for (const entry of raw.windows ?? []) {
    assertVerifiedRenderer(entry, 'windows');
    windows.push(entry);
  }
  for (const entry of raw.macosIntel ?? []) {
    assertVerifiedRenderer(entry, 'macosIntel');
    macosIntel.push(entry);
  }
  for (const entry of raw.macosArm ?? []) {
    assertVerifiedRenderer(entry, 'macosArm');
    macosArm.push(entry);
  }
  for (const entry of raw.linux ?? []) {
    assertVerifiedRenderer(entry, 'linux');
    linux.push(entry);
  }
  if (windows.length < 300) throw new Error(`Windows renderer catalog too small: ${windows.length}`);
  if (macosIntel.length + macosArm.length < 200) {
    throw new Error(
      `macOS renderer catalog too small: ${macosIntel.length + macosArm.length}`,
    );
  }
  if (linux.length < 300) throw new Error(`Linux renderer catalog too small: ${linux.length}`);
  return { windows, macosIntel, macosArm, linux, meta: raw };
}

function loadVerifiedLinuxFonts(raw) {
  const fonts = uniqueSorted((raw.fonts ?? []).map((entry) => entry.family ?? entry).filter(Boolean));
  if (fonts.length < 200) throw new Error(`Linux font catalog too small: ${fonts.length}`);
  return fonts;
}

function renderWindowsRenderers(entries) {
  const lines = entries.map((entry) => {
    const id = `win-${slug(entry.vendorFamily)}-${slug(entry.label)}-${entry.deviceId.replace(/^0x/i, '').toLowerCase()}`;
    return `  winRenderer(${literal(id)}, ${literal(entry.vendorFamily)}, ${literal(entry.label)}, ${literal(entry.deviceId)}, ${literal(entry.source)}),`;
  });
  return `export const WINDOWS_RENDERER_PRESETS: RendererCatalogEntry[] = [\n${lines.join('\n')}\n];\n`;
}

function renderMacIntelRenderers(entries) {
  const lines = entries.map((entry) => {
    const id = `mac-${slug(entry.vendorFamily)}-${slug(entry.label)}-${entry.deviceId.replace(/^0x/i, '').toLowerCase()}`;
    return `  macIntelRenderer(${literal(id)}, ${literal(entry.vendorFamily)}, ${literal(entry.label)}, ${literal(entry.deviceId)}, ${literal(entry.source)}),`;
  });
  return `export const MACOS_INTEL_RENDERER_PRESETS: RendererCatalogEntry[] = [\n${lines.join('\n')}\n];\n`;
}

function renderMacArmRenderers(entries) {
  const lines = entries.map((entry) => {
    const chip = entry.label.replace(/^Apple\s+/i, '');
    const id = `mac-apple-${slug(chip)}`;
    return `  macArmRenderer(${literal(id)}, ${literal(chip)}, ${literal(entry.deviceId)}, ${literal(entry.source)}),`;
  });
  return `export const MACOS_ARM_RENDERER_PRESETS: RendererCatalogEntry[] = [\n${lines.join('\n')}\n];\n`;
}

function renderLinuxRenderers(entries) {
  const lines = entries.map((entry) => {
    const id = `linux-${slug(entry.vendorFamily)}-${slug(entry.label)}-${entry.deviceId.replace(/^0x/i, '').toLowerCase()}`;
    return `  linuxRenderer(${literal(id)}, ${literal(entry.vendorFamily)}, ${literal(entry.label)}, ${literal(entry.deviceId)}, ${literal(entry.source)}),`;
  });
  return `export const LINUX_RENDERER_PRESETS: RendererCatalogEntry[] = [\n${lines.join('\n')}\n];\n`;
}

function renderGenerated({
  windowsFonts,
  macFonts,
  linuxFonts,
  androidPhones,
  androidTablets,
  webgl,
  retrievedAt,
}) {
  const provenance = {
    retrievedAt,
    sources: SOURCES,
    webglSource: webgl.meta.source,
    webglLicense: webgl.meta.license,
    counts: {
      windowsFonts: windowsFonts.length,
      macFonts: macFonts.length,
      linuxFonts: linuxFonts.length,
      androidPhones: androidPhones.length,
      androidTablets: androidTablets.length,
      windowsRenderers: webgl.windows.length,
      macosIntelRenderers: webgl.macosIntel.length,
      macosArmRenderers: webgl.macosArm.length,
      linuxRenderers: webgl.linux.length,
    },
  };

  return `// Auto-generated by scripts/generate-fingerprint-catalog.mjs.
// Do not edit by hand; edit the generator or packages/fingerprint/data/* instead.
import type { WebGlCaps, WebGlFingerprint } from '@lobster/shared-types';

export const FINGERPRINT_CATALOG_SOURCES = ${JSON.stringify(SOURCES, null, 2)} as const;

export const CATALOG_PROVENANCE = ${JSON.stringify(provenance, null, 2)} as const;

export interface AndroidDeviceCatalogEntry {
  label: string;
  brand: string;
  marketingName: string;
  device: string;
  model: string;
  formFactor: 'mobile' | 'tablet';
}

export interface RendererCatalogEntry {
  id: string;
  os: 'windows' | 'macos' | 'linux';
  label: string;
  vendorFamily: 'NVIDIA' | 'Intel' | 'AMD' | 'Apple';
  /** PCI device ID (0xXXXX) or apple-* product id. Required for verified_source entries. */
  deviceId: string;
  source: string;
  validationLevel: 'verified_source';
  webgl: WebGlFingerprint;
}

const D3D11_CAPS = ${JSON.stringify(D3D11_CAPS, null, 2)} satisfies WebGlCaps;
const METAL_CAPS = ${JSON.stringify(METAL_CAPS, null, 2)} satisfies WebGlCaps;
const MESA_CAPS = ${JSON.stringify(MESA_CAPS, null, 2)} satisfies WebGlCaps;

function winRenderer(
  id: string,
  vendor: 'NVIDIA' | 'Intel' | 'AMD',
  model: string,
  deviceId: string,
  source: string,
): RendererCatalogEntry {
  const webglVendor = \`Google Inc. (\${vendor})\`;
  const renderer = \`ANGLE (\${vendor}, \${model} (\${deviceId}) Direct3D11 vs_5_0 ps_5_0, D3D11)\`;
  return {
    id,
    os: 'windows',
    label: model,
    vendorFamily: vendor,
    deviceId,
    source,
    validationLevel: 'verified_source',
    webgl: {
      vendor: webglVendor,
      renderer,
      unmaskedVendor: webglVendor,
      unmaskedRenderer: renderer,
      caps: D3D11_CAPS,
    },
  };
}

function macArmRenderer(
  id: string,
  chip: string,
  deviceId: string,
  source: string,
): RendererCatalogEntry {
  const webglVendor = 'Google Inc. (Apple)';
  const renderer = \`ANGLE (Apple, ANGLE Metal Renderer: Apple \${chip}, Unspecified Version)\`;
  return {
    id,
    os: 'macos',
    label: \`Apple \${chip}\`,
    vendorFamily: 'Apple',
    deviceId,
    source,
    validationLevel: 'verified_source',
    webgl: {
      vendor: webglVendor,
      renderer,
      unmaskedVendor: webglVendor,
      unmaskedRenderer: renderer,
      caps: METAL_CAPS,
    },
  };
}

function macIntelRenderer(
  id: string,
  vendor: 'Intel' | 'AMD',
  model: string,
  deviceId: string,
  source: string,
): RendererCatalogEntry {
  const webglVendor =
    vendor === 'Intel' ? 'Google Inc. (Intel Inc.)' : 'Google Inc. (ATI Technologies Inc.)';
  const backendVendor = vendor === 'Intel' ? 'Intel Inc.' : 'ATI Technologies Inc.';
  const renderer = \`ANGLE (\${backendVendor}, ANGLE Metal Renderer: \${model}, Unspecified Version)\`;
  return {
    id,
    os: 'macos',
    label: model,
    vendorFamily: vendor,
    deviceId,
    source,
    validationLevel: 'verified_source',
    webgl: {
      vendor: webglVendor,
      renderer,
      unmaskedVendor: webglVendor,
      unmaskedRenderer: renderer,
      caps: METAL_CAPS,
    },
  };
}

function linuxRenderer(
  id: string,
  vendor: 'NVIDIA' | 'Intel' | 'AMD',
  model: string,
  deviceId: string,
  source: string,
): RendererCatalogEntry {
  const webglVendor = \`Google Inc. (\${vendor})\`;
  const renderer =
    vendor === 'Intel'
      ? \`ANGLE (Intel, Mesa \${model} (\${deviceId}), OpenGL 4.6)\`
      : \`ANGLE (\${vendor}, \${model} (\${deviceId}), OpenGL 4.5)\`;
  return {
    id,
    os: 'linux',
    label: model,
    vendorFamily: vendor,
    deviceId,
    source,
    validationLevel: 'verified_source',
    webgl: {
      vendor: webglVendor,
      renderer,
      unmaskedVendor: webglVendor,
      unmaskedRenderer: renderer,
      caps: MESA_CAPS,
    },
  };
}

${renderStringArray('WINDOWS_FONT_NAMES', windowsFonts)}
${renderStringArray('MACOS_FONT_NAMES', macFonts)}
${renderStringArray('LINUX_FONT_NAMES', linuxFonts)}
${renderAndroidArray('ANDROID_PHONE_MODEL_CATALOG', androidPhones)}
${renderAndroidArray('ANDROID_TABLET_MODEL_CATALOG', androidTablets)}
${renderWindowsRenderers(webgl.windows)}
${renderMacArmRenderers(webgl.macosArm)}
${renderMacIntelRenderers(webgl.macosIntel)}
${renderLinuxRenderers(webgl.linux)}
`;
}

async function main() {
  const retrievedAt = new Date().toISOString();
  const webglRaw = JSON.parse(await readFile(WEBGL_FILE, 'utf8'));
  const webgl = loadVerifiedWebgl(webglRaw);
  const linuxFontsRaw = JSON.parse(await readFile(LINUX_FONTS_FILE, 'utf8'));
  const linuxFonts = loadVerifiedLinuxFonts(linuxFontsRaw);

  const [win10Html, win11Html, venturaHtml, sonomaHtml, sequoiaHtml, tahoeHtml, devicesBytes] =
    await Promise.all([
      fetchText(SOURCES.windows10Fonts),
      fetchText(SOURCES.windows11Fonts),
      fetchText(SOURCES.macOSVenturaFonts).catch(() => ''),
      fetchText(SOURCES.macOSSonomaFonts),
      fetchText(SOURCES.macOSSequoiaFonts),
      fetchText(SOURCES.macOSTahoeFonts),
      fetchBytes(SOURCES.googlePlaySupportedDevices),
    ]);

  const windowsFonts = uniqueSorted([
    ...extractWindowsFonts(win10Html),
    ...extractWindowsFonts(win11Html),
  ]);
  let macFonts = uniqueSorted([
    ...extractAppleSupportFonts(venturaHtml),
    ...extractAppleSupportFonts(sonomaHtml),
    ...extractAppleSupportFonts(sequoiaHtml),
    ...extractAppleSupportFonts(tahoeHtml),
  ]);
  const { phones, tablets } = extractAndroidModels(decodeDeviceCsv(devicesBytes));

  if (windowsFonts.length < 300) {
    throw new Error(`Windows font catalog too small: ${windowsFonts.length}`);
  }
  if (macFonts.length < 1000) {
    // Fall back: developer.apple.com system-fonts page if Support pages under-parse
    console.warn(
      `macOS Support font parse yielded ${macFonts.length}; attempting developer.apple.com fallback`,
    );
    const appleDev = await fetchText('https://developer.apple.com/fonts/system-fonts/');
    const fromDev = [];
    const rx = /<span data-profile-detail="name" class="filter-font-name">([\s\S]*?)<\/span>/g;
    let match;
    while ((match = rx.exec(appleDev))) {
      const next = appleDev.indexOf('<li class="font-item"', match.index + 1);
      const block = appleDev.slice(match.index, next === -1 ? match.index + 2500 : next);
      if (/\bmacOS\b/i.test(block)) fromDev.push(decodeHtml(match[1]));
    }
    macFonts = uniqueSorted([...macFonts, ...fromDev]);
    if (macFonts.length < 1000) {
      throw new Error(`macOS font catalog too small: ${macFonts.length}`);
    }
  }
  if (phones.length < 300) throw new Error(`Android phone catalog too small: ${phones.length}`);
  if (tablets.length < 30) throw new Error(`Android tablet catalog too small: ${tablets.length}`);

  const output = renderGenerated({
    windowsFonts,
    macFonts,
    linuxFonts,
    androidPhones: phones,
    androidTablets: tablets,
    webgl,
    retrievedAt,
  });
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, output, 'utf8');
  console.log(
    `generated ${OUT_FILE}: ${windowsFonts.length} Windows fonts, ${macFonts.length} macOS fonts, ${linuxFonts.length} Linux fonts, ${phones.length} Android phones, ${tablets.length} Android tablets, ${webgl.windows.length} Windows renderers, ${webgl.macosIntel.length + webgl.macosArm.length} macOS renderers, ${webgl.linux.length} Linux renderers`,
  );
}

await main();
