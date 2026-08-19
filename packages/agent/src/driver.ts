/**
 * The browser driver seam.
 *
 * The agent core is engine-agnostic: it never touches CDP. The sidecar provides a concrete
 * {@link BrowserDriver} that fulfils these primitives over the first-party leak-free CDP client
 * (`Runtime.evaluate` only — never `Runtime.enable`/`Page.enable`) and the humanized `Input.*` helpers.
 * Tests provide a fake driver, so the whole loop runs with no browser.
 *
 * CONTRACT — stealth is the driver's responsibility, and every method here is implementable without a
 * single detectable CDP domain-enable:
 *   - `evaluate` MUST use one-shot `Runtime.evaluate` (leak-free).
 *   - `click`/`type`/`pressKey` MUST go through humanized `Input.*` dispatch (real pointer path + key
 *     cadence), NOT synthetic `element.click()` — synthetic activation is a bot tell and skips the
 *     trusted-event checks real sites rely on.
 *   - the driver owns cursor position, so the agent asks to click a POINT and the driver moves there
 *     from wherever the cursor was, like a hand.
 */

export interface Point {
  x: number;
  y: number;
}

export interface BrowserTab {
  index: number;
  id: string;
  url: string;
  title: string;
  active: boolean;
}

/** A live browser-config operation the driver runs on the BROWSER target (no page-domain enable). */
export interface BrowserConfigCommand {
  op:
    | 'clear_cookies'
    | 'clear_all_cookies'
    | 'clear_site_data'
    | 'clear_cache'
    | 'set_permission'
    | 'set_downloads'
    /** Write Chromium preferences through the browser's own settings API. */
    | 'set_prefs'
    /** Read Chromium preferences, to report current state or verify a write. */
    | 'get_prefs';
  domain?: string;
  origin?: string;
  permission?: string;
  setting?: 'granted' | 'denied' | 'prompt';
  behavior?: 'allow' | 'deny' | 'default';
  /**
   * Preference writes for `set_prefs`. ALREADY SCREENED by the browser-config guard — the driver
   * applies these verbatim and performs no safety filtering of its own, because the guard is the single
   * place that decides what the agent may touch (see browser-config-guard.ts).
   */
  prefs?: Array<{ key: string; value: unknown }>;
  /** Preference keys for `get_prefs`. */
  keys?: string[];
}

/**
 * Largest screenshot the vision path may carry, measured on the BASE64 STRING (which is what the API
 * counts). Anthropic rejects an image block above 5 MB base64 with a 400, and a 400 is not retryable —
 * it propagates out of the loop and kills the run.
 *
 * The previous gates allowed 16,000,000 chars, 3.2× that limit, and reported it as a "12MB" limit —
 * so the two numbers in the code and the number in the error message were three different values, and
 * the case most likely to exceed them is precisely the one that triggers auto-capture: a full-page
 * canvas with almost no readable elements.
 */
export const MAX_SCREENSHOT_BASE64_CHARS = 5_000_000;

export interface BrowserDriver {
  /**
   * Deep browser-config operations that run against the BROWSER target over leak-free CDP (Storage.* /
   * Browser.* / Network.* — no page-domain enable), so they're invisible to the visited page and add no
   * anti-detect tell. Optional: a driver without a browser surface may omit it. Returns a short
   * human-readable outcome; throws with a clear message on failure.
   */
  browserConfig?(command: BrowserConfigCommand): Promise<string>;

  /**
   * Lazy-launch capability: `false` while no browser surface is attached yet. Perception treats a
   * not-ready driver as "browser closed" WITHOUT touching it (so a task that never needs the web
   * never opens a browser); action methods on a lazy driver attach/launch on first use. Drivers that
   * are always connected may omit this (treated as ready).
   */
  ready?(): boolean;

  /**
   * Evaluate an expression in the page's main world and return its value (leak-free `Runtime.evaluate`,
   * `returnByValue`, `awaitPromise`). `expression` must yield the value (e.g. an IIFE).
   */
  evaluate<T>(expression: string): Promise<T>;

  /** Move the cursor to `point` along a human path and click. */
  click(point: Point, options?: { button?: 'left' | 'right'; count?: 1 | 2 }): Promise<void>;

  /** Move the cursor without clicking (hover menus/tooltips). */
  hover(point: Point): Promise<void>;

  /** Drag from one viewport point to another using trusted pointer events. */
  drag(from: Point, to: Point): Promise<void>;

  /** Type into the currently focused element with a human cadence. */
  type(text: string): Promise<void>;

  /** Press one non-text key (Enter to submit, Tab to advance, Backspace/Escape, etc.). */
  pressKey(key: string): Promise<void>;

  /** Select-all the focused field's contents (so a subsequent `type` replaces rather than appends). */
  selectAll(): Promise<void>;

  /** Scroll the viewport by a delta in CSS pixels (positive dy = down). */
  scrollBy(dx: number, dy: number): Promise<void>;

  /** Set one or more values on a select control at a measured point. */
  select(point: Point, values: string[]): Promise<void>;

  /** Set local files on a file input at a measured point. Policy validates roots before this call. */
  uploadFiles(point: Point, paths: string[]): Promise<void>;

  /** Navigate the top frame to `url` (leak-free `Page.navigate` — a command, needs no `Page.enable`). */
  navigate(url: string): Promise<void>;

  /** Navigate browser history back one entry. */
  goBack(): Promise<void>;

  listTabs(): Promise<BrowserTab[]>;
  /**
   * Open a new tab and make it the agent's working target. `background: true` opens it WITHOUT stealing
   * the user's foreground view (used for the settings-UI fallback so a config task never hijacks the tab
   * the user is on); the agent still drives it over CDP.
   */
  newTab(url?: string, opts?: { background?: boolean }): Promise<void>;
  switchTab(index: number): Promise<void>;
  /** Switch by stable target id, immune to positional drift. Optional for minimal drivers. */
  switchTabById?(id: string): Promise<void>;
  closeTab(index: number): Promise<void>;
  /** Close by stable target id. Optional for minimal drivers. */
  closeTabById?(id: string): Promise<void>;

  /** Current top-frame URL. */
  currentUrl(): Promise<string>;

  /**
   * Best-effort wait until the page settles after an action (readyState + a short quiet period),
   * WITHOUT enabling Page-domain events — the driver polls. Bounded by `timeoutMs`.
   */
  waitForSettle(timeoutMs?: number): Promise<void>;

  /**
   * Capture a viewport screenshot as a base64 PNG for the on-demand vision fallback (`Page.captureScreenshot`
   * — also a command, no `Page.enable`). Optional: a driver may omit it if vision is unsupported.
   *
   * `clip` narrows the capture to a viewport rectangle. Freshness checks around a coordinate gesture
   * use it: comparing whole frames meant a caret blink or a spinner anywhere on the page counted as
   * "the visual target moved", so the visual fallback could essentially never execute.
   */
  screenshot?(clip?: { x: number; y: number; width: number; height: number }): Promise<string>;

  /**
   * Report (and clear) a popup the driver adopted as the working target since the last call. Optional;
   * drivers that never adopt may omit it.
   */
  takeAdoptedPopup?(): string | undefined;

  /** Release browser protocol resources. Safe to call repeatedly. */
  close?(): void;
}
