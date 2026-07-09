import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Vite config for the Lobster desktop UI. Tuned for Tauri 2: Tauri runs `beforeDevCommand`
// (`npm run dev`) and points its webview at `devUrl` (http://localhost:5173), so the dev
// server must be predictable and quiet.
// https://vitejs.dev/config/  •  https://v2.tauri.app/reference/config/
export default defineConfig({
  plugins: [react()],

  // Tauri owns the terminal output; don't let Vite wipe Rust/tauri logs on rebuild.
  clearScreen: false,

  resolve: {
    // Avoid pulling `seed.ts` → `node:crypto` into the browser bundle (UI-4 coherence preview).
    alias: {
      '@lobster/fingerprint': path.resolve(rootDir, '../../packages/fingerprint/src/browser.ts'),
    },
  },

  server: {
    // Must match `build.devUrl` in src-tauri/tauri.conf.json.
    port: 5173,
    // Fail loudly instead of silently hopping to a random port the webview can't find.
    strictPort: true,
  },

  // Emit assets the Tauri packager can load with relative paths (frontendDist = ../dist).
  build: {
    // Chromium/WebView2 baseline for the engines we ship; safe modern target.
    target: 'es2022',
  },
});
