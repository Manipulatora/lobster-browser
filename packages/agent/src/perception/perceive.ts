import type { BrowserDriver } from '../driver.js';
import type { PerceivedElement, RawPerception } from '../types.js';
import { EXTRACT_SCRIPT, type ExtractResult } from './extract-script.js';
import { redactUrl, urlIdentity } from '../security.js';

/** Longest element href kept in an observation. */
const ELEMENT_HREF_CHARS = 256;

/** A defensive default when a page yields nothing (about:blank, mid-navigation, hostile CSP). */
function emptyPerception(url: string, identity?: string): RawPerception {
  return {
    url,
    ...(identity ? { urlIdentity: identity } : {}),
    title: '',
    scrollY: 0,
    viewportH: 0,
    docH: 0,
    canScrollUp: false,
    canScrollDown: false,
    elements: [],
    truncated: 0,
  };
}

/**
 * Run the extraction script in the page and normalise it into a {@link RawPerception}. Never throws —
 * a page that can't be read yields an empty perception (the loop then decides to wait/scroll/navigate),
 * because a thrown perception would kill an otherwise-recoverable run.
 *
 * A lazy driver that has no browser attached yet is NOT touched at all: the model sees a "browser
 * closed" observation and decides whether the task needs the web. Its first browser action is what
 * launches the browser — a task answerable from knowledge never opens one.
 */
export async function perceive(driver: BrowserDriver): Promise<RawPerception> {
  if (driver.ready && !driver.ready()) {
    return {
      ...emptyPerception(''),
      title:
        'The browser is closed. It opens automatically on your first browser action (navigate, click, …). If the task needs no website, answer with `done` now.',
      signals: ['browser-closed'],
    };
  }
  let raw: ExtractResult | null = null;
  let failure = '';
  try {
    raw = await driver.evaluate<ExtractResult>(EXTRACT_SCRIPT);
    // The script runs in the page's own main world, where a page-defined global or a patched prototype
    // can make the walk throw; its top-level catch reports that through `error`. An in-page exception is
    // as complete a failure to read the page as a rejected evaluate, so it takes the same branch — the
    // only difference is which side of the CDP boundary produced the message.
    const reported = raw?.error;
    if (typeof reported === 'string' && reported.trim()) failure = reported;
  } catch (error) {
    raw = null;
    failure = error instanceof Error ? error.message : String(error);
  }
  if (!raw || !Array.isArray(raw.elements) || failure) {
    const fullUrl = typeof raw?.url === 'string' ? raw.url : await safeUrl(driver);
    const url = redactUrl(text(fullUrl, 8192));
    // Do NOT present a failed read as a blank page. "(no interactive elements visible)" is a claim
    // about the page; when the read itself failed it is a false one, and the model would respond by
    // scrolling or waiting forever instead of recovering or handing off. Say what went wrong.
    //
    // Every arrival here is a read that produced no page, whether the script threw, the evaluate was
    // rejected, or the value came back in no recognisable shape. `page-unreadable` is unconditional
    // because it is load-bearing twice over: it is the model's documented cue to stop, and it is the
    // ONLY thing post-action verification checks before certifying an irreversible action as observed.
    const empty = emptyPerception(url, urlIdentity(fullUrl));
    return {
      ...empty,
      signals: [...(empty.signals ?? []), 'page-unreadable'],
      text: `The page could not be read: ${redactUrl(text(failure || 'the page returned no readable content', 500))}`,
    };
  }
  // ONE source of truth for "which page is this": the page's own unredacted location. The model-facing
  // string is derived from it by redaction; the identity digest is taken from it verbatim, so it equals
  // the digest of `driver.currentUrl()` — the comparison the loop's pre-dispatch fence and post-action
  // verification both depend on. Clipping is display-only for the same reason: an 8k+ URL must not
  // acquire a different identity from the one the driver reports.
  const fullPageUrl = typeof raw.url === 'string' ? raw.url : '';
  const pageUrl = redactUrl(text(fullPageUrl, 8192));
  const pageUrlIdentity = urlIdentity(fullPageUrl);
  // `about:blank` can inherit its opener's effective origin and be populated with arbitrary DOM. Its
  // location string does not reveal that origin, so forwarding content/elements would let a file:/
  // data:/extension opener hide behind an innocuous URL. Treat it as a synthetic empty page: the model
  // may navigate away or manage tabs, but it receives none of the inherited document.
  if (isAboutBlank(pageUrl)) {
    return {
      ...emptyPerception('about:blank', pageUrlIdentity),
      title: 'Blank page',
      signals: ['blank-page'],
    };
  }
  // Re-index defensively so indices are always a dense 0..n-1 the model can trust, even if the script
  // ever skips one. Coordinates/fields are taken verbatim from the in-page measurement.
  const elements: PerceivedElement[] = raw.elements
    .slice(0, 90)
    .map((candidate, i): PerceivedElement | null => normalizeElement(candidate, i))
    .filter((element): element is PerceivedElement => element !== null)
    .map((element, index) => ({ ...element, index }));
  return {
    url: pageUrl,
    urlIdentity: pageUrlIdentity,
    title: text(raw.title, 300),
    scrollY: number(raw.scrollY),
    viewportH: number(raw.viewportH),
    ...(raw.viewportW !== undefined ? { viewportW: number(raw.viewportW) } : {}),
    ...(raw.devicePixelRatio !== undefined
      ? { devicePixelRatio: number(raw.devicePixelRatio) }
      : {}),
    docH: number(raw.docH),
    canScrollUp: raw.canScrollUp === true,
    canScrollDown: raw.canScrollDown === true,
    ...(typeof raw.text === 'string' ? { text: text(raw.text, 1600) } : {}),
    ...(Array.isArray(raw.signals)
      ? { signals: raw.signals.filter((s): s is string => typeof s === 'string').slice(0, 10) }
      : {}),
    elements,
    truncated: Math.max(0, number(raw.truncated)),
  };
}

