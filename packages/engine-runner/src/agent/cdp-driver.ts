import {
  normalizeBrowserPermission,
  type BrowserConfigCommand,
  type BrowserDriver,
  type BrowserTab,
  type Point,
} from '@lobster/agent';
import { cdpEvaluate } from '../cdp-client.js';
import { humanClick, humanDrag, humanMouseMove, humanType } from '../humanize.js';
import { listCdpTargets, openPersistentCdpSession } from './persistent-cdp.js';
import type { CdpTarget, PersistentCdpSession } from './persistent-cdp.js';

const CTRL = 2;
const META = 4;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class CdpBrowserDriver implements BrowserDriver {
  readonly closed: Promise<void>;
  private readonly browserWs: string;
  private readonly browser: PersistentCdpSession;
  private page: PersistentCdpSession;
  private targetId: string;
  private knownTargets: Set<string>;
  private cursor: Point = { x: 200, y: 200 };
  private isClosed = false;

  private constructor(
    browserWs: string,
    browser: PersistentCdpSession,
    page: PersistentCdpSession,
    target: CdpTarget,
    targets: CdpTarget[],
  ) {
    this.browserWs = browserWs;
    this.browser = browser;
    this.page = page;
    this.targetId = target.id;
    this.knownTargets = new Set(targets.map((item) => item.id));
    this.closed = browser.closed;
  }

  static async create(browserWs: string): Promise<CdpBrowserDriver> {
    const [browser, targets] = await Promise.all([
      openPersistentCdpSession(browserWs, { resolveTarget: false }),
      listCdpTargets(browserWs),
    ]);
    // Never attach the web agent to its own Lobee side panel (or another extension/devtools page).
    // `/json/list` ordering is not a foreground-tab contract, and in real profiles the side panel is
    // frequently first. Prefer an ordinary web tab, then a vetted browser UI tab, then about:blank.
    const target = selectInitialTarget(targets);
    if (!target) {
      browser.close();
      throw new Error('the browser has no page target');
    }
    try {
      const page = await openPersistentCdpSession(target.webSocketDebuggerUrl, {
        resolveTarget: false,
      });
      return new CdpBrowserDriver(browserWs, browser, page, target, targets);
    } catch (error) {
      browser.close();
      throw error;
    }
  }

  evaluate<T>(expression: string): Promise<T> {
    return cdpEvaluate<T>(this.page, expression);
  }

  async click(
    point: Point,
    options: { button?: 'left' | 'right'; count?: 1 | 2 } = {},
  ): Promise<void> {
    await humanClick(this.page, this.cursor, point, options);
    this.cursor = { ...point };
  }

  async hover(point: Point): Promise<void> {
    await humanMouseMove(this.page, this.cursor, point);
    this.cursor = { ...point };
  }

  async drag(from: Point, to: Point): Promise<void> {
    await humanDrag(this.page, this.cursor, from, to);
    this.cursor = { ...to };
  }

  type(text: string): Promise<void> {
    return humanType(this.page, text);
  }

  async pressKey(rawKey: string): Promise<void> {
    const combo = /^(Control|Meta)\+A$/i.exec(rawKey);
    if (combo) {
      await this.dispatchKey('a', 'KeyA', 65, combo[1]?.toLowerCase() === 'meta' ? META : CTRL);
      return;
    }
    const key = normalizeKey(rawKey);
    const info = keyInfo(key);
    await this.dispatchKey(key, info.code, info.vk, 0, info.text);
  }

  selectAll(): Promise<void> {
    const modifier = process.platform === 'darwin' ? META : CTRL;
    return this.dispatchKey('a', 'KeyA', 65, modifier);
  }

  async scrollBy(dx: number, dy: number): Promise<void> {
    await this.page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: this.cursor.x,
      y: this.cursor.y,
      deltaX: dx,
      deltaY: dy,
    });
  }

  async select(point: Point, values: string[]): Promise<void> {
    const objectId = await this.objectAt(point);
    try {
      const result = (await this.page.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(values) {
          if (!(this instanceof HTMLSelectElement)) return { ok: false };
          const wanted = new Set(values);
          let matched = 0;
          for (const option of this.options) {
            const yes = wanted.has(option.value) || wanted.has(option.label) || wanted.has(option.textContent.trim());
            option.selected = yes;
            if (yes) matched++;
          }
          if (!this.multiple && matched > 1) {
            let kept = false;
            for (const option of this.options) if (option.selected) { option.selected = !kept; kept = true; }
          }
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: matched > 0, matched };
        }`,
        arguments: [{ value: values }],
        returnByValue: true,
        userGesture: true,
      })) as { result?: { value?: { ok?: boolean } } };
      if (result.result?.value?.ok) return;
    } finally {
      await this.page.send('Runtime.releaseObject', { objectId }).catch(() => {});
    }

    // Custom ARIA combobox fallback: use the real pointer and keyboard path.
    await this.click(point);
    await this.type(values[0] ?? '');
    await this.pressKey('Enter');
  }

  async uploadFiles(point: Point, paths: string[]): Promise<void> {
    const objectId = await this.objectAt(point);
    let inputObjectId = objectId;
    try {
      const result = (await this.page.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          if (this instanceof HTMLInputElement && this.type === 'file') return this;
          if (this instanceof HTMLLabelElement && this.control instanceof HTMLInputElement && this.control.type === 'file') return this.control;
          return this.querySelector && this.querySelector('input[type=file]');
        }`,
        returnByValue: false,
      })) as { result?: { objectId?: string; subtype?: string } };
      if (!result.result?.objectId || result.result.subtype === 'null') {
        throw new Error('the selected element is not a file input or file-input label');
      }
      inputObjectId = result.result.objectId;
      const described = (await this.page.send('DOM.describeNode', { objectId: inputObjectId })) as {
        node?: { backendNodeId?: number };
      };
      if (!described.node?.backendNodeId) throw new Error('could not resolve the file input node');
      await this.page.send('DOM.setFileInputFiles', {
        files: paths,
        backendNodeId: described.node.backendNodeId,
      });
    } finally {
      if (inputObjectId !== objectId) {
        await this.page.send('Runtime.releaseObject', { objectId: inputObjectId }).catch(() => {});
      }
      await this.page.send('Runtime.releaseObject', { objectId }).catch(() => {});
    }
  }

  async navigate(url: string): Promise<void> {
    await this.page.send('Page.navigate', { url });
  }

  async goBack(): Promise<void> {
    const history = (await this.page.send('Page.getNavigationHistory')) as {
      currentIndex?: number;
      entries?: Array<{ id: number }>;
    };
    const current = history.currentIndex ?? 0;
    const entry = history.entries?.[current - 1];
    if (!entry) throw new Error('there is no previous history entry');
    await this.page.send('Page.navigateToHistoryEntry', { entryId: entry.id });
  }

  async listTabs(): Promise<BrowserTab[]> {
    const targets = controllableTargets(await listCdpTargets(this.browserWs));
    return targets.map((target, index) => ({
      index,
      id: target.id,
      url: target.url,
      title: target.title,
      active: target.id === this.targetId,
    }));
  }

  async newTab(url = 'about:blank', opts?: { background?: boolean }): Promise<void> {
    // `background: true` creates the tab without bringing it to the foreground; `switchTo` only moves
    // the CDP session (never calls Target.activateTarget), so the user's visible tab is left untouched
    // while the agent drives the new one — used for the settings-UI fallback.
    const created = (await this.browser.send('Target.createTarget', {
      url,
      ...(opts?.background ? { background: true } : {}),
    })) as { targetId?: string };
    if (!created.targetId) throw new Error('browser did not create a tab target');
    const target = await this.waitForTarget(created.targetId);
    this.knownTargets.add(target.id);
    await this.switchTo(target);
  }

  async switchTab(index: number): Promise<void> {
    const targets = controllableTargets(await listCdpTargets(this.browserWs));
    const target = targets[index];
    if (!target) throw new Error(`no tab [${index}]`);
    this.knownTargets.add(target.id);
    await this.switchTo(target);
    await this.browser.send('Target.activateTarget', { targetId: target.id });
  }

  async closeTab(index: number): Promise<void> {
    const targets = controllableTargets(await listCdpTargets(this.browserWs));
    const target = targets[index];
    if (!target) throw new Error(`no tab [${index}]`);
    if (targets.length === 1) throw new Error('refusing to close the only browser tab');
    if (target.id === this.targetId) {
      const next = targets.find((item) => item.id !== target.id) as CdpTarget;
      await this.switchTo(next);
      await this.browser.send('Target.activateTarget', { targetId: next.id });
    }
    await this.browser.send('Target.closeTarget', { targetId: target.id });
    this.knownTargets.delete(target.id);
  }

  currentUrl(): Promise<string> {
    return cdpEvaluate<string>(this.page, 'location.href');
  }

  async waitForSettle(timeoutMs = 8000): Promise<void> {
    await this.adoptPopupIfPresent();
    const deadline = Date.now() + timeoutMs;
    const started = Date.now();
    let last = '';
    let stable = 0;
    while (Date.now() < deadline) {
      let signature = '';
      try {
        signature = await cdpEvaluate<string>(
          this.page,
          `location.href + '|' + document.readyState + '|' + (document.body?.innerText?.length || 0) + '|' + document.getElementsByTagName('*').length`,
        );
      } catch {
        await sleep(120);
        continue;
      }
      stable = signature === last ? stable + 1 : 0;
      last = signature;
      if (Date.now() - started >= 450 && stable >= 2 && signature.includes('|complete|')) break;
      if (Date.now() - started >= 700 && stable >= 3 && signature.includes('|interactive|')) break;
      await sleep(150);
      await this.adoptPopupIfPresent();
    }
  }

  async screenshot(): Promise<string> {
    const result = (await this.page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })) as { data?: string };
    return result.data ?? '';
  }

  /**
   * Deep browser-config operations. Every command here is a ONE-SHOT CDP call that never enables an
   * event domain (no `*.enable`), so it is invisible to the visited page and adds no automation tell —
   * the page only observes the effect (its cookies gone, a permission decided), exactly as it would
   * when a real user changes the same setting from the browser UI.
   *
   * Session split is dictated by where each command actually lives (verified against the fork):
   *   - `Browser.*` (permissions, downloads) and `Storage.getCookies` run on the BROWSER target.
   *   - `Network.deleteCookies` / `Network.clearBrowserCache` / `Storage.clearDataForOrigin` are NOT on
   *     the browser target; they run as one-shot commands on the PAGE target (still no domain enable,
   *     still leak-free) and act on the browser-global cookie/cache stores regardless of the page URL.
   */
  async browserConfig(command: BrowserConfigCommand): Promise<string> {
    switch (command.op) {
      case 'clear_cookies': {
        const domain = normalizeDomain(command.domain);
        if (!domain) throw new Error('clear_cookies needs a domain');
        // Enumerate the full cookie store on the browser target, then delete only the domain's cookies
        // (and its subdomains) one-by-one on the page target — siblings for other sites are preserved.
        const { cookies = [] } = (await this.browser.send('Storage.getCookies')) as {
          cookies?: Array<{ name: string; domain: string; path: string }>;
        };
        const victims = cookies.filter((c) => {
          const d = c.domain.replace(/^\./, '');
          return d === domain || d.endsWith(`.${domain}`);
        });
        for (const c of victims) {
          await this.page.send('Network.deleteCookies', {
            name: c.name,
            domain: c.domain,
            path: c.path,
          });
        }
        return `cleared ${victims.length} cookie(s) for ${domain}`;
      }
      case 'clear_all_cookies': {
        const { cookies = [] } = (await this.browser.send('Storage.getCookies')) as {
          cookies?: unknown[];
        };
        // Storage.clearCookies is browser-global and avoids the brittle chrome://settings flow. Keep
        // a Network fallback for older Chromium protocol revisions.
        try {
          await this.browser.send('Storage.clearCookies');
        } catch (error) {
          if (!/method|command|wasn't found|not found/i.test(String(error))) throw error;
          await this.page.send('Network.clearBrowserCookies');
        }
        return `cleared all ${cookies.length} browser cookie(s)`;
      }
      case 'clear_site_data': {
        const origin = originOf(command);
        if (!origin) throw new Error('clear_site_data needs an origin or domain');
        await this.page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
        return `cleared all site data (cookies, storage, cache) for ${origin}`;
      }
      case 'clear_cache': {
        await this.page.send('Network.clearBrowserCache');
        return 'cleared the browser cache';
      }
      case 'set_permission': {
        const name = normalizeBrowserPermission(command.permission);
        if (!name) throw new Error('set_permission needs a permission name');
        const setting = command.setting ?? 'prompt';
        const origin = originOf(command);
        await this.browser.send('Browser.setPermission', {
          permission: { name },
          setting,
          ...(origin ? { origin } : {}),
        });
        return `${setting} "${name}"${origin ? ` for ${origin}` : ' for all origins'}`;
      }
      case 'set_downloads': {
        const behavior =
          command.behavior === 'allow' ? 'allow' : command.behavior === 'deny' ? 'deny' : 'default';
        await this.browser.send('Browser.setDownloadBehavior', { behavior });
        return `set download behavior to ${behavior}`;
      }
      default: {
        const never: never = command.op;
        throw new Error(`unsupported browser-config op ${String(never)}`);
      }
    }
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.page.close();
    this.browser.close();
  }

  private async dispatchKey(
    key: string,
    code: string,
    vk: number,
    modifiers: number,
    text?: string,
  ): Promise<void> {
    await this.page.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: vk,
      modifiers,
      ...(text ? { text } : {}),
    });
    await this.page.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: vk,
      modifiers,
    });
  }

  private async objectAt(point: Point): Promise<string> {
    const located = (await this.page.send('DOM.getNodeForLocation', {
      x: Math.round(point.x),
      y: Math.round(point.y),
      includeUserAgentShadowDOM: true,
      ignorePointerEventsNone: true,
    })) as { backendNodeId?: number };
    if (!located.backendNodeId) throw new Error('could not resolve element at the measured point');
    const resolved = (await this.page.send('DOM.resolveNode', {
      backendNodeId: located.backendNodeId,
    })) as { object?: { objectId?: string } };
    if (!resolved.object?.objectId) throw new Error('could not resolve page element object');
    return resolved.object.objectId;
  }

  private async adoptPopupIfPresent(): Promise<void> {
    const targets = await listCdpTargets(this.browserWs).catch(() => []);
    const fresh = controllableTargets(targets).filter(
      (target) => !this.knownTargets.has(target.id),
    );
    for (const target of targets) this.knownTargets.add(target.id);
    const newest = fresh.at(-1);
    if (newest) {
      await this.switchTo(newest);
      await this.browser.send('Target.activateTarget', { targetId: newest.id }).catch(() => {});
    }
  }

  private async switchTo(target: CdpTarget): Promise<void> {
    if (target.id === this.targetId) return;
    const next = await openPersistentCdpSession(target.webSocketDebuggerUrl, {
      resolveTarget: false,
    });
    const previous = this.page;
    this.page = next;
    this.targetId = target.id;
    this.cursor = { x: 200, y: 200 };
    previous.close();
  }

  private async waitForTarget(targetId: string): Promise<CdpTarget> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const target = (await listCdpTargets(this.browserWs)).find((item) => item.id === targetId);
      if (target) return target;
      await sleep(80);
    }
    throw new Error('new browser tab did not become available');
  }
}

