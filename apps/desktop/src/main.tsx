import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
import './styles.css';

// React 18 client entrypoint. Tauri loads index.html which pulls in this module.
const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
