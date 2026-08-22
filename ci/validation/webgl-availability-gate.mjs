#!/usr/bin/env node
/**
 * WebGL availability gate - the product's launch path must produce a browser that HAS WebGL.
 *
 * WHY THIS EXISTS. Every other WebGL check in this repo asks whether the context reports the right
 * things. None of them asked whether there IS a context. On a host with no usable GPU there was not:
 *
 *     headless (what audit-oracles.mjs runs)   webgl1 true   webgl2 true
 *     headful  (what the product ships)        webgl1 FALSE  webgl2 FALSE
 *
 * Chromium permits the software GL fallback by default in headless and refuses it headful, so the
 * entire oracle suite scored 6/7 on a WebGL context that a real user launching a real profile never
 * had. The bug was invisible precisely because the harness and the product disagreed about a flag.
 *
 * Two consequences, and the second is why this is a gate and not a perf note. No 3D content can run
 * at all. And a browser with no WebGL is not a quieter fingerprint - real Chrome on real hardware
 * always has WebGL, so its absence is a louder headless/VM tell than any renderer string, and it
 * makes the native WebGL moat (webgl-surfaces, host-gpu-profile, webgl2-surfaces, webgpu-adapter)
 * inert, because every one of those hooks a context that is never created.
 *
 * This runs HEADFUL on purpose. A headless run cannot observe the defect.
 *
 *   LOBSTER_LOBIUM_BIN=<path-to-chrome> node ci/validation/webgl-availability-gate.mjs
 *
 * Exit codes: 0 pass, 1 fail (no context, or a software renderer leaked to the page), 2 blocked.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildGpuArgs, isSoftwareRenderer } from '@lobster/engine-runner';
import { withCdpSession, cdpEvaluate } from '../../packages/engine-runner/dist/cdp-client.js';
import { launchEngine } from './e2e/engine.mjs';

const bin = process.env.LOBSTER_LOBIUM_BIN;
if (!bin) {
  console.error('BLOCKED: set LOBSTER_LOBIUM_BIN to the engine binary');
  process.exit(2);
}

/** A minimal but real persona: the gate only needs the engine to take a config and spoof a renderer. */
const PERSONA_RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
const CONFIG = {
  version: 1,
  seeds: { canvas: 1, webgl: 2, audio: 3, clientRects: 4 },
  webgl: {
    vendor: 'Google Inc. (Intel)',
    renderer: PERSONA_RENDERER,
    unmaskedVendor: 'Google Inc. (Intel)',
    unmaskedRenderer: PERSONA_RENDERER,
  },
};

const PROBE = `(() => {
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = 64; return c; };
  const gl = mk().getContext('webgl') || mk().getContext('experimental-webgl');
  const gl2 = mk().getContext('webgl2');
  let renderer = null;
  if (gl) {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }
  return JSON.stringify({ webgl1: !!gl, webgl2: !!gl2, renderer });
})()`;

const dir = await mkdtemp(join(tmpdir(), 'lobium-webgl-gate-'));
const configPath = join(dir, 'lobium-fp.json');
await writeFile(configPath, JSON.stringify(CONFIG), 'utf8');

let engine;
try {
  engine = await launchEngine({
    bin,
    headless: false, // THE POINT OF THIS GATE. Headless hides the defect.
    extraArgs: [`--lobium-fp-config=${configPath}`, ...buildGpuArgs()],
  });
} catch (err) {
  console.error(`BLOCKED: the engine did not start headful - ${err.message}`);
  await rm(dir, { recursive: true, force: true });
  process.exit(2);
}

let result;
try {
  result = JSON.parse(await withCdpSession(engine.ws, (s) => cdpEvaluate(s, PROBE)));
} catch (err) {
  console.error(`BLOCKED: probe did not run - ${err.message}`);
  process.exit(2);
} finally {
  await engine.close?.();
  await rm(dir, { recursive: true, force: true });
}

const failures = [];
if (!result.webgl1) failures.push('canvas.getContext("webgl") returned null');
if (!result.webgl2) failures.push('canvas.getContext("webgl2") returned null');
// The software backend is allowed to BE there; it is not allowed to be VISIBLE.
if (result.renderer && isSoftwareRenderer(result.renderer)) {
  failures.push(`the page can read a software renderer: ${result.renderer}`);
}
if (result.renderer && result.renderer !== PERSONA_RENDERER) {
  failures.push(`renderer is not the persona's: ${result.renderer}`);
}

console.log(`webgl1=${result.webgl1} webgl2=${result.webgl2} renderer=${result.renderer}`);
if (failures.length) {
  console.error('WEBGL AVAILABILITY GATE: FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('WEBGL AVAILABILITY GATE: PASS - headful launch has WebGL 1 + 2 and shows the persona');
