#!/usr/bin/env node
/**
 * Windows font-pack registration and RENDERER-side fallback gate.
 *
 * This complements font-isolation-gate.mjs instead of replacing it. That gate proves host-family
 * subtraction with a deliberately tiny persona. This one drives a PRODUCTION-SHAPED persona (its
 * `fonts` list is the manifest's claimed Windows families — never a physical pack name like
 * "Liberation Sans" or "Noto Color Emoji") and proves the contracts that only hold once Blink's
 * renderer-side font code accepts the browser's substitution:
 *
 *   1. a claimed metric-compatible family (e.g. Calibri) renders its PACK physical clone (Carlito),
 *      a face the host does not have — proving both pack registration AND that the renderer accepted
 *      the substituted typeface by pack-inventory membership rather than rejecting it by name;
 *   2. a claimed NON-metric family (e.g. Segoe UI) resolves to its class-fallback pack face instead
 *      of the last-resort face (the renderer's TypefacesMatchesFamily check, made alias-aware); and
 *   3. an emoji codepoint gets a real glyph-bearing face (Noto Color Emoji) from the restricted
 *      collection, never host Segoe UI Emoji — the character-fallback path that returned nullptr for
 *      EVERY codepoint before the fix.
 *
 * WHY PRODUCTION SHAPE MATTERS. An earlier revision advertised the physical pack names in `fonts` so
 * their truthful Local Font Access / local() metadata was observable. That silently MASKED this bug:
 * with "Noto Color Emoji" in `fonts`, the renderer's by-name re-resolution passed FontFamilyAllowed
 * and emoji rendered, so a binary missing windows-font-renderer-fallback.patch still went green. A
 * real persona never advertises physical names; this gate now matches that, which is what makes the
 * renderer fix observable at all. (Truthful pack metadata is covered by font-isolation-gate.mjs.)
 *
 * Usage (Windows):
 *   LOBSTER_LOBIUM_BIN=C:\path\to\chrome.exe \
 *   LOBSTER_FONTS_DIR=C:\path\to\verified-pack \
 *   node ci/validation/font-pack-registration-gate.mjs
 *
 * Set LOBSTER_HEADFUL=1 if the host refuses Local Font Access in headless mode. Exit 2 means a
 * prerequisite/permission prevented a meaningful proof; exit 1 means the implementation failed.
 */
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildGpuArgs,
  orderFontFallbackFamilies,
  planFontAliases,
  probeLobiumBuildCapabilities,
  resolveLobiumBinary,
  verifyFontPackFiles,
  withCdpSession,
} from '@lobster/engine-runner';
import { launchEngine } from './e2e/engine.mjs';

class BlockedError extends Error {}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const blocked = (condition, message) => {
  if (!condition) throw new BlockedError(message);
};
const lower = (value) => value.toLocaleLowerCase('en-US');
const truthy = (value) => /^(1|true|yes|on)$/i.test(value ?? '');
const html = (value) =>
  String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function baseConfig(fonts) {
  return {
    version: 1,
    arch: 'x86_64',
    navigator: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      platform: 'Win32',
      languages: ['en-US', 'en'],
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 0,
      uaPlatform: 'Windows',
      uaPlatformVersion: '15.0.0',
      uaMobile: false,
    },
    screen: { width: 1920, height: 1080, colorDepth: 24, devicePixelRatio: 1 },
    webgl: {
      unmaskedVendor: 'Google Inc. (NVIDIA)',
      unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, D3D11)',
    },
    locale: {
      timezone: 'America/New_York',
      locale: 'en-US',
      acceptLanguage: 'en-US,en;q=0.9',
    },
    fonts,
    seeds: { canvas: 0, webgl: 0, audio: 0, clientRects: 0, mediaDevices: 1 },
    policy: {},
    net: {},
  };
}

async function evaluateWithGesture(session, expression) {
  const response = await session.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    { timeoutMs: 30_000 },
  );
  if (response?.exceptionDetails) {
    const detail =
      response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text ??
      'unknown page exception';
    throw new Error(`Runtime.evaluate failed: ${detail}`);
  }
  return response?.result?.value;
}

async function waitForReady(session) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await evaluateWithGesture(session, 'document.readyState');
    if (state === 'complete') return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('test page did not reach document.readyState=complete');
}

async function grantLocalFonts(browserWs, origin) {
  await new Promise((resolveGrant, rejectGrant) => {
    const socket = new WebSocket(browserWs);
    const timer = setTimeout(() => {
      socket.close();
      rejectGrant(new BlockedError('Browser.grantPermissions timed out'));
    }, 15_000);
    const finish = (error) => {
      clearTimeout(timer);
      socket.close();
      if (error) rejectGrant(error);
      else resolveGrant();
    };
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Browser.grantPermissions',
          params: { origin, permissions: ['localFonts'] },
        }),
      );
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      finish(
        message.error
          ? new BlockedError(
              `could not grant Local Font Access permission: ${message.error.message}`,
            )
          : undefined,
      );
    });
    socket.addEventListener('error', () => {
      finish(new BlockedError('browser CDP websocket failed while granting Local Font Access'));
    });
  });
}

