import { useEffect, useRef, useState } from 'react';

import { authClient, type CloudUser } from '../../api/auth';
import siteLogo from '../../assets/brand/site-logo.png';
import { Button } from '../../ui';
import { SignInAttemptGate } from './signInAttempt';

interface AuthScreenProps {
  onAttemptStarted: () => void;
  onUnauthenticatedAttemptFinished: () => void;
  onAuthenticated: (user: CloudUser) => void;
}

/**
 * The first screen: two buttons, centred.
 *
 * Neither one asks for a password. Both open the system browser at lobrowser.com and wait for the
 * loopback callback (see `cloud_auth.rs` for the flow and what protects it). That keeps every
 * credential path — reset, verification, rate limiting, later 2FA — in one implementation on the
 * website, and means this window never handles a password at all.
 *
 * NO EXPLANATORY COPY. The two buttons say what they do, and a paragraph under a logo on a launcher's
 * first screen is text nobody reads that still has to be maintained, translated and kept true — the
 * previous line had already gone stale twice, promising sync that did not exist and a free-profile
 * count the server no longer honoured.
 *
 * WAITING IS THE INTERESTING STATE. Once the browser opens, this window has nothing to show for
 * up to ten minutes while the user reads a pricing page or hunts for a verification email. It must
 * not look frozen and it must offer a way out — so it keeps the mark, an animated pulse, and one
 * unmissable Cancel. Nothing else: the instruction it used to print ("finish signing in in the
 * browser window that just opened") describes something already happening in front of the user.
 */
export function AuthScreen({
  onAttemptStarted,
  onUnauthenticatedAttemptFinished,
  onAuthenticated,
}: AuthScreenProps): JSX.Element {
  const [waiting, setWaiting] = useState<'signup' | 'login' | null>(null);
  const [cancelState, setCancelState] = useState<'cancelling' | 'finishing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeAttempt = useRef<SignInAttemptGate | null>(null);

  useEffect(
    () => () => {
      const attempt = activeAttempt.current;
      if (attempt) {
        activeAttempt.current = null;
        void attempt
          .requestCancel((attemptId) => authClient.cancelSignIn(attemptId))
          .catch(() => undefined);
      }
    },
    [],
  );

  async function start(mode: 'signup' | 'login'): Promise<void> {
    if (activeAttempt.current) return;
    const attempt = new SignInAttemptGate();
    activeAttempt.current = attempt;
    // Invalidate boot-time auth_status before its old-account response can unmount this attempt.
    onAttemptStarted();
    setError(null);
    setCancelState(null);
    setWaiting(mode);
    try {
      const user = await authClient.signIn(mode, attempt.id);
      if (activeAttempt.current === attempt && (await attempt.acceptsCompletion())) {
        activeAttempt.current = null;
        setWaiting(null);
        setCancelState(null);
        onAuthenticated(user);
      }
    } catch (err: unknown) {
      if (activeAttempt.current === attempt && (await attempt.acceptsCompletion())) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (activeAttempt.current === attempt) {
        activeAttempt.current = null;
        setWaiting(null);
        setCancelState(null);
        // Starting this attempt invalidated boot-time token-A answers. If no new account was
        // accepted, re-check local/native auth so a still-valid A is not hidden until restart.
        onUnauthenticatedAttemptFinished();
      }
    }
  }

  async function cancel(): Promise<void> {
    const attempt = activeAttempt.current;
    if (!attempt) return;
    setError(null);
    setCancelState('cancelling');
    try {
      const accepted = await attempt.requestCancel((attemptId) =>
        authClient.cancelSignIn(attemptId),
      );
      // `false` means credential commit won the Rust-side lock. Keep waiting for its real result.
      if (activeAttempt.current === attempt && !accepted) setCancelState('finishing');
    } catch (err: unknown) {
      // Cancellation was not confirmed, so the original attempt remains authoritative and visible.
      if (activeAttempt.current === attempt) {
        setCancelState(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  return (
    // NO CARD. The content sits directly on the window background: a bordered panel floating on an
    // empty screen is chrome drawn around nothing, and at this size it reads as a dialog the user
    // is expected to dismiss rather than the app's own first screen.
    <div className="auth-screen">
      <div className="auth-screen__content">
        <img className="auth-screen__logo" src={siteLogo} alt="Lobster Browser" />

        {waiting ? (
          <>
            {/* The status is carried by the pulsing mark and announced to screen readers, rather
                than printed as a sentence. */}
            <div
              className="auth-screen__waiting"
              role="status"
              aria-live="polite"
              aria-label={
                waiting === 'signup'
                  ? 'Waiting for you to finish creating your account in the browser'
                  : 'Waiting for you to finish signing in in the browser'
              }
            >
              <span className="auth-screen__dot" />
              <span className="auth-screen__dot" />
              <span className="auth-screen__dot" />
            </div>
            {/* Rust confirms the exact attempt was cancelled before this completion is ignored. */}
            <Button
              className="auth-screen__button auth-screen__cancel"
              disabled={cancelState !== null}
              onClick={() => void cancel()}
            >
              {cancelState === 'cancelling'
                ? 'Cancelling…'
                : cancelState === 'finishing'
                  ? 'Finishing…'
                  : 'Cancel'}
            </Button>
            {error ? (
              <p className="auth-screen__error" role="alert">
                {error}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div className="auth-screen__actions">
              <Button
                variant="primary"
                className="auth-screen__button"
                onClick={() => void start('signup')}
              >
                Sign up
              </Button>
              <Button className="auth-screen__button" onClick={() => void start('login')}>
                Log in
              </Button>
            </div>

            {error ? (
              <p className="auth-screen__error" role="alert">
                {error}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
