import { Injectable, computed, inject, signal } from '@angular/core';

import { ApiClient } from '../api/api.client';
import { TokenStore } from './token.store';

export interface AuthUser {
  id: string;
  email: string;
  displayName?: string;
  createdAt: string;
  /** When the address was proven. Absent until the emailed code has been entered. */
  emailVerifiedAt?: string;
}

interface AuthResult {
  user: AuthUser;
  token: string;
}

/**
 * Signed-in state for the whole site.
 *
 * The user object is the reactive surface; the token is not (see {@link TokenStore}). `restore()`
 * is what turns a persisted token back into a session on load, and it is separate from the
 * constructor on purpose — it performs a network call, and a service constructor that fetches
 * runs during SSR rendering as well.
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly api = inject(ApiClient);
  private readonly tokens = inject(TokenStore);

  private readonly _user = signal<AuthUser | null>(null);
  private readonly _restoring = signal(false);
  /** The single outstanding `/auth/me` call, so concurrent restores share one result. */
  private _inFlight?: Promise<void>;

  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => this._user() !== null);
  readonly restoring = this._restoring.asReadonly();

  /**
   * Begin a sign-up. DOES NOT SIGN ANYONE IN, because no account exists yet.
   *
   * The server holds the credentials as a pending registration and emails a code; only
   * {@link verifyEmail} creates the account and returns a session. Nothing is stored here — there
   * is no token to store — so a caller that treats a resolved promise as "signed in" gets a signed
   * -out store, which is the truth.
   */
  async register(input: {
    email: string;
    password: string;
    fullName: string;
    company?: string;
  }): Promise<void> {
    await this.api.post<{ pending: true; email: string }>('/auth/register', {
      email: input.email,
      password: input.password,
      fullName: input.fullName,
      // Sent only when non-empty: the DTO rejects an empty string, and signing up as an individual
      // is a legitimate case with nothing truthful to put here.
      ...(input.company ? { company: input.company } : {}),
    });
  }

  async login(email: string, password: string): Promise<void> {
    this.accept(await this.api.post<AuthResult>('/auth/login', { email, password }));
  }

  /** True once the address on the account has actually been proven. */
  readonly emailVerified = computed(() => this.user()?.emailVerifiedAt != null);

  /**
   * Submit the emailed 6-digit code. THIS is what creates the account and signs the user in.
   *
   * Takes the address explicitly because there is no session to infer it from — registration
   * deliberately issues no token, so until this succeeds there is no account at all. Guessing is
   * bounded server-side by an attempt counter on the pending sign-up.
   */
  async verifyEmail(email: string, code: string): Promise<void> {
    this.accept(await this.api.post<AuthResult>('/auth/verify-email', { email, code }));
  }

  /**
   * Prove the address on an account that ALREADY exists and is signed in.
   *
   * The counterpart of {@link verifyEmail}, for accounts created before verification gated account
   * creation. They are signed in but unproven, so there is no pending registration to consume —
   * the session identifies them instead.
   */
  async verifyExistingEmail(code: string): Promise<void> {
    this._user.set(await this.api.post<AuthUser>('/auth/verify-email/session', { code }));
  }

  /**
   * Ask for a fresh code. Supersedes any still outstanding.
   *
   * Routes to whichever flow the caller is actually in: a signed-in user is re-proving an existing
   * address, anyone else is finishing a sign-up. Sending both to the sign-up endpoint would silently
   * do nothing for the first group, since they have no pending registration.
   */
  async resendVerification(email: string): Promise<void> {
    if (this.isAuthenticated()) {
      await this.api.post<{ sent: true }>('/auth/resend-verification/session', {});
      return;
    }
    await this.api.post<{ sent: true }>('/auth/resend-verification', { email });
  }

  /**
   * Re-establish the session from a stored token, if there is one.
   *
   * Verifies against `/auth/me` rather than trusting the token's presence: it may be expired or
   * signed with a rotated secret, and a UI that assumes otherwise renders a signed-in dashboard
   * whose every request then fails.
   */
  async restore(): Promise<void> {
    if (!this.tokens.read() || this._user()) return;
    // SHARE THE IN-FLIGHT CALL. A deep link into a guarded page calls this twice before either
    // resolves — once from `authGuard`, once from the page's own init — and two independent
    // requests race: if the loser rejects after the winner resolved, its `catch` sets the user
    // back to null and the freshly restored session is thrown away. That is precisely how a hard
    // load of /account/billing bounced an authenticated user to /login.
    this._inFlight ??= this.fetchSession().finally(() => {
      this._inFlight = undefined;
    });
    return this._inFlight;
  }

  private async fetchSession(): Promise<void> {
    this._restoring.set(true);
    try {
      this._user.set(await this.api.get<AuthUser>('/auth/me'));
    } catch {
      // ApiClient already cleared the token on 401. Any other failure leaves the user signed out,
      // which is the safe direction to be wrong in.
      this._user.set(null);
    } finally {
      this._restoring.set(false);
    }
  }

  logout(): void {
    this.tokens.clear();
    this._user.set(null);
  }

  private accept(result: AuthResult): void {
    // Token first: a component reacting to `user` may immediately issue an authenticated request,
    // and it would go out unauthenticated if the order were reversed.
    this.tokens.write(result.token);
    this._user.set(result.user);
  }
}
