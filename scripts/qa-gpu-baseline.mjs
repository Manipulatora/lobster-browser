#!/usr/bin/env node
/**
 * Real-host fingerprint baseline capture (Phase 2 of the 2026-08-26 Windows QA brief).
 *
 * WHY THIS EXISTS. Every detector report in this repo was captured on a software GL backend, which
 * the project's own gate.mjs is written to reject - so the product has never been measured under
 * conditions resembling what it ships into, and every conclusion drawn from those runs is suspect.
 * This captures, per persona and in one browser session, the surfaces that decide whether a profile
 * is coherent:
 *
 *   * chrome://gpu feature status, via CDP SystemInfo.getInfo rather than by scraping the page
 *   * navigator.gpu.requestAdapter() and its adapter info
 *   * requestMediaKeySystemAccess('com.widevine.alpha') - expected to FAIL, see CONTRADICTIONS
 *   * the WebGL cap set, and for each advertised cap whether the backend can execute it
 *   * matchMedia (color:) / (dynamic-range:) / (color-gamut:) against screen.colorDepth
 *   * canPlayType for Dolby Vision, H.264 and AAC
 *   * the persona surfaces a detector reads first: UA, UA-CH, platform, languages, timezone
 *
 * It also evaluates the four CONTRADICTIONS the brief lists as already known, so each run either
 * confirms or refutes them with its own measurement instead of inheriting the claim.
 *
 * Read-only with respect to user data: every launch gets a throwaway --user-data-dir and the persona
 * configs come from scripts/qa-generate-personas.mjs, never from a real profile.
 *
 *   node scripts/qa-gpu-baseline.mjs --personas qa-out/personas-p2 --engine <chrome.exe>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const PERSONAS = resolve(flag('personas', 'qa-out/personas-p2'));
const ENGINE = flag('engine', process.env.LOBSTER_ENGINE_BINARY ?? '');
const OUTDIR = resolve(flag('outdir', 'ci/validation/reports'));
const ONLY = flag('only', '');
const CREEPJS = argv.includes('--creepjs');
const STAMP = flag('stamp', new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z'));

if (!ENGINE || !existsSync(ENGINE)) throw new Error(`engine not found: ${ENGINE || '(unset)'}`);
mkdirSync(OUTDIR, { recursive: true });

const index = JSON.parse(readFileSync(join(PERSONAS, 'index.json'), 'utf8'));
const wanted = ONLY ? index.filter((p) => ONLY.split(',').includes(p.name)) : index;

/** Resolve after `ms`, used instead of bare setTimeout so every wait names itself in a stack. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withDeadline(p, ms, label) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`TIMEOUT ${label} after ${ms}ms`)), ms);
    }),
  ]);
}

/** A CDP connection over Node 22's built-in WebSocket. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  await withDeadline(
    new Promise((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true });
      ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
    }),
    20_000,
    'ws open',
  );
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    withDeadline(
      new Promise((res) => {
        const q = ++id;
        pending.set(q, res);
        ws.send(JSON.stringify({ id: q, method, params }));
      }),
      45_000,
      method,
    );
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.result?.exceptionDetails) {
      return { __error: r.result.exceptionDetails.exception?.description ?? 'evaluate threw' };
    }
    return r.result?.result?.value;
  };
  return { ws, send, evaluate, close: () => ws.close() };
}

/**
 * The whole in-page probe. One evaluate rather than many: every extra round trip is another chance
 * for the page to settle differently, and these surfaces must be read as one consistent snapshot.
 */
