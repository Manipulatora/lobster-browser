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
  private readonly _verifyFor = signal<string | null>(null);
  private readonly _verifyForRead = this._verifyFor.asReadonly();

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

  /**
   * Open straight at the code step for an already-registered, still-unverified account.
   *
   * Needed because the dialog can be dismissed mid-verification: the account exists and is signed
   * in, but every money route stays shut until the address is proven, so there has to be a way
   * back to the code entry that does not ask the user to register again.
   */
  openVerification(email: string, onSuccess?: () => void): void {
    this._verifyFor.set(email);
    this._mode.set('sign-up');
    this._afterAuth.set(onSuccess ?? null);
  }

  /** The address awaiting a code, when the dialog should open at that step. */
  readonly verifyFor = this._verifyForRead;

  /** Cleared by the modal once it has taken the hint, so a later open starts at credentials. */
  clearVerification(): void {
    this._verifyFor.set(null);
  }

  switchTo(mode: AuthMode): void {
    this._verifyFor.set(null);
    // Deliberately keeps the pending `onSuccess`: someone who opens sign-in, realises they have no
    // account, and switches to sign-up should still land where they were going.
    this._mode.set(mode);
  }

  close(): void {
    this._mode.set(null);
    this._afterAuth.set(null);
    this._verifyFor.set(null);
  }

  /** Called by the modal after a successful sign-in or sign-up. */
  completed(): void {
    const callback = this._afterAuth();
    this._mode.set(null);
    this._afterAuth.set(null);
    this._verifyFor.set(null);
    callback?.();
  }
}
