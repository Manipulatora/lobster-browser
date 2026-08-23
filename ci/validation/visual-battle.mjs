#!/usr/bin/env node
/**
 * Visual battle observation for the 5 reported bugs: fonts (tofu/mono/ugly), 3D/WebGL, thin phone
 * frame, and Ctrl +/- zoom. Launches REAL product profiles through the production startProfile path
 * (installed Lobium binary + installed font pack via env), drives CDP to capture page pixels, and uses
 * scrot for full-window (device-frame) capture. Runs on an isolated Xvfb so it never clobbers the
 * user's observation display.
 *
 * Usage: node visual-battle.mjs <fonts|webgl|phone|tablet>
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeRunner, buildLaunchers, startProfile } from '@lobster/engine-runner';
import { canonicalFingerprintSeed } from './canonical-seed.mjs';

const OUT = process.env.LOBSTER_VISUAL_BATTLE_OUT || join(tmpdir(), 'lobster-visual-battle');
const mode = process.argv[2] ?? 'fonts';

// ---- tiny CDP client over native WebSocket ----
class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(new Error('ws error ' + (e.message ?? '')));
      this.ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { res, rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
        } else if (msg.method && this.handlers.has(msg.method)) {
          this.handlers.get(msg.method)(msg.params);
        }
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error('timeout ' + method));
        }
      }, 60000);
    });
  }
  on(method, fn) {
    this.handlers.set(method, fn);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FONT_PAGE = `data:text/html,<!doctype html><meta charset=utf-8><body style="margin:0;background:#fff;color:#111">
<div style="padding:24px;font-size:26px;line-height:1.7">
<div style="font-family:sans-serif">SANS default: The quick brown fox jumps 0123456789 (must be proportional, NOT monospace)</div>
<div style="font-family:serif">SERIF: The quick brown fox jumps over the lazy dog</div>
<div style="font-family:monospace">MONO: The quick brown fox 0123 (this one SHOULD be monospace)</div>
<div style="font-family:Helvetica,Arial">Helvetica/Arial: proportional sans expected</div>
<div>Emoji: 😀 🎉 🚀 ❤️ 👍 🌍 🔥 (must be COLOR glyphs, not squares)</div>
<div>CJK: 中文测试 日本語のテスト 한국어 테스트 (no tofu squares)</div>
<div>Arabic: مرحبا بالعالم &nbsp; Hebrew: שלום עולם &nbsp; Thai: สวัสดีชาวโลก</div>
<div>Symbols: ✓ ✗ → ★ ☂ ♠ ♥ ∑ √ ∞ №</div>
</div></body>`;

const WEBGL_PAGE = `data:text/html,<!doctype html><meta charset=utf-8><body style="margin:0;background:#202030">
<canvas id=c width=760 height=380></canvas>
<pre id=info style="color:#0f0;font:14px monospace;padding:8px"></pre>
<script>
const gl=document.getElementById('c').getContext('webgl')||document.getElementById('c').getContext('experimental-webgl');
const info=document.getElementById('info');
if(!gl){info.textContent='WEBGL: NULL CONTEXT (fail)';}
else{
 const dbg=gl.getExtension('WEBGL_debug_renderer_info');
 const rend=dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):'(masked)';
 const ven=dbg?gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL):'(masked)';
 // draw a spinning-ish gradient triangle so we can SEE 3D output
 const vs=gl.createShader(gl.VERTEX_SHADER);gl.shaderSource(vs,'attribute vec2 p;varying vec2 v;void main(){v=p;gl_Position=vec4(p,0.,1.);}');gl.compileShader(vs);
 const fs=gl.createShader(gl.FRAGMENT_SHADER);gl.shaderSource(fs,'precision mediump float;varying vec2 v;void main(){gl_FragColor=vec4(v*0.5+0.5,0.8,1.);}');gl.compileShader(fs);
 const pr=gl.createProgram();gl.attachShader(pr,vs);gl.attachShader(pr,fs);gl.linkProgram(pr);gl.useProgram(pr);
 const buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,0.8,-0.8,-0.8,0.8,-0.8]),gl.STATIC_DRAW);
 const loc=gl.getAttribLocation(pr,'p');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
 gl.clearColor(0.12,0.12,0.19,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,3);
 const px=new Uint8Array(4);gl.readPixels(380,190,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);
 info.textContent='WEBGL OK\\nVENDOR: '+ven+'\\nRENDERER: '+rend+'\\ncenter pixel rgba: '+px.join(',')+'  (nonzero => 3D drew)';
 document.title='webgl:'+(px[2]>0?'DREW':'blank');
}
</script></body>`;

async function capturePage(ws, html, outPng) {
  // Encode as a data: URL. encodeURIComponent is REQUIRED: raw '#' in inline CSS colors is a fragment
  // delimiter that silently truncates the document, and emoji/CJK bytes must be percent-escaped.
  const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  const cdp = new Cdp(ws);
  await cdp.connect();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  let loaded = false;
  cdp.on('Page.loadEventFired', () => {
    loaded = true;
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  for (let i = 0; i < 60 && !loaded; i++) await sleep(200);
  await sleep(1500); // settle fonts/webgl
  let title = '';
  try {
    title = (
      await cdp.send(
        'Runtime.evaluate',
        { expression: 'document.title', returnByValue: true },
        sessionId,
      )
    ).result.value;
  } catch {}
  let infoText = '';
  try {
    infoText = (
      await cdp.send(
        'Runtime.evaluate',
        {
          expression: "(document.getElementById('info')||{}).textContent||''",
          returnByValue: true,
        },
        sessionId,
      )
    ).result.value;
  } catch {}
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  await writeFile(outPng, Buffer.from(shot.data, 'base64'));
  cdp.close();
  return { title, infoText };
}

async function captureUrl(ws, url, outPng) {
  const cdp = new Cdp(ws);
  await cdp.connect();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  let loaded = false;
  cdp.on('Page.loadEventFired', () => {
    loaded = true;
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  for (let i = 0; i < 100 && !loaded; i++) await sleep(200);
  await sleep(3000);
  const probe = `(() => {
    const b = getComputedStyle(document.body);
    const pick = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).fontFamily + ' | ' + getComputedStyle(e).fontSize : '(none)'; };
    return JSON.stringify({ bodyFF: b.fontFamily, bodySize: b.fontSize, h1: pick('h1'), p: pick('p'), a: pick('a') }, null, 1);
  })()`;
  let info = '';
  try {
    info = (
      await cdp.send('Runtime.evaluate', { expression: probe, returnByValue: true }, sessionId)
    ).result.value;
  } catch (e) {
    info = 'probe fail: ' + e.message;
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  await writeFile(outPng, Buffer.from(shot.data, 'base64'));
  cdp.close();
  return info;
}

async function launchDesktop(os, seed, renderer) {
  const userDataDir = await mkdtemp(join(tmpdir(), `vb-${os}-`));
  const runner = new CompositeRunner(
    await buildLaunchers({
      headless: false,
      extraArgs: ['--no-sandbox', '--disable-dev-shm-usage'],
    }),
  );
  const launched = await startProfile(runner, {
    profileId: `vb-${os}`,
    profileName: `VB ${os}`,
    engine: 'lobium',
    os,
    fingerprintSeed: seed,
    fingerprintOverrides: renderer
      ? { renderer: { mode: 'validated_preset', presetId: renderer } }
      : {},
    userDataDir,
    headless: false,
  });
  return { runner, userDataDir, launched };
}

async function launchPhone(deviceType) {
  const userDataDir = await mkdtemp(join(tmpdir(), `vb-${deviceType}-`));
  const runner = new CompositeRunner(
    await buildLaunchers({
      headless: false,
      extraArgs: ['--no-sandbox', '--disable-dev-shm-usage'],
    }),
  );
  const { dispatch } = await import('@lobster/engine-runner');
  const res = await dispatch(runner, {
    id: 1,
    method: 'startProfile',
    params: {
      profileId: `vb-${deviceType}`,
      profileName: `VB ${deviceType}`,
      engine: 'lobium',
      os: 'android',
      osVersion: '14',
      fingerprintSeed: canonicalFingerprintSeed(`vb-${deviceType}-seed`),
      fingerprintOverrides: { androidDeviceType: deviceType },
      userDataDir,
      headless: false,
    },
  });
  if (!res.ok) throw new Error('android launch failed: ' + res.error?.message);
  return { runner, userDataDir, launched: res.result };
}

async function main() {
  await mkdir(OUT, { recursive: true });

  if (mode === 'fonts') {
    const { runner, launched } = await launchDesktop(
      'windows',
      canonicalFingerprintSeed('vb-fonts-seed'),
      'win-nvidia-nvidia-geforce-rtx-3080-ti-20gb-2205',
    );
    console.log('launched pid', launched.pid, 'ws', launched.ws);
    const r = await capturePage(launched.ws, FONT_PAGE, join(OUT, 'battle-fonts.png'));
    console.log('FONT PAGE title:', r.title);
    await runner.stopAll?.().catch(() => {});
    spawnSync('pkill', ['-f', 'vb-windows']);
    console.log('saved', join(OUT, 'battle-fonts.png'));
  } else if (mode === 'webgl') {
    const { runner, launched } = await launchDesktop(
      'windows',
      canonicalFingerprintSeed('vb-webgl-seed'),
      'win-nvidia-nvidia-geforce-rtx-3080-ti-20gb-2205',
    );
    console.log('launched pid', launched.pid, 'ws', launched.ws);
    const r = await capturePage(launched.ws, WEBGL_PAGE, join(OUT, 'battle-webgl.png'));
    console.log('WEBGL title:', r.title);
    console.log('WEBGL info:\n' + r.infoText);
    await runner.stopAll?.().catch(() => {});
    console.log('saved', join(OUT, 'battle-webgl.png'));
  } else if (mode === 'realsite') {
    const url = process.argv[3] || 'https://en.wikipedia.org/wiki/Mobile_phone';
    const os = process.argv[4] || 'windows';
    const renderer =
      os === 'windows' ? 'win-nvidia-nvidia-geforce-rtx-3080-ti-20gb-2205' : undefined;
    const { runner, launched } = await launchDesktop(
      os,
      canonicalFingerprintSeed('vb-realsite-' + os),
      renderer,
    );
    console.log('launched pid', launched.pid, 'os', os, 'url', url);
    const info = await captureUrl(launched.ws, url, join(OUT, `battle-realsite-${os}.png`));
    console.log('COMPUTED FONTS:\n' + info);
    await runner.stopAll?.().catch(() => {});
    console.log('saved', join(OUT, `battle-realsite-${os}.png`));
  } else if (mode === 'mobilesite') {
    const url = process.argv[3] || 'https://en.m.wikipedia.org/wiki/Firefox';
    const { runner, launched } = await launchPhone('phone');
    console.log('launched pid', launched.pid, 'url', url);
    await sleep(3500);
    const cdp = new Cdp(launched.ws);
    await cdp.connect();
    const { targetInfos } = await cdp.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    await sleep(6000);
    const info = (
      await cdp.send(
        'Runtime.evaluate',
        {
          expression:
            'JSON.stringify({body:getComputedStyle(document.body).fontFamily, size:getComputedStyle(document.body).fontSize})',
          returnByValue: true,
        },
        sessionId,
      )
    ).result.value;
    console.log('MOBILE COMPUTED FONTS:', info);
    cdp.close();
    spawnSync('scrot', ['-o', join(OUT, 'battle-mobilesite.png')], { env: process.env });
    console.log('saved battle-mobilesite.png');
    await runner.stopAll?.().catch(() => {});
  } else if (mode === 'phone' || mode === 'tablet') {
    const { runner, launched } = await launchPhone(mode);
    console.log('launched pid', launched.pid, 'ws', launched.ws);
    await sleep(4000);
    // Navigate the ACTIVE tab to a viewport probe and read the emulated CSS dimensions, so we can
    // confirm the phone's screen resolution matches the profile config (not the host desktop).
    try {
      const cdp = new Cdp(launched.ws);
      await cdp.connect();
      const { targetInfos } = await cdp.send('Target.getTargets');
      const page = targetInfos.find((t) => t.type === 'page');
      if (page) {
        const { sessionId } = await cdp.send('Target.attachToTarget', {
          targetId: page.targetId,
          flatten: true,
        });
        await cdp.send('Page.enable', {}, sessionId);
        await cdp.send('Runtime.enable', {}, sessionId);
        const probe =
          '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0;font:20px sans-serif;background:#eef"><div style="padding:16px" id=o></div><script>o.innerHTML="innerWidth="+innerWidth+"<br>innerHeight="+innerHeight+"<br>screen="+screen.width+"x"+screen.height+"<br>dpr="+devicePixelRatio+"<br>touch="+navigator.maxTouchPoints+"<br>ua="+navigator.userAgent.slice(0,60);document.title="vw:"+innerWidth+"x"+innerHeight<\/script></body>';
        await cdp.send(
          'Page.navigate',
          { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(probe) },
          sessionId,
        );
        await sleep(2500);
        const t = (
          await cdp.send(
            'Runtime.evaluate',
            { expression: 'document.title', returnByValue: true },
            sessionId,
          )
        ).result.value;
        const info = (
          await cdp.send(
            'Runtime.evaluate',
            { expression: "document.getElementById('o').innerText", returnByValue: true },
            sessionId,
          )
        ).result.value;
        console.log('PHONE VIEWPORT title:', t);
        console.log('PHONE VIEWPORT probe:\n' + info);
      }
      cdp.close();
    } catch (e) {
      console.log('viewport probe failed:', e.message);
    }
    await sleep(500);
    // full-window capture (device frame is browser chrome, not page pixels)
    spawnSync('scrot', ['-o', join(OUT, `battle-${mode}-1.png`)], { env: process.env });
    console.log('captured', `battle-${mode}-1.png`);
    // zoom out twice via xdotool Ctrl+minus, then capture again to prove the WHOLE phone scales
    for (let i = 0; i < 2; i++) {
      spawnSync('xdotool', ['key', '--clearmodifiers', 'ctrl+minus'], { env: process.env });
      await sleep(600);
    }
    spawnSync('scrot', ['-o', join(OUT, `battle-${mode}-zoomout.png`)], { env: process.env });
    console.log('captured', `battle-${mode}-zoomout.png`);
    // reset, then zoom IN hard: the device must grow to fill the stage but NEVER cover the toolbar/omnibox.
    spawnSync('xdotool', ['key', '--clearmodifiers', 'ctrl+0'], { env: process.env });
    await sleep(500);
    for (let i = 0; i < 7; i++) {
      spawnSync('xdotool', ['key', '--clearmodifiers', 'ctrl+equal'], { env: process.env });
      await sleep(400);
    }
    spawnSync('scrot', ['-o', join(OUT, `battle-${mode}-zoomin.png`)], { env: process.env });
    console.log('captured', `battle-${mode}-zoomin.png`);
    await runner.stopAll?.().catch(() => {});
  }
  process.exit(0);
}
main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
