import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
import { EngineGate } from './features/engine/EngineGate';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { ToastProvider } from './ui/Toast';
// Before the tokens, so the @font-face declarations exist by the time --font references the family.
import './assets/inter.css';
import './ui/tokens.css';
import './styles.css';
import './ui/components.css';

// React 18 client entrypoint. Tauri loads index.html which pulls in this module.
const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

// Errors that escape React entirely — a listener, a timer, a rejected promise nobody awaited. They
// cannot unmount the tree, so there is a window still on screen to report into; the log is the whole
// response. A render-time throw is the case that CAN blank the window, and <ErrorBoundary> below
// catches that one. A production build swaps this for a real crash reporter (Sentry) gated on user
// opt-in.
window.addEventListener('error', (e) => {
  console.error('[lobster] uncaught error', e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[lobster] unhandled rejection', e.reason);
});

// The boundary is OUTSIDE the toast provider on purpose: a toast cannot report a crash that took
// the renderer with it, and the fallback must not depend on the tree that just failed.
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <EngineGate>
          <App />
        </EngineGate>
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
