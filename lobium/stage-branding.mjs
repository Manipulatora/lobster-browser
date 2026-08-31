#!/usr/bin/env node
/**
 * BUILD-TIME brand STAGER. Deterministic, Playwright-free, idempotent. Run at build time, once, on a
 * freshly patched Chromium checkout.
 *
 *   node lobium/stage-branding.mjs <CHROMIUM_SRC>
 *
 * WHY THIS EXISTS
 * A clean checkout + build kept shipping STOCK Chromium branding — the tab still showed the Chromium
 * ball, `chrome --version` printed "Chromium", chrome://version said "The Chromium Authors". The
 * renderer that produced the Lobium art (scripts/apply-lobium-branding.mjs) wrote straight into a
 * live Chromium tree and committed NOTHING, and no build path ever invoked it; even hand-running it
 * was undone by build.ps1's `git checkout -- .`. So branding never survived to the build.
 *
 * The fix is a split. Rendering is a rare DESIGN-time step (Playwright, canvas, ICO assembly) that
 * writes the COMMITTED overlay under lobium/branding/. Staging — THIS script — is a BUILD-time step
 * that copies that committed overlay into the checkout and applies the text transforms, with no
 * Playwright, so it can be a hard prerequisite of every reproducible build. build.sh and build.ps1
 * call it AFTER their clean+patch steps, so nothing reverts it.
 *
 * WHAT IT DOES (all idempotent — safe to run twice):
 *   a. copies every file under lobium/branding/overlay/ into the checkout at its mirrored path
 *      (product_logo_* rasters, the linux .xpm, the chrome://version logos, the Windows chrome.ico),
 *   b. copies lobium/branding/BRANDING over chrome/app/theme/chromium/BRANDING (so version_info reads
 *      "Lobium" — branding_path_component stays "chromium" and we overwrite those files),
 *   c. runs the product-name string transforms over the branding .grd/.grdp files, EXTENDED to
 *      components/components_chromium_strings.grd (the chrome://version "Chromium logo" alt-text and
 *      the "Chromium is made possible by the Chromium open source project" license line),
 *   d. stages the NTP brand icons and re-asserts the NTP html/css/logo transforms.
 *
 * NOTE on (d): branding/ntp-branding.patch already applies the NTP source transforms during the
 * quilt/patch step that runs before this script, so these transforms are a guarded SAFETY NET here —
 * every one no-ops when its marker is already present. What is NOT redundant is copying the icon
 * PNGs: build.sh never staged them, and the patch adds all four to the icons BUILD.gn input_files, so
 * gn/ninja fail outright if they are not on disk.
 */
import { mkdir, readFile, writeFile, copyFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const OVERLAY_DIR = resolve(REPO_ROOT, 'lobium/branding/overlay');
const BRANDING_SRC = resolve(REPO_ROOT, 'lobium/branding/BRANDING');
const NTP_ICON_DIR = resolve(REPO_ROOT, 'lobium/assets/ntp-icons');

const CHROMIUM_SRC = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!CHROMIUM_SRC) {
  console.error('usage: node lobium/stage-branding.mjs <CHROMIUM_SRC>');
  process.exit(2);
}
if (!existsSync(resolve(CHROMIUM_SRC, '.gn'))) {
  console.error(`error: ${CHROMIUM_SRC} does not look like a Chromium checkout (no .gn).`);
  process.exit(2);
}

async function ensureDir(path) {
  await mkdir(dirname(path), { recursive: true });
}

async function copyInto(srcFile, dstFile) {
  await ensureDir(dstFile);
  await copyFile(srcFile, dstFile);
}

