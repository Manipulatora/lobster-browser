import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * MV3-safe build for the Lobee side panel.
 *
 * The extension's CSP is `script-src 'self'` — NO inline scripts, NO eval. So the production build must
 * emit external ES-module scripts only: `base: './'` for relative asset URLs (the extension root is the
 * unguessable extension id), and `modulePreload.polyfill: false` so Vite doesn't inject its inline
 * preload shim. `public/` (manifest, service worker, icons) is copied verbatim to the build root.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: resolve(import.meta.dirname, 'sidepanel.html'),
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
