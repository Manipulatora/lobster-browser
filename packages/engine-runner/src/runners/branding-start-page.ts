import { LOBIUM_NTP_AD_PNG_BASE64 } from './lobium-ntp-ad-data.js';
import { LOBSTER_ICON_MONO_PNG_BASE64 } from './lobster-icon-mono-data.js';
import { LOBSTER_NTP_HERO_PNG_BASE64 } from './lobster-ntp-hero-data.js';

export interface BrandingStartPageOptions {
  /** Lobster profile display name shown on the NTP (and used when setting Chromium profile prefs). */
  profileName?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Chrome-like Lobium NTP HTML (images embedded as data URLs inside the document only). */
export function buildLobsterStartPageHtml(opts: BrandingStartPageOptions = {}): string {
  const heroDataUrl = `data:image/png;base64,${LOBSTER_NTP_HERO_PNG_BASE64}`;
  const adDataUrl = `data:image/png;base64,${LOBIUM_NTP_AD_PNG_BASE64}`;
  const faviconDataUrl = `data:image/png;base64,${LOBSTER_ICON_MONO_PNG_BASE64}`;
  const profileName = (opts.profileName ?? '').trim();
  const profileLabel = profileName ? escapeHtml(profileName) : '';
  const profileChip = profileName
    ? `<div class="profile-chip" title="${profileLabel}"><span class="profile-chip__dot" aria-hidden="true"></span><span class="profile-chip__name">${profileLabel}</span></div>`
    : '';
  const docTitle = profileName ? escapeHtml(profileName) : 'New Tab';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="light">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" type="image/png" href="${faviconDataUrl}">
    <title>${docTitle}</title>
    <style>
      :root {
        --ntp-bg: #fff;
        --ntp-text: #202124;
        --ntp-muted: #5f6368;
        --ntp-border: #dfe1e5;
        --ntp-hover: #f1f3f4;
        --ntp-shadow: 0 1px 6px rgba(32,33,36,.28);
        --search-width: min(692px, 92vw);
      }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        min-height: 100%;
        background: var(--ntp-bg);
        color: var(--ntp-text);
        font-family: "Google Sans", "Product Sans", Roboto, Arial, Helvetica, sans-serif;
      }
      a { color: var(--ntp-muted); text-decoration: none; }
      a:hover { text-decoration: underline; }

