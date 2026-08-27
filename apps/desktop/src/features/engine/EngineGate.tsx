import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import siteLogo from '../../assets/brand/site-logo.png';

interface EngineStatus {
  present: boolean;
  runtimeDir: string;
}

interface EngineDownloadProgress {
  received: number;
  total: number | null;
}

/**
 * First run, before there is a browser engine to run.
 *
 * The installer is ~30 MB and does not carry the engine; the engine arrives here.
 *
 * DELIBERATELY WORDLESS ON THE HAPPY PATH. No heading, no explanation, no "Download engine" button -
 * a logo, a bar, and a number. The user just chose to install a browser and is waiting for it to
 * open; every sentence there would be read as an obstacle, and none of them change what they do
 * next. The download starts on its own, because a button would ask approval for something already
 * approved by installing the product.
 *
 * A FAILURE IS NOT THE HAPPY PATH, and this screen used to treat it as one. It showed a bare Retry
 * with no reason, so a deterministic failure - a manifest that cannot be read, no disk space for the
 * ~800 MB expansion, antivirus holding the archive open - became a loop the user could only keep
 * clicking, with nothing on screen to say why or to suggest it would never work. Reported from the
 * field as "it finished, then Retry appears, endlessly". Three things fix that, and only the first
 * is cosmetic:
 *
 *   1. The reason is shown. It is the one place on this screen where words are the whole point.
 *   2. Retry re-checks engine_status FIRST. `provision_engine` is idempotent, so if the engine did
 *      land and only a later step failed, this ends the loop instead of re-running it.
 *   3. Retrying is disabled while an attempt is in flight, so an impatient double-click cannot stack
 *      two 300 MB downloads writing to the same staging directory - which fails, and would look
 *      exactly like the bug being fixed.
 */
export function EngineGate({ children }: { children: ReactNode }): JSX.Element {
  const desktop = isTauri();
  const [ready, setReady] = useState(!desktop);
  const [progress, setProgress] = useState<EngineDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A ref, not state: the guard must be correct at call time, and state updates are not synchronous
  // enough to stop two clicks landing in the same tick.
  const running = useRef(false);

  const attempt = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      // Ask before fetching. `provision_engine` short-circuits when the engine already matches the
      // manifest, but going through engine_status means a retry after a post-install failure ends
      // here rather than re-entering the download path at all.
      const status = await invoke<EngineStatus>('engine_status').catch(() => null);
      if (status?.present) {
        setReady(true);
        return;
      }
      await invoke('provision_engine');
      setReady(true);
    } catch (cause) {
      // Surfaced verbatim. The Rust side already writes these for a human - "engine download failed:
      // HTTP 404 for <url>", "no engine source configured", "the engine archive does not contain
      // chrome.exe at its root" - and paraphrasing them into something friendlier would throw away
      // the only thing that makes the failure actionable.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    const unlisten = listen<EngineDownloadProgress>('engine-download-progress', (event) => {
      if (!cancelled) setProgress(event.payload);
    });
    void attempt();
    return () => {
      cancelled = true;
      void unlisten.then((off) => off());
    };
  }, [desktop, attempt]);

  if (ready) return <>{children}</>;

  // Only once the server has told us the size. Before that the bar sweeps rather than claiming a
  // figure it does not have - a percentage that starts wrong is worse than no percentage.
  const pct =
    progress && progress.total && progress.total > 0
      ? Math.min(100, Math.floor((progress.received / progress.total) * 100))
      : null;

  return (
    <div className="engine-gate">
      <div className="engine-gate__stage">
        <img className="engine-gate__logo" src={siteLogo} alt="Lobster Browser" />

        {error === null ? (
          <div
            className="engine-gate__bar"
            role="progressbar"
            aria-label="Preparing Lobster Browser"
            {...(pct === null
              ? {}
              : { 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 })}
          >
            <div
              className={
                pct === null ? 'engine-gate__fill engine-gate__fill--indet' : 'engine-gate__fill'
              }
              {...(pct === null ? {} : { style: { width: `${pct}%` } })}
            />
            {pct === null ? null : <span className="engine-gate__pct">{pct}%</span>}
          </div>
        ) : (
          <div className="engine-gate__failure" role="alert">
            <p className="engine-gate__reason">{error}</p>
            <button
              type="button"
              className="engine-gate__retry"
              onClick={() => void attempt()}
              disabled={busy}
            >
              {busy ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
