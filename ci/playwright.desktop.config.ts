import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

// Playwright config for apps/desktop/e2e. The specs existed for months with no config and no
// workflow, so `npx playwright test` found nothing and the whole desktop UI suite ran nowhere.
//
// It lives under ci/ rather than in apps/desktop because the desktop workspace is a Tauri app: its
// package scripts are `tauri`/`vite`, and adding a Playwright runner there implies the suite drives
// the packaged shell. It does not — the UI falls back to the in-memory mock client whenever
// `__TAURI_INTERNALS__` is absent (apps/desktop/src/api/tauri.ts), which is exactly what makes these
// specs runnable in a plain browser on a CI runner with no webview and no Rust core.
// `__dirname`, not `import.meta`: the repo root package.json is CommonJS, so Playwright loads this
// config through require() and an ESM-only path expression throws before a single test is collected.
const ROOT = path.resolve(__dirname, '..');

// Not 5173: that port is `strictPort` in the desktop vite config because the Tauri webview points at
// it, so reusing it would make a stray dev server and a test run fight over the same socket.
const PORT = Number(process.env.LOBSTER_E2E_PORT ?? 5181);
const BASE_URL = process.env.LOBSTER_E2E_URL ?? `http://127.0.0.1:${PORT}/`;

export default defineConfig({
  testDir: path.join(ROOT, 'apps/desktop/e2e'),
  // apps/desktop/e2e holds both browser specs and pure draft/serialization unit specs; both are
  // `*.spec.ts` and both belong to this suite.
  testMatch: '**/*.spec.ts',
  // The specs create profiles in a shared in-memory store per page, but they also assert on
  // list contents by name — running files in parallel is fine, tests within a file are not.
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  // A stale spec must fail the run, not be papered over by a retry.
  retries: 0,
  // Never let `test.only` reach main.
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Serve the UI the same way `npm run dev` does. Vite is started from the repo root through the
  // workspace so the run needs no cwd juggling on Windows, where `cd apps/desktop && vite` is not a
  // portable shell line.
  webServer: {
    // `--host 127.0.0.1` pins the dev server to the loopback address the specs target instead of
    // letting vite pick `localhost` (which resolves to ::1 first on a dual-stack box, so the specs'
    // 127.0.0.1 URL then hits nothing) and keeps the runner from serving the UI on every interface.
    command: `npm run dev --workspace @lobster/desktop -- --port ${PORT} --strictPort --host 127.0.0.1`,
    cwd: ROOT,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
