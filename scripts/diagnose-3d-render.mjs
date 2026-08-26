#!/usr/bin/env node
/**
 * Why does 3D content not render in a Lobium profile?
 *
 * WHY THIS EXISTS. The "3D models do not render on github.com" report could not be reproduced on the
 * Linux build host, because that host has no GPU at all: with llvmpipe/SwiftShader, GitHub's
 * section-intro WebGL mascots render pixel-IDENTICALLY in Lobium and in stock Chrome 152. So the
 * defect lives on the real-GPU path, which only a machine with a real GPU can observe. Rather than
 * guess, this script collects — from the affected machine — the exact evidence that separates the
 * remaining causes:
 *
 *   1. the GPU never came up          -> gpu.featureStatus shows software/disabled
 *   2. the context was never created  -> getContext returns null / creation error
 *   3. the persona over-claims caps   -> advertised MAX_* exceed what the backend can execute
 *   4. the persona advertises an extension the backend does not have -> getExtension() null
 *   5. draws happen but nothing lands -> draw calls > 0 yet the canvas pixels are uniform
 *
 * Each is a different fix, and (3)/(4) are Lobium's own doing while (1) is the host's. Run it on the
 * machine that shows the bug and send back the JSON.
 *
 *   node scripts/diagnose-3d-render.mjs                        # auto-detect engine, no persona
 *   node scripts/diagnose-3d-render.mjs --config <lobium-fp.json>   # with a real profile persona
 *   node scripts/diagnose-3d-render.mjs --engine <chrome|chrome.exe> --out report.json
 *
 * Read-only: it launches a throwaway --user-data-dir and never touches a real profile.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir, homedir, platform } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = flag('out', 'lobium-3d-report.json');
const SHOTS = flag('shots', 'lobium-3d-shots');
const CONFIG = flag('config', null);
const URL_UNDER_TEST = flag('url', 'https://github.com/');

/** Where the product puts the engine on each OS, in the order the launcher would find it. */
function detectEngine() {
  const explicit = flag('engine', process.env.LOBSTER_ENGINE_BINARY);
  if (explicit) return explicit;
  const win = platform() === 'win32';
  const exe = win ? 'chrome.exe' : 'chrome';
  const candidates = win
    ? [
        join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Lobster Browser', 'resources', 'lobium', exe),
        join(process.env.PROGRAMFILES ?? '', 'Lobster Browser', 'resources', 'lobium', exe),
        join(process.env.LOCALAPPDATA ?? '', 'lobster', 'lobium', exe),
      ]
    : [
        '/usr/lib/Lobster Browser/resources/lobium/chrome',
        join(homedir(), '.local/share/lobster/lobium/chrome'),
        join(process.cwd(), 'dist-linux/lobium-runtime/chrome'),
      ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error(`engine not found; pass --engine <path>. Tried:\n  ${candidates.join('\n  ')}`);
}

const ENGINE = detectEngine();
mkdirSync(SHOTS, { recursive: true });
const userDir = mkdtempSync(join(tmpdir(), 'lobium-3d-'));
const PORT = 9000 + Math.floor(Math.random() * 900);

// The product's own GPU policy, so the diagnosis reflects a real launch rather than a bare one.
const gpuArgs = ['--enable-unsafe-swiftshader'];
const args = [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000', '--hide-scrollbars',
  ...gpuArgs,
  ...(CONFIG ? [`--lobium-fp-config=${CONFIG}`] : []),
  'about:blank',
];
console.log(`engine : ${ENGINE}`);
console.log(`persona: ${CONFIG ?? '(none — host values)'}`);
const proc = spawn(ENGINE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = ''; proc.stderr.on('data', (d) => { stderr += d.toString(); });

for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pend = new Map(); const events = [];
  const ready = new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (m) => {
    const x = JSON.parse(m.data);
    if (x.id && pend.has(x.id)) { pend.get(x.id)(x); pend.delete(x.id); } else if (x.method) events.push(x);
  });
  const send = (method, params = {}) => new Promise((res) => { const q = ++id; pend.set(q, res); ws.send(JSON.stringify({ id: q, method, params })); });
  const ex = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    return r.result?.exceptionDetails ? { __error: r.result.exceptionDetails.exception?.description } : r.result?.result?.value;
  };
  return { ws, send, ex, events, ready };
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await page.ready;
await page.send('Runtime.enable'); await page.send('Page.enable'); await page.send('Log.enable');

