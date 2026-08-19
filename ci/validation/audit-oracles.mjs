#!/usr/bin/env node
/**
 * Audit oracles â€” the executable half of docs/ENGINE_AUDIT.md.
 *
 * Every check here is a DETECTION ORACLE: a short script a real page can run that returns a
 * different answer on Lobium than on honest Chrome. They come straight from the adversarial audit,
 * so this file is the regression gate for the anti-detect surface itself, complementing the external
 * detector matrix (`detector-matrix.json`, 15 independent providers) which measures how third-party
 * fingerprinters score us.
 *
 * Why both: a third-party scanner tells you your score on the checks IT happens to run. An oracle
 * tells you whether a specific, known, cheap contradiction is present. The audit found several that
 * no listed scanner probes â€” a 1x1 getImageData read recovering the pristine canvas, a
 * ConstantSourceNode render coming back non-constant, PACK_ROW_LENGTH switching WebGL farbling off.
 * Those need their own gate or they regress silently.
 *
 *   LOBSTER_LOBIUM_BIN=<path-to-chrome> node ci/validation/audit-oracles.mjs
 *   LOBIUM_ORACLES_HEADFUL=1 ...        run headful (required for release evidence)
 *   LOBIUM_ORACLE_OS=windows,linux ...  which persona OS(es) to measure (default: windows)
 *   LOBIUM_ORACLE_EXIT_IP=<ip> ...      the proxy's egress IP, enabling the WebRTC leak check
 *
 * WHICH PERSONA OS. Windows is the first target platform, so it is the default even when the host is
 * something else â€” taking the persona OS from `process.platform` meant a Linux runner only ever
 * measured a Linux persona, and every Windows-only surface (font isolation, native timezone, UA-CH
 * platformVersion) went unmeasured while the report still said "all oracles pass".
 *
 * Exit codes:
 *   0  every declared aspect is green.
 *   1  an oracle whose finding is marked FIXED measured and failed â€” a regression. Oracles for
 *      findings still OPEN are reported and counted, but never fail the run: they are tracked work.
 *   2  BLOCKED. The run measured nothing it can draw a conclusion from: no binary, a build missing
 *      hooks the product's own launcher requires, or an aspect whose every probe was inconclusive.
 *      A blocked run is neither a pass nor a regression, and saying otherwise is how a score gets
 *      recorded against a binary that cannot ship.
 */

import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { deriveFingerprint, generateSeed } from '@lobster/fingerprint';
import {
  buildLobiumConfig,
  writeLobiumConfig,
  lobiumConfigArg,
  probeLobiumBuildCapabilities,
  requiredLobiumCapabilities,
  resolveLobiumBinary,
  withCdpSession,
  cdpEvaluate,
  buildGpuArgs,
  resolveGpuMode,
} from '@lobster/engine-runner';

import { launchEngine } from './e2e/engine.mjs';
import { ASPECTS, aspectOf, exitCodeFor, formatAspectTable, scoreAspects } from './aspect-coverage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(here, 'reports');

/** Persona OS(es) to measure. Windows first, because Windows ships first. */
const PERSONA_OSES = (process.env.LOBIUM_ORACLE_OS || 'windows')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * The TLS ClientHello and the HTTP/2 SETTINGS frame are not readable from a page: they are measured
 * by tls-fingerprint.mjs against a live echo. Its report is folded into the aspect score when it is
 * recent enough to describe this same engine; otherwise those aspects are BLOCKED, never assumed.
 */