// Recursively walk a directory, yielding absolute file paths.
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function replaceInFile(path, transforms) {
  if (!existsSync(path)) return false;
  let text = await readFile(path, 'utf8');
  const before = text;
  for (const [pattern, replacement] of transforms) {
    text = text.replace(pattern, replacement);
  }
  if (text !== before) {
    await writeFile(path, text, 'utf8');
    return true;
  }
  return false;
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

// (a) Mirror the committed overlay into the checkout.
async function stageOverlay() {
  if (!existsSync(OVERLAY_DIR)) {
    throw new Error(
      `Missing committed overlay at ${OVERLAY_DIR}. Regenerate it with ` +
        '`node scripts/apply-lobium-branding.mjs` (design-time, needs Playwright).',
    );
  }
  let count = 0;
  for await (const src of walk(OVERLAY_DIR)) {
    const rel = relative(OVERLAY_DIR, src);
    await copyInto(src, resolve(CHROMIUM_SRC, rel));
    count += 1;
  }
  console.log(`  overlay: staged ${count} binary asset(s) into the checkout`);
}

// (b) The Lobium BRANDING — what version_info compiles into `chrome --version` and chrome://version.
async function stageBranding() {
  if (!existsSync(BRANDING_SRC)) {
    throw new Error(`Missing ${BRANDING_SRC}. Regenerate it with scripts/apply-lobium-branding.mjs.`);
  }
  await copyInto(BRANDING_SRC, resolve(CHROMIUM_SRC, 'chrome/app/theme/chromium/BRANDING'));
  console.log('  BRANDING: chrome/app/theme/chromium/BRANDING -> Lobium');
}

// (c) User-visible product-name strings. SURGICAL: only the product-name tokens are replaced. The
// tokens are capitalised ("Chrome"/"Chromium"/"Google Chrome") so they never touch the ALL-CAPS
// message/ph identifiers (IDS_..._CHROMIUM, BEGIN_LINK_CHROMIUM), lowercase URLs (chromium.org,
// chrome://…) or any structural XML — only translator-facing desc text and message bodies change.
const NAME_TRANSFORMS = [
  [/\bGoogle Chrome\b/g, 'Lobium'],
  [/\bChrome\b/g, 'Lobium'],
  [/\bChromium\b/g, 'Lobium'],
  // Earlier passes used "Lobster" as the product name; normalize to Lobium.
  [/\bLobster for Testing\b/g, 'Lobium for Testing'],
  [/\bLobster\b/g, 'Lobium'],
];

// A NARROWER transform for the long tail of string files below. It rewrites ONLY "Chromium" — never
// "Chrome" or "Google Chrome".
//
// That asymmetry is deliberate and is the documented product decision: "Chromium" is our own engine
// identity and must never be user-visible, whereas a bare "Chrome"/"Google" in these files is usually
// a genuine third-party reference we WANT left alone (the real Chrome Web Store, "Search Google or
// type a URL", Google Password Manager, Google Wallet). Rewriting those would misname other people's
// products; rewriting "Chromium" never can.
const CHROMIUM_ONLY_TRANSFORMS = [[/\bChromium\b/g, 'Lobium']];

// The files that leak a LITERAL "Chromium" into shipped desktop UI. Every one of these strings sits
// in a `<if expr="not _google_chrome">` / `*_NON_BRANDED` branch — which is exactly the branch this
// engine compiles — so before this list they reached real users: "Relaunch Chromium" in the password
// bubble, "Chromium cannot verify these certificates" on the SSL interstitial, "Autofill this card
// for purchases made in Chromium".
//
// Deliberately EXCLUDED, having been checked one by one: chrome/app/generated_resources.grd and
// chrome/app/settings_strings.grdp (their only hits are <ex> translator hints, never shipped),
// components/metrics/server_urls.grd and components/policy/resources/policy_templates*.grd (file
// header comments only).
const CHROMIUM_ONLY_FILES = [
  'chrome/app/password_manager_ui_strings.grdp',
  'components/privacy_sandbox_strings.grd',
  'components/page_info_strings.grdp',
  'components/search_engine_choice_strings.grdp',
  'components/autofill_strings.grdp',
  'components/autofill_payments_strings.grdp',
  'components/security_interstitials_strings.grdp',
  'components/password_manager_strings.grdp',
  'components/ssl_errors_strings.grdp',
  'components/reset_password_strings.grdp',
  'components/new_or_sad_tab_strings.grdp',
  'components/management_strings.grdp',
  'components/components_google_chrome_strings.grd',
  // Outside chrome/ and components/: the external-install prompts ("Another program on your computer
  // added an extension that may change the way Chromium works.", "Remove from Chromium").
  'extensions/strings/extensions_chromium_strings.grdp',
];

async function stageStrings() {
  // Full product-name rewrite: these four+1 files exist purely to name the product.
  const files = [
    'chrome/app/chromium_strings.grd',
    'chrome/app/settings_chromium_strings.grdp',
    'chrome/app/google_chrome_strings.grd',
    'chrome/app/settings_google_chrome_strings.grdp',
    // Extended: holds the chrome://version logo alt-text and the license/"made possible by" line.
    'components/components_chromium_strings.grd',
  ];
  for (const file of files) {
    const changed = await replaceInFile(resolve(CHROMIUM_SRC, file), NAME_TRANSFORMS);
    console.log(`  strings: ${file} ${changed ? '-> Lobium' : '(already Lobium / no tokens)'}`);
  }

  // Chromium-only rewrite across the long tail of shipped UI strings.
  let touched = 0;
  for (const file of CHROMIUM_ONLY_FILES) {
    if (await replaceInFile(resolve(CHROMIUM_SRC, file), CHROMIUM_ONLY_TRANSFORMS)) touched += 1;
  }
  console.log(
    `  strings: Chromium-only pass over ${CHROMIUM_ONLY_FILES.length} shipped-UI file(s), ${touched} rewritten`,
  );
}

// (c2) Windows install_static display names.
//
// chrome/install_static/chromium_install_modes.h mixes two very different kinds of constant, and only
// one of them may be rewritten:
//
//   DISPLAY (rewritten here) - base_app_name, and the two ProgID *descriptions* that Windows shows in
//   Explorer's "Open with" list and the file-properties dialog ("Chromium HTML Document").
//
//   IDENTITY (deliberately LEFT ALONE) - base_app_id is the AppUserModelId, which owns taskbar
//   pinning identity; kProductPathName is a component of the install and USER DATA directory path, so
//   changing it orphans every existing profile; browser_prog_id_prefix / pdf_prog_id_prefix are the
//   registry KEY names behind the file associations; direct_launch_url_scheme is a URL scheme; and
//   kSafeBrowsingName is a network-visible client identifier sent to the Safe Browsing service -
//   giving an anti-detect browser its own unique value there would be a fingerprinting regression,
//   not a branding win. Every one of those is a product decision with migration consequences and is
//   NOT something a branding pass may change silently.
//
// Windows-only: this header is not compiled on Linux, so the rewrite can be verified as staged text
// here but its visual effect only appears in a Windows build.
async function stageWindowsInstallModes() {
  const file = 'chrome/install_static/chromium_install_modes.h';
  const changed = await replaceInFile(resolve(CHROMIUM_SRC, file), [
    // Anchored on the field name: base_app_id on the very next line holds the identical literal
    // L"Chromium" and must NOT be touched.
    [/(\.base_app_name\s*=\s*)L"Chromium"/, '$1L"Lobium"'],
    [/L"Chromium HTML Document"/, 'L"Lobium HTML Document"'],
    [/L"Chromium PDF Document"/, 'L"Lobium PDF Document"'],
  ]);
  console.log(
    `  install_static: ${file} ${changed ? '-> Lobium display names (identity keys untouched)' : '(already Lobium / absent)'}`,
  );
}

// (d) NTP brand icons + the html/css/logo transforms. The icon COPY is the load-bearing part; the
// source transforms are a guarded safety net (branding/ntp-branding.patch normally applies them
// before this script runs, so each guard no-ops).
async function stageNtp() {
  // --- icon PNGs (must be on disk; the patch's BUILD.gn input_files reference them) ---
  const ntpIconDst = resolve(CHROMIUM_SRC, 'chrome/browser/resources/new_tab_page/icons');
  const wanted = [
    'lobium_master.png',
    'lobster_ad.png',
    'lobster_wordmark.png',
    'lobster_wordmark_horizontal.png',
  ];
  for (const name of wanted) {
    const src = resolve(NTP_ICON_DIR, name);
    if (!existsSync(src)) throw new Error(`Missing NTP brand icon: ${src}`);
    await copyInto(src, resolve(ntpIconDst, name));
  }
  console.log(`  ntp: staged ${wanted.length} brand icon(s)`);

  // --- logo.html: brand image above the search box (guard on the img marker) ---
  const logoHtmlPath = resolve(CHROMIUM_SRC, 'chrome/browser/resources/new_tab_page/logo.html');
  if (existsSync(logoHtmlPath)) {
    const cur = await readFile(logoHtmlPath, 'utf8');
    if (!cur.includes('id="logoImage"')) {
      const logoHtml = [
        '${this.showLogo_ ? html`',
        '  <div id="logo" aria-label="Lobster Browser">',
        '    <img id="logoImage" src="icons/lobium_master.png" alt="Lobster Browser" draggable="false">',
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
      await writeFile(logoHtmlPath, logoHtml, 'utf8');
      console.log('  ntp: logo.html -> brand image (safety net; patch normally owns this)');
    } else {
      console.log('  ntp: logo.html (already branded)');
    }
  }

  // --- logo.css: display the wordmark image (guard on #logoImage) ---
  const logoCssPath = resolve(CHROMIUM_SRC, 'chrome/browser/resources/new_tab_page/logo.css');
  if (existsSync(logoCssPath) && !(await readFile(logoCssPath, 'utf8')).includes('#logoImage')) {
    await replaceInFile(logoCssPath, [
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
    console.log('  ntp: logo.css -> wordmark image (safety net)');
  }

  // --- app.html: brand ad under the search box (guard on the marker id) ---
  const appHtmlPath = resolve(CHROMIUM_SRC, 'chrome/browser/resources/new_tab_page/app.html');
  if (existsSync(appHtmlPath)) {
    let appHtml = await readFile(appHtmlPath, 'utf8');
    if (!appHtml.includes('id="lobiumSubBrand"')) {
      appHtml = appHtml.replace(
        /(\n {2}<\/div>\n)( {2}\$\{this\.lazyRender_ && this\.ntpNextFeaturesEnabled_)/,
        `$1  <!-- Lobster Browser ad directly under the search box. -->\n  <div id="lobiumSubBrand" ?hidden="\${!this.logoEnabled_}">\n    <img src="icons/lobster_ad.png" alt="Lobster Browser for multiple profile management" draggable="false">\n  </div>\n$2`,
      );
      await writeFileIfChanged(appHtmlPath, appHtml);
      console.log('  ntp: app.html -> brand ad (safety net)');
    }
  }

  // --- app.css: styling for the brand ad (guard on the selector) ---
  const appCssPath = resolve(CHROMIUM_SRC, 'chrome/browser/resources/new_tab_page/app.css');
  if (existsSync(appCssPath)) {
    let appCss = await readFile(appCssPath, 'utf8');
    if (!appCss.includes('#lobiumSubBrand')) {
      appCss +=
        '\n/* Lobster Browser ad directly under the search box. */\n' +
        '#lobiumSubBrand {\n  display: flex;\n  justify-content: center;\n  align-items: center;\n' +
        '  margin: 4px auto 16px;\n  width: var(--ntp-search-box-width, min(337px, 80vw));\n}\n' +
        '#lobiumSubBrand[hidden] {\n  display: none;\n}\n' +
        '#lobiumSubBrand img {\n  display: block;\n  width: 100%;\n  height: auto;\n' +
        '  max-width: var(--ntp-search-box-width, min(337px, 80vw));\n  object-fit: contain;\n' +
        '  user-select: none;\n  -webkit-user-drag: none;\n}\n';
      await writeFileIfChanged(appCssPath, appCss);
      console.log('  ntp: app.css -> brand ad styling (safety net)');
    }
  }

  // --- icons/BUILD.gn: ensure the brand icons are grd inputs (guard per-asset) ---
  const iconsBuildGn = resolve(ntpIconDst, 'BUILD.gn');
  if (existsSync(iconsBuildGn)) {
    let gn = await readFile(iconsBuildGn, 'utf8');
    let touched = false;
    for (const asset of wanted) {
      if (!gn.includes(`"${asset}"`)) {
        gn = gn.replace('input_files = [', `input_files = [\n    "${asset}",`);
        touched = true;
      }
    }
    if (touched) {
      await writeFile(iconsBuildGn, gn, 'utf8');
      console.log('  ntp: icons/BUILD.gn -> brand icons added to input_files (safety net)');
    }
  }
}

async function main() {
  console.log(`Staging Lobium branding into ${CHROMIUM_SRC}`);
  await stageOverlay();
  await stageBranding();
  await stageStrings();
  await stageWindowsInstallModes();
  await stageNtp();
  console.log('Lobium branding staged. Rebuild to ship it.');
}

await main();
