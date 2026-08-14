/**
 * Deterministic real-browser fixture site for the Lobee agent (docs/LOBEE_AGENT_ROADMAP.md §7.2).
 *
 * Every scenario the roadmap requires needs a page that behaves like the real web: content that
 * arrives late, lists that only exist after scrolling, shadow roots, same-origin frames, native
 * selects and custom comboboxes, consent overlays, popups, native dialogs, and a POST that mints a
 * receipt.
 *
 * The load-bearing property is that each server mints a fresh random `nonce` per boot and every
 * answer is derived from it. A model cannot pass a scenario by restating the task, by recalling a
 * public web fact, or by guessing — the fact only exists in this process's memory, and only reaches
 * the agent through the browser it is actually driving. That is what makes this a browser test
 * rather than a prompt test.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

/**
 * `script` is appended at the END of `<body>`, never in `<head>`. A fixture whose setup runs before
 * its own DOM exists throws, silently degrades to a static page, and then "proves" a perception bug
 * that does not exist — which is exactly what happened the first time this file was written.
 */
const html = (title, body, script = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 24px; max-width: 900px; }
  button, input, select { font: inherit; padding: 6px 10px; }
  .row { margin: 10px 0; }
</style></head><body>${body}${script}</body></html>`;

/**
 * @returns {Promise<{ url: string, nonce: string, facts: Record<string,string>,
 *   submissions: Array<Record<string,string>>, close: () => Promise<void>, hits: string[] }>}
 */
export async function startFixtureSite() {
  const nonce = randomBytes(4).toString('hex').toUpperCase();
  /** Per-boot answers. None of these strings exist anywhere outside this process. */
  const facts = {
    /** Visible immediately on /basic. */
    basic: `BASIC-${nonce}`,
    /** Rendered by JS 900ms after load. */
    delayed: `DELAYED-${nonce}`,
    /** Only in the 60th row, which only exists after scrolling. */
    deep: `DEEP-${nonce}`,
    /** Inside an open shadow root. */
    shadow: `SHADOW-${nonce}`,
    /** Inside a same-origin iframe. */
    frame: `FRAME-${nonce}`,
    /** Revealed only after the consent overlay is accepted. */
    consent: `CONSENT-${nonce}`,
    /** Revealed only in the popup opened by target=_blank. */
    popup: `POPUP-${nonce}`,
    /** Revealed only after the native select is set to "gamma". */
    select: `SELECT-${nonce}`,
    /** Revealed only after the custom (non-<select>) combobox picks "delta". */
    combobox: `COMBO-${nonce}`,
    /** Revealed only after the checkbox enables the button and it is clicked. */
    gated: `GATED-${nonce}`,
    /** Only on /recall, a different page on the same host. */
    recall: `RECALL-${nonce}`,
  };
  /** Receipts minted by POST /submit — never present in any page until a real submit happens. */
  const submissions = [];
  const hits = [];

  const routes = {
    '/': () =>
      html(
        'Fixture index',
        `<h1>Lobee fixture site</h1>
         <ul>
           <li><a href="/basic">basic</a></li><li><a href="/delayed">delayed</a></li>
           <li><a href="/scroll">scroll</a></li><li><a href="/shadow">shadow</a></li>
           <li><a href="/frame">frame</a></li><li><a href="/consent">consent</a></li>
           <li><a href="/popup">popup</a></li><li><a href="/controls">controls</a></li>
           <li><a href="/form">form</a></li><li><a href="/recall">recall</a></li>
           <li><a href="/dialog">dialog</a></li><li><a href="/rerender">rerender</a></li>
           <li><a href="/dense">dense</a></li>
         </ul>`,
      ),

    // ── immediately visible ────────────────────────────────────────────────────────────────────
    '/basic': () =>
      html('Basic', `<h1>Basic</h1><p id="fact">The access code is ${facts.basic}.</p>`),

    // ── content that only exists after JS runs, and that keeps changing ────────────────────────
    '/delayed': () =>
      html(
        'Delayed',
        `<h1>Delayed</h1><p id="fact">loading…</p><p id="tick">0</p>`,
        `<script>
           setTimeout(() => { document.getElementById('fact').textContent =
             'The access code is ${facts.delayed}.'; }, 900);
           let n = 0; setInterval(() => { document.getElementById('tick').textContent = String(++n); }, 200);
         </script>`,
      ),

    // ── infinite scroll: row 60 only renders once the reader reaches the bottom ────────────────
    '/scroll': () =>
      html(
        'Scroll',
        `<h1>Scroll</h1><div id="list"></div><p id="end"></p>`,
        `<script>
           let n = 0;
           function add() {
             const list = document.getElementById('list');
             for (let i = 0; i < 20 && n < 60; i++) {
               n++;
               const d = document.createElement('div');
               d.className = 'row';
               d.textContent = n === 60 ? 'row 60: ${facts.deep}' : ('row ' + n + ': filler');
               list.appendChild(d);
             }
             if (n >= 60) document.getElementById('end').textContent = 'end of list';
           }
           add();
           addEventListener('scroll', () => {
             if (innerHeight + scrollY >= document.body.offsetHeight - 200) add();
           });
         </script>`,
      ),

    // ── open shadow root ──────────────────────────────────────────────────────────────────────
    '/shadow': () =>
      html(
        'Shadow',
        `<h1>Shadow</h1><div id="host"></div>`,
        `<script>
           const root = document.getElementById('host').attachShadow({ mode: 'open' });
           root.innerHTML = '<p id="fact">The access code is ${facts.shadow}.</p>' +
             '<button id="inner">Inner button</button>';
         </script>`,
      ),

    // ── same-origin iframe ────────────────────────────────────────────────────────────────────
    '/frame': () =>
      html('Frame', `<h1>Frame</h1><iframe src="/frame-inner" width="600" height="200"></iframe>`),
    '/frame-inner': () =>
      html('Frame inner', `<p id="fact">The access code is ${facts.frame}.</p>`),

    // ── consent overlay that must be accepted before the content is readable ───────────────────
    '/consent': () =>
      html(
        'Consent',
        `<div id="overlay" style="position:fixed;inset:0;background:#111;color:#fff;padding:40px;z-index:9">
           <h2>Privacy choices</h2>
           <p>We need your choice before showing the page.</p>
           <button id="accept">Accept all</button>
           <button id="reject">Reject all</button>
         </div>
         <h1>Consent</h1><p id="fact">hidden</p>`,
        `<script>
           document.getElementById('accept').onclick = () => {
             document.getElementById('overlay').remove();
             document.getElementById('fact').textContent = 'The access code is ${facts.consent}.';
           };
           document.getElementById('reject').onclick = () => {
             document.getElementById('overlay').remove();
             document.getElementById('fact').textContent = 'The access code is unavailable.';
           };
         </script>`,
      ),

    // ── popup / second tab ────────────────────────────────────────────────────────────────────
    '/popup': () =>
      html(
        'Popup',
        `<h1>Popup</h1><p>Open the report in a new tab.</p>
         <a id="open" href="/popup-target" target="_blank" rel="noopener">Open report</a>`,
      ),
    '/popup-target': () =>
      html('Report', `<h1>Report</h1><p id="fact">The access code is ${facts.popup}.</p>`),

    // ── native select, custom combobox, disabled→enabled control ──────────────────────────────
    '/controls': () =>
      html(
        'Controls',
        `<h1>Controls</h1>
         <div class="row">
           <label for="sel">Channel</label>
           <select id="sel"><option value="">choose…</option><option value="alpha">alpha</option>
             <option value="beta">beta</option><option value="gamma">gamma</option></select>
           <span id="selout"></span>
         </div>
         <div class="row">
           <button id="cbtrigger" role="combobox" aria-expanded="false" aria-controls="cblist">Pick a tier</button>
           <ul id="cblist" role="listbox" hidden>
             <li role="option" id="opt-c">charlie</li><li role="option" id="opt-d">delta</li>
           </ul>
           <span id="cbout"></span>
         </div>
         <div class="row">
           <label><input type="checkbox" id="agree"> I agree</label>
           <button id="go" disabled>Reveal</button>
           <span id="goout"></span>
         </div>`,
        `<script>
           const sel = document.getElementById('sel');
           sel.onchange = () => { document.getElementById('selout').textContent =
             sel.value === 'gamma' ? 'The access code is ${facts.select}.' : 'wrong channel'; };
           const trig = document.getElementById('cbtrigger'), list = document.getElementById('cblist');
           trig.onclick = () => { const open = list.hidden; list.hidden = !open;
             trig.setAttribute('aria-expanded', String(open)); };
           for (const li of list.querySelectorAll('li')) {
             li.onclick = () => { list.hidden = true; trig.setAttribute('aria-expanded','false');
               trig.textContent = li.textContent;
               document.getElementById('cbout').textContent =
                 li.id === 'opt-d' ? 'The access code is ${facts.combobox}.' : 'wrong tier'; };
           }
           const agree = document.getElementById('agree'), go = document.getElementById('go');
           agree.onchange = () => { go.disabled = !agree.checked; };
           go.onclick = () => { document.getElementById('goout').textContent =
             'The access code is ${facts.gated}.'; };
         </script>`,
      ),

    // ── multi-field POST that mints a receipt ─────────────────────────────────────────────────
    '/form': () =>
      html(
        'Form',
        `<h1>Order form</h1>
         <form method="POST" action="/submit">
           <div class="row"><label for="name">Full name</label><input id="name" name="name"></div>
           <div class="row"><label for="qty">Quantity</label><input id="qty" name="qty"></div>
           <div class="row"><label for="tier">Tier</label>
             <select id="tier" name="tier"><option value="">choose…</option>
               <option value="std">standard</option><option value="pro">pro</option></select></div>
           <div class="row"><label><input type="checkbox" id="tos" name="tos" value="yes"> Accept terms</label></div>
           <div class="row"><button id="submit" type="submit">Place order</button></div>
         </form>`,
      ),

    // ── a page whose only content is a fact on a DIFFERENT path of the same host ──────────────
    '/recall': () =>
      html('Recall', `<h1>Recall</h1><p id="fact">The saved code is ${facts.recall}.</p>`),

    // ── a native dialog that blocks the renderer ──────────────────────────────────────────────
    '/dialog': () =>
      html(
        'Dialog',
        `<h1>Dialog</h1><p id="fact">hidden behind a dialog</p>`,
        // Synchronous, at parse time: the renderer is blocked before anything can observe the page.
        // A `setTimeout` here raced the agent and usually lost, which made the scenario pass without
        // ever testing the thing it is named after.
        `<script>alert('blocking dialog');</script>`,
      ),

    // ── two controls that trade places on demand (the time-of-check/time-of-use window) ───────
    //
    // The swap is triggered by the harness rather than a timer. A timer makes the outcome a race the
    // test wins or loses at random; triggering it from the pilot puts the page change exactly where
    // the real risk is — after the observation the action was built from, before that action is
    // dispatched — so the assertion is deterministic.
    '/swap': () =>
      html(
        'Swap',
        `<h1>Swap</h1>
         <div id="box">
           <button id="alpha" style="width:180px">Alpha the first button</button>
           <button id="keep" style="width:180px">Keep this one</button>
         </div>
         <p id="out">nothing clicked</p>`,
        `<script>
           const out = document.getElementById('out');
           for (const b of document.querySelectorAll('#box button')) {
             b.onclick = () => { out.textContent = 'clicked:' + b.id; };
           }
           // Exchange the two buttons' positions, so the coordinate measured for one now holds the other.
           window.__swap = () => {
             const box = document.getElementById('box');
             box.insertBefore(box.lastElementChild, box.firstElementChild);
             return 'swapped';
           };
         </script>`,
      ),

    // ── a dense page that exceeds the perception element cap ──────────────────────────────────
    // Perception only lists controls that are actually IN THE VIEWPORT, so a tall stack of 400 rows
    // truncates nothing — it just scrolls. To reach the element cap the controls have to be small
    // enough that far more than `MAX_ELEMENTS` of them are on screen at once.
    '/dense': () => {
      const cells = [];
      for (let i = 1; i <= 300; i++) cells.push(`<button id="b${i}">A${i}</button>`);
      return html(
        'Dense',
        `<h1>Dense</h1><p id="tail">tail marker ${nonce}</p>
         <div id="grid">${cells.join('')}</div>`,
        `<style>
           #grid { display: flex; flex-wrap: wrap; gap: 2px; }
           #grid button { font-size: 9px; padding: 1px 2px; min-width: 22px; }
         </style>`,
      );
    },
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    hits.push(`${req.method} ${url.pathname}`);

    if (req.method === 'POST' && url.pathname === '/submit') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on('end', () => {
        const fields = Object.fromEntries(new URLSearchParams(body));
        const receipt = `RCPT-${nonce}-${String(submissions.length + 1).padStart(2, '0')}`;
        submissions.push({ ...fields, receipt });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          html(
            'Receipt',
            `<h1>Order received</h1><p id="receipt">Your receipt number is ${receipt}.</p>
             <p id="echo">name=${escapeHtml(fields.name ?? '')} qty=${escapeHtml(fields.qty ?? '')} tier=${escapeHtml(fields.tier ?? '')} tos=${escapeHtml(fields.tos ?? '')}</p>`,
          ),
        );
      });
      return;
    }

    const route = routes[url.pathname];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(route());
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    nonce,
    facts,
    submissions,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