      .top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 18px 0;
        min-height: 48px;
      }
      .top__left { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .profile-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        max-width: min(320px, 46vw);
        padding: 5px 12px 5px 6px;
        border: 1px solid var(--ntp-border);
        border-radius: 999px;
        background: #fff;
        color: var(--ntp-text);
        font-size: 13px;
        font-weight: 500;
        box-shadow: 0 1px 2px rgba(60,64,67,.08);
      }
      .profile-chip__dot {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: linear-gradient(135deg, #e62424, #8d1717);
        flex: 0 0 auto;
      }
      .profile-chip__name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .top__right {
        display: flex;
        align-items: center;
        gap: 20px;
        font-size: 13px;
        font-weight: 400;
      }
      .top__right a { color: var(--ntp-text); }
      .apps-btn {
        width: 40px;
        height: 40px;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: var(--ntp-muted);
        cursor: pointer;
        display: grid;
        place-items: center;
        padding: 0;
      }
      .apps-btn:hover { background: var(--ntp-hover); }
      .apps-grid {
        width: 18px;
        height: 18px;
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 2px;
      }
      .apps-grid i {
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: currentColor;
        display: block;
      }

      main {
        min-height: calc(100vh - 112px);
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 36px 16px 120px;
      }
      .brand {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        margin-bottom: 32px;
        user-select: none;
      }
      .brand__mark {
        /* Much larger than a favicon-sized mark — Chrome-logo scale on the NTP. */
        width: min(320px, 56vw);
        height: auto;
        display: block;
        -webkit-user-drag: none;
      }
      .brand__title {
        margin: 0;
        font-size: clamp(40px, 6vw, 64px);
        font-weight: 700;
        letter-spacing: -0.025em;
        line-height: 1.08;
        background: linear-gradient(105deg, #e62424 0%, #ff6b4a 26%, #c41e6a 52%, #7c3aed 76%, #2563eb 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        -webkit-text-fill-color: transparent;
      }

      .search {
        width: var(--search-width);
        display: flex;
        align-items: center;
        gap: 10px;
        height: 46px;
        padding: 0 14px 0 16px;
        border: 1px solid transparent;
        border-radius: 24px;
        background: #fff;
        box-shadow: var(--ntp-shadow);
      }
      .search:hover, .search:focus-within {
        box-shadow: 0 1px 8px rgba(32,33,36,.36);
      }
      .search__icon {
        width: 20px;
        height: 20px;
        flex: 0 0 auto;
        color: #9aa0a6;
      }
      .search input {
        flex: 1;
        min-width: 0;
        border: 0;
        outline: none;
        font: inherit;
        font-size: 16px;
        color: var(--ntp-text);
        background: transparent;
      }
      .search__tools {
        display: flex;
        align-items: center;
        gap: 2px;
        flex: 0 0 auto;
      }
      .search__tool {
        width: 40px;
        height: 40px;
        border: 0;
        border-radius: 50%;
        background: transparent;
        cursor: pointer;
        display: grid;
        place-items: center;
        padding: 0;
      }
      .search__tool:hover { background: var(--ntp-hover); }
      .search__tool svg { width: 24px; height: 24px; display: block; }

      .ad {
        width: var(--search-width);
        margin-top: 28px;
        border-radius: 12px;
        overflow: hidden;
        border: 1px solid var(--ntp-border);
        background: #fff;
        aspect-ratio: 4 / 1;
        display: block;
      }
      .ad img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        -webkit-user-drag: none;
      }

      .shortcuts {
        width: var(--search-width);
        margin-top: 32px;
        display: flex;
        justify-content: center;
      }
      .shortcut-add {
        width: 112px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        border: 0;
        background: transparent;
        color: var(--ntp-text);
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        padding: 10px 8px;
        border-radius: 8px;
      }
      .shortcut-add:hover { background: var(--ntp-hover); }
      .shortcut-add__plus {
        width: 48px;
        height: 48px;
        border-radius: 50%;
        border: 2px dashed #dadce0;
        background: transparent;
        display: grid;
        place-items: center;
        font-size: 28px;
        line-height: 1;
        color: var(--ntp-muted);
        font-weight: 300;
      }

      .customise {
        position: fixed;
        right: 16px;
        bottom: 16px;
        height: 40px;
        padding: 0 18px;
        border: 0;
        border-radius: 20px;
        background: #fff;
        color: #1a73e8;
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        box-shadow: 0 1px 3px 0 rgba(60,64,67,.3), 0 4px 8px 3px rgba(60,64,67,.15);
        cursor: pointer;
        z-index: 2;
      }
      .customise:hover { background: #f8fbff; }
    </style>
  </head>
  <body>
    <header class="top">
      <div class="top__left">${profileChip}</div>
      <div class="top__right">
        <a href="https://mail.google.com/mail/">Gmail</a>
        <a href="https://www.google.com/imghp">Images</a>
        <button type="button" class="apps-btn" aria-label="Google apps" title="Google apps">
          <span class="apps-grid" aria-hidden="true">
            <i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
          </span>
        </button>
      </div>
    </header>
    <main>
      <div class="brand">
        <img class="brand__mark" src="${heroDataUrl}" width="320" height="320" alt="" draggable="false">
        <h1 class="brand__title">Lobster Browser</h1>
      </div>
      <form class="search" action="https://www.google.com/search" method="get" role="search">
        <svg class="search__icon" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
        </svg>
        <input name="q" type="search" autocomplete="off" spellcheck="false" aria-label="Search Google" autofocus>
        <div class="search__tools">
          <button type="button" class="search__tool" aria-label="Search by voice" title="Search by voice">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285f4" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path fill="#34a853" d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
              <path fill="#fbbc04" d="M11 18.92V21h2v-2.08c-.33.05-.66.08-1 .08s-.67-.03-1-.08z" opacity=".01"/>
              <path fill="#ea4335" d="M12 16c-2.76 0-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c.34.05.67.08 1 .08.33 0 .66-.03 1-.08"/>
            </svg>
          </button>
          <button type="button" class="search__tool" aria-label="Search by image" title="Search by image">
            <svg viewBox="0 0 192 192" aria-hidden="true">
              <rect fill="none" height="192" width="192"/>
              <g>
                <circle fill="#4285f4" cx="96" cy="104.15" r="28"/>
                <path fill="#ea4335" d="M161.49,51.48H127.2l-9.14-9.14h-44.1l-9.14,9.14H30.51v99.04h130.98V51.48z M96,145.15c-22.6,0-40.99-18.39-40.99-40.99S73.4,63.17,96,63.17s40.99,18.39,40.99,40.99S118.6,145.15,96,145.15z"/>
                <path fill="#fbbc04" d="M30.51,150.52h130.98V51.48H127.2l-9.14-9.14h-44.1l-9.14,9.14H30.51V150.52z M96,63.17c-22.6,0-40.99,18.39-40.99,40.99S73.4,145.15,96,145.15s40.99-18.39,40.99-40.99S118.6,63.17,96,63.17z" opacity="0"/>
                <path fill="#34a853" d="M96,63.17v81.98c22.6,0,40.99-18.39,40.99-40.99S118.6,63.17,96,63.17z"/>
                <path fill="#4285f4" d="M55.01,104.16c0,9.94,3.55,19.05,9.43,26.15L96,104.16H55.01z"/>
              </g>
            </svg>
          </button>
        </div>
      </form>
      <a class="ad" href="https://lobium.app" aria-label="Lobium Browser is now available globally">
        <img src="${adDataUrl}" width="692" height="173" alt="Lobium Browser is now available globally" draggable="false">
      </a>
      <div class="shortcuts">
        <button type="button" class="shortcut-add" id="add-shortcut">
          <span class="shortcut-add__plus" aria-hidden="true">+</span>
          <span>Add shortcut</span>
        </button>
      </div>
    </main>
    <button type="button" class="customise" id="customise">Customise Lobium</button>
    <script>
      document.getElementById('add-shortcut')?.addEventListener('click', function () {
        window.alert('Shortcut editing is not available on this start page yet.');
      });
      document.getElementById('customise')?.addEventListener('click', function () {
        window.alert('Customise Lobium is coming soon.');
      });
      document.querySelectorAll('.search__tool').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          window.location.href = 'https://www.google.com/';
        });
      });
      document.querySelector('.apps-btn')?.addEventListener('click', function () {
        window.open('https://www.google.com/intl/en/about/products', '_blank', 'noopener');
      });
    </script>
  </body>
