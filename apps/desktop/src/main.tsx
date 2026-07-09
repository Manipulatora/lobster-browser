import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
import { ThemeProvider } from './ui/theme';
import { ToastProvider } from './ui/Toast';
import './ui/tokens.css';
import './styles.css';
import './ui/components.css';

// React 18 client entrypoint. Tauri loads index.html which pulls in this module.
const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

// A last-resort crash hook (UI-8): surface unhandled errors instead of a blank window. A production
// build swaps this for a real crash reporter (Sentry) gated on user opt-in.
window.addEventListener('error', (e) => {
  console.error('[lobster] uncaught error', e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[lobster] unhandled rejection', e.reason);
});

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
