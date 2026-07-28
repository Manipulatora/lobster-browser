import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  heroArrowLeft,
  heroEnvelopeOpen,
  heroExclamationCircle,
} from '@ng-icons/heroicons/outline';

@Component({
  selector: 'app-forgot-password-page',
  imports: [ReactiveFormsModule, RouterLink, NgIcon],
  viewProviders: [provideIcons({ heroArrowLeft, heroEnvelopeOpen, heroExclamationCircle })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './forgot-password-page.html',
})
export class ForgotPasswordPage {
  private readonly fb = inject(FormBuilder);

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected readonly submitting = signal(false);
  /** Once true the form is replaced by the confirmation panel. */
  protected readonly submitted = signal(false);
  protected readonly sentTo = signal('');

  /** Errors surface once the field has been touched, or as soon as a submit is attempted. */
  protected readonly attempted = signal(false);

  protected showEmailError(): boolean {
    const control = this.form.controls.email;
    return control.invalid && (control.touched || this.attempted());
  }

  protected submit(): void {
    if (this.submitting()) return;

    this.attempted.set(true);
    this.form.markAllAsTouched();
    if (this.form.invalid) return;

    this.submitting.set(true);

    // No backend yet. The real request goes here — POST /auth/forgot-password, which always
    // responds the same way so the endpoint cannot be used to enumerate accounts.
    setTimeout(() => {
      this.sentTo.set(this.form.controls.email.value.trim());
      this.submitting.set(false);
      this.submitted.set(true);
    }, 900);
  }

  protected tryAnotherEmail(): void {
    this.submitted.set(false);
    this.attempted.set(false);
    this.sentTo.set('');
    this.form.reset();
  }
}