</html>`;
}

/**
 * @deprecated Prefer {@link brandSessionWithStartPage} / setDocumentContent so the omnibox is not
 * polluted with a huge `data:text/html,...` URL. Kept for harnesses that still assert the constant.
 */
export const LOBSTER_START_PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(
  buildLobsterStartPageHtml(),
)}`;

/** True for Chromium NTP URLs (every new tab). Does not match about:blank. */
export function isNtpUrl(url: string | undefined | null): boolean {
  const u = url ?? '';
  return (
    u.startsWith('chrome://newtab') ||
    u.startsWith('chrome://new-tab-page') ||
    u.startsWith('chrome-search://local-ntp') ||
    u.startsWith('edge://newtab')
  );
}

/** Legacy branding navigated to a huge data: URL — still brand/replace those tabs. */
export function isLegacyBrandingDataUrl(url: string | undefined | null): boolean {
  const u = url ?? '';
  return u.startsWith('data:text/html');
}

/** Initial launch pages may still be about:blank before the NTP loads. */
export function isBrandableStartUrl(url: string | undefined | null): boolean {
  const u = url ?? '';
  return !u || u === 'about:blank' || isNtpUrl(u) || isLegacyBrandingDataUrl(u);
}

type CdpSend = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

/**
 * Brand a page without navigating to a data: URL (keeps omnibox empty / about:blank).
 * Uses about:blank + Page.setDocumentContent (verified to leave location as about:blank).
 */
