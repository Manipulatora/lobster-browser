import type { BrowserConfigCommand, BrowserDriver, BrowserTab, Point } from '@lobster/agent';
import { CdpBrowserDriver } from './cdp-driver.js';

/**
 * A {@link BrowserDriver} whose browser may not exist yet.
 *
 * The run starts with no browser. Perception sees `ready() === false` and shows the model a
 * "browser closed" observation without touching CDP — so a task answerable from knowledge finishes
 * without ever opening a window. The FIRST action method invoked here requests a browser from the
 * host (which launches the profile and attaches), then delegates every call to the real CDP driver.
 * All stealth properties live in {@link CdpBrowserDriver}; this wrapper adds no protocol traffic.
 */
export class LazyBrowserDriver implements BrowserDriver {
  private real: CdpBrowserDriver | null = null;
  private attaching: Promise<CdpBrowserDriver> | null = null;
  private closeRequested = false;
  private resolveClosed!: () => void;

  /** Resolves when the (eventually attached) browser connection closes. Never resolves if no browser was ever needed. */
  readonly closed: Promise<void> = new Promise((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(
    /** Asks the host for a CDP endpoint (emitting `run.needsBrowser` + awaiting the launch). */
    private readonly requestWs: () => Promise<string>,
  ) {}

  ready(): boolean {
    return this.real !== null;
  }

  /** Attach immediately to an already-running profile's endpoint (no lazy round-trip). */
  async attachNow(ws: string): Promise<void> {
    if (this.real) return;
    const real = await CdpBrowserDriver.create(ws);
    this.adopt(real);
  }

  private adopt(real: CdpBrowserDriver): void {
    this.real = real;
    void real.closed.then(() => this.resolveClosed());
    if (this.closeRequested) real.close();
  }

  private ensure(): Promise<CdpBrowserDriver> {
    if (this.real) return Promise.resolve(this.real);
    this.attaching ??= (async () => {
      const ws = await this.requestWs();
      const real = await CdpBrowserDriver.create(ws);
      this.adopt(real);
      return real;
    })().catch((error: unknown) => {
      // A failed attach must not poison the session forever; the loop surfaces the error and a
      // later action may retry (e.g. after the user fixes a dead proxy and relaunches).
      this.attaching = null;
      throw error instanceof Error ? error : new Error(String(error));
    });
    return this.attaching;
  }

  // ---- act methods: attach (launch) on first use -------------------------------------------------

  async browserConfig(command: BrowserConfigCommand): Promise<string> {
    return (await this.ensure()).browserConfig(command);
  }
  async evaluate<T>(expression: string): Promise<T> {
    return (await this.ensure()).evaluate<T>(expression);
  }
  async click(point: Point, options?: { button?: 'left' | 'right'; count?: 1 | 2 }): Promise<void> {
    return (await this.ensure()).click(point, options);
  }
  async hover(point: Point): Promise<void> {
    return (await this.ensure()).hover(point);
  }
  async drag(from: Point, to: Point): Promise<void> {
    return (await this.ensure()).drag(from, to);
  }
  async type(text: string): Promise<void> {
    return (await this.ensure()).type(text);
  }
  async pressKey(key: string): Promise<void> {
    return (await this.ensure()).pressKey(key);
  }
  async selectAll(): Promise<void> {
    return (await this.ensure()).selectAll();
  }
  async scrollBy(dx: number, dy: number): Promise<void> {
    return (await this.ensure()).scrollBy(dx, dy);
  }
  async select(point: Point, values: string[]): Promise<void> {
    return (await this.ensure()).select(point, values);
  }
  async uploadFiles(point: Point, paths: string[]): Promise<void> {
    return (await this.ensure()).uploadFiles(point, paths);
  }
  async navigate(url: string): Promise<void> {
    return (await this.ensure()).navigate(url);
  }
  async goBack(): Promise<void> {
    return (await this.ensure()).goBack();
  }
  async listTabs(): Promise<BrowserTab[]> {
    return (await this.ensure()).listTabs();
  }
  async newTab(url?: string, opts?: { background?: boolean }): Promise<void> {
    return (await this.ensure()).newTab(url, opts);
  }
  async switchTab(index: number): Promise<void> {
    return (await this.ensure()).switchTab(index);
  }
  async closeTab(index: number): Promise<void> {
    return (await this.ensure()).closeTab(index);
  }
  async screenshot(): Promise<string> {
    return (await this.ensure()).screenshot();
  }

  // ---- reads: safe no-ops while the browser is closed --------------------------------------------

  async currentUrl(): Promise<string> {
    return this.real ? this.real.currentUrl() : '';
  }
  async waitForSettle(timeoutMs?: number): Promise<void> {
    if (this.real) return this.real.waitForSettle(timeoutMs);
  }

  close(): void {
    this.closeRequested = true;
    this.real?.close();
  }
}