const TLS_REPORT = join(REPORTS_DIR, 'tls-fingerprint.json');
const TLS_REPORT_MAX_AGE_MS = Number(process.env.LOBIUM_ORACLE_TLS_MAX_AGE_MS || 2 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------------------------
// The oracles.
//
//   status 'fixed' -> the engine is supposed to pass. A failure is a REGRESSION and fails the run.
//   status 'open'  -> a known gap from the audit. Reported, never fails the run, and flipping it to
//                     'fixed' is what closes the finding.
//
// `run` is a JS expression evaluated in the page that resolves to { pass: boolean, detail: string }.
// Keep each one small enough to paste into a devtools console: that is the point.
//
// `applies(ctx)` opts an oracle out of environments where it measures nothing meaningful â€” a
// Windows-only surface under a Linux persona, an egress check with no proxy. A row that does not
// apply is recorded and excluded from scoring; that is NOT the same as inconclusive, which means the
// probe should have worked and did not.
// ---------------------------------------------------------------------------------------------

const SCENE = `
  const scene = (c) => {
    const x = c.getContext('2d', { willReadFrequently: true });
    x.textBaseline = 'top';
    x.font = '14px "Arial"';
    x.fillStyle = '#f60'; x.fillRect(10, 10, 100, 50);
    x.fillStyle = '#069'; x.fillText('Lobium \\u{1F980} fingerprint', 4, 62);
    x.fillStyle = 'rgba(102,204,0,0.7)'; x.fillText('Lobium \\u{1F980} fingerprint', 6, 64);
    return x;
  };`;

export const ORACLES = [
  {
    id: 'canvas-solid-fill-exact',
    finding: 'canvas-solid-cascade',
    status: 'fixed',
    surface: 'canvas',
    why: 'A known solid fillRect must read back byte-exact. This is the cheapest canvas tamper check and the one CreepJS reports as a canvas lie.',
    run: `(() => {
      const c = document.createElement('canvas'); c.width = 200; c.height = 100;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.fillStyle = 'rgb(255,102,0)'; x.fillRect(10, 10, 100, 50);
      const d = x.getImageData(10, 10, 100, 50).data;
      let bad = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] !== 255 || d[i+1] !== 102 || d[i+2] !== 0 || d[i+3] !== 255) bad++;
      }
      return { pass: bad === 0, detail: bad + '/' + (d.length / 4) + ' pixels of a solid fill were modified' };
    })()`,
  },
  {
    id: 'canvas-cleared-is-zero',
    finding: 'canvas-solid-cascade',
    status: 'fixed',
    surface: 'canvas',
    why: 'A cleared canvas must read back all-zero.',
    run: `(() => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 64, 64).data;
      const bad = [...d].filter((v) => v !== 0).length;
      return { pass: bad === 0, detail: bad + ' non-zero bytes on a cleared canvas' };
    })()`,
  },
  {
    id: 'canvas-1x1-agrees-with-full',
    finding: 'canvas-read-rect-dependent-farble',
    status: 'fixed',
    surface: 'canvas',
    severity: 'critical',
    why: 'A 1x1 read used to have no neighbours of its own, was always classified flat, and so returned the PRISTINE pixel â€” recovering the whole host canvas one pixel at a time and proving tampering in two calls.',
    run: `(() => {${SCENE}
      const c = document.createElement('canvas'); c.width = 160; c.height = 90;
      const x = scene(c);
      const full = x.getImageData(0, 0, 160, 90).data;
      let mismatch = 0, checked = 0;
      for (let y = 20; y < 80; y += 7) {
        for (let px = 5; px < 155; px += 11) {
          const one = x.getImageData(px, y, 1, 1).data;
          const o = (y * 160 + px) * 4;
          checked++;
          for (let k = 0; k < 4; k++) if (one[k] !== full[o + k]) { mismatch++; break; }
        }
      }
      return { pass: mismatch === 0, detail: mismatch + '/' + checked + ' 1x1 reads disagreed with the full read' };
    })()`,
  },
  {
    id: 'canvas-subrect-agrees-with-full',
    finding: 'canvas-read-rect-dependent-farble',
    status: 'fixed',
    surface: 'canvas',
    why: 'A sub-rect read must perturb each pixel identically to a full-canvas read.',
    run: `(() => {${SCENE}
      const c = document.createElement('canvas'); c.width = 160; c.height = 90;
      const x = scene(c);
      const full = x.getImageData(0, 0, 160, 90).data;
      const sub = x.getImageData(40, 30, 32, 24).data;
      let mismatch = 0;
      for (let y = 0; y < 24; y++) for (let px = 0; px < 32; px++) {
        const a = ((30 + y) * 160 + (40 + px)) * 4, b = (y * 32 + px) * 4;
        for (let k = 0; k < 4; k++) if (full[a + k] !== sub[b + k]) { mismatch++; break; }
      }
      return { pass: mismatch === 0, detail: mismatch + '/768 sub-rect pixels disagreed with the full read' };
    })()`,
  },
  {
    id: 'canvas-roundtrip-fixed-point',
    finding: 'canvas-putimagedata-roundtrip-recovery',
    status: 'fixed',
    surface: 'canvas',
    severity: 'critical',
    why: 'getImageData -> putImageData -> getImageData must be a fixed point. An additive nudge gives b = v + 2d, handing the page the true pixel as 2a - b.',
    // An {alpha:false} canvas on purpose. Chromium stores canvas pixels PREMULTIPLIED, while
    // ImageData is unpremultiplied, so on an alpha canvas the round trip loses precision on
    // semi-transparent pixels in HONEST Chrome too â€” testing there would measure Skia's rounding,
    // not our farble. With kOpaque_SkAlphaType the write-back is a memcpy and honest Chrome is
    // byte-exact, which is what makes this a clean oracle.
    run: `(() => {
      const c = document.createElement('canvas'); c.width = 160; c.height = 90;
      const x = c.getContext('2d', { alpha: false, willReadFrequently: true });
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, 160, 90);
      x.textBaseline = 'top'; x.font = '14px "Arial"';
      x.fillStyle = '#069'; x.fillText('Lobium \\u{1F980} fingerprint', 4, 20);
      x.fillStyle = 'rgba(102,204,0,0.7)'; x.fillText('Lobium \\u{1F980} fingerprint', 6, 40);
      const a = x.getImageData(0, 0, 160, 90);
      x.putImageData(a, 0, 0);
      const b = x.getImageData(0, 0, 160, 90);
      let diff = 0;
      for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) diff++;
      return { pass: diff === 0, detail: diff + ' bytes changed across a putImageData round trip' };
    })()`,
  },
  {
    id: 'canvas-todataurl-matches-getimagedata',
    finding: 'canvas-snapshot-readback-bypass',
    status: 'fixed',
    surface: 'canvas',
    why: 'The encoded snapshot and the pixel readback must describe the same image; a mismatch is a cross-surface contradiction.',
    run: `(async () => {${SCENE}
      const c = document.createElement('canvas'); c.width = 120; c.height = 60;
      const x = scene(c);
      const direct = x.getImageData(0, 0, 120, 60).data;
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = c.toDataURL(); });
      const c2 = document.createElement('canvas'); c2.width = 120; c2.height = 60;
      const x2 = c2.getContext('2d', { willReadFrequently: true });
      x2.drawImage(img, 0, 0);
      const viaUrl = x2.getImageData(0, 0, 120, 60).data;
      let diff = 0;
      for (let i = 0; i < direct.length; i += 4) {
        if (direct[i] !== viaUrl[i] || direct[i+1] !== viaUrl[i+1] || direct[i+2] !== viaUrl[i+2]) diff++;
      }
      return { pass: diff === 0, detail: diff + '/7200 pixels differ between toDataURL and getImageData' };
    })()`,
  },
  {
    id: 'canvas-imagebitmap-bypass',
    finding: 'canvas-snapshot-readback-bypass',
    status: 'fixed',
    surface: 'canvas',
    severity: 'critical',
    why: 'Snapshot() is deliberately unfarbled, and createImageBitmap(canvas) -> bitmaprenderer -> toDataURL reaches it, returning the pristine host canvas.',
    run: `(async () => {${SCENE}
      const c = document.createElement('canvas'); c.width = 120; c.height = 60;
      scene(c);
      const farbled = c.toDataURL();
      const bmp = await createImageBitmap(c);
      const c2 = document.createElement('canvas'); c2.width = 120; c2.height = 60;
      c2.getContext('bitmaprenderer').transferFromImageBitmap(bmp);
      const viaBitmap = c2.toDataURL();
      return { pass: farbled === viaBitmap, detail: farbled === viaBitmap ? 'bitmaprenderer route agrees' : 'bitmaprenderer route returns a DIFFERENT image (the unfarbled one)' };
    })()`,
  },

  {
    id: 'audio-constant-input-stays-constant',
    finding: 'audio-index-keyed-noise-breaks-known-input',
    status: 'fixed',
    surface: 'audio',
    severity: 'high',
    why: 'Honest Chrome renders ConstantSourceNode through a fill and a byte copy, so every frame is bit-identical on every platform. Index-keyed noise turned one constant into thousands of distinct values.',
    run: `(async () => {
      const ctx = new OfflineAudioContext(1, 8192, 44100);
      const s = new ConstantSourceNode(ctx, { offset: 0.5 });
      s.connect(ctx.destination); s.start();
      const d = (await ctx.startRendering()).getChannelData(0);
      const distinct = new Set(d).size;
      return { pass: distinct === 1, detail: distinct + ' distinct values from a constant input (honest Chrome: 1), first=' + d[0] };
    })()`,
  },
  {
    id: 'audio-upmix-channels-identical',
    finding: 'audio-index-keyed-noise-breaks-known-input',
    status: 'fixed',
    surface: 'audio',
    why: 'An honest mono-to-stereo upmix yields bit-identical channels; a per-sample or per-channel key breaks the channelData(0)[k] === channelData(1)[k] oracle.',
    run: `(async () => {
      const ctx = new OfflineAudioContext(2, 8192, 44100);
      const o = new OscillatorNode(ctx, { type: 'triangle', frequency: 1000 });
      o.connect(ctx.destination); o.start();
      const b = await ctx.startRendering();
      const a0 = b.getChannelData(0), a1 = b.getChannelData(1);
      let diff = 0;
      for (let i = 0; i < a0.length; i++) if (a0[i] !== a1[i]) diff++;
      return { pass: diff === 0, detail: diff + '/' + a0.length + ' frames differ between upmixed channels' };
    })()`,
  },
  {
    id: 'audio-sum-inside-honest-manifold',
    finding: 'audio-amplitude-4-orders-too-large',
    status: 'fixed',
    surface: 'audio',
    why: 'The canonical FingerprintJS sum must land near the known Chrome cluster. The old 1.5e-3 amplitude moved it ~190x further than the entire honest population spread, i.e. off the manifold.',
    // The compressor parameters are NOT defaults â€” these are the exact values FingerprintJS uses,
    // and the published 124.043... cluster only means anything for this precise graph.
    run: `(async () => {
      const ctx = new OfflineAudioContext(1, 5000, 44100);
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 10000;
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = -50; c.knee.value = 40; c.ratio.value = 12;
      c.attack.value = 0; c.release.value = 0.25;
      o.connect(c); c.connect(ctx.destination); o.start(0);
      const b = await ctx.startRendering();
      const ch = b.getChannelData(0);
      let s = 0; for (let i = 4500; i < 5000; i++) s += Math.abs(ch[i]);
      const known = [124.04344968475198, 124.04347527516074, 124.0807];
      const off = Math.min(...known.map((k) => Math.abs(s - k))) / s;
      return { pass: off < 3e-4, detail: 'sum=' + s + ' relative distance to the nearest known Chrome value=' + off.toExponential(3) };
    })()`,
  },
  {
    id: 'audio-worklet-not-double-farbled',
    finding: 'audio-worklet-spn-double-farble',
    status: 'fixed',
    surface: 'audio',
    severity: 'high',
    why: 'A pass-through offline AudioWorklet must not perturb a sample a second time on its way to the destination buffer.',
    run: `(async () => {
      const render = async (useWorklet) => {
        const ctx = new OfflineAudioContext(1, 8192, 44100);
        const s = new ConstantSourceNode(ctx, { offset: 0.25 });
        if (useWorklet) {
          const src = "class P extends AudioWorkletProcessor{process(i,o){if(i[0]&&i[0][0])o[0][0].set(i[0][0]);return true}}registerProcessor('p',P)";
          await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
          const n = new AudioWorkletNode(ctx, 'p');
          s.connect(n); n.connect(ctx.destination);
        } else {
          s.connect(ctx.destination);
        }
        s.start();
        return (await ctx.startRendering()).getChannelData(0)[4096];
      };
      const direct = await render(false), viaWorklet = await render(true);
      return { pass: direct === viaWorklet, detail: 'direct=' + direct + ' viaWorklet=' + viaWorklet };
    })()`,
  },

  {
    id: 'clientrect-coincident-edges-stay-equal',
    finding: 'clientrect-index-keying',
    status: 'fixed',
    surface: 'geometry',
    why: 'Honest Chrome returns exactly equal doubles when one element ends where the next begins. Index-keyed noise gave them independent nudges.',
    run: `(() => {
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:0;top:0;width:200px';
      const a = document.createElement('div'); a.style.cssText = 'height:40px';
      const b = document.createElement('div'); b.style.cssText = 'height:40px';
      host.append(a, b); document.body.append(host);
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      host.remove();
      return { pass: ra.bottom === rb.top, detail: 'A.bottom=' + ra.bottom + ' B.top=' + rb.top };
    })()`,
  },
  {
    id: 'clientrect-unrendered-is-zero',
    finding: 'clientrect-empty-rect-farbled',
    status: 'fixed',
    surface: 'geometry',
    severity: 'high',
    why: 'getBoundingClientRect() on a display:none or detached element returns all zeros in every real browser.',
    run: `(() => {
      const d = document.createElement('div');
      d.style.display = 'none'; document.body.append(d);
      const r = d.getBoundingClientRect(); d.remove();
      const zero = r.x === 0 && r.y === 0 && r.width === 0 && r.height === 0;
      return { pass: zero, detail: JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }) };
    })()`,
  },

  {
    id: 'webgl-getextension-case-insensitive',
    finding: 'getextension-case-sensitive-allowlist',
    status: 'open',
    surface: 'webgl',
    why: 'The WebGL spec matches extension names case-insensitively. If getExtension("webgl_debug_renderer_info") succeeds while getSupportedExtensions() omits it (or vice versa), that is direct proof of a filter.',
    // Two halves, and the SECOND is the one that actually bites. Checking only names already in the
    // persona list can pass on a case-sensitive filter, because Chrome canonicalises the name before
    // the filter ever sees it. The real test is a name the persona list EXCLUDES: if getExtension
    // returns an object for something getSupportedExtensions() denies, the filter is being bypassed.
    run: `(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return { inconclusive: true, detail: 'no webgl context on this host' };
      const list = gl.getSupportedExtensions() || [];
      const listed = new Set(list.map((n) => n.toLowerCase()));
      const caseMismatch = list.filter((n) => !!gl.getExtension(n.toLowerCase()) !== !!gl.getExtension(n));
      // A broad pool of real WebGL1 extension names; whichever the persona excludes are the probes.
      const pool = ['ANGLE_instanced_arrays','EXT_blend_minmax','EXT_clip_control','EXT_color_buffer_half_float',
        'EXT_disjoint_timer_query','EXT_float_blend','EXT_frag_depth','EXT_shader_texture_lod','EXT_sRGB',
        'EXT_texture_compression_bptc','EXT_texture_compression_rgtc','EXT_texture_filter_anisotropic',
        'KHR_parallel_shader_compile','OES_element_index_uint','OES_fbo_render_mipmap','OES_standard_derivatives',
        'OES_texture_float','OES_texture_float_linear','OES_texture_half_float','OES_texture_half_float_linear',
        'OES_vertex_array_object','WEBGL_color_buffer_float','WEBGL_compressed_texture_s3tc',
        'WEBGL_compressed_texture_s3tc_srgb','WEBGL_debug_renderer_info','WEBGL_debug_shaders',
        'WEBGL_depth_texture','WEBGL_draw_buffers','WEBGL_lose_context','WEBGL_multi_draw'];
      const excluded = pool.filter((n) => !listed.has(n.toLowerCase()));
      const leaked = excluded.filter((n) => gl.getExtension(n) || gl.getExtension(n.toLowerCase()));
      // If almost nothing is excluded, the persona is not filtering extensions at all and the page
      // is seeing the host's own list. There is then no filter to be case-sensitive ABOUT, so a
      // "pass" here would be vacuous â€” report it as inconclusive instead of banking it.
      if (excluded.length < 3) {
        return { inconclusive: true, detail: 'only ' + excluded.length + ' of ' + pool.length +
          ' probe names are excluded, so this persona is not filtering extensions - nothing to test' };
      }
      const ok = caseMismatch.length === 0 && leaked.length === 0;
      return { pass: ok, detail: caseMismatch.length + ' case mismatches; ' + excluded.length +
        ' excluded names probed, ' + leaked.length + ' leaked' + (leaked.length ? ': ' + leaked.slice(0,4).join(', ') : '') };
    })()`,
  },
  {
    id: 'webgl-extension-order-not-alphabetical',
    finding: 'supported-extensions-alphabetically-sorted',
    status: 'fixed',
    surface: 'webgl',
    severity: 'high',
    why: 'Real Chrome returns registration order. A perfectly alphabetised list is a fingerprint of the spoof itself, not of any real browser. NOTE: when the persona configures no extension list this passes against the HOST order, which is correct-but-unspoofed â€” webgl-surfaces-match-the-persona is what reports that.',
    run: `(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return { inconclusive: true, detail: 'no webgl context on this host' };
      const list = gl.getSupportedExtensions() || [];
      const sorted = [...list].sort((a, b) => a.localeCompare(b));
      const isSorted = list.length > 3 && list.every((v, i) => v === sorted[i]);
      return { pass: !isSorted, detail: (isSorted ? 'list IS alphabetised' : 'registration order preserved') + ' (' + list.length + ' extensions)' };
    })()`,
  },
  {
    id: 'webgl2-version-is-spoofed',
    finding: 'webgl2-getparameter-never-hooked',
    status: 'fixed',
    surface: 'webgl',
    severity: 'critical',
    why: 'WebGL2RenderingContextBase::getParameter intercepts VERSION and SHADING_LANGUAGE_VERSION before the Lobium hook, so a webgl2 context leaks the real driver.',
    // NOT the unmasked renderer â€” WebGL2 INHERITS that from the hooked base class, so comparing it
    // passes even when WebGL2 is otherwise entirely uncovered. The finding is specifically about the
    // strings WebGL2RenderingContextBase::getParameter answers ITSELF before delegating.
    run: `(() => {
      const g1 = document.createElement('canvas').getContext('webgl');
      const g2 = document.createElement('canvas').getContext('webgl2');
      if (!g1 || !g2) return { inconclusive: true, detail: 'missing a webgl/webgl2 context on this host' };
      const v1 = g1.getParameter(g1.VERSION), s1 = g1.getParameter(g1.SHADING_LANGUAGE_VERSION);
      const v2 = g2.getParameter(g2.VERSION), s2 = g2.getParameter(g2.SHADING_LANGUAGE_VERSION);
      // Shape, not equality: WebGL2 must say "WebGL 2.0" / GLSL ES 3.00, WebGL1 "WebGL 1.0".
      const shapeOk = /WebGL 2\\.0/.test(v2) && /3\\.0/.test(s2) && /WebGL 1\\.0/.test(v1);
      // Serving the WebGL1-calibrated extension list to a WebGL2 context is the other half of the
      // finding: WebGL2-only names would go missing and WebGL1-only names would wrongly appear.
      const l1 = new Set(g1.getSupportedExtensions() || []);
      const l2 = new Set(g2.getSupportedExtensions() || []);
      const wrongIn1 = ['EXT_color_buffer_float','EXT_texture_norm16','OVR_multiview2'].filter((n) => l1.has(n));
      const wrongIn2 = ['OES_texture_float','OES_vertex_array_object','ANGLE_instanced_arrays','WEBGL_depth_texture'].filter((n) => l2.has(n));
      const identical = l1.size === l2.size && [...l1].every((n) => l2.has(n));
      const ok = shapeOk && wrongIn1.length === 0 && wrongIn2.length === 0 && !identical;
      return { pass: ok, detail: 'v1=' + v1 + ' | v2=' + v2 + ' | glsl2=' + s2 +
        ' | webgl2-only-in-gl1=' + wrongIn1.length + ' gl1-only-in-gl2=' + wrongIn2.length +
        ' | identical lists=' + identical + ' (' + l1.size + '/' + l2.size + ')' };
    })()`,
  },
  {
    id: 'webgl-pack-row-length-still-farbles',
    finding: 'pack-row-length-disables-webgl-farble',
    status: 'fixed',
    surface: 'webgl',
    severity: 'critical',
    why: 'gl.pixelStorei(PACK_ROW_LENGTH, width) is a byte-for-byte no-op, but it takes readPixels off the default-pack path and switches farbling off, returning the true GPU pixels.',
    // The scene MUST be textured. A gl.clear() to a solid colour is skipped by the flat-run rule by
    // design, so reading it back twice trivially gives 0 difference and proves nothing at all â€” it
    // does not even prove WebGL farbling is running. This draws a per-pixel-varying fragment so
    // every pixel is eligible, then asserts (a) farbling is actually happening, and (b) setting
    // PACK_ROW_LENGTH to exactly the row width â€” a byte-for-byte no-op â€” does not change the result.
    run: `(() => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const gl = c.getContext('webgl2', { preserveDrawingBuffer: true });
      if (!gl) return { inconclusive: true, detail: 'no webgl2 context on this host' };
      const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, '#version 300 es\\nin vec2 a;void main(){gl_Position=vec4(a,0.,1.);}'));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, '#version 300 es\\nprecision highp float;out vec4 o;' +
        'void main(){vec2 f=gl_FragCoord.xy;' +
        'float n=fract(sin(dot(f,vec2(12.9898,78.233)))*43758.5453);' +
        'o=vec4(fract(f.x/7.0),fract(f.y/11.0),n,1.0);}'));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return { inconclusive: true, detail: 'shader link failed: ' + gl.getProgramInfoLog(p) };
      gl.useProgram(p);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(p, 'a');
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const n = 64 * 64 * 4;
      const a = new Uint8Array(n), b = new Uint8Array(n);
      gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, a);
      gl.pixelStorei(gl.PACK_ROW_LENGTH, 64);
      gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, b);
      let diff = 0; for (let i = 0; i < n; i++) if (a[i] !== b[i]) diff++;

      // Is WebGL pixel farbling running at all? Compare the readback against what the encoded
      // snapshot says the same pixels are; both are farbled, so they must agree.
      const c2 = document.createElement('canvas'); c2.width = 64; c2.height = 64;
      const x2 = c2.getContext('2d', { willReadFrequently: true });
      x2.drawImage(c, 0, 0);
      const viaDraw = x2.getImageData(0, 0, 64, 64).data;
      let flat = 0;
      for (let i = 0; i < n; i += 4) if (viaDraw[i] === viaDraw[4] && viaDraw[i+1] === viaDraw[5]) flat++;
      const textured = flat < (n / 4) * 0.5;

      return { pass: diff === 0 && textured,
        detail: diff + ' bytes differ with PACK_ROW_LENGTH set (must be 0); scene textured=' + textured };
    })()`,
  },
  {
    id: 'webgpu-absent-or-agrees-with-webgl',
    finding: 'webgpu-adapter-unhooked',
    status: 'open',
    surface: 'webgpu',
    severity: 'critical',
    why: 'WebGPU is shipped and completely unhooked: adapter.info exposes the real GPU while WebGL reports the persona. Either it must be off, or it must agree.',
    // `navigator.gpu` absent is INCONCLUSIVE, never a pass: on this GPU-less CI host WebGPU simply
    // is not available, which proves nothing about a user's machine where it will be. Reporting
    // that as green would be the most dangerous kind of false confidence.
    run: `(async () => {
      if (!navigator.gpu) return { inconclusive: true, detail: 'navigator.gpu absent on this host - proves nothing about a GPU machine' };
      const adapter = await navigator.gpu.requestAdapter().catch(() => null);
      if (!adapter) return { inconclusive: true, detail: 'no adapter on this host' };
      const info = adapter.info || {};
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const glRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
      const gpuDesc = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ');
      const agrees = gpuDesc && glRenderer && gpuDesc.toLowerCase().split(/\\W+/).some((t) => t.length > 3 && glRenderer.toLowerCase().includes(t));
      return { pass: Boolean(agrees), detail: 'webgpu="' + gpuDesc + '" vs webgl="' + glRenderer + '"' };
    })()`,
  },

  {
    id: 'webgl-surfaces-match-the-persona',
    finding: 'webgl-deep-surfaces',
    status: 'fixed',
    surface: 'webgl',
    severity: 'high',
    expectsPersona: 'webgl',
    why: 'The decisive WebGL check. Every other WebGL oracle here tests SHAPE (does WebGL2 say "WebGL 2.0", is the list unsorted) and can pass on host values, because Chromium\'s generic strings look plausible either way. This one compares what the page reports against what we actually configured, so it fails if a surface silently falls back to the host.',
    run: (persona) => {
      const w = persona.webgl || {};
      return `(() => {
      const want = ${JSON.stringify({
        unmaskedVendor: w.unmaskedVendor ?? null,
        unmaskedRenderer: w.unmaskedRenderer ?? null,
        version: w.version ?? null,
        shadingLanguageVersion: w.shadingLanguageVersion ?? null,
        extensions: Array.isArray(w.extensions) ? w.extensions : null,
      })};
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return { inconclusive: true, detail: 'no webgl context on this host' };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const got = {
        unmaskedVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
        version: gl.getParameter(gl.VERSION),
        shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      };
      const bad = [];
      for (const k of ['unmaskedVendor','unmaskedRenderer','version','shadingLanguageVersion']) {
        if (want[k] && got[k] !== want[k]) bad.push(k + ': got ' + JSON.stringify(got[k]) + ' want ' + JSON.stringify(want[k]));
      }
      let extNote = 'not configured';
      if (want.extensions && want.extensions.length) {
        const live = gl.getSupportedExtensions() || [];
        // Two separate claims, because they fail for different reasons and only one is a defect.
        //
        // (a) SUBSET + ORDER is the engine's job and must always hold. Any name the page sees that
        //     the persona did not configure is a host extension leaking, and a reordering breaks the
        //     registration-order shape.
        // (b) COUNT depends on the backend. webgl-runtime-safety intersects the persona list with
        //     what the active GL implementation can actually enable, precisely so the engine never
        //     advertises an extension getExtension() would then refuse. SwiftShader supports fewer
        //     than a real GPU, so a shortfall here measures the backend, not the hook.
        const extra = live.filter((n) => !want.extensions.includes(n));
        const order = want.extensions.filter((n) => live.includes(n));
        const orderOk = live.length === order.length && live.every((n, i) => n === order[i]);
        if (extra.length) bad.push('extensions not in the persona list: ' + extra.join(', '));
        if (!orderOk) bad.push('extensions are not in the configured order');
        extNote = live.length + '/' + want.extensions.length + ' enabled by this backend, subset+order ok=' + (extra.length === 0 && orderOk);
      }
      return { pass: bad.length === 0,
        detail: bad.length ? bad.join(' | ') : 'renderer/version/GLSL match the persona; extensions: ' + extNote };
    })()`;
    },
  },
  {
    id: 'timezone-matches-persona',
    finding: 'timezone-tz-env-noop-on-windows',
    status: 'fixed',
    surface: 'locale',
    severity: 'critical',
    expectsPersona: 'timezone',
    why: 'On Windows, ICU ignores the TZ environment variable, so the persona timezone is never applied and every profile reports the host zone.',
    run: (persona) => `(() => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return { pass: tz === ${JSON.stringify(persona.locale.timezone)}, detail: 'reported=' + tz + ' expected=' + ${JSON.stringify(persona.locale.timezone)} };
    })()`,
  },
  {
    id: 'ua-ch-platform-version-linux-empty',
    finding: 'linux-persona-nonempty-platform-version',
    status: 'fixed',
    surface: 'navigator',
    // Under a Windows persona the assertion is vacuously true, which reads as a pass while measuring
    // nothing. Only a Linux persona exercises it.
    applies: (ctx) => ctx.personaOs === 'linux',
    why: 'Real Chrome on Linux always reports an empty Sec-CH-UA-Platform-Version; a kernel-shaped value is one no Chrome has emitted.',
    run: `(async () => {
      const h = await navigator.userAgentData.getHighEntropyValues(['platform', 'platformVersion']);
      const ok = h.platform !== 'Linux' || h.platformVersion === '';
      return { pass: ok, detail: 'platform=' + h.platform + ' platformVersion="' + h.platformVersion + '"' };
    })()`,
  },
  {
    id: 'desktop-maxtouchpoints-zero',
    finding: 'host-calibration-maxtouchpoints-hardfail',
    status: 'fixed',
    surface: 'navigator',
    why: 'A desktop UA advertising touch points while matchMedia reports a fine, hovering pointer is incoherent, and the same non-zero count on every profile links them.',
    run: `(async () => {
      const h = await navigator.userAgentData.getHighEntropyValues(['platform']);
      const mobile = navigator.userAgentData.mobile;
      const ok = mobile || navigator.maxTouchPoints === 0;
      return { pass: ok, detail: 'mobile=' + mobile + ' maxTouchPoints=' + navigator.maxTouchPoints + ' pointer:fine=' + matchMedia('(pointer: fine)').matches };
    })()`,
  },
  {
    id: 'worker-ua-matches-window',
    finding: 'navigator-worker-coherence',
    status: 'fixed',
    surface: 'navigator',
    why: 'A worker that reports a different userAgent or platform than the window is a classic cross-context lie; the native hook exists precisely so they cannot diverge.',
    run: `(async () => {
      const src = 'self.postMessage({ua:navigator.userAgent,plat:navigator.platform,hc:navigator.hardwareConcurrency})';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      const got = await new Promise((res) => { w.onmessage = (e) => res(e.data); });
      w.terminate();
      const ok = got.ua === navigator.userAgent && got.plat === navigator.platform && got.hc === navigator.hardwareConcurrency;
      return { pass: ok, detail: ok ? 'worker agrees with window' : 'worker=' + JSON.stringify(got) };
    })()`,
  },
  {
    id: 'screen-matchmedia-agreement',
    finding: 'screen-dpr-coherence',
    status: 'fixed',
    surface: 'screen',
    why: 'CreepJS reports a Screen lie when matchMedia device-width/height or the resolution query disagrees with screen.* and devicePixelRatio.',
    run: `(() => {
      const dw = matchMedia('(device-width: ' + screen.width + 'px)').matches;
      const dh = matchMedia('(device-height: ' + screen.height + 'px)').matches;
      const dpr = matchMedia('(resolution: ' + devicePixelRatio + 'dppx)').matches;
      return { pass: dw && dh && dpr, detail: 'device-width=' + dw + ' device-height=' + dh + ' resolution=' + dpr + ' (' + screen.width + 'x' + screen.height + ' @' + devicePixelRatio + ')' };
    })()`,
  },
  {
    id: 'timezone-is-the-persona-zone',
    finding: 'native-timezone-windows-noop',
    status: 'fixed',
    surface: 'locale',
    severity: 'critical',
    why: 'The launcher sets TZ, but ICU ignores it on Windows and reads the registry instead â€” so the persona timezone silently did not apply there at all, while the profile still routed through a proxy in that zone. A page compares Intl against the exit IP in one line.',
    run: (persona) => `(() => {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const want = ${JSON.stringify(persona.locale.timezone)};
      // The offset must be consistent with the zone the engine reports, not merely present: a hook
      // that changed the reported name without moving the clock would be caught by exactly this.
      const viaZone = new Intl.DateTimeFormat('en-US', { timeZone: want, timeZoneName: 'longOffset' })
        .formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value;
      const viaDefault = new Intl.DateTimeFormat('en-US', { timeZoneName: 'longOffset' })
        .formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value;
      return {
        pass: zone === want && viaZone === viaDefault,
        detail: 'Intl zone=' + zone + ' want=' + want + ' offset=' + viaDefault + ' (zone says ' + viaZone + ')',
      };
    })()`,
  },
  {
    id: 'timezone-agrees-in-worker',
    finding: 'native-timezone-windows-noop',
    status: 'fixed',
    surface: 'locale',
    why: 'Workers get their own ICU default. A window/worker timezone split is the same class of cross-context lie as a worker UA split, and just as cheap to read.',
    run: `(async () => {
      const src = 'self.postMessage(Intl.DateTimeFormat().resolvedOptions().timeZone)';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      const got = await new Promise((res) => { w.onmessage = (e) => res(e.data); });
      w.terminate();
      const win = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return { pass: got === win, detail: 'window=' + win + ' worker=' + got };
    })()`,
  },
  {
    id: 'webgl2-extensions-are-the-webgl2-list',
    finding: 'webgl2-extension-list-collapse',
    status: 'fixed',
    surface: 'webgl',
    why: 'Feeding a WebGL1 extension list to a WebGL2 context collapses it to the few names common to both, because the engine intersects the configured names with the context own registrations. A WebGL2 context advertising a handful of extensions is not a shape any real Chrome emits.',
    run: (persona) => `(() => {
      const c = document.createElement('canvas');
      const gl2 = c.getContext('webgl2');
      if (!gl2) return { inconclusive: true, detail: 'no WebGL2 context in this environment' };
      const got = gl2.getSupportedExtensions();
      const want = ${JSON.stringify(persona.webgl.extensions2 ?? [])};
      const want1 = ${JSON.stringify(persona.webgl.extensions ?? [])};
      if (!want.length) return { inconclusive: true, detail: 'persona carries no extensions2 list' };
      // What this oracle is for: proving the WebGL2 context is served the WebGL2 list. Before the
      // fix it got the WebGL1 list, which collapsed to the handful of names common to both.
      //
      // MISSING names are not a defect here â€” webgl-runtime-safety intersects the persona list with
      // what the backend can enable, and SwiftShader enables fewer than a real GPU. EXTRA names are,
      // because they can only have come from the host. The decisive claim is the one that
      // distinguishes the two lists: names unique to the WebGL2 list must actually appear.
      const extra = got.filter((n) => !want.includes(n));
      const distinct = JSON.stringify(want) !== JSON.stringify(want1);
      const only2 = want.filter((n) => !want1.includes(n));
      const only2Present = only2.filter((n) => got.includes(n));
      // If the backend enables none of the WebGL2-only names, the context could still be serving a
      // WebGL1 list and we could not tell. That is unmeasured, not a pass.
      if (only2.length && only2Present.length === 0) {
        return {
          inconclusive: true,
          detail: 'this backend enables none of the ' + only2.length +
                  ' WebGL2-only names, so which list was served is unmeasurable here',
        };
      }
      return {
        pass: extra.length === 0 && distinct && only2Present.length > 0,
        detail: got.length + '/' + want.length + ' enabled by this backend; extra=' + extra.length +
                '; WebGL2-only names present=' + only2Present.length + '/' + only2.length +
                '; distinctFromWebGL1=' + distinct,
      };
    })()`,
  },
  {
    id: 'webgl2-components-are-4x-webgl1-vectors',
    finding: 'webgl2-component-limits-unspoofed',
    status: 'fixed',
    surface: 'webgl',
    why: 'WebGL2 reports the same driver limits as WebGL1 counted in scalar components. Spoofing only the vector view lets one page divide by four and catch the contradiction.',
    run: `(() => {
      const c1 = document.createElement('canvas').getContext('webgl');
      const c2 = document.createElement('canvas').getContext('webgl2');
      if (!c1 || !c2) return { inconclusive: true, detail: 'WebGL1 or WebGL2 unavailable' };
      const pairs = [
        ['MAX_VERTEX_UNIFORM_VECTORS', 'MAX_VERTEX_UNIFORM_COMPONENTS'],
        ['MAX_FRAGMENT_UNIFORM_VECTORS', 'MAX_FRAGMENT_UNIFORM_COMPONENTS'],
        ['MAX_VARYING_VECTORS', 'MAX_VARYING_COMPONENTS'],
      ];
      const bad = [];
      for (const [vecName, compName] of pairs) {
        const vec = c1.getParameter(c1[vecName]);
        const comp = c2.getParameter(c2[compName]);
        // The engine clamps to what the backend can satisfy, so components may be LOWER than 4x on a
        // constrained backend. Higher than 4x is the incoherent direction and is what this catches.
        if (comp > vec * 4) bad.push(compName + '=' + comp + ' > 4*' + vecName + '=' + vec * 4);
      }
      return { pass: bad.length === 0, detail: bad.length ? bad.join('; ') : 'all three component limits agree with their vector limits' };
    })()`,
  },
  {
    id: 'webgpu-adapter-matches-webgl-renderer',
    finding: 'webgpu-adapter-reports-real-gpu',
    status: 'fixed',
    surface: 'webgpu',
    severity: 'critical',
    why: 'WebGPU and WebGL describe the same card in two calls. Reporting the persona in one and the real GPU in the other is worse than spoofing neither: the mismatch positively identifies a rewriter.',
    run: (persona) => `(async () => {
      if (!navigator.gpu) return { inconclusive: true, detail: 'navigator.gpu unavailable (WebGPU off in this environment)' };
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { inconclusive: true, detail: 'requestAdapter() returned null' };
      const info = adapter.info || {};
      const want = ${JSON.stringify(persona.webgpu ?? null)};
      if (!want) return { inconclusive: true, detail: 'persona carries no webgpu block' };
      const problems = [];
      if (info.vendor !== want.vendor) problems.push('vendor=' + info.vendor + ' want ' + want.vendor);
      if (info.architecture !== want.architecture) problems.push('architecture=' + info.architecture + ' want ' + want.architecture);
      // isFallbackAdapter is derived from the adapter TYPE. A persona claiming real hardware while
      // reporting a fallback adapter contradicts itself inside one object read.
      if (adapter.isFallbackAdapter) problems.push('isFallbackAdapter=true for a persona claiming ' + want.description);
      return {
        pass: problems.length === 0,
        detail: problems.length ? problems.join('; ') : 'vendor=' + info.vendor + ' architecture=' + info.architecture,
      };
    })()`,
  },
  {
    id: 'mediadevices-ids-have-chrome-shape',
    finding: 'media-devices-id-shape',
    status: 'fixed',
    surface: 'mediaDevices',
    why: 'Chrome device ids are a 64-char lowercase hex HMAC, with `default` and `communications` passed through verbatim. Any other shape â€” a short token, uppercase, a UUID â€” is a tell on its own, before anyone compares values across origins.',
    run: `(async () => {
      const list = await navigator.mediaDevices.enumerateDevices();
      if (!list.length) return { inconclusive: true, detail: 'no devices enumerated in this environment' };
      const hex = /^[0-9a-f]{64}$/;
      const reserved = new Set(['default', 'communications', '']);
      const bad = [];
      for (const d of list) {
        if (!reserved.has(d.deviceId) && !hex.test(d.deviceId)) bad.push(d.kind + ' deviceId=' + d.deviceId);
        if (d.groupId && !hex.test(d.groupId)) bad.push(d.kind + ' groupId=' + d.groupId);
        // A groupId equal to its own deviceId would mean one salt was reused for both, letting a page
        // derive one from the other.
        if (d.groupId && d.groupId === d.deviceId) bad.push(d.kind + ' groupId equals deviceId');
      }
      return { pass: bad.length === 0, detail: bad.length ? bad.join('; ') : list.length + ' devices, all ids well formed' };
    })()`,
  },
  {
    id: 'fonts-limited-to-the-persona-set',
    finding: 'windows-font-isolation',
    status: 'fixed',
    surface: 'fonts',
    severity: 'critical',
    // Off Windows the isolation is the launcher's per-profile FONTCONFIG_FILE, not a property of the
    // binary, and this harness launches without one â€” so a leak here would be the harness, not the
    // engine. Only a build that carries the DirectWrite filter can be judged.
    applies: (ctx) => ctx.capabilities.includes('font-isolation'),
    why: 'The installed font set is high-entropy and readable without permission by measuring text width against a fallback. Any family measurable but NOT claimed by the persona is a host font leaking through.',
    run: (persona) => `(() => {
      // Probe families that exist on some machines and not others â€” the exact set a detector walks.
      // Anything measurable here must be in the persona list, or it came from the host.
      const probes = [
        'Arial', 'Times New Roman', 'Courier New', 'Segoe UI', 'Calibri', 'Cambria', 'Consolas',
        'Candara', 'Corbel', 'Franklin Gothic Medium', 'Gabriola', 'Georgia', 'Impact',
        'Lucida Console', 'Palatino Linotype', 'Sylfaen', 'Tahoma', 'Trebuchet MS', 'Verdana',
        'Wingdings', 'MS Gothic', 'Meiryo', 'SimSun', 'Malgun Gothic', 'Leelawadee UI',
        'Adobe Garamond Pro', 'Helvetica Neue', 'Menlo', 'SF Pro Text', 'Ubuntu', 'DejaVu Sans',
        'Liberation Serif', 'Noto Sans CJK JP', 'Cantarell', 'FreeSans',
      ];
      const c = document.createElement('canvas').getContext('2d');
      const text = 'mmmmmmmmmmlli WWW 0123';
      const baseline = {};
      for (const generic of ['monospace', 'sans-serif', 'serif']) {
        c.font = '72px ' + generic;
        baseline[generic] = c.measureText(text).width;
      }
      const present = probes.filter((f) => {
        for (const generic of ['monospace', 'sans-serif', 'serif']) {
          c.font = '72px "' + f + '", ' + generic;
          if (c.measureText(text).width !== baseline[generic]) return true;
        }
        return false;
      });
      const claimed = new Set(${JSON.stringify(persona.fonts ?? [])}.map((f) => f.toLowerCase()));
      // Chromium's own last-resort families are always resolvable by design: getLastResortFallbackFont
      // crashes the renderer if none of them load, so the filter cannot be allowed to remove them.
      const alwaysAllowed = new Set(['sans', 'arial', 'ms ui gothic', 'microsoft sans serif',
                                     'segoe ui', 'calibri', 'times new roman', 'courier new']);
      const leaked = present.filter((f) => !claimed.has(f.toLowerCase()) && !alwaysAllowed.has(f.toLowerCase()));
      return {
        pass: leaked.length === 0,
        detail: present.length + '/' + probes.length + ' probed families resolve; ' +
                (leaked.length ? 'LEAKED (not in persona): ' + leaked.join(', ') : 'none outside the persona set'),
      };
    })()`,
  },
  {
    id: 'fonts-persona-families-resolve',
    finding: 'windows-font-isolation',
    status: 'open',
    surface: 'fonts',
    applies: (ctx) => ctx.capabilities.includes('font-isolation'),
    why: 'The other half of isolation: a persona MISSING fonts a real machine of that class has is as identifying as one with too many. Filtering can only subtract, so closing this needs the font pack provisioned and sideloaded.',
    // DELIBERATELY LEFT OPEN even though it currently passes. It passes because this build host is
    // a Windows machine whose installed fonts happen to cover the Windows persona - the "add" half
    // is not being exercised at all. Flipping it to 'fixed' on that evidence would claim the font
    // pack works when no pack is provisioned. It closes when it passes on a host that LACKS the
    // claimed families, which is the only run that measures the sideload.
    run: (persona) => `(() => {
      const want = ${JSON.stringify((persona.fonts ?? []).slice(0, 40))};
      if (!want.length) return { inconclusive: true, detail: 'persona carries no font list' };
      const c = document.createElement('canvas').getContext('2d');
      const text = 'mmmmmmmmmmlli WWW 0123';
      const baseline = {};
      for (const generic of ['monospace', 'sans-serif', 'serif']) {
        c.font = '72px ' + generic;
        baseline[generic] = c.measureText(text).width;
      }
      const missing = want.filter((f) => {
        for (const generic of ['monospace', 'sans-serif', 'serif']) {
          c.font = '72px "' + f + '", ' + generic;
          if (c.measureText(text).width !== baseline[generic]) return false;
        }
        return true;
      });
      return {
        pass: missing.length === 0,
        detail: (want.length - missing.length) + '/' + want.length + ' claimed families resolve' +
                (missing.length ? '; absent: ' + missing.slice(0, 8).join(', ') + (missing.length > 8 ? ' +' + (missing.length - 8) + ' more' : '') : ''),
      };
    })()`,
  },

  // ── The mechanism CreepJS actually runs ────────────────────────────────────────────────────────
  //
  // Everything above tests canvas fidelity the way the audit reasoned about it. This tests it the way
  // the detector implements it, which is the only version that decides a score: 64 single-pixel
  // fillRects with random colours, each read straight back with a 1x1 getImageData. One differing
  // channel anywhere in those 64 is what prints "pixel data modified" (docs/FARBLE_DETECTION.md).
  {
    id: 'canvas-getpixelmods-known-input',
    finding: 'canvas-read-rect-dependent-farble',
    status: 'fixed',
    surface: 'canvas',
    severity: 'critical',
    why: 'CreepJS getPixelMods: 64 known 1x1 writes read back one pixel at a time. Known input, known output, no host baseline needed â€” which is why it is the check every profile is scored on.',
    run: `(() => {
      const len = 8, alpha = 255;
      const opts = { willReadFrequently: true, desynchronized: true };
      const c = document.createElement('canvas'); c.width = len; c.height = len;
      const x = c.getContext('2d', opts);
      const written = [];
      for (let px = 0; px < len; px++) for (let y = 0; y < len; y++) {
        const r = ~~(Math.random() * 256), g = ~~(Math.random() * 256), b = ~~(Math.random() * 256);
        x.fillStyle = 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
        x.fillRect(px, y, 1, 1);
        written.push([r, g, b, alpha]);
      }
      let diffs = 0;
      const channels = new Set();
      let i = 0;
      for (let px = 0; px < len; px++) for (let y = 0; y < len; y++, i++) {
        const d = x.getImageData(px, y, 1, 1).data;
        const w = written[i];
        let differs = false;
        for (let k = 0; k < 4; k++) if (d[k] !== w[k]) { differs = true; channels.add('rgba'[k]); }
        if (differs) diffs++;
      }
      // The other half of the same if() in creep.js: a cleared canvas must read all-zero.
      const c2 = document.createElement('canvas'); c2.width = 50; c2.height = 50;
      const x2 = c2.getContext('2d', opts);
      x2.font = '35px sans-serif'; x2.fillText('\\u{1F47E}', 0, 37);
      x2.clearRect(0, 0, 50, 50);
      const clearedMax = Math.max(...x2.getImageData(0, 0, 8, 8).data);
      return {
        pass: diffs === 0 && clearedMax === 0,
        detail: diffs + '/64 known-input pixels modified' + (channels.size ? ' (' + [...channels].join('') + ')' : '') +
                ', cleared-canvas max byte ' + clearedMax,
      };
    })()`,
  },
  {
    id: 'canvas-getpixelmods-toblob',
    finding: 'canvas-snapshot-readback-bypass',
    status: 'fixed',
    surface: 'canvas',
    why: 'toBlob is a third readback path beside getImageData and toDataURL. PNG is lossless, so a known-input write must survive the encode/decode byte-exact â€” and must agree with what getImageData reports for the same canvas.',
    run: `(async () => {
      const len = 8;
      const c = document.createElement('canvas'); c.width = len; c.height = len;
      const x = c.getContext('2d', { willReadFrequently: true });
      for (let px = 0; px < len; px++) for (let y = 0; y < len; y++) {
        x.fillStyle = 'rgba(' + ((px * 31) % 256) + ', ' + ((y * 37) % 256) + ', ' + ((px * y * 7) % 256) + ', 255)';
        x.fillRect(px, y, 1, 1);
      }
      const direct = x.getImageData(0, 0, len, len).data;
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      if (!blob) return { inconclusive: true, detail: 'toBlob produced no blob' };
      const bmp = await createImageBitmap(blob);
      const c2 = document.createElement('canvas'); c2.width = len; c2.height = len;
      const x2 = c2.getContext('2d', { willReadFrequently: true });
      x2.drawImage(bmp, 0, 0);
      const viaBlob = x2.getImageData(0, 0, len, len).data;
      let diff = 0;
      for (let i = 0; i < direct.length; i++) if (direct[i] !== viaBlob[i]) diff++;
      return { pass: diff === 0, detail: diff + '/' + direct.length + ' bytes differ between toBlob and getImageData' };
    })()`,
  },
  {
    id: 'canvas-getpixelmods-offscreen',
    finding: 'canvas-read-rect-dependent-farble',
    status: 'fixed',
    surface: 'canvas',
    why: 'OffscreenCanvas is the same 2D backend reached through a different object. A known-input write that survives on the main canvas and not here means the two paths farble differently, which is measurable in one page.',
    run: `(() => {
      if (typeof OffscreenCanvas === 'undefined') return { inconclusive: true, detail: 'OffscreenCanvas unavailable' };
      const len = 8;
      const o = new OffscreenCanvas(len, len);
      const x = o.getContext('2d', { willReadFrequently: true });
      if (!x) return { inconclusive: true, detail: 'no 2d context on OffscreenCanvas' };
      const written = [];
      for (let px = 0; px < len; px++) for (let y = 0; y < len; y++) {
        const r = ~~(Math.random() * 256), g = ~~(Math.random() * 256), b = ~~(Math.random() * 256);
        x.fillStyle = 'rgba(' + r + ', ' + g + ', ' + b + ', 255)';
        x.fillRect(px, y, 1, 1);
        written.push([r, g, b, 255]);
      }
      let diffs = 0, i = 0;
      for (let px = 0; px < len; px++) for (let y = 0; y < len; y++, i++) {
        const d = x.getImageData(px, y, 1, 1).data;
        for (let k = 0; k < 4; k++) if (d[k] !== written[i][k]) { diffs++; break; }
      }
      return { pass: diffs === 0, detail: diffs + '/64 known-input pixels modified on an OffscreenCanvas' };
    })()`,
  },

  // ── Cross-context coherence ───────────────────────────────────────────────────────────────────
  //
  // Farbling is per-profile, so the SAME scene must produce the SAME bytes in every execution context
  // of the profile. A window/worker/iframe split is not noise, it is a signature: a page renders the
  // scene twice, sees two different hashes, and knows the values are synthesised without ever knowing
  // what the host really is. CreepJS scores exactly this under "cross-context lies".
  {
    id: 'crosscontext-canvas-window-vs-worker',
    finding: 'farble-cross-context-coherence',
    status: 'fixed',
    surface: 'canvas',
    aspect: 'crossContext',
    severity: 'critical',
    why: 'The same OffscreenCanvas scene rendered in the window and in a worker must hash identically; a per-context seed makes the profile self-contradicting on one page.',
    run: `(async () => {
      if (typeof OffscreenCanvas === 'undefined') return { inconclusive: true, detail: 'OffscreenCanvas unavailable' };
      const draw = (canvas) => {
        const x = canvas.getContext('2d', { willReadFrequently: true });
        x.textBaseline = 'top';
        x.font = '14px "Arial"';
        x.fillStyle = '#f60'; x.fillRect(2, 2, 60, 20);
        x.fillStyle = '#069'; x.fillText('Lobium coherence', 4, 24);
        const d = x.getImageData(0, 0, canvas.width, canvas.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i++) h = ((h << 5) - h + d[i]) | 0;
        return (h >>> 0).toString(16);
      };
      const here = draw(new OffscreenCanvas(120, 60));
      const src = '(' + draw.toString() + ')';
      const worker = new Worker(URL.createObjectURL(new Blob([
        'self.onmessage = () => { try { self.postMessage(' + src + '(new OffscreenCanvas(120, 60))); }' +
        ' catch (e) { self.postMessage("error:" + e.message); } };'
      ], { type: 'text/javascript' })));
      worker.postMessage(0);
      const there = await new Promise((res) => { worker.onmessage = (e) => res(e.data); setTimeout(() => res('timeout'), 10000); });
      worker.terminate();
      if (String(there).startsWith('error:') || there === 'timeout') {
        return { inconclusive: true, detail: 'worker could not render: ' + there };
      }
      return { pass: here === there, detail: 'window=' + here + ' worker=' + there };
    })()`,
  },
  {
    id: 'crosscontext-canvas-window-vs-iframe',
    finding: 'farble-cross-context-coherence',
    status: 'fixed',
    surface: 'canvas',
    aspect: 'crossContext',
    why: 'A same-origin iframe is its own document with its own execution context. Its canvas must farble with the profile seed, not a per-frame one.',
    run: `(async () => {
      const frame = document.createElement('iframe');
      frame.src = '/frame.html';
      document.body.appendChild(frame);
      await new Promise((res, rej) => { frame.onload = res; frame.onerror = rej; setTimeout(res, 10000); });
      const draw = (doc) => {
        const c = doc.createElement('canvas'); c.width = 120; c.height = 60;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.textBaseline = 'top';
        x.font = '14px "Arial"';
        x.fillStyle = '#f60'; x.fillRect(2, 2, 60, 20);
        x.fillStyle = '#069'; x.fillText('Lobium coherence', 4, 24);
        const d = x.getImageData(0, 0, 120, 60).data;
        let h = 0;
        for (let i = 0; i < d.length; i++) h = ((h << 5) - h + d[i]) | 0;
        return (h >>> 0).toString(16);
      };
      const here = draw(document);
      const inner = frame.contentDocument;
      if (!inner) { frame.remove(); return { inconclusive: true, detail: 'iframe document unreachable' }; }
      const there = draw(inner);
      frame.remove();
      return { pass: here === there, detail: 'window=' + here + ' iframe=' + there };
    })()`,
  },
  {
    id: 'crosscontext-webgl-window-vs-worker',
    finding: 'farble-cross-context-coherence',
    status: 'fixed',
    surface: 'webgl',
    aspect: 'crossContext',
    why: 'WEBGL_debug_renderer_info read from a worker must name the same card as the window. A worker reporting the host GPU beside a spoofed window is the cleanest possible proof of a rewriter.',
    run: `(async () => {
      const read = (gl) => {
        if (!gl) return null;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return [
          ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '',
          ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : '',
          gl.getParameter(gl.VERSION),
        ].join('|');
      };
      const here = read(document.createElement('canvas').getContext('webgl'));
      if (!here) return { inconclusive: true, detail: 'no WebGL context in the window' };
      if (typeof OffscreenCanvas === 'undefined') return { inconclusive: true, detail: 'OffscreenCanvas unavailable' };
      const src = '(' + read.toString() + ')';
      const worker = new Worker(URL.createObjectURL(new Blob([
        'self.onmessage = () => { try { self.postMessage(' + src + '(new OffscreenCanvas(8, 8).getContext("webgl"))); }' +
        ' catch (e) { self.postMessage("error:" + e.message); } };'
      ], { type: 'text/javascript' })));
      worker.postMessage(0);
      const there = await new Promise((res) => { worker.onmessage = (e) => res(e.data); setTimeout(() => res('timeout'), 10000); });
      worker.terminate();
      if (!there || String(there).startsWith('error:') || there === 'timeout') {
        return { inconclusive: true, detail: 'worker WebGL unavailable: ' + there };
      }
      return { pass: here === there, detail: 'window=' + here + ' worker=' + there };
    })()`,
  },
  {
    id: 'crosscontext-audio-window-vs-iframe',
    finding: 'farble-cross-context-coherence',
    status: 'fixed',
    surface: 'audio',
    aspect: 'crossContext',
    why: 'The OfflineAudioContext render is the audio fingerprint. Rendering the same graph in a same-origin iframe must produce the same sum, or the profile carries two audio identities at once.',
    run: `(async () => {
      const render = async (view) => {
        const Ctx = view.OfflineAudioContext || view.webkitOfflineAudioContext;
        if (!Ctx) return null;
        const ctx = new Ctx(1, 5000, 44100);
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = 10000;
        const comp = ctx.createDynamicsCompressor();
        osc.connect(comp); comp.connect(ctx.destination);
        osc.start(0);
        const buf = await ctx.startRendering();
        const data = buf.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
        return sum.toFixed(10);
      };
      const frame = document.createElement('iframe');
      frame.src = '/frame.html';
      document.body.appendChild(frame);
      await new Promise((res) => { frame.onload = res; setTimeout(res, 10000); });
      const inner = frame.contentWindow;
      if (!inner) { frame.remove(); return { inconclusive: true, detail: 'iframe window unreachable' }; }
      const here = await render(window);
      const there = await render(inner);
      frame.remove();
      if (here === null || there === null) return { inconclusive: true, detail: 'OfflineAudioContext unavailable' };
      return { pass: here === there, detail: 'window=' + here + ' iframe=' + there };
    })()`,
  },

  // ── WebRTC ────────────────────────────────────────────────────────────────────────────────────
  //
  // The single highest-value leak in the product: ICE gathering happens below the fetch stack, so a
  // profile can route every request through a residential proxy and still hand the page its real LAN
  // and WAN addresses in an SDP. The policy that prevents it is native (`webrtc-policy`), and until
  // now nothing measured whether it engaged.
  {
    id: 'webrtc-candidates-carry-no-ip-literal',
    finding: 'webrtc-ice-host-candidate-leak',
    status: 'fixed',
    surface: 'webrtc',
    severity: 'critical',
    why: 'Under the launch policy every host candidate must be an mDNS `.local` name. An IPv4 or IPv6 literal in a candidate line is the host address, readable by any page with no permission prompt.',
    run: `(async () => {
      if (typeof RTCPeerConnection === 'undefined') return { inconclusive: true, detail: 'RTCPeerConnection unavailable' };
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('probe');
      const lines = [];
      const gathered = new Promise((res) => {
        pc.onicecandidate = (e) => { if (!e.candidate) res(); else lines.push(e.candidate.candidate); };
        setTimeout(res, 8000);
      });
      await pc.setLocalDescription(await pc.createOffer());
      await gathered;
      const sdp = pc.localDescription ? pc.localDescription.sdp : '';
      pc.close();
      if (!lines.length) return { inconclusive: true, detail: 'no ICE candidates gathered in this environment' };
      const ipv4 = /^\\d{1,3}(\\.\\d{1,3}){3}$/;
      const leaks = [];
      for (const line of lines) {
        const address = line.split(' ')[4] || '';
        if (address.endsWith('.local')) continue;
        // 0.0.0.0 is the placeholder the stack emits when it has nothing to offer, not an address.
        if (address === '0.0.0.0' || address === '::') continue;
        if (ipv4.test(address) || address.includes(':')) leaks.push(address + ' (' + line.split(' ')[7] + ')');
      }
      // The connection line is written separately from the candidates and has leaked on its own.
      for (const c of sdp.split('\\r\\n').filter((l) => l.startsWith('c='))) {
        const address = c.split(' ')[2] || '';
        if (address !== '0.0.0.0' && address !== '::' && !address.endsWith('.local')) leaks.push('c=' + address);
      }
      return {
        pass: leaks.length === 0,
        detail: lines.length + ' candidates; ' + (leaks.length ? 'LEAKED: ' + leaks.join(', ') : 'all mDNS or placeholder'),
      };
    })()`,
  },
  {
    id: 'webrtc-host-candidates-are-mdns',
    finding: 'webrtc-ice-host-candidate-leak',
    status: 'fixed',
    surface: 'webrtc',
    why: 'The absence of literals is only half the claim: a policy that suppressed host candidates entirely would also pass it, and a browser that gathers no host candidate at all is itself unusual. Real Chrome emits mDNS host candidates, so that is what must be there.',
    run: `(async () => {
      if (typeof RTCPeerConnection === 'undefined') return { inconclusive: true, detail: 'RTCPeerConnection unavailable' };
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('probe');
      const lines = [];
      const gathered = new Promise((res) => {
        pc.onicecandidate = (e) => { if (!e.candidate) res(); else lines.push(e.candidate.candidate); };
        setTimeout(res, 8000);
      });
      await pc.setLocalDescription(await pc.createOffer());
      await gathered;
      pc.close();
      if (!lines.length) return { inconclusive: true, detail: 'no ICE candidates gathered in this environment' };
      const host = lines.filter((l) => / typ host/.test(l));
      const mdns = host.filter((l) => (l.split(' ')[4] || '').endsWith('.local'));
      return {
        pass: host.length > 0 && mdns.length === host.length,
        detail: mdns.length + '/' + host.length + ' host candidates are mDNS names (' + lines.length + ' total)',
      };
    })()`,
  },
  {
    id: 'webrtc-reflexive-address-is-the-proxy',
    finding: 'webrtc-ice-host-candidate-leak',
    status: 'fixed',
    surface: 'webrtc',
    severity: 'critical',
    // Needs a real egress to compare against. With no proxy there is nothing to be wrong ABOUT, so
    // the oracle does not apply rather than reporting an unmeasured pass.
    applies: (ctx) => Boolean(ctx.exitIp),
    why: 'A server-reflexive candidate carries whatever address the STUN server saw. If UDP escaped the proxy, that is the real WAN address sitting next to a proxied HTTP request from the same profile.',
    run: (persona, ctx) => `(async () => {
      if (typeof RTCPeerConnection === 'undefined') return { inconclusive: true, detail: 'RTCPeerConnection unavailable' };
      const pc = new RTCPeerConnection({ iceServers: [{ urls: ${JSON.stringify(ctx.stunUrl)} }] });
      pc.createDataChannel('probe');
      const lines = [];
      const gathered = new Promise((res) => {
        pc.onicecandidate = (e) => { if (!e.candidate) res(); else lines.push(e.candidate.candidate); };
        setTimeout(res, 12000);
      });
      await pc.setLocalDescription(await pc.createOffer());
      await gathered;
      pc.close();
      const reflexive = lines.filter((l) => / typ (srflx|relay)/.test(l)).map((l) => l.split(' ')[4]);
      if (!reflexive.length) {
        // Under disable_non_proxied_udp the stack is SUPPOSED to gather no reflexive candidate at all,
        // which is the strongest possible answer: nothing left the proxy.
        return { pass: true, detail: 'no server-reflexive candidate gathered â€” UDP never left the proxy' };
      }
      const want = ${JSON.stringify(ctx.exitIp)};
      const wrong = [...new Set(reflexive.filter((a) => a !== want))];
      return { pass: wrong.length === 0, detail: 'reflexive=' + [...new Set(reflexive)].join(',') + ' proxy exit=' + want };
    })()`,
  },

  // ── Locale and languages ──────────────────────────────────────────────────────────────────────
  //
  // navigator.languages is read by every detector and by every site that guesses a locale, and it is
  // carried on the wire as Accept-Language. The JS value and the header are produced by different
  // layers of the browser, so they are exactly the pair that drifts apart.
  {
    id: 'languages-match-the-persona',
    finding: 'navigator-languages-coherence',
    status: 'fixed',
    surface: 'locale',
    aspect: 'languages',
    severity: 'critical',
    why: 'navigator.languages and navigator.language are the persona locale or they are the host locale; there is no third option, and the host locale beside a proxied exit IP is the contradiction detectors look for first.',
    run: (persona) => `(() => {
      const want = ${JSON.stringify(persona.navigator.languages)};
      const got = [...navigator.languages];
      const listOk = got.length === want.length && got.every((v, i) => v === want[i]);
      const primaryOk = navigator.language === want[0];
      return {
        pass: listOk && primaryOk,
        detail: 'languages=' + JSON.stringify(got) + ' language=' + navigator.language + ' want ' + JSON.stringify(want),
      };
    })()`,
  },
  {
    id: 'languages-agree-across-contexts',
    finding: 'navigator-languages-coherence',
    status: 'fixed',
    surface: 'locale',
    aspect: 'languages',
    why: 'Workers, iframes and service workers each build their own navigator. A window that reports the persona while a worker reports the host is a cross-context lie CreepJS scores directly.',
    run: (persona) => `(async () => {
      const want = JSON.stringify(${JSON.stringify(persona.navigator.languages)});
      const seen = { window: JSON.stringify([...navigator.languages]) };

      const worker = new Worker(URL.createObjectURL(new Blob([
        'self.postMessage(JSON.stringify([...navigator.languages]))'
      ], { type: 'text/javascript' })));
      seen.worker = await new Promise((res) => { worker.onmessage = (e) => res(e.data); setTimeout(() => res('timeout'), 8000); });
      worker.terminate();

      const frame = document.createElement('iframe');
      frame.src = '/frame.html';
      document.body.appendChild(frame);
      await new Promise((res) => { frame.onload = res; setTimeout(res, 8000); });
      seen.iframe = frame.contentWindow ? JSON.stringify([...frame.contentWindow.navigator.languages]) : 'unreachable';
      frame.remove();

      if (navigator.serviceWorker) {
        try {
          const reg = await navigator.serviceWorker.register('/sw.js');
          await navigator.serviceWorker.ready;
          const active = reg.active || navigator.serviceWorker.controller;
          if (active) {
            const channel = new MessageChannel();
            seen.serviceWorker = await new Promise((res) => {
              channel.port1.onmessage = (e) => res(e.data.languages);
              active.postMessage('languages', [channel.port2]);
              setTimeout(() => res('timeout'), 8000);
            });
          } else {
            seen.serviceWorker = 'no active worker';
          }
          await reg.unregister();
        } catch (err) {
          seen.serviceWorker = 'error: ' + err.message;
        }
      } else {
        seen.serviceWorker = 'unavailable';
      }

      const contexts = Object.entries(seen);
      const unreadable = contexts.filter(([, v]) => v === 'timeout' || v === 'unreachable' || v === 'unavailable' || String(v).startsWith('error:'));
      if (unreadable.length) {
        return { inconclusive: true, detail: 'could not read ' + unreadable.map(([k, v]) => k + '=' + v).join(', ') };
      }
      const wrong = contexts.filter(([, v]) => v !== want);
      return {
        pass: wrong.length === 0,
        detail: wrong.length ? wrong.map(([k, v]) => k + '=' + v).join('; ') + ' want ' + want
                             : contexts.length + ' contexts all report ' + want,
      };
    })()`,
  },
  {
    id: 'accept-language-header-matches-navigator',
    finding: 'navigator-languages-coherence',
    status: 'fixed',
    surface: 'locale',
    aspect: 'languages',
    severity: 'critical',
    why: 'The header is emitted by the network stack and the JS value by Blink. They are set by different hooks, so they drift independently â€” and a page that compares its own request header against navigator.languages catches it without any fingerprinting library at all.',
    run: (persona) => `(async () => {
      const res = await fetch('/echo', { cache: 'no-store' });
      const headers = await res.json();
      const header = headers['accept-language'] || '';
      const want = ${JSON.stringify(persona.locale.acceptLanguage)};
      // Blink derives the header from the language list, so the primary language must lead it and every
      // listed language must appear; q-values are Chrome's own formatting and are not asserted.
      const listed = header.split(',').map((part) => part.split(';')[0].trim()).filter(Boolean);
      const langs = [...navigator.languages];
      const missing = langs.filter((l) => !listed.includes(l));
      return {
        pass: header === want && missing.length === 0,
        detail: 'Accept-Language="' + header + '" persona="' + want + '"' +
                (missing.length ? ' missing from header: ' + missing.join(',') : ''),
      };
    })()`,
  },
];

// ---------------------------------------------------------------------------------------------

const EXIT_PASS = 0;
const EXIT_REGRESSION = 1;
const EXIT_BLOCKED = 2;

function fmt(row) {
  const mark = row.pass ? 'PASS' : row.inconclusive ? '  ? ' : row.status === 'open' ? 'OPEN' : 'FAIL';
  return `  [${mark}] ${row.personaOs.padEnd(7)} ${row.id.padEnd(38)} ${row.detail}`;
}

/**
 * The page the oracles run in, plus the three extra resources they need:
 *
 *   /frame.html  a same-origin document, so cross-context coherence has a second context to compare
 *                against without leaving the origin.
 *   /sw.js       a service worker, the one context whose navigator is built furthest from the page.
 *   /echo        the request headers as JSON, which is how Accept-Language becomes readable from
 *                inside the browser at all â€” it is not exposed to script any other way.
 *
 * `about:blank` is NOT a secure context, and `navigator.userAgentData` â€” which several oracles read â€”
 * is only exposed in one, so on about:blank they threw instead of measuring anything. A loopback
 * origin is "potentially trustworthy" per the spec, so it gives a secure context with no certificate
 * machinery.
 */
function createOracleServer() {
  const page = '<!doctype html><meta charset="utf-8"><title>lobium oracles</title><body></body>';
  const frame = '<!doctype html><meta charset="utf-8"><title>lobium frame</title><body></body>';
  const sw = `self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => {
  const reply = {
    languages: JSON.stringify([...navigator.languages]),
    language: navigator.language,
    userAgent: navigator.userAgent,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  if (e.ports && e.ports[0]) e.ports[0].postMessage(reply);
});`;
  return createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(req.headers));
      return;
    }
    if (path === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(sw);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(path === '/frame.html' ? frame : page);
  });
}