async function platformFonts(session, rootNodeId, selector) {
  const match = await session.send('DOM.querySelector', { nodeId: rootNodeId, selector });
  assert(match?.nodeId, `test node ${selector} is absent`);
  const result = await session.send('CSS.getPlatformFontsForNode', { nodeId: match.nodeId });
  return (result?.fonts ?? []).map((font) => ({
    familyName: font.familyName,
    glyphCount: font.glyphCount,
    isCustomFont: font.isCustomFont,
  }));
}

async function inspectEngine(engine, origin, url, aliases) {
  await grantLocalFonts(engine.ws, origin);
  return withCdpSession(
    engine.ws,
    async (session) => {
      await session.send('Page.navigate', { url });
      await waitForReady(session);
      const local = await evaluateWithGesture(
        session,
        `(async () => {
          if (typeof self.queryLocalFonts !== 'function') {
            return { ok: false, error: 'self.queryLocalFonts() is unavailable' };
          }
          try {
            const fonts = await self.queryLocalFonts();
            return {
              ok: true,
              fonts: fonts.map((font) => ({
                family: font.family,
                fullName: font.fullName,
                postscriptName: font.postscriptName,
                style: font.style,
              })),
            };
          } catch (error) {
            return { ok: false, error: String(error && error.message ? error.message : error) };
          }
        })()`,
      );
      blocked(local?.ok, `Local Font Access did not yield evidence: ${local?.error ?? 'unknown'}`);

      await session.send('DOM.enable');
      await session.send('CSS.enable');
      const document = await session.send('DOM.getDocument', { depth: -1, pierce: true });
      const rootNodeId = document?.root?.nodeId;
      assert(rootNodeId, 'CDP did not return a document root');

      const aliasResults = {};
      for (const [index] of aliases.entries()) {
        aliasResults[index] = await platformFonts(session, rootNodeId, `#alias-${index}`);
      }

      // The `local()` surface, proved NEGATIVELY — which is the only shape it can take under a
      // production persona.
      //
      // An earlier revision advertised the physical pack names in `fonts` and proved that
      // `local("NotoColorEmoji")` LOADS. That was backwards: it asserted as a feature the very
      // condition that masked the renderer-fallback bug. A real persona never claims a pack face,
      // so the correct contract is the opposite one — `@font-face { src: local(<pack PostScript
      // name>) }` must FAIL to load, because a page that can name the shared open pack by its
      // PostScript name has identified the product regardless of which OS the persona claims.
      // `queryLocalFonts()` above covers enumeration; this covers the un-permissioned CSS path,
      // which is the one a real fingerprinter reaches for.
      const packPostScriptName = 'NotoColorEmoji';
      const localProbe = await evaluateWithGesture(
        session,
        `(async () => {
          try {
            const face = new FontFace(
              'LobiumPackLeakProbe',
              ${JSON.stringify(`local(${JSON.stringify(packPostScriptName)})`)},
            );
            await face.load();
            return { loaded: face.status === 'loaded', status: face.status };
          } catch (error) {
            return { loaded: false, status: String(error && error.name ? error.name : error) };
          }
        })()`,
      );

      return {
        localFonts: local.fonts,
        aliases: aliasResults,
        packLocalProbe: localProbe,
        claimedNonMetric: await platformFonts(session, rootNodeId, '#claimed-nonmetric'),
        emoji: await platformFonts(session, rootNodeId, '#emoji-fallback'),
      };
    },
    { timeoutMs: 90_000 },
  );
}

