import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { isDesktopRuntime } from './tauri';

/**
 * Re-run `refresh` every time the launcher window becomes the user's focus again, plus a slow poll
 * while it stays focused.
 *
 * WHY FOCUS IS THE TRIGGER. Everything that changes the account — a top-up, an upgrade, a plan
 * lapse — happens on the WEBSITE, in the system browser, because payment is a hosted flow the app
 * deliberately does not embed. The launcher cannot observe any of it; what it can observe is the
 * user coming back. The moment this window regains focus is precisely the moment the old answer is
 * most likely to have just changed, and the moment the user is looking at the number that shows
 * it. Without this, "pay on the website, come back, still see the old plan" only resolved on a
 * restart.
 *
 * WHY THE SLOW POLL EXISTS AT ALL. Some deposits are credited by a payment webhook that lands
 * AFTER the user has already tabbed back — the focus refresh then ran a moment too early and read
 * the pre-credit balance. The poll picks those up. It runs only while the window is focused AND
 * visible, so a launcher minimised behind a day of other work makes no requests.
 *
 * MECHANICS. One window activation fires several signals at once — DOM `focus`,
 * `visibilitychange`, and Tauri's own `onFocusChanged` — so they all funnel into one `activate()`
 * with a short dedupe window rather than each triggering its own fetch. The callback lives in a
 * ref so callers may pass an inline arrow without tearing the listeners down every render. There
 * is deliberately NO refresh on mount: every caller already fetches once on its own, and doubling
 * that up would just race it.
 */
export function useRefreshOnFocus(refresh: () => void, pollMs = 60_000): void {
  // Always-current callback, so the effect below never needs `refresh` in its deps and an inline
  // arrow at the call site cannot churn the listeners.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    let disposed = false;
    let lastActivation = 0;
    let pollId: number | null = null;

    const focusedAndVisible = (): boolean =>
      document.visibilityState === 'visible' && document.hasFocus();

    const stopPoll = (): void => {
      if (pollId !== null) {
        window.clearInterval(pollId);
        pollId = null;
      }
    };

    const startPoll = (): void => {
      if (pollId !== null) return;
      pollId = window.setInterval(() => {
        // Belt and braces: if a blur signal was missed (WebKitGTK has dropped them), the tick
        // itself refuses to fire unfocused rather than polling a window nobody is looking at.
        if (focusedAndVisible()) refreshRef.current();
      }, pollMs);
    };

    const activate = (): void => {
      // DOM focus, visibilitychange and Tauri's onFocusChanged all announce the same activation
      // within a few milliseconds of each other; 750ms collapses them into one refresh without
      // being long enough to swallow a genuine leave-and-return.
      const now = Date.now();
      if (now - lastActivation >= 750) {
        lastActivation = now;
        refreshRef.current();
      }
      startPoll();
    };

    const deactivate = (): void => stopPoll();

    const onFocus = (): void => activate();
    const onBlur = (): void => deactivate();
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') activate();
      else deactivate();
    };

    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);

    // The Tauri signal too, not as redundancy but as coverage: the webview's DOM focus events are
    // not guaranteed for every native activation (click on the title bar, alt-tab on some window
    // managers), while the window server always knows. Subscribing is async, so the unlisten may
    // arrive after unmount — `disposed` makes that a call instead of a leak.
    let unlistenTauri: (() => void) | null = null;
    if (isDesktopRuntime()) {
      void getCurrentWindow()
        .onFocusChanged(({ payload: focused }) => {
          if (focused) activate();
          else deactivate();
        })
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlistenTauri = unlisten;
        })
        .catch(() => undefined);
    }

    // No refresh on mount — but the poll must not wait for a blur/refocus cycle to start when the
    // window is already frontmost, which it is on virtually every launch.
    if (focusedAndVisible()) startPoll();

    return () => {
      disposed = true;
      stopPoll();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      unlistenTauri?.();
    };
  }, [pollMs]);
}
