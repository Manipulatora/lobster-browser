import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { AgentAction, AgentConfig } from '@lobster/shared-types';
import { assessBrowserConfig } from './browser-config-guard.js';
import type { BrowserConfigCommand, BrowserDriver } from './driver.js';
import { assessNavigation } from './policy.js';
import { isSensitiveElement, redactUrl } from './security.js';
import type { PerceivedElement, RawPerception } from './types.js';

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ExecOutcome {
  outcome: string;
  terminal?: { success: boolean; summary: string };
  needsInput?: { prompt: string; sensitive?: boolean; targetId?: number };
  extracted?: string;
  /** Structured rows the run accumulates into its dataset. */
  collected?: { rows: Array<Record<string, string>>; columns?: string[] };
  /** Base64 PNG requested for the next model step; never persisted. */
  image?: string;
}

export interface ExecOptions {
  sleep?: Sleep;
  config?: AgentConfig;
  maxWaitMs?: number;
  signal?: AbortSignal;
  /** The loop already obtained a human confirmation for a cross-domain destination. */
  navigationApproved?: boolean;
}

/**
 * Structure-preserving page extraction.
 *
 * The previous version walked text nodes and did `parts.join(' ')`, which flattened an entire table or
 * product grid into ONE space-separated line. Reconstructing "row 3, column 2" from that is guesswork,
 * and guessing is exactly how a scrape reports a price against the wrong product. Tables now emit one
 * line per row with `|` between cells, lists emit one item per line, headings are marked, and link text
 * carries its href — so the row/column relationships the answer depends on survive into the model's
 * context instead of having to be inferred.
 */
const EXTRACT_TEXT = `(() => {
  const MAX = 12000;
  const out = [];
  let budget = MAX;
  const push = (line) => {
    if (budget <= 0) return;
    const value = String(line).replace(/[ \\t]+/g, ' ').trim();
    if (!value) return;
    out.push(value);
    budget -= value.length + 1;
  };
  const txt = (el) => {
    if (!el) return '';
    const raw = el.innerText != null ? el.innerText : el.textContent;
    return String(raw || '').replace(/\\s+/g, ' ').trim();
  };
  const shown = (el) => {
    if (!el || el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    if (!view) return true;
    const style = view.getComputedStyle(el);
    return !style || (style.display !== 'none' && style.visibility !== 'hidden');
  };
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|OBJECT|VIDEO|AUDIO)$/;
  const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|HEADER|MAIN|NAV|P|PRE|SECTION|SUMMARY)$/;
  // Anything whose presence means a container is more than a run of inline text.
  const STRUCTURAL = 'h1,h2,h3,h4,h5,h6,table,ul,ol,li,p,div,section,article,header,footer,nav,form,pre,blockquote,dl,figure,details,fieldset,address,main,aside';

  /** One line of text in document order, with each link's target shown after its label. */
  const inlineWithLinks = (el) => {
    let value = '';
    const visit = (n) => {
      if (!n || budget <= 0) return;
      if (n.nodeType === 3) { value += n.nodeValue || ''; return; }
      if (n.nodeType !== 1) return;
      if (SKIP.test(n.tagName || '') || !shown(n)) return;
      if (n.tagName === 'BR') { value += ' '; return; }
      const before = value.length;
      for (const child of Array.prototype.slice.call(n.childNodes || [])) visit(child);
      if (n.tagName === 'A') {
        const href = n.getAttribute('href') || '';
        // A label alone loses WHICH link it was; the href is often the identifier a scrape needs.
        if (href && !/^(#|javascript:)/i.test(href) && value.length > before) {
          value += ' (' + href + ')';
        }
      }
    };
    for (const child of Array.prototype.slice.call(el.childNodes || [])) visit(child);
    return value;
  };

  const walk = (node, depth) => {
    if (budget <= 0 || depth > 30 || !node) return;
    const tag = node.tagName || '';
    if (SKIP.test(tag) || !shown(node)) return;

    if (/^H[1-6]$/.test(tag)) { push('#'.repeat(Number(tag[1])) + ' ' + txt(node)); return; }

    if (tag === 'TABLE') {
      const rows = node.rows ? Array.prototype.slice.call(node.rows, 0, 300) : [];
      for (const row of rows) {
        const cells = Array.prototype.slice.call(row.cells || [], 0, 40).map(txt);
        if (cells.some((c) => c)) push(cells.join(' | '));
        if (budget <= 0) break;
      }
      push('');
      return;
    }

    if (tag === 'UL' || tag === 'OL') {
      const items = node.children ? Array.prototype.slice.call(node.children, 0, 300) : [];
      let index = 1;
      for (const item of items) {
        if (item.tagName !== 'LI' || !shown(item)) continue;
        // A nested list is handled by recursion; only this item's own text goes on its line.
        const nested = item.querySelector('ul,ol');
        const own = nested ? txt(item).replace(txt(nested), '').trim() : txt(item);
        push((tag === 'OL' ? index++ + '. ' : '- ') + own);
        if (nested) walk(nested, depth + 1);
        if (budget <= 0) break;
      }
      push('');
      return;
    }

    if (tag === 'BR') { push(''); return; }

    // A container holding only inline content is emitted as ONE line, in document order, with link
    // targets annotated in place. Recursing into its children instead would split a sentence around
    // its own links ("See ... for details." then "the returns policy"), which reads as two facts.
    if (!node.querySelector || !node.querySelector(STRUCTURAL)) {
      push(inlineWithLinks(node));
      return;
    }

    const children = node.children ? Array.prototype.slice.call(node.children) : [];
    for (const child of children) {
      walk(child, depth + 1);
      if (budget <= 0) break;
    }
    if (BLOCK.test(tag)) push('');
  };

  const roots = [document];
  for (let i = 0; i < roots.length && i < 32; i++) {
    const root = roots[i];
    const doc = root.nodeType === 9 ? root : root.ownerDocument;
    const start = root.nodeType === 9
      ? (root.querySelector('main,[role="main"],article') || root.body || root.documentElement)
      : root;
    if (!doc || !start) continue;
    walk(start, 0);
    const all = start.querySelectorAll ? start.querySelectorAll('*') : [];
    for (const el of Array.prototype.slice.call(all, 0, 4000)) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      if (roots.length >= 32) break;
    }
  }

  const text = out.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  return text.length > MAX ? text.slice(0, MAX) + '\\u2026[truncated]' : text;
})()`;

