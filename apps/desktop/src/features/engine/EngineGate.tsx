import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import siteLogo from '../../assets/brand/site-logo.png';

interface EngineStatus {
  present: boolean;
  runtimeDir: string;
}

interface DownloadProgress {
  received: number;
  total: number | null;
}

const mb = (n: number): string => (n / (1024 * 1024)).toFixed(0);

/**
 * First-run gate for the DOWNLOADER distribution model. The shipped package does not carry the ~840 MB
 * Lobium engine; on first launch this gate detects the missing engine and downloads + verifies it (once)
 * before the app is usable. In the dev/browser runtime (no Tauri) it is a pass-through.
 */
export function EngineGate({ children }: { children: ReactNode }): JSX.Element {
  const desktop = isTauri();
  const [ready, setReady] = useState(!desktop);
  const [checking, setChecking] = useState(desktop);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress>({ received: 0, total: null });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    invoke<EngineStatus>('engine_status')
      .then((status) => {
        setReady(status.present);
        setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [desktop]);

  useEffect(() => {
    if (!downloading) return undefined;
    const unlisten = listen<DownloadProgress>('engine-download-progress', (event) =>
      setProgress(event.payload),
    );
    return () => {
      void unlisten.then((off) => off());
    };
  }, [downloading]);

  async function startDownload(): Promise<void> {
    setError(null);
    setProgress({ received: 0, total: null });
    setDownloading(true);
    try {
      await invoke('provision_engine');
      setReady(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }

  if (ready) return <>{children}</>;

  const pct =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : null;

  return (
    <div className="engine-gate">
      <div className="engine-gate__card">
        <img className="engine-gate__logo" src={siteLogo} alt="Lobster Browser" />
        {checking ? (
          <p className="engine-gate__status">Checking browser engine…</p>
        ) : (
          <>
            <h1>Set up the browser engine</h1>
            <p className="engine-gate__desc">
              Lobster downloads the Lobium browser engine once before you can create profiles. It is
              verified by checksum and installed locally.
            </p>
            {downloading ? (
              <>
                <div
                  className="engine-gate__bar"
                  role="progressbar"
                  aria-valuenow={pct ?? undefined}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className={
                      pct === null
                        ? 'engine-gate__fill engine-gate__fill--indet'
                        : 'engine-gate__fill'
                    }
                    style={pct === null ? undefined : { width: `${pct}%` }}
                  />
                </div>
                <p className="engine-gate__status">
                  {pct !== null
                    ? `${pct}% · ${mb(progress.received)} / ${mb(progress.total ?? 0)} MB`
                    : `Downloading… ${mb(progress.received)} MB`}
                </p>
              </>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void startDownload()}
              >
                Download engine
              </button>
            )}
            {error ? (
              <p className="notice notice--error engine-gate__error" role="alert">
                {error}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
