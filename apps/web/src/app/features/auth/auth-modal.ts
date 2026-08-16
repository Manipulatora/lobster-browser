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
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';

import { AuthStore } from '../../core/auth/auth.store';
import { DesktopHandoff } from '../../core/auth/desktop-handoff';
import { AuthModalService } from './auth-modal.service';

/** Minimum password length accepted by the form. Must not exceed the backend's own minimum. */
const MIN_PASSWORD = 8;

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

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(MIN_PASSWORD)]],
  });

  constructor() {
    effect(() => {
      const open = this.mode() !== null;
      // Lock the page behind the modal. Without this the backdrop scrolls under the dialog on
      // wheel and touch, which reads as the modal itself being broken.
      this.document.body.style.overflow = open ? 'hidden' : '';
      if (!open) {
        this.form.reset();
        this.submitted.set(false);
        this.error.set(null);
      }
    });
  }

  /** Errors stay hidden until the field has been visited or the form submitted once. */
  protected invalid(name: 'email' | 'password'): boolean {
    const control = this.form.controls[name];
    return control.invalid && (control.touched || this.submitted());
  }

  protected togglePassword(): void {
    this.showPassword.update((shown) => !shown);
  }

  protected switchMode(): void {
    this.error.set(null);
    this.submitted.set(false);
    this.modal.switchTo(this.isSignUp() ? 'sign-in' : 'sign-up');
  }

  protected close(): void {
    if (this.submitting()) return; // never abandon an in-flight auth request
    this.modal.close();
    // `/signup` and `/login` are real routes, so dismissing the modal has to leave them or the URL
    // keeps claiming a dialog that is no longer open — and a reload would reopen it.
    const path = this.router.url.split('?')[0];
    if (path === '/signup' || path === '/login') void this.router.navigate(['/']);
  }

  /** Backdrop clicks dismiss; clicks inside the panel must not. */
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
    const { email, password } = this.form.getRawValue();

    try {
      if (this.isSignUp()) {
        await this.auth.register(email, password);
      } else {
        await this.auth.login(email, password);
      }

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
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'something went wrong');
    } finally {
      this.submitting.set(false);
    }
  }
}
