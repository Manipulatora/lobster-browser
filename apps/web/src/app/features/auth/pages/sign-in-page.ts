import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { heroExclamationCircle, heroEye, heroEyeSlash } from '@ng-icons/heroicons/outline';

import { SocialAuth } from '../components/social-auth';

@Component({
  selector: 'app-sign-in-page',
  imports: [ReactiveFormsModule, RouterLink, NgIcon, SocialAuth],
  viewProviders: [provideIcons({ heroExclamationCircle, heroEye, heroEyeSlash })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sign-in-page.html',
})
export class SignInPage {
  private readonly fb = inject(FormBuilder);

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    // Sign-in only checks presence — length rules belong on sign-up, not on existing credentials.
    password: ['', [Validators.required]],
    remember: [false],
  });

  protected readonly submitting = signal(false);
  protected readonly submitted = signal(false);
  protected readonly showPassword = signal(false);

  protected togglePassword(): void {
    this.showPassword.update((shown) => !shown);
  }

  /** Errors surface once the field has been touched, or as soon as a submit is attempted. */
  protected showError(field: 'email' | 'password'): boolean {
    const control = this.form.controls[field];
    return control.invalid && (control.touched || this.submitted());
  }

  protected submit(): void {
    if (this.submitting()) return;

    this.submitted.set(true);
    this.form.markAllAsTouched();
    if (this.form.invalid) return;

    this.submitting.set(true);

    // No backend yet. The real credential exchange goes here — POST /auth/sign-in, then store the
    // session and navigate to the dashboard.
    setTimeout(() => this.submitting.set(false), 900);
  }
}