/**
 * Confirm the element still under a measured point is the one the model chose.
 *
 * Coordinates are measured when the page is perceived, then an LLM round trip of 1-20s passes before
 * the click is dispatched. Nothing re-checked the target in between, so a cookie banner, a lazily
 * loaded image, or a sticky header appearing in that window silently redirected the click to whatever
 * had moved under the cursor — a wrong click that reports success, which is the worst kind.
 *
 * Deliberately conservative: it only refuses when it can positively identify a DIFFERENT labelled
 * control. An unreadable point, a driver that cannot evaluate, or an ambiguous match all proceed, so
 * this can cost a wrong click but never blocks a correct one.
 */
async function pointStillMatches(
  driver: BrowserDriver,
  element: PerceivedElement,
): Promise<{ ok: true } | { ok: false; found: string }> {
  const script = `(() => {
    const el = document.elementFromPoint(${Math.round(element.x)}, ${Math.round(element.y)});
    if (!el) return null;
    const target = el.closest('a,button,input,textarea,select,summary,label,[role],[onclick],[tabindex],[contenteditable]') || el;
    const name = (
      target.getAttribute('aria-label') ||
      target.getAttribute('placeholder') ||
      target.getAttribute('title') ||
      target.getAttribute('alt') ||
      target.value ||
      target.innerText ||
      target.textContent ||
      ''
    ).replace(/\\s+/g, ' ').trim().slice(0, 120);
    return { name: name, role: (target.getAttribute('role') || target.tagName || '').toLowerCase() };
  })()`;
  let seen: { name?: string; role?: string } | null = null;
  try {
    seen = await driver.evaluate<{ name?: string; role?: string } | null>(script);
  } catch {
    return { ok: true }; // cannot verify — do not block the action
  }
  if (!seen || typeof seen !== 'object') return { ok: true };
  const expected = (element.name ?? '').trim().toLowerCase();
  const actual = (seen.name ?? '').trim().toLowerCase();
  // Only a confident mismatch counts: both sides labelled, and neither contains the other.
  if (!expected || !actual) return { ok: true };
  if (expected === actual || expected.includes(actual) || actual.includes(expected)) {
    return { ok: true };
  }
  return { ok: false, found: `${seen.role ?? 'element'} ${JSON.stringify(seen.name ?? '')}` };
}

