/**
 * The local micro-benchmark battery.
 *
 * Every entry is a self-contained function body evaluated in the page. It must return a number of
 * MILLISECONDS (lower is better) or, for throughput benchmarks, set `higherIsBetter` and return a rate.
 *
 * WHY LOCAL AND DETERMINISTIC. The public suites (Speedometer/JetStream/MotionMark) are the headline
 * numbers, but they move with network conditions and their own releases, so they are poor regression
 * detectors. These run offline against a fixed workload, so a change in the number is a change in the
 * ENGINE - which is what a build/compile-flag investigation needs.
 *
 * `gpu: true` marks a benchmark whose result is meaningless as "engine performance" on a host with no
 * GPU: it is measuring a software rasterizer. The runner flags those rows rather than hiding them.
 */
export const BENCHMARKS = [
  // ---------------------------------------------------------------- JS / compute
  { id: 'js-math-float', group: 'js', body: `
    let a = 0; for (let i = 1; i < 3e6; i++) a += Math.sqrt(i) * Math.sin(i) / Math.log(i + 1);
    return a;` },
  { id: 'js-int-loop', group: 'js', body: `
    let a = 0; for (let i = 0; i < 2e7; i++) a = (a + i * 2654435761) | 0; return a;` },
  { id: 'js-string-build', group: 'js', body: `
    let s = ''; for (let i = 0; i < 2e5; i++) s += (i % 10);
    let n = 0; for (let i = 0; i < s.length; i += 97) n += s.charCodeAt(i); return n;` },
  { id: 'js-array-sort', group: 'js', body: `
    const a = new Array(3e5); for (let i = 0; i < a.length; i++) a[i] = (i * 2654435761) % 1e6;
    a.sort((x, y) => x - y); return a[0];` },
  { id: 'js-object-alloc', group: 'js', body: `
    let n = 0; for (let i = 0; i < 6e5; i++) { const o = { a: i, b: i * 2, c: 'k' + (i & 255) }; n += o.b; }
    return n;` },
  { id: 'js-map-set', group: 'js', body: `
    const m = new Map(); for (let i = 0; i < 4e5; i++) m.set('k' + (i & 65535), i);
    let n = 0; for (const [, v] of m) n += v; return n;` },
  { id: 'js-json-roundtrip', group: 'js', body: `
    const o = []; for (let i = 0; i < 2e4; i++) o.push({ id: i, name: 'row' + i, tags: [i, i + 1, i + 2] });
    let n = 0; for (let r = 0; r < 12; r++) n += JSON.parse(JSON.stringify(o)).length; return n;` },
  { id: 'js-regex-scan', group: 'js', body: `
    const text = ('lorem ipsum dolor sit amet 12345 '.repeat(3000));
    const re = /([a-z]+)\\s+(\\d+)/g; let n = 0, m;
    for (let r = 0; r < 40; r++) { re.lastIndex = 0; while ((m = re.exec(text))) n += m[2].length; }
    return n;` },
  { id: 'js-typedarray', group: 'js', body: `
    const a = new Float64Array(2e6); for (let i = 0; i < a.length; i++) a[i] = i * 0.5;
    let s = 0; for (let r = 0; r < 6; r++) for (let i = 0; i < a.length; i++) s += a[i]; return s;` },
  { id: 'js-promise-churn', group: 'js', async: true, body: `
    let n = 0; for (let i = 0; i < 3e4; i++) n += await Promise.resolve(i) % 7; return n;` },

  // ---------------------------------------------------------------- DOM / layout / style
  { id: 'dom-create-append', group: 'dom', body: `
    const host = document.getElementById('sandbox'); host.textContent = '';
    const f = document.createDocumentFragment();
    for (let i = 0; i < 2e4; i++) { const d = document.createElement('div'); d.className = 'c' + (i & 15);
      d.textContent = 'n' + i; f.appendChild(d); }
    host.appendChild(f); const n = host.childElementCount; host.textContent = ''; return n;` },
  { id: 'dom-query-selector', group: 'dom', body: `
    const host = document.getElementById('sandbox'); host.textContent = '';
    const f = document.createDocumentFragment();
    for (let i = 0; i < 2e4; i++) { const d = document.createElement('div'); d.className = 'c' + (i & 15); f.appendChild(d); }
    host.appendChild(f);
    let n = 0; for (let r = 0; r < 200; r++) n += host.querySelectorAll('.c7').length;
    host.textContent = ''; return n;` },
  { id: 'dom-style-thrash', group: 'dom', body: `
    const host = document.getElementById('sandbox'); host.textContent = '';
    const f = document.createDocumentFragment();
    for (let i = 0; i < 1500; i++) { const d = document.createElement('div'); d.textContent = 's' + i; f.appendChild(d); }
    host.appendChild(f);
    const els = host.children; let h = 0;
    // Deliberately interleaves a write and a read so each iteration forces layout - that is the point
    // of the benchmark. Kept to 1500 nodes x 4 rounds so the forced-layout cost stays bounded.
    for (let r = 0; r < 4; r++) for (let i = 0; i < els.length; i++) {
      els[i].style.paddingLeft = (r + (i & 7)) + 'px'; h += els[i].offsetWidth; }
    host.textContent = ''; return h;` },
  { id: 'dom-reflow-forced', group: 'dom', body: `
    const host = document.getElementById('sandbox'); let h = 0;
    for (let r = 0; r < 400; r++) { host.style.fontSize = (12 + (r & 3)) + 'px'; h += host.offsetHeight; }
    host.style.fontSize = ''; return h;` },
  { id: 'dom-innerhtml-parse', group: 'dom', body: `
    const host = document.getElementById('sandbox'); let n = 0;
    const html = '<p><span>x</span><b>y</b></p>'.repeat(400);
    for (let r = 0; r < 40; r++) { host.innerHTML = html; n += host.childElementCount; }
    host.textContent = ''; return n;` },
  { id: 'dom-getboundingrect', group: 'dom', body: `
    const host = document.getElementById('sandbox'); host.textContent='';
    const f=document.createDocumentFragment();
    for (let i=0;i<3000;i++){const d=document.createElement('div');d.textContent='r'+i;f.appendChild(d);}
    host.appendChild(f);
    const els = host.children; let s = 0;
    for (let r = 0; r < 8; r++) for (let i = 0; i < els.length; i++) s += els[i].getBoundingClientRect().top;
    host.textContent=''; return s;` },

  // ---------------------------------------------------------------- canvas 2D (software raster on a GPU-less host)
  { id: 'canvas-fill-rects', group: 'canvas', gpu: true, body: `
    const c = document.createElement('canvas'); c.width = c.height = 800; const x = c.getContext('2d');
    for (let i = 0; i < 4e4; i++) { x.fillStyle = 'rgb(' + (i & 255) + ',80,120)';
      x.fillRect((i * 7) % 760, (i * 13) % 760, 32, 32); }
    return x.getImageData(0, 0, 1, 1).data[0];` },
  { id: 'canvas-paths', group: 'canvas', gpu: true, body: `
    const c = document.createElement('canvas'); c.width = c.height = 800; const x = c.getContext('2d');
    for (let r = 0; r < 300; r++) { x.beginPath(); for (let i = 0; i < 120; i++)
      x.lineTo((i * 6 + r) % 800, (i * i + r) % 800); x.stroke(); }
    return x.getImageData(0, 0, 1, 1).data[3];` },
  { id: 'canvas-text', group: 'canvas', gpu: true, body: `
    const c = document.createElement('canvas'); c.width = 1200; c.height = 400; const x = c.getContext('2d');
    x.font = '16px sans-serif';
    for (let i = 0; i < 6000; i++) x.fillText('Lobium benchmark ' + i, (i * 11) % 900, (i * 7) % 380);
    return x.measureText('Lobium').width;` },
  { id: 'canvas-getimagedata', group: 'canvas', gpu: true, body: `
    const c = document.createElement('canvas'); c.width = c.height = 512; const x = c.getContext('2d');
    x.fillStyle = '#3a7'; x.fillRect(0, 0, 512, 512); let s = 0;
    for (let r = 0; r < 60; r++) s += x.getImageData(0, 0, 512, 512).data[r & 1023];
    return s;` },
  { id: 'canvas-drawimage-scale', group: 'canvas', gpu: true, body: `
    const src = document.createElement('canvas'); src.width = src.height = 256;
    const sx = src.getContext('2d'); sx.fillStyle = '#e51'; sx.fillRect(0, 0, 256, 256);
    const c = document.createElement('canvas'); c.width = c.height = 1024; const x = c.getContext('2d');
    for (let i = 0; i < 4000; i++) x.drawImage(src, (i * 3) % 700, (i * 5) % 700, 300, 300);
    return x.getImageData(0, 0, 1, 1).data[0];` },

  // ---------------------------------------------------------------- WebGL (software on a GPU-less host)
  { id: 'webgl-context-create', group: 'webgl', gpu: true, body: `
    let n = 0; for (let i = 0; i < 60; i++) { const c = document.createElement('canvas');
      c.width = c.height = 128; if (c.getContext('webgl')) n++; }
    if (n === 0) throw new Error('no webgl context'); return n;` },
  { id: 'webgl-draw-triangles', group: 'webgl', gpu: true, body: `
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const gl = c.getContext('webgl'); if (!gl) throw new Error('no webgl context');
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'); gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, 'precision mediump float;void main(){gl_FragColor=vec4(.3,.7,.9,1.);}'); gl.compileShader(fs);
    const pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr); gl.useProgram(pr);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const tri = new Float32Array([-.5,-.5, .5,-.5, 0,.5]);
    gl.bufferData(gl.ARRAY_BUFFER, tri, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (let i = 0; i < 3000; i++) gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.finish(); return 1;` },
  { id: 'webgl-texture-upload', group: 'webgl', gpu: true, body: `
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const gl = c.getContext('webgl'); if (!gl) throw new Error('no webgl context');
    const px = new Uint8Array(256 * 256 * 4); for (let i = 0; i < px.length; i++) px[i] = i & 255;
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    for (let i = 0; i < 120; i++)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.finish(); return 1;` },
  { id: 'webgl-readpixels', group: 'webgl', gpu: true, body: `
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const gl = c.getContext('webgl'); if (!gl) throw new Error('no webgl context');
    gl.clearColor(.2, .4, .6, 1); const out = new Uint8Array(512 * 512 * 4);
    for (let i = 0; i < 40; i++) { gl.clear(gl.COLOR_BUFFER_BIT);
      gl.readPixels(0, 0, 512, 512, gl.RGBA, gl.UNSIGNED_BYTE, out); }
    return out[0];` },

  // ---------------------------------------------------------------- audio / crypto / storage
  { id: 'audio-offline-render', group: 'audio', async: true, body: `
    let acc = 0;
    for (let r = 0; r < 6; r++) {
      const ctx = new OfflineAudioContext(1, 44100 * 3, 44100);
      const osc = ctx.createOscillator(); const comp = ctx.createDynamicsCompressor();
      osc.type = 'triangle'; osc.frequency.value = 220 + r;
      osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
      const b = await ctx.startRendering(); acc += b.getChannelData(0)[1000];
    }
    return acc;` },
  { id: 'crypto-digest', group: 'crypto', async: true, body: `
    const data = new Uint8Array(1 << 20); for (let i = 0; i < data.length; i++) data[i] = i & 255;
    let n = 0; for (let r = 0; r < 24; r++) n += (await crypto.subtle.digest('SHA-256', data)).byteLength;
    return n;` },
  { id: 'crypto-getrandom', group: 'crypto', body: `
    const a = new Uint8Array(65536); let n = 0;
    for (let r = 0; r < 300; r++) { crypto.getRandomValues(a); n += a[0]; } return n;` },
  { id: 'storage-localstorage', group: 'storage', body: `
    for (let i = 0; i < 4000; i++) localStorage.setItem('bk' + i, 'v'.repeat(64) + i);
    let n = 0; for (let i = 0; i < 4000; i++) n += localStorage.getItem('bk' + i).length;
    for (let i = 0; i < 4000; i++) localStorage.removeItem('bk' + i); return n;` },
  { id: 'storage-indexeddb', group: 'storage', async: true, body: `
    await new Promise((res, rej) => { const r = indexedDB.deleteDatabase('benchdb'); r.onsuccess = res; r.onerror = res; r.onblocked = res; });
    const db = await new Promise((res, rej) => { const r = indexedDB.open('benchdb', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('s', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const tx = db.transaction('s', 'readwrite'); const st = tx.objectStore('s');
      for (let i = 0; i < 3000; i++) st.put({ id: i, payload: 'p'.repeat(100) });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    const count = await new Promise((res, rej) => { const tx = db.transaction('s', 'readonly');
      const rq = tx.objectStore('s').count(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    db.close(); return count;` },

  // ---------------------------------------------------------------- worker / codec
  { id: 'worker-roundtrip', group: 'worker', async: true, body: `
    const src = 'onmessage=(e)=>{let a=0;for(let i=0;i<2e5;i++)a+=i%7;postMessage(a+e.data);}';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    let n = 0;
    for (let i = 0; i < 60; i++) n += await new Promise((res) => { w.onmessage = (e) => res(e.data); w.postMessage(i); });
    w.terminate(); return n;` },
  { id: 'textcodec', group: 'codec', body: `
    const enc = new TextEncoder(); const dec = new TextDecoder();
    const s = 'Lobium — ünïcodé ✓ '.repeat(2000); let n = 0;
    for (let r = 0; r < 120; r++) n += dec.decode(enc.encode(s)).length; return n;` },
]

export const GROUPS = [...new Set(BENCHMARKS.map((b) => b.group))]
