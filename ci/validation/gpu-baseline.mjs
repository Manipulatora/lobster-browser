#!/usr/bin/env node
// Real-GPU baseline capture (roadmap RG-1).
//
// Launches a Chromium-family engine on the physical GPU (no SwiftShader) and archives the true deep
// fingerprint surfaces a detector reads: WebGL vendor/renderer/unmasked, extensions, caps, shader
// precision, GL/GLSL version strings, canvas hash, WebGL pixel hash, audio hash, UA/UA-CH, and WebRTC.
// It records whether the run actually used hardware (vs SwiftShader/llvmpipe) so a false baseline can
// never be mistaken for real-GPU evidence.
//
// This intentionally does NOT require the native Lobium binary: it measures the ENGINE + GPU pipeline
// (the RG-0 unknown: "is the browser using the physical GPU?"). Point it at Lobium once built via
// LOBSTER_LOBIUM_BIN; otherwise it uses the interim patched Chromium (patchright) as the stand-in.
//
//   LOBSTER_GPU=gpu LOBSTER_ANGLE_BACKEND=vulkan node ci/validation/gpu-baseline.mjs [seed]

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';


/**
 * Navigate, tolerating the browser finishing its OWN startup navigation first.
 *
 * The engine is launched with `about:blank`, but Chromium can still navigate to
 * `chrome://new-tab-page/` shortly AFTER the first page target appears. A goto issued the moment the
 * target exists then dies with "interrupted by another navigation to chrome://new-tab-page/".
 * Measured: 3 of 38 persona launches (~8%) across windows/macos, and it is what makes
 * gpu-baseline.mjs exit 3 intermittently. The interruption is the browser settling, not a failure of
 * the navigation we asked for, so retry it rather than scoring the persona as broken.
 */
async function gotoSettled(page, url, opts) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.goto(url, opts);
    } catch (err) {
      lastError = err;
      if (!/interrupted by another navigation/i.test(String(err && err.message))) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError;
}

import { deriveFingerprint, generateSeed } from '@lobster/fingerprint';
import {
  buildDevShmArgs,
  buildGpuArgs,
  buildHostCalibrationProbeScript,
  buildLaunchOptions,
  isSoftwareRenderer,
  resolveGpuMode,
  resolveLobiumBinary,
} from '@lobster/engine-runner';

const here = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(here, 'reports');

function resolveEngine() {
  const lobium = resolveLobiumBinary();
  if (lobium) return { binary: lobium, engine: 'lobium' };
  const bin = process.env.CHROME_BIN;
  if (bin && existsSync(bin)) return { binary: bin, engine: 'chromium' };
  return { binary: undefined, engine: 'chromium' };
}

async function patchrightChromium() {
  const { chromium } = await import('patchright');
  return chromium;
}

async function readCdpEndpoint(userDataDir, retries = 150) {
  const file = join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < retries; i += 1) {
    try {
      const [portLine, pathLine] = (await readFile(file, 'utf8')).split('\n');
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && pathLine)
        return `ws://127.0.0.1:${port}${pathLine.trim()}`;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for the CDP endpoint (DevToolsActivePort)');
}

async function measureDeepSurfaces(page) {
  return page.evaluate(async () => {
    const fnv = (s) => {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16);
    };
    // Canvas 2D hash.
    let canvasHash = null;
    try {
      const c = document.createElement('canvas');
      c.width = 240;
      c.height = 60;
      const x = c.getContext('2d');
      x.textBaseline = 'top';
      x.font = "16px 'Arial'";
      x.fillStyle = '#f60';
      x.fillRect(0, 0, 120, 30);
      x.fillStyle = '#069';
      x.fillText('Lobster \u{1F99E} baseline 12345', 2, 18);
      canvasHash = fnv(c.toDataURL());
    } catch {
      /* no 2d */
    }
    // WebGL pixel hash: render a gradient triangle and hash the readback pixels.
    let webglPixelHash = null;
    try {
      const gc = document.createElement('canvas');
      gc.width = 128;
      gc.height = 128;
      const gl = gc.getContext('webgl') || gc.getContext('experimental-webgl');
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(
        vs,
        'attribute vec2 p;varying vec2 v;void main(){v=p;gl_Position=vec4(p,0.0,1.0);}',
      );
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(
        fs,
        'precision mediump float;varying vec2 v;void main(){gl_FragColor=vec4(v*0.5+0.5,0.5,1.0);}',
      );
      gl.compileShader(fs);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-0.8, -0.8, 0.8, -0.8, 0.0, 0.8]),
        gl.STATIC_DRAW,
      );
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.clearColor(0.1, 0.2, 0.3, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = new Uint8Array(128 * 128 * 4);
      gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let acc = '';
      for (let i = 0; i < px.length; i += 997) acc += px[i].toString(16);
      webglPixelHash = fnv(acc);
    } catch {
      /* no webgl */
    }
    // Audio hash.
    let audioHash = null;
    try {
      const octx = new OfflineAudioContext(1, 5000, 44100);
      const o = octx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 10000;
      const cm = octx.createDynamicsCompressor();
      o.connect(cm);
      cm.connect(octx.destination);
      o.start(0);
      const rendered = await octx.startRendering();
      const ch = rendered.getChannelData(0);
      let s = 0;
      for (let i = 4500; i < 5000; i += 1) s += Math.abs(ch[i]);
      audioHash = s.toFixed(8);
    } catch {
      /* no audio */
    }
    let uaData = { present: false };
    try {
      if (navigator.userAgentData) {
        const high = await navigator.userAgentData.getHighEntropyValues([
          'fullVersionList',
          'uaFullVersion',
          'platformVersion',
          'bitness',
        ]);
        uaData = {
          present: true,
          brands: navigator.userAgentData.brands,
          platform: navigator.userAgentData.platform,
          mobile: navigator.userAgentData.mobile,
          fullVersionList: high.fullVersionList,
          uaFullVersion: high.uaFullVersion,
          platformVersion: high.platformVersion,
          bitness: high.bitness,
        };
      }
    } catch (e) {
      uaData = { present: false, error: String(e).slice(0, 80) };
    }
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory ?? null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      uaData,
      canvasHash,
      webglPixelHash,
      audioHash,
    };
  });
}

