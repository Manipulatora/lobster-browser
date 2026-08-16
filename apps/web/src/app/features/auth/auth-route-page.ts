import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import { AuthModalService, type AuthMode } from './auth-modal.service';

/**
 * The page behind `/signup` and `/login`.
 *
 * Those are real URLs — the desktop launcher opens them directly, and they are what people paste
 * and bookmark — but the product decision is that authentication is a modal. So the route resolves
 * to this: a quiet backdrop that opens the modal on arrival.
 *
 * WHY NOT RENDER THE LANDING PAGE BEHIND IT. That would be the more natural backdrop, but the
 * landing page mounts two WebGL scenes. Someone arriving cold from the launcher would pay for a
 * fluid simulation they will never look at, on a page whose only purpose is a 400px dialog. This
 * costs nothing and gets out of the way.
 */
@Component({
  selector: 'app-auth-route-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bg-aurora min-h-[70vh]" aria-hidden="true"></div>
  `,
})
export class AuthRoutePage {
  /** Bound from route `data` via `withComponentInputBinding()`. */
  readonly mode = input.required<AuthMode>();

  private readonly modal = inject(AuthModalService);

  constructor() {
    // Opening in the constructor is safe on the server too: AuthModalService only sets a signal,
    // and the modal renders as markup that hydration then takes over.
    queueMicrotask(() => this.modal.open(this.mode()));
  }
}