/** Visible/exported for a deterministic unit test; does not perform protocol I/O. */
export function selectInitialTarget(targets: readonly CdpTarget[]): CdpTarget | undefined {
  const controllable = controllableTargets(targets);
  return (
    controllable.find((target) => /^(https?|file):/i.test(target.url)) ??
    controllable.find((target) =>
      /^chrome:\/\/(?:settings|new-tab-page|newtab)(?:\/|$)/i.test(target.url),
    ) ??
    controllable.find((target) => target.url !== 'about:blank') ??
    controllable[0]
  );
}

function controllableTargets(targets: readonly CdpTarget[]): CdpTarget[] {
  return targets.filter(
    (target) =>
      !/^(?:chrome-extension|devtools):/i.test(target.url) &&
      !/^(?:Lobee|Developer Tools)/i.test(target.title),
  );
}

function normalizeKey(raw: string): string {
  const match = [
    'Enter',
    'Tab',
    'Backspace',
    'Escape',
    'Delete',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Space',
  ].find((value) => value.toLowerCase() === raw.toLowerCase());
  return match ?? raw;
}

function keyInfo(key: string): { code: string; vk: number; text?: string } {
  const named: Record<string, { code: string; vk: number; text?: string }> = {
    Enter: { code: 'Enter', vk: 13 },
    Tab: { code: 'Tab', vk: 9 },
    Backspace: { code: 'Backspace', vk: 8 },
    Escape: { code: 'Escape', vk: 27 },
    Delete: { code: 'Delete', vk: 46 },
    ArrowUp: { code: 'ArrowUp', vk: 38 },
    ArrowDown: { code: 'ArrowDown', vk: 40 },
    ArrowLeft: { code: 'ArrowLeft', vk: 37 },
    ArrowRight: { code: 'ArrowRight', vk: 39 },
    Home: { code: 'Home', vk: 36 },
    End: { code: 'End', vk: 35 },
    PageUp: { code: 'PageUp', vk: 33 },
    PageDown: { code: 'PageDown', vk: 34 },
    Space: { code: 'Space', vk: 32, text: ' ' },
  };
  if (named[key]) return named[key] as { code: string; vk: number; text?: string };
  if (/^[a-z]$/i.test(key))
    return { code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0), text: key };
  if (/^[0-9]$/.test(key)) return { code: `Digit${key}`, vk: key.charCodeAt(0), text: key };
  throw new Error(`unsupported key: ${key}`);
}

/** Reduce a user-supplied host/URL to a bare registrable-ish hostname (drops scheme, port, path, leading dot). */
function normalizeDomain(raw?: string): string {
  if (!raw) return '';
  let value = raw.trim().toLowerCase();
  if (!value) return '';
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname;
    } catch {
      value = value.slice(value.indexOf('://') + 3);
    }
  }
  value = value.replace(/^\.+/, '').split('/')[0]?.split(':')[0] ?? '';
  return value;
}

/** Resolve the target origin from an explicit `origin` or by promoting a `domain` to https. */
function originOf(command: BrowserConfigCommand): string | undefined {
  if (command.origin && command.origin.trim()) {
    const value = command.origin.trim();
    try {
      return new URL(value).origin;
    } catch {
      // fall through to domain promotion
    }
  }
  const domain = normalizeDomain(command.domain ?? command.origin);
  return domain ? `https://${domain}` : undefined;
}
