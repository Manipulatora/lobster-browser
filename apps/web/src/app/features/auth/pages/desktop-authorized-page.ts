import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * "You're signed in — close this and go back to the app."
 *
 * The launcher's loopback listener serves its own confirmation after receiving the callback, so
 * this page exists for the cases where it cannot: the listener timed out, the port was taken, or
 * the user opened the link on a machine that is not running the launcher. Without it the browser
 * would sit on a connection-refused error after a successful sign-in, which reads as the sign-in
 * having failed.
 *
 * Deliberately static: by the time anyone sees this, the handoff has already happened or already
 * failed, and there is nothing left for the page to do.
 */
@Component({
  selector: 'app-desktop-authorized-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="container-page flex min-h-[70vh] items-center justify-center py-16">
      <div class="card max-w-[30rem] p-8 text-center sm:p-10">
        <div
          class="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"
          aria-hidden="true"
        >
          <span class="icon text-[28px]">check_circle</span>
        </div>

        <h1 class="mt-6 text-2xl tracking-[-0.02em] text-ink">You're signed in</h1>
        <p class="mt-3 text-[0.9375rem] text-muted">
          Lobster Browser has been authorised on this device. You can close this tab and return to
          the app — it should already be unlocked.
        </p>

        <div class="rule mt-8 pt-6 text-left">
          <p class="text-[0.875rem] text-muted">
            Still showing the sign-in screen? Quit the app and open it again. If it keeps asking,
            start the sign-in from the app rather than from this page, so it can listen for the
            reply.
          </p>
        </div>
      </div>
    </div>
  `,
})
export class DesktopAuthorizedPage {}