const PROBE = `(async () => {
  const out = {};
  const safe = async (fn, fallback = null) => { try { return await fn(); } catch (e) { return { __error: String(e && e.message || e) }; } };

  // ---- persona surfaces a detector reads first -------------------------------------------------
  out.navigator = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    languages: Array.from(navigator.languages || []),
    language: navigator.language,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    maxTouchPoints: navigator.maxTouchPoints,
    webdriver: navigator.webdriver,
    vendor: navigator.vendor,
  };
  out.uaData = await safe(async () => {
    if (!navigator.userAgentData) return null;
    const high = await navigator.userAgentData.getHighEntropyValues([
      'architecture','bitness','model','platformVersion','uaFullVersion','fullVersionList','wow64',
    ]);
    return { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, ...high };
  });
  out.timezone = { resolved: Intl.DateTimeFormat().resolvedOptions().timeZone, offsetMin: new Date().getTimezoneOffset() };

  // ---- screen + the CSS media features that must agree with it --------------------------------
  out.screen = {
    width: screen.width, height: screen.height,
    availWidth: screen.availWidth, availHeight: screen.availHeight,
    availLeft: screen.availLeft, availTop: screen.availTop,
    colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
    devicePixelRatio: window.devicePixelRatio,
  };
  const mq = (q) => matchMedia(q).matches;
  // colorBits: the (color:) feature is bits PER COMPONENT, so 8 <=> a 24-bit screen and 10 <=> 30-bit.
  let colorBits = null;
  for (const n of [16,14,12,10,8,6,5,4,2,1]) { if (mq('(color: ' + n + ')')) { colorBits = n; break; } }
  out.css = {
    colorBits,
    colorGamut: ['rec2020','p3','srgb'].find((g) => mq('(color-gamut: ' + g + ')')) ?? null,
    dynamicRangeHigh: mq('(dynamic-range: high)'),
    dynamicRangeStandard: mq('(dynamic-range: standard)'),
    deviceWidth: mq('(device-width: ' + screen.width + 'px)'),
    deviceHeight: mq('(device-height: ' + screen.height + 'px)'),
    pointerCoarse: mq('(pointer: coarse)'),
    hoverNone: mq('(hover: none)'),
    prefersColorScheme: mq('(prefers-color-scheme: dark)') ? 'dark' : 'light',
  };

  // ---- WebGL: what is advertised, and what the backend can actually execute --------------------
  out.webgl = await safe(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl');
    if (!gl) return { present: false, note: 'getContext("webgl") returned null' };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const P = (n) => { try { const v = gl.getParameter(gl[n]); return ArrayBuffer.isView(v) ? Array.from(v) : v; } catch { return null; } };
    const advertised = {
      unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      VENDOR: P('VENDOR'), RENDERER: P('RENDERER'),
      VERSION: P('VERSION'), SHADING_LANGUAGE_VERSION: P('SHADING_LANGUAGE_VERSION'),
      MAX_TEXTURE_SIZE: P('MAX_TEXTURE_SIZE'), MAX_RENDERBUFFER_SIZE: P('MAX_RENDERBUFFER_SIZE'),
      MAX_CUBE_MAP_TEXTURE_SIZE: P('MAX_CUBE_MAP_TEXTURE_SIZE'),
      MAX_VIEWPORT_DIMS: P('MAX_VIEWPORT_DIMS'),
      MAX_VARYING_VECTORS: P('MAX_VARYING_VECTORS'),
      MAX_VERTEX_UNIFORM_VECTORS: P('MAX_VERTEX_UNIFORM_VECTORS'),
      MAX_FRAGMENT_UNIFORM_VECTORS: P('MAX_FRAGMENT_UNIFORM_VECTORS'),
      MAX_VERTEX_ATTRIBS: P('MAX_VERTEX_ATTRIBS'),
      MAX_TEXTURE_IMAGE_UNITS: P('MAX_TEXTURE_IMAGE_UNITS'),
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: P('MAX_COMBINED_TEXTURE_IMAGE_UNITS'),
      ALIASED_LINE_WIDTH_RANGE: P('ALIASED_LINE_WIDTH_RANGE'),
      ALIASED_POINT_SIZE_RANGE: P('ALIASED_POINT_SIZE_RANGE'),
    };
    const extensions = (gl.getSupportedExtensions() || []).slice().sort();
    // An extension the context NAMES but will not hand over is a hard tell; check every one.
    const advertisedButNull = extensions.filter((e) => { try { return gl.getExtension(e) == null; } catch { return true; } });
    // Executability: allocate at the advertised limit. If the cap is a lie the backend cannot honour,
    // the allocation fails here rather than in a page that was told it would work.
    const canTexture = (size) => { try {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const ok = gl.getError() === gl.NO_ERROR; gl.deleteTexture(t); return ok;
    } catch { return false; } };
    const canRenderbuffer = (size) => { try {
      const rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA4, size, size);
      const ok = gl.getError() === gl.NO_ERROR; gl.deleteRenderbuffer(rb); return ok;
    } catch { return false; } };
    const linksVaryings = (n) => { try {
      const vs = gl.createShader(gl.VERTEX_SHADER);
      const decl = Array.from({length: n}, (_, i) => 'varying vec4 v' + i + ';').join('');
      const assign = Array.from({length: n}, (_, i) => 'v' + i + '=vec4(1.0);').join('');
      gl.shaderSource(vs, decl + 'void main(){' + assign + 'gl_Position=vec4(0.0);}'); gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) return false;
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, 'precision mediump float;' + decl + 'void main(){gl_FragColor=v0;}'); gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return false;
      const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
      return gl.getProgramParameter(p, gl.LINK_STATUS);
    } catch { return false; } };
    const executable = {
      textureAtMax: canTexture(advertised.MAX_TEXTURE_SIZE),
      renderbufferAtMax: canRenderbuffer(advertised.MAX_RENDERBUFFER_SIZE),
      varyingsAtMax: linksVaryings(advertised.MAX_VARYING_VECTORS),
    };
    const gl2c = document.createElement('canvas');
    const gl2 = gl2c.getContext('webgl2');
    const webgl2 = gl2 ? {
      present: true,
      VERSION: gl2.getParameter(gl2.VERSION),
      MAX_VERTEX_UNIFORM_COMPONENTS: gl2.getParameter(gl2.MAX_VERTEX_UNIFORM_COMPONENTS),
      MAX_FRAGMENT_UNIFORM_COMPONENTS: gl2.getParameter(gl2.MAX_FRAGMENT_UNIFORM_COMPONENTS),
      MAX_VARYING_COMPONENTS: gl2.getParameter(gl2.MAX_VARYING_COMPONENTS),
      extensions: (gl2.getSupportedExtensions() || []).slice().sort(),
    } : { present: false };
    return { present: true, advertised, extensions, extensionCount: extensions.length, advertisedButNull, executable, webgl2 };
  });

  // ---- WebGPU ---------------------------------------------------------------------------------
  out.webgpu = await safe(async () => {
    if (!navigator.gpu) return { present: false, reason: 'navigator.gpu is undefined' };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { present: true, adapter: null, reason: 'requestAdapter() returned null' };
    const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
    return {
      present: true,
      adapter: {
        vendor: info?.vendor ?? null, architecture: info?.architecture ?? null,
        device: info?.device ?? null, description: info?.description ?? null,
      },
      isFallbackAdapter: adapter.isFallbackAdapter ?? null,
      featureCount: adapter.features ? adapter.features.size : null,
      limits: adapter.limits ? { maxTextureDimension2D: adapter.limits.maxTextureDimension2D, maxBufferSize: String(adapter.limits.maxBufferSize) } : null,
    };
  });

  // ---- EME / Widevine -------------------------------------------------------------------------
  out.eme = await safe(async () => {
    const cfg = [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4;codecs="avc1.42E01E"' }] }];
    const result = {};
    for (const ks of ['com.widevine.alpha', 'org.w3.clearkey']) {
      try { await navigator.requestMediaKeySystemAccess(ks, cfg); result[ks] = 'RESOLVED'; }
      catch (e) { result[ks] = 'REJECTED: ' + (e && e.name || 'error'); }
    }
    return result;
  });

  // ---- codecs ---------------------------------------------------------------------------------
  out.codecs = await safe(() => {
    const v = document.createElement('video');
    const q = (t) => v.canPlayType(t) || '';
    return {
      dolbyVision_dvh1: q('video/mp4; codecs="dvh1.05.06"'),
      dolbyVision_dvh1_07: q('video/mp4; codecs="dvh1.05.07"'),
      dolbyVision_dvhe: q('video/mp4; codecs="dvhe.05.07"'),
      h264: q('video/mp4; codecs="avc1.42E01E"'),
      hevc: q('video/mp4; codecs="hvc1.1.6.L93.B0"'),
      aac: q('audio/mp4; codecs="mp4a.40.2"'),
      av1: q('video/mp4; codecs="av01.0.08M.08"'),
      vp9: q('video/webm; codecs="vp9"'),
    };
  });

  out.mediaDevices = await safe(async () => {
    const d = await navigator.mediaDevices.enumerateDevices();
    return d.map((x) => ({ kind: x.kind, label: x.label, deviceIdLen: (x.deviceId || '').length, groupIdLen: (x.groupId || '').length }));
  });

  return out;
})()`;

