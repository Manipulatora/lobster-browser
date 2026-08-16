#!/usr/bin/env node
/**
 * HC-4 deep-WebGL hook probe — proves the native hook is COMPILED and FUNCTIONAL in the Lobium binary,
 * independent of the GPU.
 *
 * Background: PROJECT-STATUS listed HC-4 (getSupportedExtensions / getShaderPrecisionFormat / gl.VERSION
 * / gl.SHADING_LANGUAGE_VERSION) as "not compiled into the binary". Build-state audit showed the hooks
 * ARE applied to webgl_rendering_context_base.cc and its object + libblink_modules.so were rebuilt after
 * the patch, and `autoninja -n chrome` reports nothing to do. This probe closes the loop empirically: it
 * feeds DISTINCTIVE sentinel HC-4 values through the config channel and asserts a page reads them back.
 *
 * This is a plumbing proof on ANY renderer (SwiftShader is fine — the sentinels are synthetic). It does
 * NOT prove real-GPU coherence; that is what the real-GPU gate (docs/ENGINEERING.md (§4)) is for. What
 * it proves: the compiled binary routes cfg->webgl.{version,shadingLanguageVersion,extensions,
 * shaderPrecision} to JS. If HC-4 were absent, the reads would return host/SwiftShader values and the
 * assertions would fail.
 *
 *   LOBSTER_LOBIUM_BIN=/path/to/chrome node ci/validation/hc4-probe.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveFingerprint } from '@lobster/fingerprint';
import { buildGpuArgs, buildLobiumConfig, lobiumConfigArg, resolveLobiumBinary } from '@lobster/engine-runner';
import { chromium } from 'patchright';

const LOBIUM = process.env.LOBSTER_LOBIUM_BIN || resolveLobiumBinary();

// Distinctive sentinels — no real GPU/driver produces these, so a match can only come from the hook.
const SENTINEL = {
  version: 'WebGL 1.0 (LOBIUM-HC4-VERSION-PROOF)',
  shadingLanguageVersion: 'WebGL GLSL ES 1.0 (LOBIUM-HC4-GLSL-PROOF)',
  extensions: ['LOBIUM_EXT_ALPHA', 'LOBIUM_EXT_BRAVO', 'WEBGL_debug_renderer_info'],
  // Deliberately impossible bucket (a real IEEE highFloat is {127,127,23}).
  highFloat: { rangeMin: 77, rangeMax: 66, precision: 55 },
};

function makePrecisionStage() {
  const f = SENTINEL.highFloat;
  const bucket = { rangeMin: f.rangeMin, rangeMax: f.rangeMax, precision: f.precision };
  return {
    lowFloat: bucket,
    mediumFloat: bucket,
    highFloat: bucket,
    lowInt: bucket,
    mediumInt: bucket,
    highInt: bucket,
  };
}

async function readCdpEndpoint(userDataDir, retries = 200) {
  const file = join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < retries; i++) {
    if (existsSync(file)) {
      const [port, path] = (await readFile(file, 'utf8')).trim().split('\n');
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for DevToolsActivePort');
}

async function main() {
  if (!LOBIUM || !existsSync(LOBIUM)) {
    console.error(`HC4 PROBE: Lobium binary not found (LOBSTER_LOBIUM_BIN=${LOBIUM}).`);
    process.exit(1);
  }
  console.error(`HC4 probe: binary=${LOBIUM}`);

  const fp = deriveFingerprint('hc4-probe-seed', { os: 'windows', engine: 'lobium' });
  fp.webgl = {
    ...fp.webgl,
    version: SENTINEL.version,
    shadingLanguageVersion: SENTINEL.shadingLanguageVersion,
    extensions: SENTINEL.extensions,
    shaderPrecision: { vertex: makePrecisionStage(), fragment: makePrecisionStage() },
  };

  const userDataDir = await mkdtemp(join(tmpdir(), 'hc4-probe-'));
  const cfg = buildLobiumConfig(fp, {});
  const cfgPath = join(userDataDir, 'lobium-fp.json');
  await writeFile(cfgPath, `${JSON.stringify(cfg)}\n`);

  const args = [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    // Chromium's setuid/namespace sandbox is unavailable in many CI/container sandboxes; the sidecar's
    // real launch path keeps the sandbox, this validation probe opts out only to run headless in CI.
    ...(process.env.LOBSTER_HC4_NO_SANDBOX === '0' ? [] : ['--no-sandbox']),
    `--user-data-dir=${userDataDir}`,
    lobiumConfigArg(cfgPath),
    '--remote-debugging-port=0',
    // Software WebGL is fine — the sentinels are synthetic, so any renderer that runs WebGL works.
    ...buildGpuArgs({ mode: 'software' }),
  ];

  const proc = spawn(LOBIUM, args, { stdio: 'ignore' });
  let observed;
  try {
    const ws = await readCdpEndpoint(userDataDir);
    const browser = await chromium.connectOverCDP(ws);
    try {
      const context = browser.contexts()[0] || (await browser.newContext());
      const page = context.pages()[0] || (await context.newPage());
      observed = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) return { error: 'no webgl context' };
        const hf = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
        return {
          version: gl.getParameter(gl.VERSION),
          shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
          extensions: gl.getSupportedExtensions(),
          getExtensionOutsideList: gl.getExtension('OES_texture_float') ? 'non-null' : 'null',
          highFloat: hf ? { rangeMin: hf.rangeMin, rangeMax: hf.rangeMax, precision: hf.precision } : null,
        };
      });
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }

  if (!observed || observed.error) {
    console.error(`HC4 PROBE FAIL: ${observed?.error || 'no observation'}`);
    process.exit(1);
  }

  const checks = [
    ['gl.VERSION', observed.version === SENTINEL.version, observed.version],
    [
      'gl.SHADING_LANGUAGE_VERSION',
      observed.shadingLanguageVersion === SENTINEL.shadingLanguageVersion,
      observed.shadingLanguageVersion,
    ],
    // The two checks below were written before fingerprint/webgl-runtime-safety.patch, and asserting
    // verbatim echo made them report "HC-4 hook is NOT live" on a binary where it demonstrably IS.
    // Runtime-safety deliberately INTERSECTS the configured extension list with what the active
    // backend can actually enable, and CLAMPS precision to what it can deliver, so a synthetic
    // sentinel can never come back untouched. Asserting the pre-patch behaviour tests a contract the
    // engine no longer has - and a gate that cries wolf is worse than no gate.
    [
      // Synthetic names cannot survive the intersection, so what proves the hook is that the ONE
      // real name in the sentinel list survives and nothing from the host leaks in.
      'getSupportedExtensions() ⊆ sentinel list (runtime-safety intersects)',
      Array.isArray(observed.extensions) &&
        observed.extensions.length > 0 &&
        observed.extensions.every((e) => SENTINEL.extensions.includes(e)),
      JSON.stringify(observed.extensions),
    ],
    [
      'getExtension() outside list refused (null)',
      observed.getExtensionOutsideList === 'null',
      observed.getExtensionOutsideList,
    ],
    [
      // rangeMin/rangeMax are pass-through, so they must echo exactly - no real GPU reports 77/66.
      // precision is clamped to the backend, so it may be <= the configured value but must not
      // exceed it.
      'getShaderPrecisionFormat(FRAGMENT, HIGH_FLOAT) == sentinel range, precision clamped',
      observed.highFloat &&
        observed.highFloat.rangeMin === SENTINEL.highFloat.rangeMin &&
        observed.highFloat.rangeMax === SENTINEL.highFloat.rangeMax &&
        observed.highFloat.precision > 0 &&
        observed.highFloat.precision <= SENTINEL.highFloat.precision,
      JSON.stringify(observed.highFloat),
    ],
  ];

  const width = Math.max(...checks.map(([n]) => n.length));
  let failed = 0;
  for (const [name, ok, got] of checks) {
    if (!ok) failed++;
    process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(width)}  got=${got}\n`);
  }
  process.stdout.write('\n');

  if (failed > 0) {
    console.error(
      `HC4 PROBE FAIL: ${failed}/${checks.length} surfaces did not reflect the config — HC-4 hook is NOT live in this binary.`,
    );
    process.exit(1);
  }
  console.log(`HC4 PROBE PASS: ${checks.length}/${checks.length} deep-WebGL surfaces are driven by the config — HC-4 is compiled and functional.`);
}

main().catch((e) => {
  console.error(`HC4 PROBE ERROR: ${e?.stack || e}`);
  process.exit(2);
});
