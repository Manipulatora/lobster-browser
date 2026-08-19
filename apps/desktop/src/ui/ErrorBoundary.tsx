import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

import { Button } from './Button';

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * The last thing between a render-time throw and a blank white window.
 *
 * React unmounts the whole tree when a render throws, so without this the desktop shell becomes an
 * empty webview with no message, no way back and nothing in the UI to report — the failure mode the
 * crash hooks in `main.tsx` only ever wrote to a console nobody has open. Reload is offered because
 * every state this app holds is re-read from the Rust side on boot: nothing is lost by starting the
 * window again.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[lobster] render crashed', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash-screen" role="alert">
        <div className="crash-screen__card">
          <h1 className="crash-screen__title">Lobster Browser hit an unexpected error</h1>
          {/* The message is shown rather than summarised: it is the only thing a user can paste into
              a support request, and hiding it costs them the one useful detail they have. */}
          <p className="crash-screen__message">{error.message}</p>
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload the window
          </Button>
        </div>
      </div>
    );
  }
}