function isAboutBlank(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'about:' && url.pathname === 'blank';
  } catch {
    return false;
  }
}

function normalizeElement(candidate: unknown, index: number): PerceivedElement | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const raw = candidate as Partial<PerceivedElement>;
  const x = number(raw.x);
  const y = number(raw.y);
  const w = number(raw.w);
  const h = number(raw.h);
  if (w < 2 || h < 2) return null;
  const sensitive = raw.sensitive === true || String(raw.type).toLowerCase() === 'password';
  return {
    index,
    tag: text(raw.tag, 30).toLowerCase() || 'unknown',
    role: text(raw.role, 40).toLowerCase() || 'generic',
    name: text(raw.name, 90),
    x,
    y,
    w,
    h,
    ...(typeof raw.type === 'string' ? { type: text(raw.type, 30).toLowerCase() } : {}),
    ...(raw.submitsForm === true ? { submitsForm: true } : {}),
    ...(raw.focused === true ? { focused: true } : {}),
    ...(raw.editable === true ? { editable: true } : {}),
    ...(typeof raw.value === 'string' && !sensitive ? { value: text(raw.value, 90) } : {}),
    ...(raw.filled === true ? { filled: true } : {}),
    ...(sensitive ? { sensitive: true } : {}),
    // An element's href only has to identify the link to the model; a tracking URL runs to
    // thousands of characters and a dense page has hundreds of them, so the clip is what keeps a
    // snapshot at a few thousand tokens instead of tens of thousands. The page URL keeps its length.
    ...(typeof raw.href === 'string'
      ? { href: redactUrl(text(raw.href, ELEMENT_HREF_CHARS)) }
      : {}),
    ...(Array.isArray(raw.options)
      ? {
          options: raw.options
            .filter((v): v is string => typeof v === 'string')
            .slice(0, 12)
            .map((v) => text(v, 45)),
        }
      : {}),
    ...(typeof raw.context === 'string' ? { context: text(raw.context, 80) } : {}),
    ...(typeof raw.state === 'string' ? { state: text(raw.state, 100) } : {}),
  };
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

async function safeUrl(driver: BrowserDriver): Promise<string> {
  try {
    return await driver.currentUrl();
  } catch {
    return '';
  }
}