/**
 * The four contradictions the brief says are already known. Evaluated from the captured document so
 * each run states its own verdict rather than inheriting the claim.
 */
function evaluateContradictions(persona, cap) {
  const out = [];
  const isAppleSilicon = persona.os === 'macos' && persona.arch === 'arm64';
  const colorDepth = cap.screen?.colorDepth ?? null;
  const colorBits = cap.css?.colorBits ?? null;

  out.push({
    id: 'colordepth-vs-css-color',
    applies: isAppleSilicon,
    fires: Boolean(isAppleSilicon && colorDepth === 30 && colorBits !== null && colorBits * 3 !== colorDepth),
    detail: `screen.colorDepth=${colorDepth} implies ${colorDepth === null ? '?' : colorDepth / 3} bits/component; CSS (color:) answered ${colorBits}`,
  });

  const widevine = cap.eme?.['com.widevine.alpha'] ?? 'unknown';
  const claimsChromeBrand = Boolean(
    (cap.uaData?.brands ?? []).some((b) => /Google Chrome/i.test(b?.brand ?? '')),
  );
  out.push({
    id: 'widevine-absent-while-claiming-chrome',
    applies: claimsChromeBrand,
    fires: Boolean(claimsChromeBrand && !String(widevine).startsWith('RESOLVED')),
    detail: `Sec-CH-UA claims "Google Chrome": ${claimsChromeBrand}; com.widevine.alpha -> ${widevine}`,
  });

  /*
   * Dolby Vision is baked to the BUILD, not the persona:
   * `enable_platform_dolby_vision = proprietary_codecs && (is_cast_media_device || is_win)`
   * (media/media_options.gni), and no Lobium patch touches media/. The tell is therefore
   * ONE-DIRECTIONAL: a non-Windows persona advertising Dolby Vision is unmasked, because real Chrome
   * on macOS or Linux reports "" for it.
   *
   * An earlier version of this check had the direction inverted and fired on the correct personas.
   * It also only probed dvh1.05.07; engine-audit.md uses dvh1.05.06, and the two are different
   * profile/levels.
   *
   * MEASURED 2026-08-26 on this host: the build reports "" for dvh1.05.06, dvh1.05.07, dvhe.05.06,
   * dvhe.05.07 and dva1.05.06 — and so does stock Chrome 152.0.7977.42 on the same machine, because
   * platform Dolby Vision also needs a host decoder this VM lacks. So the tell cannot be exercised
   * here at all, and a run that reports it clean is reporting that it never looked.
   */
  const dvCandidates = [cap.codecs?.dolbyVision_dvh1, cap.codecs?.dolbyVision_dvhe];
  const dv = dvCandidates.find((value) => value) ?? '';
  if (!dv) {
    out.push({
      id: 'dolby-vision-not-exercised',
      applies: false,
      fires: false,
      detail:
        'the build advertises no Dolby Vision on any string, so the is_win-only codec tell could not ' +
        'be exercised. Stock Chrome on this host reports the same, i.e. the host has no DV decoder.',
    });
  } else {
    out.push({
      id: 'dolby-vision-baked-to-build-os',
      applies: persona.os !== 'windows',
      fires: persona.os !== 'windows',
      detail: `persona os=${persona.os}; Dolby Vision -> ${JSON.stringify(dv)} (real Chrome on ${persona.os} reports "")`,
    });
  }

  const webglRenderer = cap.webgl?.advertised?.unmaskedRenderer ?? '';
  const discreteClaim = /NVIDIA|GeForce|RTX|GTX|Radeon|Arc|Mali|Adreno|Apple M/i.test(webglRenderer);
  const gpuPresent = cap.webgpu?.present === true && cap.webgpu?.adapter != null;
  out.push({
    id: 'webgl-gpu-without-webgpu-adapter',
    applies: discreteClaim,
    fires: Boolean(discreteClaim && !gpuPresent),
    detail: `WebGL claims ${JSON.stringify(webglRenderer.slice(0, 60))}; navigator.gpu adapter ${gpuPresent ? 'present' : JSON.stringify(cap.webgpu?.reason ?? 'absent')}`,
  });

  return out;
}