// ---- 1. Instrument WebGL before any page script runs ---------------------------------------------
await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__gl = { contexts: [], draws: 0, shaderFail: [], linkFail: [], glErrors: [], creationErrors: [], contextLost: 0 };
  const origGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    let r = null, err = null;
    try { r = origGet.call(this, type, attrs); } catch (e) { err = String(e); }
    if (/webgl|webgpu/i.test(type)) window.__gl.contexts.push({ type, ok: !!r, err, cls: (this.className||'').slice(0,60) });
    return r;
  };
  addEventListener('webglcontextcreationerror', e => window.__gl.creationErrors.push(e.statusMessage), true);
  addEventListener('webglcontextlost', () => window.__gl.contextLost++, true);
  const wrap = (proto) => {
    if (!proto) return;
    const cs = proto.compileShader;
    proto.compileShader = function (s) { cs.call(this, s); if (!this.getShaderParameter(s, this.COMPILE_STATUS)) window.__gl.shaderFail.push((this.getShaderInfoLog(s)||'').slice(0,300)); };
    const lp = proto.linkProgram;
    proto.linkProgram = function (p) { lp.call(this, p); if (!this.getProgramParameter(p, this.LINK_STATUS)) window.__gl.linkFail.push((this.getProgramInfoLog(p)||'').slice(0,300)); };
    for (const m of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']) {
      if (!proto[m]) continue; const o = proto[m];
      proto[m] = function (...a) { window.__gl.draws++; const r = o.apply(this, a); const e = this.getError(); if (e && window.__gl.glErrors.length < 30) window.__gl.glErrors.push(m + ' -> 0x' + e.toString(16)); return r; };
    }
  };
  wrap(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  wrap(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
` });

// ---- 2. Advertised caps vs what the backend can actually execute ----------------------------------
await page.send('Page.navigate', { url: 'about:blank' });
await new Promise((r) => setTimeout(r, 1200));
const caps = await page.ex(`(() => {
  const c = document.createElement('canvas'); const gl = c.getContext('webgl');
  if (!gl) return { noWebGL: true, note: 'getContext("webgl") returned null — THIS is the bug' };
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  const P = (n) => gl.getParameter(gl[n]);
  const adv = {
    unmaskedRenderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : null,
    unmaskedVendor: d ? gl.getParameter(d.UNMASKED_VENDOR_WEBGL) : null,
    VERSION: P('VERSION'), SHADING_LANGUAGE_VERSION: P('SHADING_LANGUAGE_VERSION'),
    MAX_TEXTURE_SIZE: P('MAX_TEXTURE_SIZE'), MAX_RENDERBUFFER_SIZE: P('MAX_RENDERBUFFER_SIZE'),
    MAX_CUBE_MAP_TEXTURE_SIZE: P('MAX_CUBE_MAP_TEXTURE_SIZE'),
    MAX_VIEWPORT_DIMS: Array.from(P('MAX_VIEWPORT_DIMS')),
    MAX_VARYING_VECTORS: P('MAX_VARYING_VECTORS'),
    MAX_VERTEX_UNIFORM_VECTORS: P('MAX_VERTEX_UNIFORM_VECTORS'),
    MAX_FRAGMENT_UNIFORM_VECTORS: P('MAX_FRAGMENT_UNIFORM_VECTORS'),
    MAX_TEXTURE_IMAGE_UNITS: P('MAX_TEXTURE_IMAGE_UNITS'),
  };
  const drain = () => { while (gl.getError() !== gl.NO_ERROR) {} };
  const tex = (n) => { drain(); const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const e = gl.getError(); gl.deleteTexture(t); return e === gl.NO_ERROR ? 'OK' : 'GL_ERROR 0x' + e.toString(16); };
  const varying = (n) => { const s = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(s, 'precision mediump float;\\n' + Array.from({length:n},(_,i)=>'varying vec4 v'+i+';').join('\\n') + '\\nvoid main(){' + Array.from({length:n},(_,i)=>'v'+i+'=vec4(0.0);').join('') + 'gl_Position=vec4(0.0);}');
    gl.compileShader(s); const ok = gl.getShaderParameter(s, gl.COMPILE_STATUS);
    const log = ok ? null : (gl.getShaderInfoLog(s)||'').slice(0,160); gl.deleteShader(s); return ok ? 'OK' : 'FAIL ' + log; };
  const supported = gl.getSupportedExtensions();
  return { advertised: adv,
    executable: {
      ['texture@' + adv.MAX_TEXTURE_SIZE]: tex(adv.MAX_TEXTURE_SIZE),
      ['renderbuffer-sized texture@' + adv.MAX_RENDERBUFFER_SIZE]: tex(adv.MAX_RENDERBUFFER_SIZE),
      ['varyings@' + adv.MAX_VARYING_VECTORS]: varying(adv.MAX_VARYING_VECTORS),
    },
    // The two Lobium-specific lies that break a 3D renderer: a cap it cannot honour, and an
    // extension it names but cannot hand out.
    extensionsAdvertisedButNull: supported.filter((n) => gl.getExtension(n) === null),
    supportedExtensionCount: supported.length,
  };
})()`);

// ---- 3. The real page ------------------------------------------------------------------------------
await page.send('Page.navigate', { url: URL_UNDER_TEST });
await new Promise((r) => setTimeout(r, 10000));
await page.ex(`(async () => { const h = document.body.scrollHeight; for (let y = 0; y < h; y += 400) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 150)); } window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 600)); })()`);
await new Promise((r) => setTimeout(r, 3000));

const canvasSel = '.lp-SectionIntroWebGL-canvas';
const count = await page.ex(`document.querySelectorAll('${canvasSel}').length`);
const shots = [];
for (let k = 0; k < (count || 0); k++) {
  const info = await page.ex(`(async () => { const c = document.querySelectorAll('${canvasSel}')[${k}];
    c.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 3000));
    const r = c.getBoundingClientRect();
    const sec = (() => { let n = c; while (n && n !== document.body) { const h = n.querySelector && n.querySelector('h2'); if (h && h.textContent.trim()) return h.textContent.trim().slice(0,50); n = n.parentElement; } return '?'; })();
    return { section: sec, aw: c.width, ah: c.height, px: Math.round(r.left + scrollX), py: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  let file = null;
  if (info.w > 2 && info.h > 2) {
    const s = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: info.px, y: info.py, width: info.w, height: info.h, scale: 2 } });
    if (s.result?.data) { file = join(SHOTS, `mascot-${k}.png`); writeFileSync(file, Buffer.from(s.result.data, 'base64')); }
  }
  shots.push({ ...info, file });
  console.log(`  mascot[${k}] ${info.aw}x${info.ah} "${info.section}" -> ${file ?? 'no capture'}`);
}
const glState = await page.ex(`window.__gl`);