/**
 * The TLS ClientHello and the HTTP/2 SETTINGS frame cannot be read from a page, so those two aspects
 * are measured by tls-fingerprint.mjs and folded in here from its report.
 *
 * A report older than the age limit describes some earlier engine, and an absent one describes
 * nothing at all. Both cases yield an INCONCLUSIVE row, which blocks the aspect â€” the alternative is
 * a run that never touched the network reporting network aspects green.
 */
async function networkRows(personaOs) {
  const stale = (detail) => [
    { id: 'tls-clienthello-matches-stock-chrome', aspect: 'networkTls', status: 'fixed', personaOs, pass: false, inconclusive: true, detail },
    { id: 'http2-settings-match-stock-chrome', aspect: 'networkHttp2', status: 'fixed', personaOs, pass: false, inconclusive: true, detail },
  ];
  let report;
  try {
    report = JSON.parse(await readFile(TLS_REPORT, 'utf8'));
  } catch {
    return stale(`no ${TLS_REPORT} â€” run tls-fingerprint.mjs before the oracles to score TLS/HTTP2`);
  }
  const age = Date.now() - Date.parse(report.generatedAt ?? '');
  if (!Number.isFinite(age) || age > TLS_REPORT_MAX_AGE_MS) {
    return stale(`tls-fingerprint.json is ${Number.isFinite(age) ? Math.round(age / 60000) + ' minutes' : 'of unknown age'} old â€” too stale to describe this engine`);
  }
  const rows = (report.oracleRows ?? []).filter((r) => r.personaOs === personaOs);
  return rows.length ? rows : stale(`tls-fingerprint.json carries no rows for the ${personaOs} persona`);
}

