import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
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
 * The installer is ~37 MB and does not carry the engine; the engine arrives here. That is the same
 * shape Octo and every other browser of this size uses, and it is what keeps the download the user
 * clicked from being 330 MB.
 *
 * DELIBERATELY WORDLESS. No heading, no explanation, no "Download engine" button - a logo, a bar,
 * and a number. The user just chose to install a browser and is waiting for it to open; every
 * sentence here would be read as an obstacle or a question, and none of them change what they do
 * next. The progress bar answers the only live question ("how much longer"), and the percentage
 * answers it precisely. There is nothing to decide, so nothing is asked.
 *
 * The download STARTS ON ITS OWN for the same reason. A button would be a prompt to approve
 * something the user has already approved by installing the product, and would leave a fresh
 * install sitting on a screen that does nothing.
 *
 * The one button that does exist appears only when the download fails, because a failure IS a
 * decision point and a bar frozen at 34% with no way to act on it is the worst version of this
 * screen.
 */
export function EngineGate({ children }: { children: ReactNode }): JSX.Element {
  const desktop = isTauri();
  const [ready, setReady] = useState(!desktop);
  const [progress, setProgress] = useState<EngineDownloadProgress | null>(null);
  const [failed, setFailed] = useState(false);

  const provision = useCallback(() => {
    setFailed(false);
    setProgress(null);
    invoke('provision_engine')
      .then(() => setReady(true))
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    const unlisten = listen<EngineDownloadProgress>('engine-download-progress', (event) => {
      if (!cancelled) setProgress(event.payload);
    });
    invoke<EngineStatus>('engine_status')
      .then((status) => {
        if (cancelled) return;
        if (status.present) setReady(true);
        else provision();
      })
      // Not knowing whether the engine is there is not a reason to stop: provisioning is a no-op
      // when it already matches the manifest, so attempting it is strictly better than stalling.
      .catch(() => {
        if (!cancelled) provision();
      });
    return () => {
      cancelled = true;
      void unlisten.then((off) => off());
    };
  }, [desktop, provision]);

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

        {failed ? (
          <button type="button" className="engine-gate__retry" onClick={provision}>
            Retry
          </button>
        ) : (
          <div
            className="engine-gate__bar"
            role="progressbar"
            aria-label="Preparing Lobster Browser"
            {...(pct === null
              ? {}
              : { 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 })}
          >
            <div
              className={pct === null ? 'engine-gate__fill engine-gate__fill--indet' : 'engine-gate__fill'}
              {...(pct === null ? {} : { style: { width: `${pct}%` } })}
            />
            {pct === null ? null : <span className="engine-gate__pct">{pct}%</span>}
          </div>
        )}
      </div>
    </div>
  );
}