async function main() {
  blocked(process.platform === 'win32', 'this gate is Windows/DirectWrite-specific');
  const bin = process.env.LOBSTER_LOBIUM_BIN || resolveLobiumBinary();
  blocked(bin, 'set LOBSTER_LOBIUM_BIN to the installed Lobium executable');
  const fontsDir = process.env.LOBSTER_FONTS_DIR;
  blocked(fontsDir, 'set LOBSTER_FONTS_DIR to a verified font-pack root');

  const capabilities = await probeLobiumBuildCapabilities(bin);
  blocked(
    capabilities.capabilities.includes('font-isolation'),
    'the selected binary does not advertise the Windows font-isolation capability',
  );
  const manifest = await verifyFontPackFiles(resolve(fontsDir));
  const fileFamilies = new Set(manifest.files.flatMap((file) => file.families));
  const physicalFamilies = (
    manifest.personas.windows.physicalFamilies ?? manifest.personas.windows.families
  ).filter((family) => fileFamilies.has(family));
  blocked(physicalFamilies.length, 'the manifest has no file-backed Windows physical families');
  blocked(
    physicalFamilies.includes('Noto Color Emoji'),
    'the fallback proof requires manifest-declared Noto Color Emoji',
  );

  // PRODUCTION SHAPE: the persona's `fonts` list is the manifest's CLAIMED Windows families. It must
  // NOT carry a physical pack name — advertising "Noto Color Emoji" or "Liberation Sans" is exactly
  // what masked the renderer fallback bug (the by-name re-resolution then passed FontFamilyAllowed).
  const personaFamilies = manifest.personas.windows.families;
  blocked(personaFamilies?.length, 'the manifest has no production Windows claimed-family list');
  blocked(
    !personaFamilies.includes('Noto Color Emoji'),
    'the claimed-family list advertises the physical emoji face; that re-masks the renderer bug',
  );

  // The full claimed -> physical map exactly as the launcher ships it (metric clones AND class
  // fallback), so a claimed family renders from its pack face and the renderer must accept that
  // substituted typeface by pack-inventory membership.
  const fullAliasPlan = planFontAliases('windows', physicalFamilies, personaFamilies);
  const testAliases = fullAliasPlan.aliases;
  blocked(
    Object.keys(testAliases).length,
    'the pack yields no claimed->physical aliases to prove',
  );

  // Metric-compatible aliases whose physical target is a PACK-ONLY face (Carlito/Caladea/...): the
  // host does not have it, so rendering that exact family proves registration AND that the renderer
  // accepted the substitution instead of rejecting it by name.
  const metricAliases = fullAliasPlan.metricCompatible
    .map((claimed) => ({ claimed, physical: testAliases[claimed] }))
    .filter((entry) => entry.physical && !personaFamilies.includes(entry.physical));
  blocked(
    metricAliases.length,
    'the pack has no metric-compatible alias with a pack-only target to prove registration',
  );

  // A claimed NON-metric family the persona advertises, served by a class-fallback pack face. Its
  // typeface's own family is the physical one, so it exercises the family-name check that fell to
  // last-resort before the fix. Prefer Segoe UI; else the first advertised class-fallback family.
  const claimedNonMetric =
    (personaFamilies.includes('Segoe UI') &&
      fullAliasPlan.classFallback.includes('Segoe UI') &&
      'Segoe UI') ||
    fullAliasPlan.classFallback.find((family) => personaFamilies.includes(family));
  blocked(
    claimedNonMetric,
    'the persona has no advertised class-fallback family to prove non-metric resolution',
  );
  const nonMetricTarget = testAliases[claimedNonMetric];

  const baselineConfig = baseConfig(personaFamilies);
  const packedConfig = {
    ...baseConfig(personaFamilies),
    fontPackDir: resolve(fontsDir),
    fontAliases: testAliases,
    fontFallbackFamilies: orderFontFallbackFamilies('windows', physicalFamilies),
  };

  const body = [
    ...metricAliases.map(
      (entry, index) =>
        `<span id="alias-${index}" style="font:72px &quot;${html(entry.claimed)}&quot;">` +
        'mmmm WWW 0123</span>',
    ),
    `<span id="claimed-nonmetric" style="font:72px &quot;${html(claimedNonMetric)}&quot;">` +
      'mmmm WWW 0123</span>',
    '<span id="emoji-fallback" style="font:72px &quot;Arial&quot;">&#x1F600;</span>',
  ].join('<br>');

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><meta charset="utf-8"><body>${body}</body>`);
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}/`;
  const temp = await mkdtemp(join(tmpdir(), 'lobium-pack-gate-'));
  const baselinePath = join(temp, 'baseline.json');
  const packedPath = join(temp, 'packed.json');
  await Promise.all([
    writeFile(baselinePath, JSON.stringify(baselineConfig), 'utf8'),
    writeFile(packedPath, JSON.stringify(packedConfig), 'utf8'),
  ]);

  const headless = !truthy(process.env.LOBSTER_HEADFUL);
  let baselineEngine;
  let packedEngine;
  try {
    baselineEngine = await launchEngine({
      bin,
      headless,
      extraArgs: [`--lobium-fp-config=${baselinePath}`, ...buildGpuArgs()],
    });
    const baseline = await inspectEngine(baselineEngine, origin, url, metricAliases);

    packedEngine = await launchEngine({
      bin,
      headless,
      extraArgs: [`--lobium-fp-config=${packedPath}`, ...buildGpuArgs()],
    });
    const packed = await inspectEngine(packedEngine, origin, url, metricAliases);

    // (P4) Enumeration privacy: the host emoji face never leaks, with or without the pack.
    const baselineFamilies = new Set(baseline.localFonts.map((font) => lower(font.family)));
    const packedFamilies = new Set(packed.localFonts.map((font) => lower(font.family)));
    assert(
      !baselineFamilies.has(lower('Segoe UI Emoji')),
      'baseline enumeration leaks Segoe UI Emoji',
    );
    assert(!packedFamilies.has(lower('Segoe UI Emoji')), 'packed enumeration leaks Segoe UI Emoji');

    // (P4b) The same privacy boundary on the CSS `local()` path, which needs no permission and is
    // therefore the one a fingerprinter actually uses. The pack's own PostScript name must not
    // resolve: a page that can load "NotoColorEmoji" by name has identified the shared open pack,
    // and with it the product, whatever OS the persona claims.
    assert(
      !packed.packLocalProbe?.loaded,
      "src: local('NotoColorEmoji') resolved under a production persona; the physical font pack " +
        `is nameable by a page and the isolation boundary is open (status: ${
          packed.packLocalProbe?.status ?? 'unknown'
        })`,
    );

    // (P1) Metric-compatible claimed family renders its PACK-ONLY physical clone. Under the bug the
    // renderer rejected the substituted typeface by name and fell to last-resort, so the exact pack
    // family never appeared. Baseline (no pack) rendering something OTHER than that pack family is
    // the registration control.
    let provenRegistrations = 0;
    for (const [index, entry] of metricAliases.entries()) {
      const rendered = packed.aliases[index].filter((font) => font.glyphCount > 0);
      assert(
        rendered.some((font) => lower(font.familyName) === lower(entry.physical)),
        `claimed ${entry.claimed} did not render its pack face ${entry.physical}; the renderer ` +
          'rejected the browser substitution by family name (missing windows-font-renderer-fallback.patch?)',
      );
      const baselineRendered = baseline.aliases[index] ?? [];
      if (!baselineRendered.some((font) => lower(font.familyName) === lower(entry.physical))) {
        provenRegistrations += 1;
      }
    }
    assert(
      provenRegistrations > 0,
      'every alias target also rendered without the pack; pack registration is not distinguished',
    );

    // (P2) A claimed NON-metric family resolves to its class-fallback PACK face, not the last-resort
    // face. Asserting the exact physical target (a pack-only family the host lacks) is what makes
    // this catch the bug: last-resort would render SOME glyphs, but never `nonMetricTarget`.
    assert(
      packed.claimedNonMetric.some(
        (font) => lower(font.familyName) === lower(nonMetricTarget) && font.glyphCount > 0,
      ),
      `claimed non-metric family ${claimedNonMetric} did not resolve to its pack face ` +
        `${nonMetricTarget}; the renderer fell to the last-resort face ` +
        '(missing windows-font-renderer-fallback.patch?)',
    );

    // (P3) The emoji codepoint gets a real glyph-bearing face. Under the bug GetDWriteFallbackFamily
    // re-resolved "Noto Color Emoji" by name, failed FontFamilyAllowed, and returned nullptr — no
    // face for the codepoint at all.
    const emojiFaces = packed.emoji.filter((font) => font.glyphCount > 0);
    assert(
      emojiFaces.length > 0,
      'the emoji codepoint got NO glyph-bearing face; character fallback returned nullptr ' +
        '(missing windows-font-renderer-fallback.patch?)',
    );
    const emojiFamilies = emojiFaces.map((font) => font.familyName);
    assert(
      emojiFamilies.some((family) => lower(family) === lower('Noto Color Emoji')),
      `restricted fallback did not select Noto Color Emoji (observed: ${emojiFamilies.join(', ')})`,
    );
    assert(
      !emojiFamilies.some((family) => lower(family) === lower('Segoe UI Emoji')),
      'character fallback escaped the restricted collection into host Segoe UI Emoji',
    );

    console.log(`engine        ${bin}`);
    console.log(`pack          ${manifest.packId} (${manifest.files.length} files)`);
    console.log(`persona       ${personaFamilies.length} claimed families (production-shaped)`);
    console.log(`registered    ${provenRegistrations}/${metricAliases.length} pack-only alias targets`);
    console.log(`non-metric    ${claimedNonMetric} -> ${nonMetricTarget}`);
    console.log(`emoji face    ${emojiFamilies.join(', ')}`);
    console.log(
      `metric-compatible CSS aliases: ${fullAliasPlan.metricCompatible.length}; ` +
        `class-fallback residual: ${fullAliasPlan.classFallback.length}`,
    );
    console.log(
      'OK: renderer accepts browser font substitutions (metric + class-fallback) and emoji character ' +
        'fallback renders a face, all under a production-shaped persona.',
    );
  } finally {
    await packedEngine?.close().catch(() => {});
    await baselineEngine?.close().catch(() => {});
    server.close();
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  if (error instanceof BlockedError) {
    console.error(`BLOCKED: ${error.message}`);
    process.exit(2);
  }
  console.error(`FAIL: ${error.stack ?? error}`);
  process.exit(1);
});
