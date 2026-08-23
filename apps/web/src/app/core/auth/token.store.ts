import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

const STORAGE_KEY = 'lobster.token';

/** A credential plus the logical session generation it was read from. */
export interface TokenSnapshot {
  token: string | null;
  revision: number;
}

/**
 * Where the bearer token lives.
 *
 * SSR-SAFE BY CONSTRUCTION. This app prerenders and hydrates, so every one of these methods runs
 * on the server too, where `localStorage` does not exist. Touching it there is a hard render error,
 * not a warning, so the platform check is not defensive tidiness — it is what keeps the server
 * build working. On the server `read()` returns null, which renders the signed-out shell; the
 * client corrects it on hydration.
 *
 * ON localStorage AND XSS, stated plainly rather than left implicit: a token here is readable by
 * any script that executes on this origin, so a successful XSS is a session compromise. An
 * httpOnly cookie would not be. It is used anyway because the API is bearer-token based and the
 * desktop launcher needs the same token over the same endpoints; moving the web to cookies would
 * mean two auth mechanisms in one backend. What compensates is not the storage choice but keeping
 * the origin free of injection: Angular escapes interpolated values by default, and the
 * Content-Security-Policy in `index.html` confines any script that does get in to this origin plus
 * the API — it cannot fetch, post a form to, or load an image from an attacker's host. That policy
 * has to allow inline script (a prerendered site has no nonce to hand out), so it narrows the blast
 * radius rather than closing it; treat any injection sink on this origin as session-critical.
 */
@Injectable({ providedIn: 'root' })
export class TokenStore {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  /** Used only after this document proves that localStorage is unavailable. */
  private fallbackToken: string | null = null;
  private useFallback = false;

  /**
   * Bumped whenever the token changes, so signals derived from auth state recompute.
   *
   * The token itself is deliberately NOT the signal: exposing it as reactive state invites
   * templates to interpolate it, and a bearer token rendered into the DOM ends up in the
   * prerendered HTML and in error reports.
   */
  private readonly version = signal(0);

  read(): string | null {
    if (!this.isBrowser) return null;
    // Reading `version` makes callers that use `read()` inside a computed re-evaluate on change.
    this.version();
    if (this.useFallback) return this.fallbackToken;
    try {
      const token = localStorage.getItem(STORAGE_KEY);
      // Mirror the last successful read so a later SecurityError does not erase this document's
      // already-established session merely because storage became unavailable mid-page.
      this.fallbackToken = token;
      return token;
    } catch {
      // Storage can throw in private-browsing modes and when the origin is sandboxed. Retain the
      // current document's session in memory; only persistence across a reload is unavailable.
      this.useFallback = true;
      return this.fallbackToken;
    }
  }

  /**
   * Capture request identity without exposing the token as reactive state.
   *
   * The revision matters even when the string does not change: two JWTs minted in the same second
   * can be byte-identical, while logout followed by login is still a new logical session whose
   * responses must not be invalidated by the old one.
   */
  snapshot(): TokenSnapshot {
    return { token: this.read(), revision: this.version() };
  }

  /** True only while neither the token nor its logical session generation has moved. */
  isCurrent(snapshot: TokenSnapshot): boolean {
    return this.version() === snapshot.revision && this.read() === snapshot.token;
  }

  write(token: string): void {
    if (!this.isBrowser) return;
    this.fallbackToken = token;
    try {
      localStorage.setItem(STORAGE_KEY, token);
      this.useFallback = false;
    } catch {
      this.useFallback = true;
    }
    this.version.update((v) => v + 1);
  }

  clear(): void {
    if (!this.isBrowser) return;
    this.fallbackToken = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
      this.useFallback = false;
    } catch {
      // Do not resurrect an uncleared persistent value inside this document. The logical session is
      // gone even when the browser refuses access to its backing store.
      this.useFallback = true;
    }
    this.version.update((v) => v + 1);
  }
}
