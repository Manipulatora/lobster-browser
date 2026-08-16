import { InjectionToken } from '@angular/core';

/**
 * Base URL of the Lobster cloud API, without a trailing slash.
 *
 * An injection token rather than an `environment.ts` constant because this value differs between
 * the browser and the SSR server in the same build: the browser must call the public origin, while
 * the server rendering the page may reach the API over a private network address. Providing it
 * separately in `app.config.ts` and `app.config.server.ts` is the only way to express that, and a
 * baked-in constant cannot.
 */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  // Development default. Production overrides this in app.config.ts.
  factory: () => 'http://localhost:8080',
});
