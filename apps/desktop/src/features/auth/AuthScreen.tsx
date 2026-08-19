import { useState } from 'react';

import { authClient, type CloudUser } from '../../api/auth';
import siteLogo from '../../assets/brand/site-logo.png';
import { Button } from '../../ui';

interface AuthScreenProps {
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
export function AuthScreen({ onAuthenticated }: AuthScreenProps): JSX.Element {
  const [waiting, setWaiting] = useState<'signup' | 'login' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(mode: 'signup' | 'login'): Promise<void> {
    setError(null);
    setWaiting(mode);
    try {
      onAuthenticated(await authClient.signIn(mode));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWaiting(null);
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
            {/* Cancelling only stops this window waiting; the Rust side drops its loopback
                listener when the attempt is abandoned. */}
            <Button
              className="auth-screen__button auth-screen__cancel"
              onClick={() => setWaiting(null)}
            >
              Cancel
            </Button>
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
