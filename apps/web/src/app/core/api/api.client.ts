import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { API_BASE_URL } from './api.config';
import { TokenStore } from '../auth/token.store';

/**
 * The universal `{ code, data, msg }` envelope every Lobster API returns. `code === 0` is success.
 * Mirrors `@lobster/shared-types`, restated here so the web app does not depend on the workspace
 * package (it is not in this app's dependency graph and pulling it in would drag Node-oriented
 * types into a browser bundle).
 */
interface ApiEnvelope<T> {
  code: number;
  data: T;
  msg: string;
}

/** An API call that returned a non-zero `code`, or failed at the transport level. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Typed access to the cloud API.
 *
 * UNWRAPS THE ENVELOPE, so callers deal in domain values and exceptions rather than in
 * `{ code, data, msg }`. A non-zero `code` is an ApiError even though the HTTP status was 200 —
 * the backend uses the envelope for business failures, and a caller that only checked the HTTP
 * status would treat "not enough Credit" as success and act on `data: null`.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);
  private readonly tokens = inject(TokenStore);

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let headers = new HttpHeaders({ 'Content-Type': 'application/json' });
    const auth = this.tokens.snapshot();
    const token = auth.token;
    if (token) headers = headers.set('Authorization', `Bearer ${token}`);

    try {
      const res = await firstValueFrom(
        this.http.request<ApiEnvelope<T>>(method, `${this.baseUrl}${path}`, {
          body,
          headers,
        }),
      );
      if (!res || res.code !== 0) {
        throw new ApiError(res?.msg || 'request failed', 200);
      }
      return res.data;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof HttpErrorResponse) {
        // A 401 means the stored token is gone or expired. Clear it here rather than leaving every
        // caller to notice — otherwise the UI keeps showing a signed-in shell that cannot load
        // anything.
        // Clear only the credential THIS request actually used. A slow request carrying token A can
        // finish after a fresh login has installed token B; letting A's 401 clear B signs the new
        // session out from underneath its own successful login.
        if (err.status === 401 && this.tokens.isCurrent(auth)) this.tokens.clear();
        throw new ApiError(extractMessage(err), err.status);
      }
      throw new ApiError('network error', 0);
    }
  }
}

/**
 * Pull a human-usable message out of an error response.
 *
 * The backend's global filter now answers errors in the same `{ code, data, msg }` envelope as
 * successes, so `msg` is the normal path. The `message` branches remain for the responses that never
 * reach that filter — body-parser's own 413, and anything a proxy generates in front of Nest.
 */
function extractMessage(err: HttpErrorResponse): string {
  const body = err.error as { message?: string | string[]; msg?: string } | null;
  if (body) {
    if (Array.isArray(body.message)) return body.message.join(', ');
    if (typeof body.message === 'string') return body.message;
    if (typeof body.msg === 'string') return body.msg;
  }
  if (err.status === 0) return 'cannot reach the server';
  return err.statusText || 'request failed';
}