async function captureOne(persona) {
  const udd = mkdtempSync(join(tmpdir(), `qa-baseline-${persona.name}-`));
  const args = [
    `--user-data-dir=${udd}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    `--lobium-fp-config=${persona.config}`,
    'about:blank',
  ];
  const child = spawn(ENGINE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  try {
    // Port first: DevToolsActivePort appears when the socket opens, which is BEFORE any page target.
    const portFile = join(udd, 'DevToolsActivePort');
    let port = null;
    for (let i = 0; i < 240 && port === null; i += 1) {
      if (existsSync(portFile)) {
        const [p] = readFileSync(portFile, 'utf8').split('\n');
        if (p) port = Number(p);
      }
      if (port === null) await sleep(250);
    }
    if (!port) throw new Error('no DevToolsActivePort');

    // Then a PAGE target, retried: the network service restarts moments after launch.
    let target = null;
    for (let i = 0; i < 240 && !target; i += 1) {
      try {
        const list = await withDeadline(
          fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()),
          8_000,
          '/json/list',
        );
        target = Array.isArray(list) ? list.find((t) => t.type === 'page') : null;
      } catch {
        /* retry */
      }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('no page target');

    const page = await connect(target.webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    await page.send('Page.enable');

    // GPU feature status: asked over the SystemInfo domain rather than by scraping chrome://gpu,
    // which renders in its own process and would report that process's view.
    const versionInfo = await withDeadline(
      fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()),
      15_000,
      '/json/version',
    );
    const browser = await connect(versionInfo.webSocketDebuggerUrl);
    const sysinfo = await browser.send('SystemInfo.getInfo');
    browser.close();

    // A real origin, so secure-context-only surfaces (WebGPU, EME) behave as they do on the web.
    await page.send('Page.navigate', { url: 'https://example.com/' });
    await sleep(2500);

    const captured = await page.evaluate(PROBE);

    let creepjs = null;
    if (CREEPJS) {
      try {
        await page.send('Page.navigate', { url: 'https://abrahamjuliot.github.io/creepjs/' });
        await sleep(25_000);
        creepjs = await page.evaluate(`(() => {
          const grab = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; };
          const txt = document.body ? document.body.innerText : '';
          const pick = (re) => { const m = txt.match(re); return m ? m[1].trim() : null; };
          return {
            trustScore: pick(/trust score[:\\s]*([0-9.]+%)/i),
            lies: pick(/(\\d+)\\s+lies/i),
            fingerprintId: pick(/fingerprint[:\\s]*([0-9a-f]{8,})/i),
            bot: pick(/bot[:\\s]*([A-Za-z]+)/i),
            headline: grab('.visitor-info') ?? txt.slice(0, 400),
          };
        })()`);
      } catch (e) {
        creepjs = { __error: String(e?.message ?? e) };
      }
    }

    page.close();

    return {
      persona: {
        name: persona.name,
        seed: persona.seed,
        os: persona.os,
        arch: persona.arch,
        claimedRenderer: persona.renderer,
        claimedScreen: persona.screen,
        claimedColorDepth: persona.colorDepth,
        locale: persona.locale,
        timezone: persona.timezone,
        proxy: persona.proxy,
      },
      host: {
        platform: process.platform,
        gpuFeatureStatus: sysinfo?.result?.gpu?.featureStatus ?? null,
        gpuDevices: sysinfo?.result?.gpu?.devices ?? null,
        glRenderer: sysinfo?.result?.gpu?.auxAttributes?.glRenderer ?? null,
        glVendor: sysinfo?.result?.gpu?.auxAttributes?.glVendor ?? null,
        modelName: sysinfo?.result?.modelName ?? null,
      },
      captured,
      creepjs,
      contradictions: evaluateContradictions(persona, captured ?? {}),
      engineStderrTail: stderr.split('\n').slice(-12).join('\n'),
    };
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    await sleep(800);
    try { rmSync(udd, { recursive: true, force: true }); } catch { /* windows file locks */ }
  }
}

const summary = [];
for (const persona of wanted) {
  process.stdout.write(`${persona.name.padEnd(16)} `);
  let record;
  try {
    record = await captureOne(persona);
  } catch (error) {
    record = { persona: { name: persona.name }, error: String(error?.message ?? error) };
  }
  const file = join(OUTDIR, `win-gpu-baseline-${persona.name}-${STAMP}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  if (record.error) {
    console.log(`FAILED: ${record.error}`);
    summary.push({ name: persona.name, ok: false, error: record.error });
    continue;
  }
  const fired = (record.contradictions ?? []).filter((c) => c.fires).map((c) => c.id);
  const gl = record.captured?.webgl ?? {};
  console.log(
    `webgl=${gl.present ? 'yes' : 'NO'} ext=${gl.extensionCount ?? '?'} ` +
      `advNull=${(gl.advertisedButNull ?? []).length} ` +
      `exec=${JSON.stringify(gl.executable ?? {})} ` +
      `gpu=${record.captured?.webgpu?.adapter ? 'adapter' : record.captured?.webgpu?.present ? 'null-adapter' : 'absent'} ` +
      `contradictions=[${fired.join(',')}]`,
  );
  summary.push({ name: persona.name, ok: true, fired, file });
}

const summaryFile = join(OUTDIR, `win-gpu-baseline-SUMMARY-${STAMP}.json`);
writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\n${summary.filter((s) => s.ok).length}/${summary.length} captured -> ${OUTDIR}`);
console.log(`summary -> ${summaryFile}`);