const staleTarget = (index: number, element: PerceivedElement, found: string): ExecOutcome => ({
  outcome: `error: the page moved — [${index}] should be ${element.role} ${JSON.stringify(element.name)} but ${found} is there now. Re-read the page and use a fresh index.`,
});

export async function executeAction(
  action: AgentAction,
  perception: RawPerception,
  driver: BrowserDriver,
  opts: ExecOptions = {},
): Promise<ExecOutcome> {
  const sleep = opts.sleep ?? realSleep;
  const maxWaitMs = opts.maxWaitMs ?? 8000;
  try {
    assertNotAborted(opts.signal);
    switch (action.kind) {
      case 'click': {
        const el = findElement(perception, action.id);
        if (!el) return missing(action.id, perception);
        const fresh = await pointStillMatches(driver, el);
        if (!fresh.ok) return staleTarget(action.id, el, fresh.found);
        await driver.click(point(el), {
          ...(action.button ? { button: action.button } : {}),
          ...(action.count ? { count: action.count } : {}),
        });
        await driver.waitForSettle();
        return { outcome: `clicked [${action.id}] ${el.role} ${JSON.stringify(el.name)}` };
      }
      case 'click_at': {
        if (!inViewport(action.x, action.y, perception))
          return { outcome: 'blocked: click coordinates are outside the current viewport' };
        await driver.click(
          { x: action.x, y: action.y },
          {
            ...(action.button ? { button: action.button } : {}),
            ...(action.count ? { count: action.count } : {}),
          },
        );
        await driver.waitForSettle();
        return { outcome: `clicked visual coordinate (${action.x}, ${action.y})` };
      }
      case 'hover': {
        const el = findElement(perception, action.id);
        if (!el) return missing(action.id, perception);
        await driver.hover(point(el));
        await sleepAbortable(250, sleep, opts.signal);
        return { outcome: `hovered [${action.id}] ${JSON.stringify(el.name)}` };
      }
      case 'type': {
        const el = findElement(perception, action.id);
        if (!el) return missing(action.id, perception);
        const stillThere = await pointStillMatches(driver, el);
        if (!stillThere.ok) return staleTarget(action.id, el, stillThere.found);
        await driver.click(point(el));
        if (action.clear) await driver.selectAll();
        await driver.type(action.text);
        if (action.submit) {
          await driver.pressKey('Enter');
          await driver.waitForSettle();
        }
        const shown = isSensitiveElement(el)
          ? '<sensitive>'
          : JSON.stringify(clip(action.text, 40));
        return {
          outcome: `typed ${shown} into [${action.id}] ${JSON.stringify(el.name)}${action.submit ? ' + Enter' : ''}`,
        };
      }
      case 'type_at': {
        if (!inViewport(action.x, action.y, perception))
          return { outcome: 'blocked: type coordinates are outside the current viewport' };
        await driver.click({ x: action.x, y: action.y });
        if (action.clear) await driver.selectAll();
        await driver.type(action.text);
        if (action.submit) {
          await driver.pressKey('Enter');
          await driver.waitForSettle();
        }
        return {
          outcome: `typed <redacted coordinate input> at (${action.x}, ${action.y})${action.submit ? ' + Enter' : ''}`,
        };
      }
      case 'select': {
        const el = findElement(perception, action.id);
        if (!el) return missing(action.id, perception);
        await driver.select(point(el), action.values);
        await driver.waitForSettle(3000);
        return {
          outcome: `selected ${action.values.map((value) => JSON.stringify(value)).join(', ')} in [${action.id}]`,
        };
      }
      case 'key': {
        if (!isSafeKey(action.key))
          return { outcome: `blocked: unsupported key ${JSON.stringify(action.key)}` };
        await driver.pressKey(action.key);
        await driver.waitForSettle(3000);
        return { outcome: `pressed ${action.key}` };
      }
      case 'scroll': {
        if (action.id !== undefined) {
          const el = findElement(perception, action.id);
          if (!el) return missing(action.id, perception);
          await driver.hover(point(el));
        }
        const amount = action.amount ?? Math.round((perception.viewportH || 720) * 0.8);
        await driver.scrollBy(0, amount * (action.direction === 'up' ? -1 : 1));
        await sleepAbortable(250, sleep, opts.signal);
        return {
          outcome: `scrolled ${action.direction}${action.id === undefined ? '' : ` over [${action.id}]`}`,
        };
      }
      case 'drag': {
        const from = findElement(perception, action.fromId);
        const to = findElement(perception, action.toId);
        if (!from) return missing(action.fromId, perception);
        if (!to) return missing(action.toId, perception);
        await driver.drag(point(from), point(to));
        await driver.waitForSettle(3000);
        return { outcome: `dragged [${action.fromId}] to [${action.toId}]` };
      }
      case 'upload': {
        const el = findElement(perception, action.id);
        if (!el) return missing(action.id, perception);
        const roots = opts.config?.allowedUploadRoots ?? [];
        if (roots.length === 0)
          return { outcome: 'blocked: file uploads are disabled for this run' };
        // Uploads had no staleness check, unlike click and type. Attaching a file to whatever moved
        // under the coordinate is worse than a stray click: it sends the file somewhere else.
        const stillThere = await pointStillMatches(driver, el);
        if (!stillThere.ok) return staleTarget(action.id, el, stillThere.found);
        const paths = await validateUploadPaths(action.paths, roots);
        await driver.uploadFiles(point(el), paths);
        await driver.waitForSettle(3000);
        return {
          outcome: `uploaded ${paths.length} approved local file(s) through [${action.id}]`,
        };
      }
      case 'navigate': {
        const current = await driver.currentUrl();
        if (opts.config) {
          const decision = assessNavigation(action.url, current, opts.config);
          if (
            decision.verdict === 'deny' ||
            (decision.verdict === 'confirm' && !opts.navigationApproved)
          ) {
            return { outcome: `blocked: ${decision.reason}` };
          }
        }
        await driver.navigate(action.url);
        await driver.waitForSettle();
        return { outcome: `navigated to ${redactUrl(action.url)}` };
      }
      case 'back':
        await driver.goBack();
        await driver.waitForSettle();
        return { outcome: 'went back' };
      case 'tab': {
        if (action.operation === 'list') {
          const tabs = await driver.listTabs();
          return {
            outcome: `tabs: ${tabs.map((tab) => `${tab.active ? '*' : ''}tabId=${tab.id} ${JSON.stringify(tab.title)} ${redactUrl(tab.url)}`).join(' | ') || '(none)'}`,
          };
        }
        if (action.operation === 'new') {
          if (action.url && opts.config) {
            const decision = assessNavigation(action.url, await driver.currentUrl(), opts.config);
            if (
              decision.verdict === 'deny' ||
              (decision.verdict === 'confirm' && !opts.navigationApproved)
            ) {
              return { outcome: `blocked: ${decision.reason}` };
            }
          }
          await driver.newTab(action.url);
          await driver.waitForSettle();
          return { outcome: `opened a new tab${action.url ? ` at ${redactUrl(action.url)}` : ''}` };
        }
        if (action.tabId) {
          // Stable addressing: unaffected by other tabs opening or closing between list and act.
          const byId = action.operation === 'switch' ? driver.switchTabById : driver.closeTabById;
          if (!byId) return { outcome: 'error: this driver cannot address tabs by id' };
          await byId.call(driver, action.tabId);
          if (action.operation === 'switch') await driver.waitForSettle();
          return {
            outcome: `${action.operation === 'switch' ? 'switched to' : 'closed'} tab ${action.tabId}`,
          };
        }
        if (action.index === undefined)
          return { outcome: `error: tab ${action.operation} needs a tabId or index` };
        if (action.operation === 'switch') {
          await driver.switchTab(action.index);
          await driver.waitForSettle();
          return { outcome: `switched to tab [${action.index}]` };
        }
        await driver.closeTab(action.index);
        return { outcome: `closed tab [${action.index}]` };
      }
      case 'wait': {
        const ms = Math.min(maxWaitMs, Math.max(0, action.ms ?? 1000));
        await sleepAbortable(ms, sleep, opts.signal);
        await driver.waitForSettle();
        return { outcome: `waited ${ms}ms` };
      }
      case 'extract': {
        // Report what actually happened. Swallowing the failure and still saying "extracted" let the
        // model believe it had captured the page when it had captured nothing — it would then answer
        // from memory or invention rather than retrying, which is precisely the grounding failure the
        // system prompt forbids.
        let extracted: string;
        try {
          extracted = await driver.evaluate<string>(EXTRACT_TEXT);
        } catch (error) {
          return {
            outcome: `error: could not read the page text (${error instanceof Error ? error.message : String(error)})`,
          };
        }
        if (!extracted || !extracted.trim()) {
          return {
            outcome:
              'error: the page returned no readable text (it may still be loading, be blocked, or render inside a cross-origin frame)',
          };
        }
        const truncated = extracted.includes('…[truncated]');
        return {
          outcome: `extracted ${extracted.length} characters of page text for: ${action.description}${truncated ? ' (page was longer than the limit; the tail was cut)' : ''}`,
          extracted,
        };
      }
      case 'collect': {
        // The rows are already validated and bounded by the parser; the loop owns accumulation and
        // dedupe, so execution here is just acknowledgement.
        return {
          outcome: `collected ${action.rows.length} row(s)`,
          collected: { rows: action.rows, ...(action.columns ? { columns: action.columns } : {}) },
        };
      }
      case 'browser_config': {
        // The anti-detect guard is the FIRST gate: it hard-blocks any fingerprint/proxy-touching
        // change with no override (see browser-config-guard.ts). Only a cleared verdict proceeds.
        const assessment = assessBrowserConfig(action);
        if (assessment.verdict === 'block') {
          return { outcome: assessment.reason ?? 'blocked: not permitted' };
        }
        if (assessment.settingsUrl) {
          // UI fallback: open the vetted chrome://settings page in a SEPARATE BACKGROUND tab — never
          // navigate the user's current tab (that would hijack what they're viewing) and never render in
          // the panel. The agent drives the background tab's controls over CDP; Chromium applies the
          // change live. When done, the agent should CLOSE this tab (tab close) to leave the user where
          // they were. The guard already screened the URL; this stays leak-free (Page.navigate only).
          await driver.newTab(assessment.settingsUrl, { background: true });
          await driver.waitForSettle();
          const hint = action.value
            ? ` Now set "${action.value}" using the on-page controls (perceive the page, then click/select), then CLOSE this settings tab when the change is confirmed.`
            : ' Use the on-page controls to change the setting, then CLOSE this settings tab when done.';
          return {
            outcome: `opened ${assessment.settingsUrl} in a separate background tab (the user's tab is untouched).${hint}`,
          };
        }
        if (!driver.browserConfig) {
          return { outcome: 'error: browser configuration is unavailable in this driver' };
        }
        const command: BrowserConfigCommand = {
          op: action.op as BrowserConfigCommand['op'],
          ...(action.domain ? { domain: action.domain } : {}),
          ...(action.origin ? { origin: action.origin } : {}),
          ...(action.permission ? { permission: action.permission } : {}),
          ...(action.setting ? { setting: action.setting } : {}),
          ...(action.behavior ? { behavior: action.behavior } : {}),
        };
        const result = await driver.browserConfig(command);
        return { outcome: result };
      }
      case 'ask':
        return {
          outcome: `asked the user: ${action.question}`,
          needsInput: {
            prompt: action.question,
            ...(action.sensitive !== undefined ? { sensitive: action.sensitive } : {}),
            ...(action.targetId !== undefined ? { targetId: action.targetId } : {}),
          },
        };
      case 'screenshot': {
        if (!driver.screenshot)
          return { outcome: 'error: screenshots are unavailable in this browser driver' };
        const image = await driver.screenshot();
        if (!image || image.length > 16_000_000) {
          return { outcome: 'error: screenshot was empty or exceeded the 12MB visual-input limit' };
        }
        return {
          outcome: `captured a visual observation${action.description ? ` for ${action.description}` : ''}`,
          image,
        };
      }
      case 'done':
        return {
          outcome: `done (${action.success ? 'success' : 'gave up'}): ${action.summary}`,
          terminal: { success: action.success, summary: action.summary },
        };
      // `remember` is a memory action handled in the loop before execution — it never drives the
      // browser, so it's a no-op here (present only to keep the switch exhaustive).
      case 'remember':
        return { outcome: `remembered "${action.factKey}"` };
      default: {
        const exhaustive: never = action;
        return { outcome: `error: unknown action ${JSON.stringify(exhaustive)}` };
      }
    }
  } catch (error) {
    if (opts.signal?.aborted) return { outcome: 'error: action aborted' };
    return { outcome: `error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function findElement(perception: RawPerception, index: number): PerceivedElement | undefined {
  return perception.elements.find((element) => element.index === index);
}

function point(element: PerceivedElement): { x: number; y: number } {
  return { x: element.x, y: element.y };
}

function missing(index: number, perception: RawPerception): ExecOutcome {
  // Tell the model the valid range so a weaker model self-corrects on the NEXT step instead of
  // re-guessing a hallucinated index (which wastes steps + tokens — observed with low-tier models).
  const n = perception.elements.length;
  const hint =
    n === 0
      ? 'no interactive elements are listed here — scroll, wait, or navigate first'
      : `valid element indices on this page are 0-${n - 1}`;
  return { outcome: `error: no element [${index}] (${hint})` };
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isSafeKey(key: string): boolean {
  if (/^[A-Za-z0-9 ]$/.test(key)) return true;
  return /^(Enter|Tab|Backspace|Escape|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space|Control\+A|Meta\+A)$/i.test(
    key,
  );
}

/** Absolute cap on an attached file. Chrome would happily stream 10GB to an attacker's server. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Content that must never leave the machine, whatever the model was told.
 *
 * The allowlist bounds WHERE a file may come from, but a root is chosen once for convenience and then
 * everything inside it is one persuasive sentence away from an attacker. This is the backstop that
 * does not depend on location or on the model's judgement: a private key is refused even if it is
 * sitting in the uploads folder.
 */
const SECRET_CONTENT =
  /-----BEGIN (?:[A-Z ]*)?PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----|PuTTY-User-Key-File-|^\s*\[default\][\s\S]*aws_secret_access_key/im;
const SECRET_NAME =
  /(^|[/\\])(id_[a-z0-9]+|\.env(\.[a-z]+)?|credentials|\.netrc|\.htpasswd|wallet\.dat|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk))$/i;

/**
 * Decide whether the agent may attach these files.
 *
 * Every rejection returns the SAME opaque message on purpose. An earlier version ran realpath and stat
 * before the containment check and surfaced the raw errno to the model, which turned the action into a
 * filesystem oracle: a page could ask the agent to "try this path and tell me the error" and read back
 * whether an arbitrary file exists, is a directory, or is a regular file — usernames, installed apps,
 * whether ~/.ssh/id_rsa is there — without ever being allowed a single upload.
 */
async function validateUploadPaths(paths: string[], roots: string[]): Promise<string[]> {
  const denied = new Error('upload path is not permitted');
  const canonicalRoots: string[] = [];
  for (const root of roots) {
    try {
      canonicalRoots.push(await realpath(root));
    } catch {
      continue; // a configured root that does not exist simply grants nothing
    }
  }
  if (canonicalRoots.length === 0) throw denied;

  const approved: string[] = [];
  for (const path of paths) {
    let canonical: string;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      canonical = await realpath(path);
      info = await stat(canonical);
    } catch {
      throw denied;
    }
    // Containment first, and silent about everything else.
    if (!canonicalRoots.some((root) => isWithin(canonical, root))) throw denied;
    if (!info.isFile()) throw denied;
    // A hard link inside a root points at a file outside it and realpath cannot tell the difference,
    // so the link count is the only available signal. Needs no race to exploit.
    if (info.nlink > 1) throw denied;
    if (info.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `file is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB upload limit`,
      );
    }
    if (SECRET_NAME.test(canonical)) throw denied;
    try {
      const handle = await open(canonical, 'r');
      try {
        const head = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        if (SECRET_CONTENT.test(head.subarray(0, bytesRead).toString('latin1'))) throw denied;
      } finally {
        await handle.close();
      }
    } catch (error) {
      throw error === denied ? denied : denied;
    }
    approved.push(canonical);
  }
  return approved;
}

/**
 * Containment test.
 *
 * `path.relative` returns an ABSOLUTE path when the two sides have different roots — on Windows,
 * `relative('C:\\Users\\x\\uploads', 'D:\\secrets\\id_rsa')` is `D:\\secrets\\id_rsa`, which begins with
 * neither `..` nor a separator and so passed the old check. The allowlist then constrained only the
 * drive the root happened to live on, leaving every other volume — including mapped network drives —
 * wide open. The absolute test closes that.
 */
function isWithin(path: string, root: string): boolean {
  const value = relative(root, path);
  if (value === '') return true;
  if (isAbsolute(value)) return false;
  // `..foo.txt` is a legitimate child; only a real `..` segment escapes.
  return value !== '..' && !value.startsWith(`..${sep}`);
}

function inViewport(x: number, y: number, perception: RawPerception): boolean {
  const width = perception.viewportW ?? 20_000;
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0 &&
    x <= width &&
    y <= perception.viewportH
  );
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
}

async function sleepAbortable(
  ms: number,
  sleep: Sleep,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return sleep(ms);
  assertNotAborted(signal);
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const onAbort = (): void => rejectAbort?.(signal.reason ?? new Error('aborted'));
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
