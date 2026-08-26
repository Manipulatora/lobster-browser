import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

import siteLogo from '../../assets/brand/site-logo.png';

interface EngineStatus {
  present: boolean;
  runtimeDir: string;
}

/**
 * First-run check for the EMBEDDED engine.
 *
 * The installer carries the Lobium runtime, so by the time this renders the engine is already on
 * disk and this gate is a pass-through. It used to be a download screen: the package shipped without
 * an engine and fetched ~840 MB on first launch, which put a "Download engine" button in front of a
 * browser the user had just finished installing, and made the product's one core action depend on a
 * release URL and the user's network at the moment they had least reason to expect either.
 *
 * What remains is a check, not a prompt. A missing engine now means the INSTALL is damaged - files
 * removed, an antivirus quarantine, a half-extracted upgrade - and the honest response is to say so
 * and point at reinstalling. Offering to download an engine from here would paper over a broken
 * install with a several-hundred-megabyte workaround, and would appear to succeed on exactly the
 * machines where the real problem is that something is deleting files.
 */
export function EngineGate({ children }: { children: ReactNode }): JSX.Element {
  const desktop = isTauri();
  const [ready, setReady] = useState(!desktop);
  const [checking, setChecking] = useState(desktop);
  const [runtimeDir, setRuntimeDir] = useState<string>('');

  useEffect(() => {
    if (!desktop) return;
    invoke<EngineStatus>('engine_status')
      .then((status) => {
        setReady(status.present);
        setRuntimeDir(status.runtimeDir);
        setChecking(false);
      })
      // A failed status call is not evidence the engine is missing, but it is evidence we cannot
      // confirm it. Stop checking and let the message below describe an install worth repairing.
      .catch(() => setChecking(false));
  }, [desktop]);

  if (ready) return <>{children}</>;

  return (
    <div className="engine-gate">
      <div className="engine-gate__card">
        <img className="engine-gate__logo" src={siteLogo} alt="Lobster Browser" />
        {checking ? (
          <p className="engine-gate__status">Checking browser engine…</p>
        ) : (
          <>
            <h1>The browser engine is missing</h1>
            <p className="engine-gate__desc">
              Lobster ships its browser engine inside the installer, so this should not happen on a
              complete installation. The usual causes are antivirus quarantine, or files removed from
              the installation folder after setup.
            </p>
            <p className="engine-gate__desc">
              Reinstall Lobster Browser to restore it. If it recurs, check whether your antivirus is
              removing files from the installation folder.
            </p>
            {runtimeDir ? (
              <p className="engine-gate__status engine-gate__path">Expected at: {runtimeDir}</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
