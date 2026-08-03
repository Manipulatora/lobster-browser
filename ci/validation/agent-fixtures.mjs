// Deterministic pathological pages for the live agent battery.
//
// Real sites drift and rate-limit; these do not. Each fixture isolates ONE mechanism a general-purpose
// web agent has to survive, and each has a single verifiable answer buried in it, so a model cannot
// pass from its own knowledge. Served on loopback — the battery enables `allowPrivateNetwork` only for
// the tasks that target them.
import { createServer } from 'node:http';

const page = (
  title,
  body,
) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;margin:24px;line-height:1.5}button{padding:8px 14px}</style>
</head><body>${body}</body></html>`;

const FIXTURES = {
  // Content inside an open shadow root. Perception must walk into it or the page looks empty.
  '/shadow': page(
    'Shadow host',
    `<h1>Shadow DOM</h1><div id="host"></div>
     <script>
       const root = document.getElementById('host').attachShadow({ mode: 'open' });
       root.innerHTML = '<p>Account status: <b>SUSPENDED-4417</b></p>' +
         '<button id="reveal">Reveal reference</button><p id="out"></p>';
       root.getElementById('reveal').addEventListener('click', () => {
         root.getElementById('out').textContent = 'Reference code: ZQ-8831';
       });
     </script>`,
  ),

  // A dropdown built from divs — no <select>, so the native select path cannot work.
  '/combobox': page(
    'Custom combobox',
    `<h1>Choose a region</h1>
     <div id="cb" role="combobox" aria-expanded="false" aria-controls="lb" tabindex="0"
          style="border:1px solid #888;padding:8px;width:220px;cursor:pointer">Select a region…</div>
     <ul id="lb" role="listbox" hidden style="border:1px solid #ccc;width:220px;padding:0;margin:0">
       <li role="option" tabindex="-1" style="padding:8px;list-style:none">Northern Reach</li>
       <li role="option" tabindex="-1" style="padding:8px;list-style:none">Copper Basin</li>
       <li role="option" tabindex="-1" style="padding:8px;list-style:none">Verdant Shelf</li>
     </ul>
     <p id="chosen"></p>
     <script>
       const cb = document.getElementById('cb'), lb = document.getElementById('lb');
       cb.addEventListener('click', () => {
         const open = lb.hidden; lb.hidden = !open; cb.setAttribute('aria-expanded', String(open));
       });
       for (const li of lb.querySelectorAll('[role=option]')) {
         li.addEventListener('click', () => {
           cb.textContent = li.textContent; lb.hidden = true;
           document.getElementById('chosen').textContent =
             li.textContent === 'Copper Basin' ? 'Allocation code: CB-2290' : 'Allocation code: none';
         });
       }
     </script>`,
  ),

  // A consent wall covering the page. The answer is unreachable until it is dismissed.
  '/consent': page(
    'Consent wall',
    `<div id="veil" style="position:fixed;inset:0;background:#000d;color:#fff;display:flex;
          align-items:center;justify-content:center;flex-direction:column;gap:12px;z-index:9999">
       <p>We value your privacy.</p>
       <button id="accept">Accept all</button><button id="reject">Reject non-essential</button>
     </div>
     <h1>Quarterly figures</h1><p>Net revenue for Q3 was <b>£4,182,900</b>.</p>
     <script>
       for (const id of ['accept','reject']) {
         document.getElementById(id).addEventListener('click', () => document.getElementById('veil').remove());
       }
     </script>`,
  ),

  // Same site, same consent wall, but the figure is NOT here. A run that only knows the number from a
  // PREVIOUS run's memory can answer; a run that re-reads the page cannot. That isolation is what makes
  // a memory-recall test mean anything.
  '/consent-archive': page(
    'Consent wall',
    `<div id="veil" style="position:fixed;inset:0;background:#000d;color:#fff;display:flex;
          align-items:center;justify-content:center;flex-direction:column;gap:12px;z-index:9999">
       <p>We value your privacy.</p>
       <button id="accept">Accept all</button>
     </div>
     <h1>Archive</h1><p>Quarterly figures for Q3 are no longer published on this page.</p>
     <script>
       document.getElementById('accept').addEventListener('click', () => document.getElementById('veil').remove());
     </script>`,
  ),

  // 400 links with the answer among them: does priority-ordered truncation hide it?
  '/dense': page(
    'Dense index',
    `<h1>Index</h1><ul>${Array.from(
      { length: 400 },
      (_, i) =>
        `<li><a href="/dense#n${i}">Record ${String(i).padStart(3, '0')}${i === 287 ? ' — clearance token QT-5566' : ''}</a></li>`,
    ).join('')}</ul>`,
  ),

  // Same-origin iframe: readable in principle, so perception must actually descend into it.
  '/iframe': page(
    'Framed content',
    `<h1>Statement</h1><iframe src="/iframe-inner" width="600" height="200"></iframe>`,
  ),
  '/iframe-inner': page('Inner', '<p>Settlement identifier: <b>SX-7742</b></p>'),

  // Content that only exists after a delay, then changes once more.
  '/lazy': page(
    'Lazy',
    `<h1>Loading…</h1><div id="slot">Please wait</div>
     <script>
       setTimeout(() => { document.getElementById('slot').textContent = 'Interim value: 0000'; }, 1200);
       setTimeout(() => { document.getElementById('slot').textContent = 'Final balance: 9,314 units'; }, 3200);
     </script>`,
  ),

  // A control that only becomes enabled after another is used — tests re-observation.
  '/gated': page(
    'Gated form',
    `<h1>Two-step</h1>
     <input id="code" placeholder="Enter unlock word"/>
     <button id="go" disabled>Continue</button><p id="out"></p>
     <script>
       const code = document.getElementById('code'), go = document.getElementById('go');
       code.addEventListener('input', () => { go.disabled = code.value.trim().toLowerCase() !== 'lobee'; });
       go.addEventListener('click', () => { document.getElementById('out').textContent = 'Vault number: VN-6120'; });
     </script>`,
  ),
};

export function startFixtureServer() {
  const server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    const body = FIXTURES[path];
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}
