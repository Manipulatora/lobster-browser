import type { BrowserDriver } from '../driver.js';
import type { PerceivedElement, RawPerception } from '../types.js';
import { EXTRACT_SCRIPT } from './extract-script.js';
import { redactUrl } from '../security.js';

/** A defensive default when a page yields nothing (about:blank, mid-navigation, hostile CSP). */
function emptyPerception(url: string): RawPerception {
  return {
    url,
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
  let raw: Partial<RawPerception> | null = null;
  let failure = '';
  try {
    raw = await driver.evaluate<Partial<RawPerception>>(EXTRACT_SCRIPT);
  } catch (error) {
    raw = null;
    failure = error instanceof Error ? error.message : String(error);
  }
  if (!raw || !Array.isArray(raw.elements)) {
    const url = raw?.url ?? (await safeUrl(driver));
    // Do NOT present a failed read as a blank page. "(no interactive elements visible)" is a claim
    // about the page; when the read itself failed it is a false one, and the model would respond by
    // scrolling or waiting forever instead of recovering or handing off. Say what went wrong.
    const empty = emptyPerception(url);
    return failure
      ? {
          ...empty,
          signals: [...(empty.signals ?? []), 'page-unreadable'],
          text: `The page could not be read: ${failure}`,
        }
      : empty;
  }
  // Re-index defensively so indices are always a dense 0..n-1 the model can trust, even if the script
  // ever skips one. Coordinates/fields are taken verbatim from the in-page measurement.
  const elements: PerceivedElement[] = raw.elements
    .slice(0, 90)
    .map((candidate, i): PerceivedElement | null => normalizeElement(candidate, i))
    .filter((element): element is PerceivedElement => element !== null)
    .map((element, index) => ({ ...element, index }));
  return {
    url: redactUrl(text(raw.url, 8192)),
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
    ...(typeof raw.value === 'string' && !sensitive ? { value: text(raw.value, 90) } : {}),
    ...(raw.filled === true ? { filled: true } : {}),
    ...(sensitive ? { sensitive: true } : {}),
    ...(typeof raw.href === 'string' ? { href: redactUrl(text(raw.href, 8192)) } : {}),
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
