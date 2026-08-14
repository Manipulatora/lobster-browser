import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';

/**
 * Sign in.
 *
 * There is no auth backend wired up yet, so {@link submit} deliberately stops after validation
 * rather than faking a session or a success message.
 */
@Component({
  selector: 'app-sign-in-page',
  imports: [ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sign-in-page.html',
})
export class SignInPage {
  private readonly fb = inject(FormBuilder);

  protected readonly showPassword = signal(false);
  protected readonly submitted = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  /** Errors stay hidden until the field has been visited or the form has been submitted once. */
  protected invalid(name: 'email' | 'password'): boolean {
    const control = this.form.controls[name];
    return control.invalid && (control.touched || this.submitted());
  }

  protected togglePassword(): void {
    this.showPassword.update((shown) => !shown);
  }

  protected submit(): void {
    this.submitted.set(true);
    if (this.form.invalid) this.form.markAllAsTouched();
  }
}
