import type { RawPerception } from '../types.js';

/** Text-first, trace-free perception evaluated in the page's main world. */
export const MAX_ELEMENTS = 90;
export const MAX_NAME = 90;
export const MAX_PAGE_TEXT = 1600;

/**
 * What {@link EXTRACT_SCRIPT} resolves to.
 *
 * The script runs in the page's own main world, so a page-defined global or a patched prototype can
 * make the walk throw. Its top-level catch therefore reports through `error` and returns NO `elements`
 * key: a failed read must not be shaped like a successful read of an empty page, because the only
 * consumer that turns this into the model-facing observation decides "unreadable" from exactly these
 * two tells, and a caller that discriminated on the element array alone would say "no interactive
 * elements visible" about a page that was never read.
 */
export interface ExtractResult extends Partial<RawPerception> {
  /** Present only when the in-page walk threw. The page was NOT read; `elements` is absent. */
  error?: string;
}

/**
 * The ONE definition of how an element is named and typed, as page-evaluated source.
 *
 * Perception decides what the model sees; the executor's pre-dispatch check decides whether the
 * thing under the coordinate is still that element. When those two derived their own answers, they
 * disagreed on the most ordinary controls on the web — a checkbox perceived as `checkbox "Accept
 * terms"` was identified at dispatch time as `input "yes"` (its `value` attribute), a `<select>`
 * labelled by `<label for>` as the concatenation of its options, and a text field as whatever the
 * agent had just typed into it. Every one of those reads as "a DIFFERENT labelled control is here
 * now", so the action was refused as stale drift. The agent could not tick a consent box, could not
 * re-type into a field it had filled, and could not click a labelled select — while every unit test
 * passed, because the check had only ever run against a fake driver returning canned answers.
 *
 * Sharing the source is the fix: a divergence is now impossible rather than merely unlikely.
 */
export const NAME_ROLE_HELPERS = `
    const MAX_NAME = ${MAX_NAME};
    const clip = (s, n = MAX_NAME) => {
      s = String(s || '').replace(/\\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n - 1) + '\\u2026' : s;
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
        const scope = el.getRootNode && el.getRootNode().getElementById ? el.getRootNode() : owner;
        const text = labelledby.split(/\\s+/).map((id) => scope.getElementById(id)?.textContent || '').join(' ');
        if (text.trim()) return clip(text);
      }
      if (['input','textarea','select'].includes(tag)) {
        if (el.id) {
          const scope = el.getRootNode && el.getRootNode().querySelector ? el.getRootNode() : owner;
          const label = scope.querySelector('label[for="' + CSS.escape(el.id) + '"]');
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
    /**
     * document.elementFromPoint retargets a hit inside a shadow tree up to the outermost host, so a
     * control in a web component identifies as its host. Descend through open roots to the node the
     * user would actually hit.
     */
    const deepElementFromPoint = (x, y) => {
      let node = document.elementFromPoint(x, y);
      for (let depth = 0; node && node.shadowRoot && depth < 12; depth++) {
        const inner = node.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === node) break;
        node = inner;
      }
      return node;
    };
`;

/**
 * Walks the top document, open shadow roots, and accessible same-origin frames. No attributes,
 * globals, listeners, or observers are installed. Secret-bearing form values are represented only by
 * `filled:true`; their bytes never leave the page.
 */
export const EXTRACT_SCRIPT = `(() => {
  try {
    const MAX_ELEMENTS = ${MAX_ELEMENTS};
    const MAX_CANDIDATES = 500;
    // Candidates are collected in traversal order and the top document is walked first, so a page dense
    // enough to reach the cap would drop every shadow-root and same-origin-frame control before it was
    // ever ranked — precisely the controls (browser WebUI, web components, embedded forms) that nothing
    // else in the observation can reach. Hold part of the budget back for non-top roots.
    const NESTED_CANDIDATE_RESERVE = 150;
    const MAX_PAGE_TEXT = ${MAX_PAGE_TEXT};
${NAME_ROLE_HELPERS}
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
    let cappedCandidates = false;
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
      const candidateBudget = context === 'top' ? MAX_CANDIDATES - NESTED_CANDIDATE_RESERVE : MAX_CANDIDATES;
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
        if (out.length >= candidateBudget) { truncated++; cappedCandidates = true; continue; }
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
        // Preserve the effective HTML semantics, not just the literal attribute. A <button> inside a
        // form defaults to type=submit even when it has no explicit type attribute; losing that distinction
        // lets a generic-looking "Continue" bypass the pre-execution commit gate.
        const form = el.form || el.closest?.('form');
        const effectiveType = tag === 'button' ? (type || 'submit').toLowerCase() : (type || '').toLowerCase();
        if (form && ((tag === 'button' && effectiveType === 'submit') || (tag === 'input' && ['submit','image'].includes(effectiveType)))) item.submitsForm = true;
        // Keyboard actions have no element id. Surface focus so an Enter/Space approval names the
        // control it is bound to; the policy still fails closed if focus is outside the bounded tree.
        try {
          if (owner.activeElement === el || root.activeElement === el) item.focused = true;
        } catch {}
        if (el.isContentEditable) item.editable = true;
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
    // The truncation footer tells the model the cut was made by relevance. That is true of the ranked
    // slice below, but not of candidates dropped at the collection cap, which are lost in traversal
    // order before any score exists. Say when that happened so the model knows the page is denser than
    // the ranking can account for and reaches for extract/scroll instead of trusting the ranking.
    if (cappedCandidates) signals.push('too-many-candidates');
    // A cross-origin frame is STRUCTURALLY invisible to this extractor: contentDocument throws, so its
    // controls produce no elements at all. Without a signal the model sees a page that looks simply
    // empty and has no idea a payment form, captcha or consent dialog is sitting in front of it. Say
    // so, and say it only when the frame is big enough to matter.
    try {
      var blindFrames = 0;
      for (var fi = 0; fi < document.querySelectorAll('iframe').length && fi < 40; fi++) {
        var fr = document.querySelectorAll('iframe')[fi];
        var reachable = false;
        try { reachable = !!(fr.contentDocument && fr.contentDocument.documentElement); } catch (e) { reachable = false; }
        if (reachable) continue;
        var fb = fr.getBoundingClientRect();
        if (fb.width >= 60 && fb.height >= 40) blindFrames++;
      }
      if (blindFrames > 0) signals.push('cross-origin-frame:' + blindFrames);
    } catch (e) {}
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
    // Report a failed read AS a failed read. A well-formed perception carrying an empty elements array
    // here is indistinguishable from a genuinely empty page: no page-unreadable signal is raised, the
    // model is told "(no interactive elements visible — try scrolling, waiting, or navigating)" about a
    // page nobody could read, and the post-action verification that fails only on that signal certifies
    // the unread page as observed. No elements key plus an error string are both of perception's failure
    // tells, so an in-page exception lands exactly where a rejected evaluate does. The url is kept
    // (the caller redacts it) because naming the page is most of the value of the failure message.
    return { url: location.href, error: String(error?.message || error) };
  }
})()`;
