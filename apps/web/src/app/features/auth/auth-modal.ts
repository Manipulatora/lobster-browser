import { A11yModule } from '@angular/cdk/a11y';
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  FormBuilder,
  ReactiveFormsModule,
  Validators,
  type AbstractControl,
  type ValidationErrors,
} from '@angular/forms';
import { Router } from '@angular/router';

import { AuthStore } from '../../core/auth/auth.store';
import { DesktopHandoff } from '../../core/auth/desktop-handoff';
import { AuthModalService } from './auth-modal.service';

/** Minimum password length accepted by the form. Must not exceed the backend's own minimum. */
const MIN_PASSWORD = 8;

/**
 * Mail providers sign-up accepts. MUST match `ALLOWED_EMAIL_DOMAINS` in the backend's auth service.
 *
 * Duplicated here only to save a round-trip and give the message next to the field. The server is
 * the authority and rejects anything else regardless of what this list says.
 */
const ALLOWED_EMAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
];

/** Rejects addresses outside the accepted providers. Only meaningful on the sign-up path. */
function allowedProviderValidator(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '')
    .trim()
    .toLowerCase();
  if (!value || !value.includes('@')) return null; // shape is `email`'s job, not ours
  const domain = value.slice(value.lastIndexOf('@') + 1);
  return ALLOWED_EMAIL_DOMAINS.includes(domain) ? null : { provider: true };
}

/**
 * Cross-field check: the two password boxes must agree.
 *
 * Attached to the GROUP rather than to `confirmPassword`, because editing the first box has to
 * re-evaluate the match too — a validator on the second field alone stays stale when the first one
 * changes, and reports a mismatch that is no longer true.
 */
function passwordsMatchValidator(group: AbstractControl): ValidationErrors | null {
  const password = group.get('password')?.value ?? '';
  const confirm = group.get('confirmPassword')?.value ?? '';
  if (!confirm) return null; // nothing typed yet; `required` is handled at submit
  return password === confirm ? null : { passwordMismatch: true };
}

/**
 * Sign up / sign in, as a modal over whatever the user was already looking at.
 *
 * A MODAL RATHER THAN A PAGE because signing up is almost always something a visitor does in the
 * middle of reading — from the pricing table, from a CTA — and routing them away discards that
 * context and their scroll position. `/signup` and `/login` still exist as real URLs (the desktop
 * launcher opens them directly, and they are what people paste), but they resolve to the site with
 * this modal open on top rather than to a separate page.
 *
 * Rendered once, in the site shell. Everything else opens it through {@link AuthModalService}.
 */