// ---- 4. What does the browser itself think of the GPU? -------------------------------------------
// Asked over CDP's SystemInfo domain rather than by scraping chrome://gpu: that page renders inside a
// shadow root, so its text is not readable from the outside, and opening it would also background the
// page under test (a throttled page never sizes its WebGL canvases, which looks exactly like the bug).
let gpuStatus;
try {
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;
  const info = await browser.send('SystemInfo.getInfo');
  const g = info.result?.gpu ?? {};
  const fs = g.featureStatus ?? {};
  gpuStatus = {
    devices: (g.devices ?? []).map((d) => ({
      vendor: d.vendorId, device: d.deviceId,
      vendorString: d.vendorString, deviceString: d.deviceString,
      driverVendor: d.driverVendor, driverVersion: d.driverVersion,
    })),
    // The line that decides "is 3D actually hardware-accelerated here". Anything other than
    // enabled/enabled_on means real Chrome would use the GPU and we are not.
    webgl: fs.webgl ?? null,
    webgl2: fs.webgl2 ?? null,
    gpuCompositing: fs.gpu_compositing ?? null,
    rasterization: fs.rasterization ?? null,
    videoDecode: fs.video_decode ?? null,
    vulkan: fs.vulkan ?? null,
    featureStatus: fs,
    driverBugWorkarounds: (g.driverBugWorkarounds ?? []).slice(0, 30),
    auxAttributes: g.auxAttributes
      ? { glRenderer: g.auxAttributes.glRenderer, glVendor: g.auxAttributes.glVendor,
          glVersion: g.auxAttributes.glVersion, glResetNotificationStrategy: g.auxAttributes.glResetNotificationStrategy }
      : null,
  };
  browser.ws.close();
} catch (e) {
  gpuStatus = { error: String(e) };
}

const report = {
  when: new Date().toISOString(), platform: platform(), engine: ENGINE,
  browser: version['Browser'], userAgent: version['User-Agent'],
  personaConfig: CONFIG, url: URL_UNDER_TEST,
  gpu: gpuStatus, caps, webgl: glState, mascots: shots,
  // The one-line verdict a human should read first.
  verdict: (() => {
    if (caps?.noWebGL) return 'NO WEBGL CONTEXT — the GPU path is dead; 3D cannot render at all.';
    const wgl = gpuStatus?.webglStatus ?? '';
    if (/software|disabled|unavailable/i.test(wgl))
      return `GPU NOT USED FOR WEBGL (${wgl.trim()}) — real Chrome on this machine uses the GPU, so 3D degrades or blanks. Fix the launch GPU policy, not the fingerprint.`;
    const overclaim = Object.entries(caps?.executable ?? {}).filter(([, v]) => v !== 'OK');
    if (overclaim.length) return `PERSONA OVER-CLAIMS CAPS: ${overclaim.map(([k, v]) => `${k} ${v}`).join('; ')}`;
    if (caps?.extensionsAdvertisedButNull?.length) return `EXTENSIONS ADVERTISED BUT UNAVAILABLE: ${caps.extensionsAdvertisedButNull.join(', ')}`;
    if ((glState?.shaderFail?.length ?? 0) || (glState?.linkFail?.length ?? 0)) return 'SHADER COMPILE/LINK FAILURES — see webgl.shaderFail / webgl.linkFail.';
    if ((glState?.draws ?? 0) === 0) return 'NO DRAW CALLS — the page never rendered; not a GL-capability problem.';
    return `${glState.draws} draw calls, no GL errors — compare mascot PNGs against stock Chrome to judge pixels.`;
  })(),
  stderrTail: stderr.split('\n').filter((l) => /gpu|gl |angle|vulkan|swiftshader/i.test(l)).slice(-20),
};
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nVERDICT: ${report.verdict}`);
console.log(`report  -> ${OUT}\nshots   -> ${SHOTS}/`);
page.ws.close(); proc.kill('SIGTERM');
setTimeout(() => { try { rmSync(userDir, { recursive: true, force: true }); } catch {} process.exit(0); }, 1500);
