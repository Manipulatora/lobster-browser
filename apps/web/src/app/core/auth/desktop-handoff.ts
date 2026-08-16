import { Injectable, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';

import { ApiClient } from '../api/api.client';

/** The launcher's parameters, as they arrive on the `?desktop=1` link. */
export interface DesktopHandoffParams {
  state: string;
  port: number;
  codeChallenge: string;
}

/**
 * The website's half of the desktop launcher's loopback sign-in (RFC 8252).
 *
 * The launcher opens `lobrowser.com/login?desktop=1&state=…&port=…&challenge=…` in the system
 * browser and waits on a local listener. Once the user has a session here, {@link complete} trades
 * it for a one-time code and sends the browser to the launcher's loopback address.
 *
 * WHY THE REDIRECT URL COMES FROM THE SERVER. It would be simpler to build
 * `http://127.0.0.1:<port>/callback?...` here from the query string. That would also make this an
 * open redirect on a page that has just minted an authorisation code: a link with a crafted `port`
 * — or a swapped host, if the URL were ever assembled less carefully — would deliver the code
 * somewhere else entirely. The server constructs it instead, so the target can only ever be
 * loopback, and this code just follows what it is given.
 */
@Injectable({ providedIn: 'root' })
export class DesktopHandoff {
  private readonly api = inject(ApiClient);
  private readonly document = inject(DOCUMENT);

  /**
   * Read the launcher's parameters out of a query string.
   *
   * @returns the parameters, or null when this is an ordinary web sign-in.
   */
  parse(search: string): DesktopHandoffParams | null {
    const params = new URLSearchParams(search);
    if (params.get('desktop') !== '1') return null;

    const state = params.get('state') ?? '';
    const codeChallenge = params.get('challenge') ?? '';
    const port = Number(params.get('port'));

    // A malformed desktop link must fall back to a normal sign-in rather than half-attempting a
    // handoff — the user still gets an account, and the launcher times out and can retry.
    if (!state || !codeChallenge || !Number.isInteger(port) || port < 1024 || port > 65535) {
      return null;
    }
    return { state, port, codeChallenge };
  }

  /**
   * Exchange the current web session for a launcher authorisation code and hand the browser over.
   *
   * Navigates away on success, so nothing after the call runs.
   */
  async complete(params: DesktopHandoffParams): Promise<void> {
    const { redirectUrl } = await this.api.post<{ redirectUrl: string }>('/auth/desktop/grant', {
      state: params.state,
      codeChallenge: params.codeChallenge,
      port: params.port,
    });

    // `location.replace`, not `assign`: the loopback URL carries a one-time code, and leaving it in
    // session history means a Back press re-issues a request with a code that is already spent —
    // which surfaces to the user as a confusing error on a page they thought had worked.
    this.document.defaultView?.location.replace(redirectUrl);
  }
}
