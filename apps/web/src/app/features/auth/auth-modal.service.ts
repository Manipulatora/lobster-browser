import { Injectable, signal } from '@angular/core';

export type AuthMode = 'sign-up' | 'sign-in';

/**
 * Open/close state for the auth modal, shared across the app.
 *
 * A service rather than component state because the modal is opened from places that have no
 * relationship to each other: the header, the pricing CTAs, a `/signup` deep link, and any guarded
 * action that needs a session. The modal itself is rendered once in the site shell.
 */
@Injectable({ providedIn: 'root' })
export class AuthModalService {
  private readonly _mode = signal<AuthMode | null>(null);
  private readonly _afterAuth = signal<(() => void) | null>(null);

  /** Null when closed. */
  readonly mode = this._mode.asReadonly();

  /**
   * @param onSuccess run once authentication succeeds — used to resume whatever the user was
   *                  trying to do when they were asked to sign in.
   */
  open(mode: AuthMode, onSuccess?: () => void): void {
    this._mode.set(mode);
    this._afterAuth.set(onSuccess ?? null);
  }

  switchTo(mode: AuthMode): void {
    // Deliberately keeps the pending `onSuccess`: someone who opens sign-in, realises they have no
    // account, and switches to sign-up should still land where they were going.
    this._mode.set(mode);
  }

  close(): void {
    this._mode.set(null);
    this._afterAuth.set(null);
  }

  /** Called by the modal after a successful sign-in or sign-up. */
  completed(): void {
    const callback = this._afterAuth();
    this._mode.set(null);
    this._afterAuth.set(null);
    callback?.();
  }
}