async function measureWebrtc(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const cands = [];
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        pc.createDataChannel('p');
        pc.onicecandidate = (e) => (e.candidate ? cands.push(e.candidate.candidate) : null);
        pc.createOffer().then((o) => pc.setLocalDescription(o));
        setTimeout(() => {
          const addr = (c) => (c.split(' ')[4] || '').toLowerCase();
          const isGlobalV6 = (a) => a.includes(':') && /^[23]/.test(a);
          const isPublicV4 = (a) =>
            /^\d+\.\d+\.\d+\.\d+$/.test(a) &&
            !/^(10|127|0|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a);
          const leaks = cands.map(addr).filter((a) => a && (isGlobalV6(a) || isPublicV4(a)));
          resolve({ total: cands.length, publicIps: [...new Set(leaks)].slice(0, 4) });
        }, 4000);
      }),
  );
}

async function main() {
  const gpuMode = resolveGpuMode();
  const { binary, engine } = resolveEngine();
  const seed = process.argv[2] || generateSeed();
  const fp = deriveFingerprint(seed, { os: 'windows', engine });

  const chromium = await patchrightChromium();
  const bin = binary ?? chromium.executablePath();
  if (!bin || !existsSync(bin)) {
    process.stderr.write(
      'No engine binary found. Set LOBSTER_LOBIUM_BIN or CHROME_BIN, or run `npx patchright install chromium`.\n',
    );
    process.exitCode = 2;
    return;
  }

  const userDataDir = await mkdtemp(join(tmpdir(), 'gpu-baseline-'));
  const launch = buildLaunchOptions({
    profileId: 'gpu-baseline',
    engine,
    userDataDir,
    fingerprint: fp,
    headless: true,
  });
  const args = [
    '--headless=new',
    '--no-sandbox',
    ...buildDevShmArgs(),
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    ...launch.args,
  ];
  if (gpuMode === 'gpu' && !args.some((a) => a.startsWith('--use-angle='))) {
    args.push(...buildGpuArgs({ mode: 'gpu' }));
  }
  if (gpuMode !== 'gpu' && !args.some((a) => a.includes('swiftshader'))) {
    args.push('--enable-unsafe-swiftshader');
  }

  const proc = spawn(bin, args, { stdio: 'ignore' });
  let report;
  try {
    const ws = await readCdpEndpoint(userDataDir);
    const browser = await chromium.connectOverCDP(ws);
    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0] ?? (await context.newPage());
      await gotoSettled(page, 'about:blank');
      const host = await page.evaluate(buildHostCalibrationProbeScript());
      const deep = await measureDeepSurfaces(page);
      const webrtc = await measureWebrtc(page);
      const rendererText = `${host.webgl.vendor} ${host.webgl.renderer}`;
      const softwareRenderer = isSoftwareRenderer(rendererText);
      const releaseGateEligible = gpuMode === 'gpu' && !softwareRenderer;
      report = {
        kind: 'gpu-baseline',
        capturedAt: new Date().toISOString(),
        engine,
        binary: bin,
        gpuMode,
        angleBackend: process.env.LOBSTER_ANGLE_BACKEND ?? 'vulkan',
        seed,
        softwareRenderer,
        webgl: {
          vendor: host.webgl.vendor,
          renderer: host.webgl.renderer,
          version: host.webgl.version,
          shadingLanguageVersion: host.webgl.shadingLanguageVersion,
          extensionCount: (host.webgl.extensions || []).length,
          extensions: host.webgl.extensions,
          caps: host.webgl.caps,
          shaderPrecision: host.webgl.shaderPrecision,
        },
        hashes: {
          canvas: deep.canvasHash,
          webglPixel: deep.webglPixelHash,
          audio: deep.audioHash,
        },
        navigator: {
          userAgent: deep.userAgent,
          platform: deep.platform,
          hardwareConcurrency: deep.hardwareConcurrency,
          deviceMemory: deep.deviceMemory,
          timezone: deep.timezone,
          uaData: deep.uaData,
        },
        webrtc,
        provisional: !releaseGateEligible,
        provisionalReason: !releaseGateEligible
          ? 'Software rendering or a non-GPU launch mode can never satisfy the real-GPU release gate.'
          : null,
        releaseGateEligible,
        verdict: releaseGateEligible ? 'ok' : 'provisional',
      };
    } finally {
      await browser.close();
    }
  } finally {
    proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }

  await mkdir(REPORTS_DIR, { recursive: true });
  const stamp = report.capturedAt.replace(/[:.]/g, '-');
  const outPath = join(REPORTS_DIR, `gpu-baseline-${engine}-${stamp}.json`);
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nsaved: ${outPath}\n`);
  if (!report.releaseGateEligible) {
    process.stderr.write(
      '\nWARNING: provisional software/non-GPU baseline — NOT valid real-GPU release evidence.\n',
    );
    if (gpuMode === 'gpu') process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.stack || e}\n`);
  process.exitCode = 3;
});
