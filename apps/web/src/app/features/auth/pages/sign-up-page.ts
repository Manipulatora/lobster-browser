import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { heroExclamationCircle, heroEye, heroEyeSlash } from '@ng-icons/heroicons/outline';

import { SocialAuth } from '../components/social-auth';

@Component({
  selector: 'app-sign-up-page',
  imports: [ReactiveFormsModule, RouterLink, NgIcon, SocialAuth],
  viewProviders: [provideIcons({ heroExclamationCircle, heroEye, heroEyeSlash })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sign-up-page.html',
})
export class SignUpPage {
  private readonly fb = inject(FormBuilder);

  protected readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2)]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
    terms: [false, [Validators.requiredTrue]],
  });

  protected readonly submitting = signal(false);
  protected readonly submitted = signal(false);
  protected readonly showPassword = signal(false);

  /** Four segments, filled from the left as the score climbs. */
  protected readonly strengthBars = [1, 2, 3, 4] as const;

  protected readonly passwordValue = toSignal(this.form.controls.password.valueChanges, {
    initialValue: '',
  });

  /** 0–4. Length carries two points; character variety carries the other two. */
  protected readonly strength = computed(() => {
    const value = this.passwordValue();
    if (!value) return 0;

    let score = 0;
    if (value.length >= 8) score++;
    if (value.length >= 12) score++;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
    if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) score++;
    return score;
  });

  protected readonly strengthLabel = computed(() => {
    switch (this.strength()) {
      case 4:
        return 'Strong';
      case 3:
        return 'Good';
      case 2:
        return 'Fair';
      case 1:
        return 'Weak';
      default:
        return 'Too short';
    }
  });

  protected togglePassword(): void {
    this.showPassword.update((shown) => !shown);
  }

  /** Errors surface once the field has been touched, or as soon as a submit is attempted. */
  protected showError(field: 'name' | 'email' | 'password' | 'terms'): boolean {
    const control = this.form.controls[field];
    return control.invalid && (control.touched || this.submitted());
  }

  protected submit(): void {
    if (this.submitting()) return;

    this.submitted.set(true);
    this.form.markAllAsTouched();
    if (this.form.invalid) return;

    this.submitting.set(true);

    // No backend yet. The real account creation goes here — POST /auth/sign-up, then start the
    // session and send the user into onboarding.
    setTimeout(() => this.submitting.set(false), 900);
  }
}
