import { useState } from 'react';

import { authClient, type CloudUser } from '../../api/auth';
import siteLogo from '../../assets/brand/site-logo.png';

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
 * WAITING IS THE INTERESTING STATE. Once the browser opens, this window has nothing to show for
 * up to ten minutes while the user reads a pricing page or hunts for a verification email. It
 * must not look frozen, and it must offer a way out — hence the explicit "waiting" panel with a
 * cancel that returns here rather than a spinner over a dead UI.
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
    <div className="auth-screen">
      <div className="auth-screen__panel">
        <img className="auth-screen__logo" src={siteLogo} alt="Lobster Browser" />

        {waiting ? (
          <>
            <h1 className="auth-screen__title">Waiting for your browser</h1>
            <p className="auth-screen__lede">
              Finish {waiting === 'signup' ? 'creating your account' : 'signing in'} in the browser
              window that just opened. This screen unlocks by itself when you are done.
            </p>
            <div className="auth-screen__waiting" role="status" aria-live="polite">
              <span className="auth-screen__dot" />
              <span className="auth-screen__dot" />
              <span className="auth-screen__dot" />
            </div>
            {/* Cancelling only stops this window waiting; the Rust side drops its loopback
                listener when the attempt is abandoned. */}
            <button
              type="button"
              className="auth-screen__link"
              onClick={() => setWaiting(null)}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <h1 className="auth-screen__title">Lobster Browser</h1>
            <p className="auth-screen__lede">
              Sign in to sync profiles and manage your plan. New accounts start with five free
              profiles.
            </p>

            <div className="auth-screen__actions">
              <button
                type="button"
                className="btn btn--primary auth-screen__button"
                onClick={() => void start('signup')}
              >
                Sign up
              </button>
              <button
                type="button"
                className="btn auth-screen__button"
                onClick={() => void start('login')}
              >
                Log in
              </button>
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