export async function brandSessionWithStartPage(
  send: CdpSend,
  sessionId: string,
  opts: BrandingStartPageOptions = {},
): Promise<void> {
  await send('Page.enable', undefined, sessionId).catch(() => {});
  // Always land on about:blank first so any restored data:text/html,... tab is cleared from the omnibox.
  const nav = (await send('Page.navigate', { url: 'about:blank' }, sessionId).catch(() => null)) as
    | { frameId?: string }
    | null;
  let frameId = nav?.frameId;
  if (!frameId) {
    const tree = (await send('Page.getFrameTree', undefined, sessionId)) as {
      frameTree?: { frame?: { id?: string } };
    };
    frameId = tree.frameTree?.frame?.id;
  }
  if (!frameId) throw new Error('branding: missing frameId for setDocumentContent');
  const html = buildLobsterStartPageHtml(opts);
  await send('Page.setDocumentContent', { frameId, html }, sessionId);
  // Belt-and-suspenders: if a future Chromium ever rewrites the URL, force about:blank in history.
  await send(
    'Runtime.evaluate',
    {
      expression:
        "try { if (location.protocol === 'data:') history.replaceState(null, '', 'about:blank'); } catch (e) {}",
    },
    sessionId,
  ).catch(() => {});
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Long-lived CDP watcher that brands every existing and future tab for the life of the browser.
 * Returns a disposer that closes the websocket (call from LaunchHandle.close).
 */
export function watchAndBrandNewTabs(
  browserWsUrl: string,
  opts: BrandingStartPageOptions = {},
): () => void {
  const ws = new WebSocket(browserWsUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const branded = new Set<string>();
  let closed = false;

  const send: CdpSend = (method, params, sessionId) =>
    new Promise((res, rej) => {
      if (closed || ws.readyState !== WebSocket.OPEN) {
        rej(new Error('branding websocket closed'));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej });
      ws.send(
        JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }),
      );
    });

  const brandTarget = async (targetId: string, url: string, allowBlank: boolean): Promise<void> => {
    if (allowBlank ? !isBrandableStartUrl(url) : !isNtpUrl(url)) return;
    if (branded.has(targetId)) return;
    branded.add(targetId);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const attached = (await send('Target.attachToTarget', {
          targetId,
          flatten: true,
        })) as { sessionId?: string };
        if (!attached.sessionId) throw new Error('no sessionId');
        await brandSessionWithStartPage(send, attached.sessionId, opts);
        return;
      } catch (err) {
        lastErr = err;
        await sleep(80 * (attempt + 1));
      }
    }
    branded.delete(targetId);
    void lastErr;
  };

  const brandExisting = async (): Promise<void> => {
    try {
      const { targetInfos } = (await send('Target.getTargets')) as {
        targetInfos?: Array<{ targetId: string; type?: string; url?: string }>;
      };
      for (const t of targetInfos ?? []) {
        // Initial targets may still be about:blank / chrome://newtab from process args.
        if (t.type === 'page') await brandTarget(t.targetId, t.url ?? '', true);
      }
    } catch {
      /* ignore */
    }
  };

  ws.addEventListener('open', () => {
    void send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    void brandExisting();
    // Re-scan shortly after launch — first paint can still be chrome://newtab briefly.
    void (async () => {
      await sleep(250);
      if (!closed) await brandExisting();
      await sleep(750);
      if (!closed) await brandExisting();
    })();
  });

  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        method?: string;
        params?: {
          targetInfo?: { targetId: string; type?: string; url?: string };
          targetId?: string;
        };
        result?: unknown;
        error?: { message?: string };
      };
      if (
        (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') &&
        msg.params?.targetInfo
      ) {
        const info = msg.params.targetInfo;
        // Subsequent tabs: brand real NTP URLs; also re-brand if a tab returns to about:blank
        // after our navigate (targetInfoChanged) — but only when not already branded.
        if (info.type === 'page') {
          if (isNtpUrl(info.url) || isLegacyBrandingDataUrl(info.url)) {
            // NTP tabs + any restored legacy data:text/html branding tabs.
            void brandTarget(info.targetId, info.url ?? '', true);
          } else if (info.url === 'about:blank' && !branded.has(info.targetId)) {
            // Rare: launch with about:blank before open handler finishes.
            void brandTarget(info.targetId, info.url ?? '', true);
          }
        }
        return;
      }
      if (msg.method === 'Target.targetDestroyed' && msg.params?.targetId) {
        branded.delete(msg.params.targetId);
        return;
      }
      if (msg.id === undefined) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
      else p.resolve(msg.result);
    } catch {
      /* ignore */
    }
  });

  return () => {
    closed = true;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}
