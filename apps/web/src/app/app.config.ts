import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
  withViewTransitions,
} from '@angular/router';
import { provideClientHydration, withEventReplay } from '@angular/platform-browser';

import { routes } from './app.routes';

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
  ],
};
