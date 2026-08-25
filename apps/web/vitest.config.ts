import { defineConfig } from 'vitest/config';

/**
 * Vitest for the web app.
 *
 * Two settings here are load-bearing, and both were missing when the suite was introduced — every
 * spec that existed failed to run, so the suite reported "2 failed, no tests" and nothing was
 * actually being checked:
 *
 *   globals   credit.spec.ts calls `describe`/`it` without importing them, which is the ordinary
 *             Jest-style convention. Without this the file throws `describe is not defined` before
 *             a single assertion runs.
 *
 *   setupFiles  auth-races.spec.ts drives Angular's TestBed. TestBed compiles components at runtime,
 *             so it needs the JIT compiler and an initialised testing environment; without them the
 *             first injection dies with "needs to be compiled using the JIT compiler". The setup
 *             file below is the standard Angular test bootstrap.
 */
export default defineConfig({
  test: {
    // Fork workers can fail to initialize under constrained Windows build hosts. Worker threads
    // carry the same isolation contract without depending on child-process IPC.
    pool: 'threads',
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
  },
});
