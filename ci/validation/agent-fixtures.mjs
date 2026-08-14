// Deterministic pathological pages for the live agent battery.
//
// Real sites drift and rate-limit; these do not. Each fixture isolates ONE mechanism a general-purpose
// web agent has to survive, and each has a single verifiable answer buried in it, so a model cannot
// pass from its own knowledge. Served on loopback — the battery enables `allowPrivateNetwork` only for
// the tasks that target them.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const page = (
  title,
  body,
) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;margin:24px;line-height:1.5}button{padding:8px 14px}</style>
</head><body>${body}</body></html>`;

const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

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

  // A consent wall covering the page. The answer is not in the DOM or response source at all until a
  // privacy choice fetches it, so perception that incorrectly reads content behind an overlay cannot
  // make this capability pass.
  '/consent': page(
    'Consent wall',
    `<div id="veil" style="position:fixed;inset:0;background:#000d;color:#fff;display:flex;
          align-items:center;justify-content:center;flex-direction:column;gap:12px;z-index:9999">
       <p>We value your privacy.</p>
       <button id="accept">Accept all</button><button id="reject">Reject non-essential</button>
     </div>
     <h1>Quarterly figures</h1><p id="figures">Choose a privacy preference to load figures.</p>
     <script>
       for (const id of ['accept','reject']) {
         document.getElementById(id).addEventListener('click', async () => {
           document.getElementById('veil').remove();
           const response = await fetch('/consent-data', { cache: 'no-store' });
           document.getElementById('figures').textContent = await response.text();
         });
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
  // Unique per battery invocation and revealed only after a successful submit. Repeating values from
  // the prompt can no longer satisfy the form grader without touching the page.
  const formPostReceipt = `LB-${randomBytes(5).toString('hex').toUpperCase()}`;
  const server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/form-post' && req.method === 'GET') {
      const body = page(
        'Order form',
        `<h1>Place an order</h1>
         <form method="post" action="/form-post-result">
           <label>Customer name <input name="custname" autocomplete="off"></label><br>
           <label>Telephone <input name="custtel" autocomplete="off"></label><br>
           <label>Email <input name="custemail" type="email" autocomplete="off"></label>
           <fieldset><legend>Size</legend>
             <label><input name="size" type="radio" value="small"> Small</label>
             <label><input name="size" type="radio" value="medium"> Medium</label>
             <label><input name="size" type="radio" value="large"> Large</label>
           </fieldset>
           <fieldset><legend>Toppings</legend>
             <label><input name="topping" type="checkbox" value="cheese"> Cheese</label>
             <label><input name="topping" type="checkbox" value="onion"> Onion</label>
           </fieldset>
           <button type="submit">Submit order</button>
         </form>`,
      );
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
      return;
    }
    if (path === '/form-post-result' && req.method === 'POST') {
      let encoded = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        encoded += chunk;
        if (encoded.length > 16_384) req.destroy();
      });
      req.on('end', () => {
        const fields = new URLSearchParams(encoded);
        const valid =
          fields.get('custname') === 'Lobee Test' &&
          fields.get('custtel') === '5550100' &&
          fields.get('custemail') === 'lobee@example.com' &&
          fields.get('size') === 'medium' &&
          fields.getAll('topping').length === 1 &&
          fields.get('topping') === 'cheese';
        if (!valid) {
          res
            .writeHead(422, { 'content-type': 'text/html; charset=utf-8' })
            .end(
              page(
                'Order rejected',
                '<h1>Order rejected</h1><p>Every requested field is required.</p>',
              ),
            );
          return;
        }
        const body = page(
          'Order accepted',
          `<h1>Order accepted</h1>
           <dl>
             <dt>custname</dt><dd>${escapeHtml(fields.get('custname') ?? '')}</dd>
             <dt>custtel</dt><dd>${escapeHtml(fields.get('custtel') ?? '')}</dd>
             <dt>custemail</dt><dd>${escapeHtml(fields.get('custemail') ?? '')}</dd>
             <dt>size</dt><dd>${escapeHtml(fields.get('size') ?? '')}</dd>
             <dt>topping</dt><dd>${escapeHtml(fields.getAll('topping').join(', '))}</dd>
             <dt>receipt</dt><dd>${formPostReceipt}</dd>
           </dl>`,
        );
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
      });
      return;
    }
    if (path === '/consent-data' && req.method === 'GET') {
      res
        .writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        })
        .end('Net revenue for Q3 was £4,182,900.');
      return;
    }
    const fixtureBody = FIXTURES[path];
    if (!fixtureBody) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fixtureBody);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        facts: { formPostReceipt },
        close: () => server.close(),
      });
    });
  });
}
