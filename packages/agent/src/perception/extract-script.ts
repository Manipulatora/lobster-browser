/** Text-first, trace-free perception evaluated in the page's main world. */
export const MAX_ELEMENTS = 90;
export const MAX_NAME = 90;
export const MAX_PAGE_TEXT = 1600;

/**
 * Walks the top document, open shadow roots, and accessible same-origin frames. No attributes,
 * globals, listeners, or observers are installed. Secret-bearing form values are represented only by
 * `filled:true`; their bytes never leave the page.
 */
export const EXTRACT_SCRIPT = `(() => {
  try {
    const MAX_ELEMENTS = ${MAX_ELEMENTS};
    const MAX_CANDIDATES = 500;
    const MAX_NAME = ${MAX_NAME};
    const MAX_PAGE_TEXT = ${MAX_PAGE_TEXT};
    const clip = (s, n = MAX_NAME) => {
      s = String(s || '').replace(/\\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n - 1) + '\\u2026' : s;
    };
    const safeUrl = (value) => {
      try {
        const url = new URL(String(value), location.href);
        for (const key of [...url.searchParams.keys()]) {
          if (/(token|code|key|secret|pass|session|auth|signature|credential|assertion)/i.test(key)) url.searchParams.set(key, '[REDACTED]');
        }
        if (/(access_token|id_token|token|code|secret|session)/i.test(url.hash)) url.hash = '#[REDACTED]';
        url.username = ''; url.password = '';
        return url.toString();
      } catch { return String(value || '').slice(0, 8192); }
    };
    const topW = window.innerWidth || document.documentElement.clientWidth || 0;
    const topH = window.innerHeight || document.documentElement.clientHeight || 0;
    const interactiveTags = new Set(['a','button','input','textarea','select','summary','label']);
    const interactiveRoles = new Set(['button','link','checkbox','radio','tab','menuitem','switch','option','combobox','listbox','textbox','searchbox','slider','spinbutton','treeitem','menuitemcheckbox','menuitemradio']);
    const secretWords = /(pass(word|code)?|pin|otp|one[ -]?time|2fa|mfa|verification|security.?code|secret|token|api.?key|cvv|cvc|card.?number|credit.?card|private.?key|seed.?phrase)/i;

    const isInteractive = (el) => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      return interactiveTags.has(tag) || (role && interactiveRoles.has(role)) || el.hasAttribute('onclick') || el.isContentEditable || (el.tabIndex >= 0 && ['div','span','li'].includes(tag));
    };
    const roleOf = (el, tag) => {
      const role = el.getAttribute('role');
      if (role) return role;
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
      if (tag === 'textarea' || el.isContentEditable) return 'textbox';
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (['button','submit','reset'].includes(type)) return 'button';
        if (type === 'search') return 'searchbox';
        if (type === 'number') return 'spinbutton';
        return 'textbox';
      }
      return 'generic';
    };
    const nameOf = (el, tag) => {
      const aria = el.getAttribute('aria-label');
      if (aria) return clip(aria);
      const owner = el.ownerDocument || document;
      const labelledby = el.getAttribute('aria-labelledby');
      if (labelledby) {
        const text = labelledby.split(/\\s+/).map((id) => owner.getElementById(id)?.textContent || '').join(' ');
        if (text.trim()) return clip(text);
      }
      if (['input','textarea','select'].includes(tag)) {
        if (el.id) {
          const label = owner.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (label?.textContent?.trim()) return clip(label.textContent);
        }
        const wrapping = el.closest('label');
        if (wrapping?.textContent?.trim()) return clip(wrapping.textContent);
        for (const attr of ['placeholder','name','title']) {
          if (el.getAttribute(attr)) return clip(el.getAttribute(attr));
        }
      }
      const text = (el.innerText || el.textContent || '').trim();
      if (text) return clip(text);
      for (const attr of ['title','alt']) if (el.getAttribute(attr)) return clip(el.getAttribute(attr));
      const image = el.querySelector?.('img[alt]');
      return image ? clip(image.getAttribute('alt')) : '';
    };
    const isSensitive = (el, name) => {
      const type = (el.getAttribute('type') || '').toLowerCase();
      const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
      const identity = [name, el.id, el.getAttribute('name'), el.getAttribute('aria-label'), el.getAttribute('placeholder')].filter(Boolean).join(' ');
      return type === 'password' || /(^| )(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)( |$)/.test(autocomplete) || secretWords.test(identity);
    };
    const stateOf = (el) => {
      const state = [];
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') state.push('disabled');
      if (el.checked || el.getAttribute('aria-checked') === 'true') state.push('checked');
      if (el.getAttribute('aria-expanded') === 'true') state.push('expanded');
      if (el.getAttribute('aria-selected') === 'true' || el.selected) state.push('selected');
      if (el.getAttribute('aria-current')) state.push('current');
      if (el.required || el.getAttribute('aria-required') === 'true') state.push('required');
      if (el.getAttribute('aria-invalid') === 'true') state.push('invalid');
      return state.join(',');
    };

    const out = [];
    const contextualText = [];
    const contextualTextSeen = new Set();
    let truncated = 0;
    const seen = new Set();
    const addedEls = new Set(); // elements actually listed — used for containment collapse
    const addRoot = (root, owner, offsetX, offsetY, context) => {
      // document.body.innerText does not cross shadow boundaries. Capture a small semantic text
      // digest from shadow roots/same-origin frames so browser WebUI and modern web components are
      // understandable without sending a screenshot or repeatedly extracting an empty page.
      if (context !== 'top') {
        let readable = [];
        try { readable = [...root.querySelectorAll('h1,h2,h3,[role="heading"],p,label,button,[role="button"],[role="link"],cr-link-row,cr-toggle-row')]; } catch {}
        for (const node of readable.slice(0, 120)) {
          const text = clip(node.getAttribute?.('aria-label') || node.innerText || node.textContent || '', 180);
          if (text && !contextualTextSeen.has(text)) {
            contextualTextSeen.add(text);
            contextualText.push(text);
          }
        }
      }
      let nodes = [];
      try { nodes = [...root.querySelectorAll('a,button,input,textarea,select,summary,label,[role],[onclick],[tabindex],[contenteditable]')]; } catch {}
      for (const el of nodes) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!isInteractive(el)) continue;
        // Containment collapse: a plain descendant of an already-listed link/button is already
        // represented by that ancestor (whose name includes this text), so skip it. This removes the
        // "one result card = 8 separately-clickable spans/divs" bloat that dominates search/grid pages.
        // Keep genuinely distinct controls: form fields, contenteditable, own onclick/aria-label, or an
        // explicit button role.
        const clickableAncestor = el.parentElement && el.parentElement.closest('a,button,[role="button"]');
        if (
          clickableAncestor && addedEls.has(clickableAncestor) &&
          !interactiveTags.has(el.tagName.toLowerCase()) && !el.isContentEditable &&
          !el.hasAttribute('onclick') && !el.getAttribute('aria-label') && el.getAttribute('role') !== 'button'
        ) continue;
        const rect = el.getBoundingClientRect();
        const localX = rect.left + rect.width / 2;
        const localY = rect.top + rect.height / 2;
        const x = offsetX + localX;
        const y = offsetY + localY;
        if (rect.width < 2 || rect.height < 2 || x < 0 || y < 0 || x > topW || y > topH) continue;
        const style = owner.defaultView?.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || style.pointerEvents === 'none') continue;
        // Occlusion hit-test. document.elementFromPoint retargets a hit inside a shadow tree up to the
        // outermost host, so a control nested in shadow DOM (chrome://settings, or any web component)
        // would look covered by its host and be dropped. Probe the element's OWN root instead (a
        // ShadowRoot's elementFromPoint returns the deepest node in that tree) so shadow controls are
        // hit-tested correctly; fall back to the document for light-DOM elements.
        const hitRoot = el.getRootNode && el.getRootNode();
        const probe = hitRoot && hitRoot !== owner && typeof hitRoot.elementFromPoint === 'function' ? hitRoot : owner;
        const top = probe.elementFromPoint(localX, localY);
        if (top && el !== top && !el.contains(top) && !top.contains(el)) continue;
        if (out.length >= MAX_CANDIDATES) { truncated++; continue; }
        const tag = el.tagName.toLowerCase();
        const name = nameOf(el, tag);
        const item = {
          index: out.length,
          tag,
          role: roleOf(el, tag),
          name,
          x: Math.round(x), y: Math.round(y), w: Math.round(rect.width), h: Math.round(rect.height),
        };
        const type = el.getAttribute('type');
        if (type) item.type = type.toLowerCase();
        if (context !== 'top') item.context = context;
        const sensitive = isSensitive(el, name);
        if (sensitive) item.sensitive = true;
        if (['input','textarea'].includes(tag) && typeof el.value === 'string' && el.value) {
          item.filled = true;
          if (!sensitive) item.value = clip(el.value);
        }
        if (tag === 'select') {
          if (el.selectedOptions.length) item.filled = true;
          if (!sensitive) item.value = clip([...el.selectedOptions].map((o) => o.label || o.value).join(', '));
          item.options = [...el.options].slice(0, 12).map((o) => clip((o.value || '') + '|' + (o.label || ''), 45));
        }
        const href = tag === 'a' ? el.href : (['button','input'].includes(tag) ? el.form?.action : '');
        if (href) item.href = safeUrl(href).slice(0, 8192);
        const state = stateOf(el);
        if (state) item.state = state;
        out.push(item);
        addedEls.add(el);
      }

      let all = [];
      try { all = [...root.querySelectorAll('*')]; } catch {}
      for (const host of all) {
        if (host.shadowRoot) addRoot(host.shadowRoot, owner, offsetX, offsetY, 'shadow:' + clip(nameOf(host, host.tagName.toLowerCase()) || host.tagName.toLowerCase(), 40));
      }
      let frames = [];
      try { frames = [...root.querySelectorAll('iframe,frame')]; } catch {}
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument;
          if (!doc?.documentElement) continue;
          const rect = frame.getBoundingClientRect();
          addRoot(doc, doc, offsetX + rect.left, offsetY + rect.top, 'frame:' + clip(frame.title || frame.name || frame.src || 'same-origin', 50));
        } catch {}
      }
    };
    addRoot(document, document, 0, 0, 'top');

    const priority = (item) => {
      let score = item.name ? 2 : 0;
      if (['textbox','searchbox','combobox','listbox','checkbox','radio','button','switch'].includes(item.role)) score += 5;
      if (item.sensitive || /required|invalid/.test(item.state || '')) score += 3;
      if (item.role === 'generic' || item.role === 'link') score -= 1;
      return score;
    };
    out.sort((a, b) => priority(b) - priority(a) || a.y - b.y || a.x - b.x);
    if (out.length > MAX_ELEMENTS) truncated += out.length - MAX_ELEMENTS;
    const selected = out.slice(0, MAX_ELEMENTS);
    selected.forEach((item, index) => { item.index = index; });

    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const docH = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
    const lightText = (document.querySelector('main,[role="main"],article') || document.body)?.innerText || '';
    const pageText = clip([lightText, contextualText.join(' · ')].filter(Boolean).join(' · '), MAX_PAGE_TEXT);
    const signalText = [document.body?.innerText || '', contextualText.join(' ')].join(' ').slice(0, 8000);
    const signals = [];
    if (/captcha|verify you are human|i am not a robot/i.test(signalText) || document.querySelector('iframe[src*="captcha"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"]')) signals.push('captcha');
    if (/one[ -]?time|verification code|security code|two.factor|2fa|mfa/i.test(signalText)) signals.push('otp');
    if (/sign in|log in|password/i.test(signalText)) signals.push('login');
    if (document.querySelector('[role="dialog"],dialog[open],[aria-modal="true"]')) signals.push('dialog');
    if (document.querySelector('canvas')) signals.push('canvas');
    return {
      url: safeUrl(location.href),
      title: document.title || '',
      scrollY: Math.round(scrollY), viewportW: topW, viewportH: topH, devicePixelRatio: window.devicePixelRatio || 1, docH,
      canScrollUp: scrollY > 4,
      canScrollDown: scrollY + topH < docH - 4,
      text: pageText,
      signals,
      elements: selected,
      truncated,
    };
  } catch (error) {
    return { url: location.href, title: document.title || '', scrollY: 0, viewportH: 0, docH: 0, canScrollUp: false, canScrollDown: false, text: '', signals: [], elements: [], truncated: 0, error: String(error?.message || error) };
  }
})()`;