@Component({
  selector: 'app-auth-modal',
  imports: [ReactiveFormsModule, A11yModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './auth-modal.html',
})
export class AuthModal {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthStore);
  private readonly modal = inject(AuthModalService);
  private readonly handoff = inject(DesktopHandoff);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);

  protected readonly minPassword = MIN_PASSWORD;
  protected readonly mode = this.modal.mode;
  protected readonly isSignUp = computed(() => this.mode() === 'sign-up');
  protected readonly submitting = signal(false);
  protected readonly submitted = signal(false);
  protected readonly showPassword = signal(false);
  protected readonly error = signal<string | null>(null);

  /**
   * Which step the dialog is on.
   *
   * Sign-up does not finish at "account created": the address still has to be proven before the
   * account can move money, so the dialog stays open and asks for the emailed code rather than
   * dropping the user on a page that will refuse them.
   */
  protected readonly step = signal<'credentials' | 'verify'>('credentials');
  protected readonly code = signal('');
  protected readonly resending = signal(false);
  protected readonly resent = signal(false);
  /** The address the code went to, kept for the "we sent it to…" line and for resending. */
  private pendingEmail = '';
  protected readonly sentTo = signal('');

  protected readonly codeComplete = computed(() => /^\d{6}$/.test(this.code()));

  protected readonly form = this.fb.nonNullable.group(
    {
      fullName: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(80)]],
      company: ['', [Validators.maxLength(120)]],
      email: ['', [Validators.required, Validators.email, allowedProviderValidator]],
      password: ['', [Validators.required, Validators.minLength(MIN_PASSWORD)]],
      confirmPassword: [''],
    },
    { validators: passwordsMatchValidator },
  );

  constructor() {
    effect(() => {
      // Opened straight at the code step for an account that exists but is not yet proven.
      const pending = this.modal.verifyFor();
      if (pending) {
        this.pendingEmail = pending;
        this.sentTo.set(pending);
        this.step.set('verify');
      }
    });

    effect(() => {
      const open = this.mode() !== null;
      // Reading `mode()` through `isSignUp()` keeps this effect subscribed to mode changes, so the
      // sign-up-only controls are enabled/disabled whenever the dialog switches between the two.
      this.isSignUp();
      this.syncEnabledControls();

      // Lock the page behind the modal. Without this the backdrop scrolls under the dialog on
      // wheel and touch, which reads as the modal itself being broken.
      this.document.body.style.overflow = open ? 'hidden' : '';
      if (!open) {
        this.form.reset();
        this.submitted.set(false);
        this.error.set(null);
        this.step.set('credentials');
        this.code.set('');
        this.resent.set(false);
      }
    });
  }

  /**
   * Leave the dialog and land somewhere useful.
   *
   * The single exit for BOTH paths — signing in, and finishing sign-up by entering the code — so
   * the desktop handoff cannot be skipped by whichever path happens to be taken. Sign-up used to
   * reach it directly; now it arrives here one step later, and the launcher still gets its session.
   */
  private async finish(): Promise<void> {
    // If the launcher sent the user here, hand the session back to it instead of continuing into
    // the website. `complete` navigates away, so nothing below runs.
    const view = this.document.defaultView;
    const desktop = view ? this.handoff.parse(view.location.search) : null;
    if (desktop) {
      await this.handoff.complete(desktop);
      return;
    }

    this.modal.completed();
    // Straight to billing: a new account has no Credit and no package, so the dashboard would
    // only be able to tell them to go there.
    void this.router.navigate(['/account/billing']);
  }

  /** Errors stay hidden until the field has been visited or the form submitted once. */
  protected invalid(
    name: 'fullName' | 'company' | 'email' | 'password' | 'confirmPassword',
  ): boolean {
    const control = this.form.controls[name];
    return control.invalid && (control.touched || this.submitted());
  }

  /** The email failed specifically because of its provider, rather than its shape. */
  protected wrongProvider(): boolean {
    const control = this.form.controls.email;
    return control.hasError('provider') && (control.touched || this.submitted());
  }

  /** The two password boxes disagree. Lives on the group, so it is read from the group. */
  protected passwordMismatch(): boolean {
    return (
      this.form.hasError('passwordMismatch') &&
      (this.form.controls.confirmPassword.touched || this.submitted())
    );
  }

  /**
   * Which controls actually apply right now.
   *
   * Sign-in only needs email and password. The extra sign-up controls stay in one FormGroup rather
   * than being built twice, so they are disabled on the sign-in path — a disabled control is
   * excluded from the group's validity, which is what stops "full name is required" from blocking
   * a login.
   */
  private syncEnabledControls(): void {
    const signUp = this.isSignUp();
    for (const name of ['fullName', 'company', 'confirmPassword'] as const) {
      const control = this.form.controls[name];
      if (signUp && control.disabled) control.enable({ emitEvent: false });
      if (!signUp && control.enabled) control.disable({ emitEvent: false });
    }
    // `required` on the confirmation only makes sense while it is shown.
    const confirm = this.form.controls.confirmPassword;
    confirm.setValidators(signUp ? [Validators.required] : []);
    confirm.updateValueAndValidity({ emitEvent: false });

    // The provider restriction is a SIGN-UP rule. Applying it at sign-in would lock out any account
    // created before the restriction existed, on an address they can no longer change.
    const email = this.form.controls.email;
    email.setValidators(
      signUp
        ? [Validators.required, Validators.email, allowedProviderValidator]
        : [Validators.required, Validators.email],
    );
    email.updateValueAndValidity({ emitEvent: false });
  }

  protected togglePassword(): void {
    this.showPassword.update((shown) => !shown);
  }

  protected switchMode(): void {
    this.error.set(null);
    this.submitted.set(false);
    this.modal.switchTo(this.isSignUp() ? 'sign-in' : 'sign-up');
  }

  /** Digits only, six at most — so the boxes can never hold something unsubmittable. */
  protected onCodeInput(value: string): void {
    this.code.set(value.replace(/\D/g, '').slice(0, 6));
    this.error.set(null);
  }

  protected async submitCode(): Promise<void> {
    if (this.submitting() || !this.codeComplete()) return;
    this.submitting.set(true);
    this.error.set(null);
    try {
      // TWO DIFFERENT FLOWS REACH THIS BUTTON, and they need different endpoints.
      //
      // A sign-up in progress has no session and no account — the code completes the registration.
      // An already-signed-in user re-proving an address created before verification gated account
      // creation has no pending registration — the code is checked against their session instead.
      // Sending the second case to the sign-up endpoint would always fail with "incorrect or
      // expired", which is exactly the dead end the billing page's "Enter your code" link used to
      // lead to.
      if (this.auth.isAuthenticated()) {
        await this.auth.verifyExistingEmail(this.code());
      } else {
        await this.auth.verifyEmail(this.pendingEmail, this.code());
      }
      await this.finish();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'that code did not work');
      this.code.set('');
    } finally {
      this.submitting.set(false);
    }
  }

  protected async resend(): Promise<void> {
    if (this.resending()) return;
    this.resending.set(true);
    this.error.set(null);
    try {
      await this.auth.resendVerification(this.pendingEmail);
      this.resent.set(true);
      this.code.set('');
    } catch {
      // Resend is deliberately silent about outcomes; a failure here is not worth alarming over.
      this.resent.set(true);
    } finally {
      this.resending.set(false);
    }
  }

  /**
   * True while the dialog must not be dismissed by a stray click or an Escape key.
   *
   * The verify step is the whole sign-up: the credentials are held server-side awaiting this code,
   * and nothing exists until it is entered. Losing the dialog to a mis-click there throws the
   * sign-up away with no visible trace and drops the user back on the marketing site as though
   * they had an account. Leaving it is still possible — deliberately, via {@link abandon} — but it
   * has to be chosen.
   */
  protected readonly dismissLocked = computed(() => this.step() === 'verify');

  protected close(): void {
    if (this.submitting()) return; // never abandon an in-flight auth request
    if (this.dismissLocked()) return; // the verify step leaves only through `abandon`
    this.dismiss();
  }

  /**
   * Explicitly give up on a sign-up that is awaiting its code.
   *
   * Nothing has to be undone server-side: no account was created, and the pending registration
   * expires on its own.
   */
  protected abandon(): void {
    if (this.submitting()) return;
    this.dismiss();
  }

  private dismiss(): void {
    this.modal.close();
    // `/signup` and `/login` are real routes, so dismissing the modal has to leave them or the URL
    // keeps claiming a dialog that is no longer open — and a reload would reopen it.
    const path = this.router.url.split('?')[0];
    if (path === '/signup' || path === '/login') void this.router.navigate(['/']);
  }

  /** Backdrop clicks dismiss; clicks inside the panel must not, and neither does the verify step. */
  protected onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.close();
  }

  protected async submit(): Promise<void> {
    this.submitted.set(true);
    this.error.set(null);

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    if (this.submitting()) return;

    this.submitting.set(true);
    const { email, password, fullName, company } = this.form.getRawValue();

    try {
      if (this.isSignUp()) {
        await this.auth.register({ email, password, fullName, company });
        // NO ACCOUNT EXISTS YET. The server holds these credentials as a pending sign-up and has
        // emailed a code; nothing is created until `submitCode` succeeds. The dialog therefore
        // stays open on the verify step — closing it here would silently discard the sign-up, and
        // leaving the user on the site would imply an account that is not there.
        this.pendingEmail = email;
        this.sentTo.set(email);
        this.step.set('verify');
        this.submitting.set(false);
        return;
      }
      await this.auth.login(email, password);
      await this.finish();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'something went wrong');
    } finally {
      this.submitting.set(false);
    }
  }
}
