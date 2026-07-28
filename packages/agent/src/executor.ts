import { realpath, stat } from 'node:fs/promises';
import { relative } from 'node:path';
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

const EXTRACT_TEXT = `(() => {
  const chunks = [];
  const roots = [document];
  const seen = new Set();
  let visitedTextNodes = 0;
  const addText = (root) => {
    const doc = root.nodeType === 9 ? root : root.ownerDocument;
    const start = root.nodeType === 9
      ? (root.querySelector('main,[role="main"],article') || root.body || root.documentElement)
      : root;
    if (!doc || !start) return;
    const walker = doc.createTreeWalker(start, NodeFilter.SHOW_TEXT);
    const parts = [];
    let node;
    while ((node = walker.nextNode()) && visitedTextNodes < 6000) {
      visitedTextNodes++;
      const parent = node.parentElement;
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/i.test(parent.tagName)) continue;
      if (parent.hidden || parent.getAttribute('aria-hidden') === 'true') continue;
      const text = (node.nodeValue || '').replace(/\\s+/g, ' ').trim();
      if (text) parts.push(text);
    }
    const value = parts.join(' ').trim();
    if (value && !seen.has(value)) { seen.add(value); chunks.push(value); }
    for (const el of start.querySelectorAll ? start.querySelectorAll('*') : []) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      if (el.tagName === 'IFRAME') {
        try { if (el.contentDocument) roots.push(el.contentDocument); } catch {}
      }
      if (roots.length >= 32) break;
    }
  };
  for (let i = 0; i < roots.length && i < 32; i++) addText(roots[i]);
  const text = chunks.join('\\n\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  return text.length > 6000 ? text.slice(0, 6000) + '\\u2026' : text;
})()`;

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
            outcome: `tabs: ${tabs.map((tab) => `[${tab.index}]${tab.active ? '*' : ''} ${JSON.stringify(tab.title)} ${redactUrl(tab.url)}`).join(' | ') || '(none)'}`,
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
        if (action.index === undefined)
          return { outcome: `error: tab ${action.operation} needs an index` };
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
        const extracted = await driver.evaluate<string>(EXTRACT_TEXT).catch(() => '');
        return { outcome: `extracted page text for: ${action.description}`, extracted };
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

async function validateUploadPaths(paths: string[], roots: string[]): Promise<string[]> {
  const canonicalRoots = await Promise.all(roots.map((root) => realpath(root)));
  const approved: string[] = [];
  for (const path of paths) {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!info.isFile()) throw new Error(`upload target is not a regular file: ${path}`);
    if (!canonicalRoots.some((root) => isWithin(canonical, root))) {
      throw new Error(`upload path is outside the approved roots: ${path}`);
    }
    approved.push(canonical);
  }
  return approved;
}

function isWithin(path: string, root: string): boolean {
  const value = relative(root, path);
  return (
    value === '' || (!value.startsWith('..') && !value.startsWith('/') && !value.startsWith('\\'))
  );
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
