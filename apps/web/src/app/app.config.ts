import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
  withViewTransitions,
} from '@angular/router';
import { provideClientHydration, withEventReplay } from '@angular/platform-browser';
import { provideHttpClient, withFetch } from '@angular/common/http';

import { routes } from './app.routes';
import { API_BASE_URL } from './core/api/api.config';

/**
 * Root application providers.
 *
 * The app is zoneless and hydrated from prerendered HTML, so the first paint is static
 * markup and interactivity is replayed on top of it.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      // Bind route params/data straight to component `input()`s.
      withComponentInputBinding(),
      // Cross-route fades via the native View Transitions API (no-op where unsupported).
      withViewTransitions(),
      // Restore scroll on back/forward and honour #fragment links.
      withInMemoryScrolling({
        scrollPositionRestoration: 'enabled',
        anchorScrolling: 'enabled',
      }),
    ),
    // Replay clicks that land before hydration finishes.
    provideClientHydration(withEventReplay()),
    // `withFetch` uses the Fetch API rather than XHR, which is what makes HttpClient work under
    // SSR without a browser XMLHttpRequest shim.
    provideHttpClient(withFetch()),
    {
      // The public API origin. Overridden at build time per environment; the token's own factory
      // default covers local development.
      provide: API_BASE_URL,
      useValue: apiBaseUrl(),
    },
  ],
};

/**
 * Resolve the API origin for the browser bundle.
 *
 * Derived from the page's own origin rather than hardcoded, so the same build serves production
 * and any preview deployment: the API is expected at `api.<host>`. Falls back to the local backend
 * when running on localhost.
 */
function apiBaseUrl(): string {
  if (typeof location === 'undefined') return 'http://localhost:8080';
  const { hostname, protocol } = location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'http://localhost:8080';
  return `${protocol}//api.${hostname.replace(/^www\./, '')}`;
}
