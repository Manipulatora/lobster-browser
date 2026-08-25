#!/usr/bin/env node
/**
 * Windows font-pack registration and fallback-isolation gate.
 *
 * This complements font-isolation-gate.mjs instead of replacing it. That gate proves host-family
 * subtraction with a deliberately tiny persona. This one proves four different contracts against a
 * verified pack:
 *
 *   1. manifest-declared physical families are absent without the pack and present with it;
 *   2. queryLocalFonts() and local(PostScript-name) expose real pack metadata, not invented aliases;
 *   3. claimed CSS families resolve to the configured physical metric clones; and
 *   4. character fallback uses the restricted collection, never the host system fallback.
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

async function inspectEngine(engine, origin, url, physicalFamilies, aliases) {
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

      const physical = {};
      for (const [index] of physicalFamilies.entries()) {
        physical[index] = await platformFonts(session, rootNodeId, `#physical-${index}`);
      }
      const aliasResults = {};
      for (const [index] of aliases.entries()) {
        aliasResults[index] = await platformFonts(session, rootNodeId, `#alias-${index}`);
      }
      return {
        localFonts: local.fonts,
        physical,
        aliases: aliasResults,
        negative: await platformFonts(session, rootNodeId, '#negative-alias'),
        emoji: await platformFonts(session, rootNodeId, '#emoji-fallback'),
      };
    },
    { timeoutMs: 90_000 },
  );
}

async function proveLocalName(engine, origin, postscriptName) {
  await grantLocalFonts(engine.ws, origin);
  return withCdpSession(
    engine.ws,
    async (session) => {
      const source = `local(${JSON.stringify(postscriptName)})`;
      return evaluateWithGesture(
        session,
        `(async () => {
          try {
            const face = new FontFace('LobiumLocalProof', ${JSON.stringify(source)});
            await face.load();
            return { ok: face.status === 'loaded', status: face.status };
          } catch (error) {
            return { ok: false, error: String(error && error.message ? error.message : error) };
          }
        })()`,
      );
    },
    { timeoutMs: 45_000 },
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

  const fullAliasPlan = planFontAliases(
    'windows',
    physicalFamilies,
    manifest.personas.windows.families,
  );
  const aliases = fullAliasPlan.metricCompatible
    .map((claimed) => ({ claimed, physical: fullAliasPlan.aliases[claimed] }))
    .filter((entry) => entry.physical && !['Liberation Sans'].includes(entry.physical));
  blocked(
    aliases.length,
    'the pack has no non-default metric-compatible CSS alias suitable for proof',
  );

  // Physical names are included solely to make their truthful Local Font Access/local() metadata
  // observable in this transport gate. Production personas carry claimed names instead; aliases are
  // CSS-only and deliberately do not manufacture proprietary PostScript or full names.
  const testFonts = [...new Set([...physicalFamilies, ...aliases.map((entry) => entry.claimed)])];
  const testAliases = Object.fromEntries(aliases.map((entry) => [entry.claimed, entry.physical]));
  const baselineConfig = baseConfig(testFonts);
  const packedConfig = {
    ...baseConfig(testFonts),
    fontPackDir: resolve(fontsDir),
    fontAliases: testAliases,
    fontFallbackFamilies: orderFontFallbackFamilies('windows', physicalFamilies),
  };

  const body = [
    ...physicalFamilies.map(
      (family, index) =>
        `<span id="physical-${index}" style="font:72px &quot;${html(family)}&quot;">` +
        'mmmm WWW 0123</span>',
    ),
    ...aliases.map(
      (entry, index) =>
        `<span id="alias-${index}" style="font:72px &quot;${html(entry.claimed)}&quot;">` +
        'mmmm WWW 0123</span>',
    ),
    '<span id="negative-alias" style="font:72px &quot;ZzzLobiumMissingAlias&quot;">' +
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
    const baseline = await inspectEngine(baselineEngine, origin, url, physicalFamilies, aliases);

    packedEngine = await launchEngine({
      bin,
      headless,
      extraArgs: [`--lobium-fp-config=${packedPath}`, ...buildGpuArgs()],
    });
    const packed = await inspectEngine(packedEngine, origin, url, physicalFamilies, aliases);

    const baselineFamilies = new Set(baseline.localFonts.map((font) => lower(font.family)));
    const packedFamilies = new Set(packed.localFonts.map((font) => lower(font.family)));
    assert(
      !baselineFamilies.has(lower('Segoe UI Emoji')),
      'baseline enumeration leaks Segoe UI Emoji',
    );
    assert(!packedFamilies.has(lower('Segoe UI Emoji')), 'packed enumeration leaks Segoe UI Emoji');

    const newFace = packed.localFonts.find(
      (font) =>
        physicalFamilies.some((family) => lower(family) === lower(font.family)) &&
        !baselineFamilies.has(lower(font.family)) &&
        font.postscriptName,
    );
    blocked(
      newFace,
      'this host has no manifest-declared physical face absent from the baseline; registration cannot be distinguished',
    );
    const physicalIndex = physicalFamilies.findIndex(
      (family) => lower(family) === lower(newFace.family),
    );
    assert(
      packed.physical[physicalIndex].some(
        (font) => lower(font.familyName) === lower(newFace.family) && font.glyphCount > 0,
      ),
      `CSS did not render the newly registered physical family ${newFace.family}`,
    );
    assert(
      !baseline.physical[physicalIndex].some(
        (font) => lower(font.familyName) === lower(newFace.family),
      ),
      `baseline CSS unexpectedly rendered pack-only family ${newFace.family}`,
    );

    const [packedLocal, baselineLocal] = await Promise.all([
      proveLocalName(packedEngine, origin, newFace.postscriptName),
      proveLocalName(baselineEngine, origin, newFace.postscriptName),
    ]);
    assert(packedLocal?.ok, `local(${newFace.postscriptName}) did not load from the verified pack`);
    assert(
      !baselineLocal?.ok,
      `local(${newFace.postscriptName}) loaded without the pack; the local() control is not discriminating`,
    );

    const negativeFamilies = new Set(
      packed.negative.filter((font) => font.glyphCount > 0).map((font) => lower(font.familyName)),
    );
    let discriminatingAliases = 0;
    for (const [index, entry] of aliases.entries()) {
      const rendered = packed.aliases[index].filter((font) => font.glyphCount > 0);
      assert(
        rendered.some((font) => lower(font.familyName) === lower(entry.physical)),
        `CSS alias ${entry.claimed} did not render with physical target ${entry.physical}`,
      );
      if (!negativeFamilies.has(lower(entry.physical))) discriminatingAliases += 1;
    }
    assert(
      discriminatingAliases > 0,
      'alias nodes and the unknown-family control used the same fallback; alias evidence is ambiguous',
    );

    const emojiFamilies = packed.emoji
      .filter((font) => font.glyphCount > 0)
      .map((font) => font.familyName);
    assert(
      emojiFamilies.some((family) => lower(family) === lower('Noto Color Emoji')),
      `restricted fallback did not select Noto Color Emoji (observed: ${emojiFamilies.join(', ')})`,
    );
    assert(
      !emojiFamilies.some((family) => lower(family) === lower('Segoe UI Emoji')),
      'character fallback escaped the restricted collection into host Segoe UI Emoji',
    );
    for (const family of emojiFamilies) {
      assert(
        packedFamilies.has(lower(family)),
        `character fallback returned ${family}, which is outside the enumerated restricted collection`,
      );
    }

    console.log(`engine        ${bin}`);
    console.log(`pack          ${manifest.packId} (${manifest.files.length} files)`);
    console.log(`physical      ${physicalFamilies.length} manifest-declared families`);
    console.log(`registered    ${newFace.family} / ${newFace.postscriptName}`);
    console.log(`fallback      ${emojiFamilies.join(', ')}`);
    console.log(
      `metric-compatible CSS aliases: ${fullAliasPlan.metricCompatible.length}; ` +
        `class-fallback residual: ${fullAliasPlan.classFallback.length}`,
    );
    console.log(
      'OK: physical registration, truthful Local Font Access/local(), CSS aliases, and restricted ' +
        'character fallback all proved with baseline controls.',
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
