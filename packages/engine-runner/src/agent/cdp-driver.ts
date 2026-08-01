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
  /** URL of a popup adopted since the last action reported, so the switch is never silent. */
  private adoptedPopup: string | undefined;

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

  async evaluate<T>(expression: string): Promise<T> {
    try {
      return await cdpEvaluate<T>(this.page, expression);
    } catch (error) {
      // A native alert()/confirm()/beforeunload blocks the renderer, so every Runtime.evaluate hangs
      // until the CDP command timeout. Perception then returned an empty page with no explanation and
      // each further step cost another 30s, with no way out.
      //
      // This CANNOT be auto-dismissed here. Handling a dialog requires Page.handleJavaScriptDialog,
      // and the fork's page_handler.cc rejects it with "No dialog is showing" unless `pending_dialog_`
      // was populated — which only happens while the Page domain is enabled, i.e. exactly the
      // automation tell this driver exists to avoid. Verified against the fork and by experiment.
      //
      // So convert an unexplained hang into an actionable failure: the model is told what is blocking
      // and can hand off to the human, the same way it does for a captcha.
      if (!/timed out/i.test(String(error))) throw error;
      const dismissed = await this.page
        .send('Page.handleJavaScriptDialog', { accept: false })
        .then(() => true)
        .catch(() => false);
      if (dismissed) return await cdpEvaluate<T>(this.page, expression);
      throw new Error(
        'the page is not responding, which usually means a native browser dialog (alert/confirm/print/beforeunload) is open and blocking it — this cannot be dismissed automatically, so ask the human to close the dialog',
      );
    }
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
    const before = await cdpEvaluate<string>(this.page, 'location.href').catch(() => '');
    await this.page.send('Page.navigate', { url });
    // `Page.navigate` resolves when navigation STARTS, not when the new document exists. The settle
    // poll then samples the OLD page, and if the server's TTFB exceeds ~450ms it sees a stable,
    // `complete` document and returns immediately — so the agent perceives and acts on the page it
    // was trying to leave. Wait for the document to actually turn over first.
    if (!before) return;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const current = await cdpEvaluate<string>(this.page, 'location.href').catch(() => '');
      // Any change counts, including a redirect to somewhere other than the requested URL.
      if (current && current !== before) return;
      await sleep(100);
    }
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

  /** Resolve a tab by its stable target id rather than its position in the enumeration. */
  private async tabById(id: string): Promise<CdpTarget> {
    const targets = controllableTargets(await listCdpTargets(this.browserWs));
    const target = targets.find((item) => item.id === id);
    if (!target) throw new Error(`no tab with id ${id} (it may have been closed)`);
    return target;
  }

  async switchTabById(id: string): Promise<void> {
    const target = await this.tabById(id);
    this.knownTargets.add(target.id);
    await this.switchTo(target);
    await this.browser.send('Target.activateTarget', { targetId: target.id });
  }

  async closeTabById(id: string): Promise<void> {
    const targets = controllableTargets(await listCdpTargets(this.browserWs));
    const target = targets.find((item) => item.id === id);
    if (!target) throw new Error(`no tab with id ${id} (it may have been closed)`);
    if (targets.length === 1) throw new Error('refusing to close the only browser tab');
    if (target.id === this.targetId) {
      const next = targets.find((item) => item.id !== target.id) as CdpTarget;
      await this.switchTo(next);
      await this.browser.send('Target.activateTarget', { targetId: next.id });
    }
    await this.browser.send('Target.closeTarget', { targetId: target.id });
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
      case 'set_prefs': {
        const prefs = command.prefs ?? [];
        if (prefs.length === 0) throw new Error('set_prefs needs at least one preference');
        // Verify by READ-BACK, not by the callback. `setPref` reports an unknown key through
        // `chrome.runtime.lastError` rather than a false result, so trusting the callback alone would
        // report a typo'd or removed pref as successfully applied — the agent would then tell the user
        // it changed a setting it never touched. Reading the value back afterwards is the only claim
        // we can actually stand behind, and it also catches prefs that are policy-enforced.
        const applied = await this.withSettingsPage<
          Array<{ key: string; ok: boolean; why?: string }>
        >(
          `new Promise((resolve) => {
             const entries = ${JSON.stringify(prefs)};
             const settle = (fn) => new Promise((done) => fn(done));
             const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
             Promise.all(entries.map(async (entry) => {
               const existing = await settle((d) => chrome.settingsPrivate.getPref(entry.key, d));
               if (chrome.runtime.lastError || !existing) {
                 void chrome.runtime.lastError;
                 return { key: entry.key, ok: false, why: 'no such browser setting' };
               }
               await settle((d) => chrome.settingsPrivate.setPref(entry.key, entry.value, '', d));
               if (chrome.runtime.lastError) {
                 void chrome.runtime.lastError;
                 return { key: entry.key, ok: false, why: 'the browser refused the value' };
               }
               const after = await settle((d) => chrome.settingsPrivate.getPref(entry.key, d));
               void chrome.runtime.lastError;
               return same(after && after.value, entry.value)
                 ? { key: entry.key, ok: true }
                 : { key: entry.key, ok: false, why: 'the value did not stick (it may be enforced by policy)' };
             })).then(resolve);
           })`,
        );
        const failed = applied.filter((entry) => !entry.ok);
        const describeFailures = (): string =>
          failed.map((entry) => `${entry.key} (${entry.why ?? 'refused'})`).join('; ');
        if (failed.length === applied.length)
          throw new Error(`could not apply ${describeFailures()}`);
        const ok = applied.filter((entry) => entry.ok).map((entry) => entry.key);
        return failed.length
          ? `applied and verified ${ok.join(', ')}; could NOT apply ${describeFailures()}`
          : `applied and verified ${ok.join(', ')}`;
      }
      case 'get_prefs': {
        const keys = command.keys ?? [];
        if (keys.length === 0) throw new Error('get_prefs needs at least one key');
        const values = await this.withSettingsPage<Array<[string, unknown]>>(
          `new Promise((resolve) => {
             const keys = ${JSON.stringify(keys)};
             let done = 0;
             const out = [];
             for (const key of keys) {
               chrome.settingsPrivate.getPref(key, (pref) => {
                 out.push([key, pref ? pref.value : null]);
                 if (++done === keys.length) resolve(out);
               });
             }
           })`,
        );
        return values.map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n');
      }
      default: {
        const never: never = command.op;
        throw new Error(`unsupported browser-config op ${String(never)}`);
      }
    }
  }

  /**
   * Run one expression in a `chrome://settings` page context and return its value.
   *
   * WebUI pages are granted the browser's own privileged bindings — `chrome.settingsPrivate` is the
   * very API the settings UI uses to read and write preferences. Evaluating there applies a setting
   * SEMANTICALLY and instantly, instead of opening the settings page and clicking through its controls
   * with the perception loop (brittle, slow, and dependent on Chromium's UI markup not changing).
   *
   * The page is a throwaway: created, used, and closed. It is never activated, never becomes the
   * agent's working target, and never disturbs whatever the user is looking at — so unlike the old
   * UI-fallback path, nothing about the visible browser changes. `Runtime.evaluate` on a fresh session
   * keeps the leak-free invariant: no `*.enable`, no events, no automation tell.
   *
   * Chromium's WebUI attach restriction is enforced only for `chrome.debugger` extensions, not for a
   * `--remote-debugging-port` client, which is why this works with no fork patch. Verified against the
   * real fork (Chrome/152).
   */
  private async withSettingsPage<T>(expression: string): Promise<T> {
    const { targetId } = (await this.browser.send('Target.createTarget', {
      url: 'chrome://settings/',
      background: true,
    })) as { targetId: string };
    let session: PersistentCdpSession | undefined;
    try {
      const wsUrl = await this.waitForTargetWs(targetId);
      session = await openPersistentCdpSession(wsUrl, { resolveTarget: false });
      // The bindings are injected with the page, which has just been created; poll briefly rather than
      // sleeping a fixed amount, so a slow machine does not fail and a fast one does not wait.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const ready = await cdpEvaluate<boolean>(
          session,
          `typeof chrome !== 'undefined' && !!chrome.settingsPrivate`,
        ).catch(() => false);
        if (ready) break;
        await sleep(100);
      }
      return await cdpEvaluate<T>(session, expression);
    } finally {
      try {
        session?.close();
      } catch {
        // The target is closed next regardless.
      }
      await this.browser.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }

  /** A newly created target exposes its debugger URL asynchronously; wait for it to appear. */
  private async waitForTargetWs(targetId: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const targets = await listCdpTargets(this.browserWs).catch(() => []);
      const match = targets.find((target) => target.id === targetId);
      if (match?.webSocketDebuggerUrl) return match.webSocketDebuggerUrl;
      await sleep(100);
    }
    throw new Error('the browser settings page did not expose an automation endpoint');
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

  /**
   * Follow a popup the page just opened, the way a person would.
   *
   * This is necessary — a click that opens a window must not leave the agent driving the old page —
   * but it was also SILENT and unconditional. Any new target adopted the agent, including a tab the
   * HUMAN opened while the run was in flight, and the model was never told its working page had
   * changed underneath it. Now the switch is recorded so the next action outcome can say so, which
   * turns an invisible context swap into something the model can notice and correct.
   */
  private async adoptPopupIfPresent(): Promise<void> {
    const targets = await listCdpTargets(this.browserWs).catch(() => []);
    const fresh = controllableTargets(targets).filter(
      (target) => !this.knownTargets.has(target.id),
    );
    for (const target of targets) this.knownTargets.add(target.id);
    const newest = fresh.at(-1);
    if (!newest) return;
    const from = this.targetId;
    await this.switchTo(newest);
    await this.browser.send('Target.activateTarget', { targetId: newest.id }).catch(() => {});
    if (this.targetId !== from) this.adoptedPopup = newest.url || '(new tab)';
  }

  /**
   * Report and clear a pending popup adoption. The executor folds this into the action's outcome, so
   * the model reads "…and the page opened a new tab, which you are now on" instead of silently
   * finding itself somewhere else next step.
   */
  takeAdoptedPopup(): string | undefined {
    const adopted = this.adoptedPopup;
    this.adoptedPopup = undefined;
    return adopted;
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