/** Run every applicable oracle once against one persona OS. */
async function measurePersona({ bin, personaOs, seed, headful, capabilities, pageUrl, exitIp, stunUrl }) {
  const persona = deriveFingerprint(seed, { os: personaOs, engine: 'lobium' });
  const config = buildLobiumConfig(persona, { seed });
  const ctx = {
    personaOs,
    hostPlatform: process.platform,
    capabilities: capabilities.capabilities,
    persona,
    exitIp,
    stunUrl,
  };

  // The config must exist before the browser starts â€” the browser process reads it once during
  // startup â€” so write it to its own directory rather than the profile's, and launch once.
  const configDir = await mkdtemp(join(tmpdir(), 'lobium-oracles-cfg-'));
  const configPath = await writeLobiumConfig(configDir, config);

  const rows = [];
  const engine = await launchEngine({
    bin,
    headless: !headful,
    extraArgs: [lobiumConfigArg(configPath), ...buildGpuArgs()],
    env: { TZ: persona.locale.timezone },
  });
  try {
    await withCdpSession(engine.ws, async (session) => {
      await session.send('Page.navigate', { url: pageUrl });
      for (let i = 0; i < 100; i++) {
        const ready = await cdpEvaluate(session, `(() => location.origin + '|' + document.readyState)()`, { timeoutMs: 10_000 });
        if (String(ready).startsWith('http://127.0.0.1') && String(ready).endsWith('|complete')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const ctxInfo = await cdpEvaluate(session, `(() => location.href + ' secure=' + window.isSecureContext)()`, { timeoutMs: 10_000 });
      console.log(`context    ${personaOs} persona Â· ${ctxInfo}`);

      for (const oracle of ORACLES) {
        if (oracle.applies && !oracle.applies(ctx)) {
          rows.push({
            ...oracle,
            run: undefined,
            applies: undefined,
            personaOs,
            aspect: aspectOf(oracle),
            applicable: false,
            pass: false,
            inconclusive: false,
            detail: 'does not apply to this persona/build',
          });
          continue;
        }
        const expression = typeof oracle.run === 'function' ? oracle.run(persona, ctx) : oracle.run;
        let pass = false;
        let inconclusive = false;
        let detail = '';
        try {
          const res = await cdpEvaluate(session, expression, { timeoutMs: 45_000 });
          pass = Boolean(res && res.pass);
          inconclusive = Boolean(res && res.inconclusive);
          detail = (res && res.detail) || '';
        } catch (err) {
          // A throwing oracle measured nothing. That is INCONCLUSIVE, not a pass and not a
          // regression â€” reporting a broken probe as either would be a lie about the engine.
          inconclusive = true;
          detail = `oracle threw: ${err instanceof Error ? err.message : String(err)}`;
        }
        rows.push({
          ...oracle,
          run: undefined,
          applies: undefined,
          personaOs,
          aspect: aspectOf(oracle),
          pass,
          inconclusive,
          detail,
        });
      }
    });
  } finally {
    await engine.close().catch(() => {});
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
  }
  return { rows, config };
}

async function main() {
  const bin = process.env.LOBSTER_LOBIUM_BIN || resolveLobiumBinary();
  if (!bin) {
    console.error(
      'BLOCKED â€” no Lobium binary. These oracles measure the SHIPPING engine; running them against\n' +
        'stock Chromium would report a wall of failures that mean nothing. Set LOBSTER_LOBIUM_BIN.',
    );
    process.exitCode = EXIT_BLOCKED;
    return;
  }

  // Prove it is actually Lobium before drawing any conclusion from a pass.
  const capabilities = await probeLobiumBuildCapabilities(bin);
  console.log(`engine     ${bin}`);
  console.log(`capabilities ${capabilities.capabilities.length}: ${capabilities.capabilities.join(', ')}`);

  const seed = process.argv[2] || generateSeed();
  const headful = process.env.LOBIUM_ORACLES_HEADFUL === '1';
  const exitIp = process.env.LOBIUM_ORACLE_EXIT_IP || '';
  const stunUrl = process.env.LOBIUM_ORACLE_STUN_URL || 'stun:stun.l.google.com:19302';

  // ── The capability gate ──────────────────────────────────────────────────────────────────────
  //
  // The launcher REFUSES to start a profile on a build missing any hook the persona needs
  // (start-profile.ts), so a binary that fails this check cannot ship and cannot be scored: every
  // oracle covering a missing hook would fail, and the run would be filed as a wall of regressions
  // against an engine nobody has actually built yet. That is exactly how thirteen "regressions" got
  // recorded against a five-week-old binary. Probing the capabilities and only PRINTING them made it
  // possible; comparing them against what the product itself requires is what makes it impossible.
  const available = new Set(capabilities.capabilities);
  const requiredByOs = PERSONA_OSES.map((os) => {
    const persona = deriveFingerprint(seed, { os, engine: 'lobium' });
    const policy = buildLobiumConfig(persona, { seed }).policy;
    return requiredLobiumCapabilities(policy, persona.locale.geolocation !== undefined);
  });
  const missing = [...new Set(requiredByOs.flat())].filter((c) => !available.has(c));
  if (missing.length) {
    // Overwrite any coverage report left behind by an earlier run on this machine. A stale
    // aspect-coverage.json is worse than none: it is uploaded as this run's artifact and reads as a
    // current score for a binary that was never measured.
    await mkdir(REPORTS_DIR, { recursive: true });
    await writeFile(
      join(REPORTS_DIR, 'aspect-coverage.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          engine: bin,
          verdict: 'blocked',
          reason: `build lacks native hooks the launcher requires: ${missing.join(', ')}`,
          missingCapabilities: missing,
          capabilities: capabilities.capabilities,
          aspectsPassed: 0,
          aspectsTotal: ASPECTS.length,
          coverageIndex: 0,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.error(
      `\nBLOCKED â€” this build is missing ${missing.length} native hook(s) the launcher requires:\n  ` +
        missing.join('\n  ') +
        '\n\nThe product refuses to launch a profile on it (packages/engine-runner start-profile), so any\n' +
        'score measured here would describe a binary that cannot ship. This is neither a pass nor a\n' +
        'regression: rebuild the engine from the current patch series and run the oracles again.',
    );
    process.exitCode = EXIT_BLOCKED;
    return;
  }

  const server = createOracleServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;

  const gpuArgs = buildGpuArgs();
  console.log(`gpu mode   ${resolveGpuMode()}${gpuArgs.length ? ` (${gpuArgs.join(' ')})` : ' â€” no GPU flags; WebGL will be unavailable headless'}`);
  console.log(`page       ${pageUrl}`);
  console.log(`personas   ${PERSONA_OSES.join(', ')}${exitIp ? ` Â· proxy exit ${exitIp}` : ' Â· no proxy exit configured'}\n`);

  const rows = [];
  try {
    for (const personaOs of PERSONA_OSES) {
      const measured = await measurePersona({
        bin, personaOs, seed, headful, capabilities, pageUrl, exitIp, stunUrl,
      });
      rows.push(...measured.rows);
      rows.push(...(await networkRows(personaOs)));
    }
  } finally {
    server.close();
  }

  const scored = rows.filter((r) => r.applicable !== false);
  const regressions = scored.filter((r) => !r.pass && !r.inconclusive && r.status === 'fixed');
  const stillOpen = scored.filter((r) => !r.pass && !r.inconclusive && r.status === 'open');
  const closedOpen = scored.filter((r) => r.pass && r.status === 'open');
  const unmeasured = scored.filter((r) => r.inconclusive);
  const score = scoreAspects(rows);

  console.log(`\nseed ${seed} Â· ${headful ? 'headful' : 'HEADLESS (not release evidence)'}\n`);
  for (const r of rows) if (r.applicable !== false) console.log(fmt(r));

  console.log(
    `\n${scored.filter((r) => r.pass).length}/${scored.length} oracles pass` +
      (unmeasured.length ? `, ${unmeasured.length} inconclusive (measured nothing)` : ''),
  );
  console.log(`\nPER-ASPECT COVERAGE\n${formatAspectTable(score)}`);
  if (unmeasured.length) {
    console.log(
      `\nINCONCLUSIVE (${unmeasured.length}) â€” the probe could not run here, so this is neither\n` +
        `evidence of a fix nor of a defect:\n  ` +
        unmeasured.map((r) => `${r.personaOs} ${r.id}: ${r.detail.split('\n')[0]}`).join('\n  '),
    );
  }
  if (closedOpen.length) {
    console.log(
      `\n${closedOpen.length} oracle(s) marked OPEN now PASS â€” if that is a real fix, flip their\n` +
        `status to 'fixed' so a future regression fails the gate:\n  ` +
        [...new Set(closedOpen.map((r) => r.id))].join('\n  '),
    );
  }
  if (stillOpen.length) {
    console.log(
      `\n${stillOpen.length} known-open finding(s) still detectable (tracked in docs/ENGINE_AUDIT.md):\n  ` +
        stillOpen.map((r) => `${r.personaOs} ${r.id}  <- ${r.finding}`).join('\n  '),
    );
  }
  if (regressions.length) {
    console.log(
      `\nREGRESSIONS (${regressions.length}) â€” these were fixed and are broken again:\n  ` +
        regressions.map((r) => `${r.personaOs} ${r.id}: ${r.detail}`).join('\n  '),
    );
  }

  await mkdir(REPORTS_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const reportPath = join(REPORTS_DIR, 'audit-oracles.json');
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        generatedAt,
        engine: bin,
        capabilities: capabilities.capabilities,
        personaOses: PERSONA_OSES,
        seed,
        headful,
        // Headless is explicitly NOT release evidence: several surfaces (real GPU, window geometry,
        // media queries) only behave honestly headful, and detector-matrix.json's evidence policy
        // rejects a software renderer outright.
        releaseEvidence: headful,
        passed: scored.filter((r) => r.pass).length,
        total: scored.length,
        regressions: regressions.map((r) => `${r.personaOs}/${r.id}`),
        stillOpen: stillOpen.map((r) => `${r.personaOs}/${r.id}`),
        rows,
      },
      null,
      2,
    ),
    'utf8',
  );
  const coveragePath = join(REPORTS_DIR, 'aspect-coverage.json');
  await writeFile(
    coveragePath,
    JSON.stringify(
      {
        generatedAt,
        engine: bin,
        seed,
        headful,
        releaseEvidence: headful,
        personaOses: PERSONA_OSES,
        aspects: ASPECTS.map(({ id }) => id),
        ...score,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\nreport:   ${reportPath}\ncoverage: ${coveragePath}`);

  // A regression outranks a block; a block never reads as a pass.
  const exit = regressions.length ? EXIT_REGRESSION : exitCodeFor(score);
  console.log(
    `\nORACLE GATE: ${exit === EXIT_PASS ? 'PASS' : exit === EXIT_REGRESSION ? 'FAIL' : 'BLOCKED'} â€” ` +
      `${score.aspectsPassed}/${score.aspectsTotal} aspects green` +
      (score.failedAspects.length ? `, failed: ${score.failedAspects.join(', ')}` : '') +
      (score.blockedAspects.length ? `, blocked: ${score.blockedAspects.join(', ')}` : ''),
  );
  process.exitCode = exit;
}

// Importable so the aspect contract can be tested offline, where there is no engine to launch.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = EXIT_REGRESSION;
  });
}
