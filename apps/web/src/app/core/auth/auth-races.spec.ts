import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';

import { API_BASE_URL } from '../api/api.config';
import { ApiClient, ApiError } from '../api/api.client';
import { AuthStore, type AuthUser } from './auth.store';
import { TokenStore } from './token.store';

class MutableTokens {
  current: string | null = null;
  clears = 0;
  revision = 0;

  read(): string | null {
    return this.current;
  }

  write(token: string): void {
    this.current = token;
    this.revision += 1;
  }

  clear(): void {
    this.clears += 1;
    this.current = null;
    this.revision += 1;
  }

  snapshot(): { token: string | null; revision: number } {
    return { token: this.current, revision: this.revision };
  }

  isCurrent(snapshot: { token: string | null; revision: number }): boolean {
    return this.current === snapshot.token && this.revision === snapshot.revision;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const userA: AuthUser = {
  id: 'user-a',
  email: 'a@example.com',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const userB: AuthUser = {
  id: 'user-b',
  email: 'b@example.com',
  createdAt: '2026-01-02T00:00:00.000Z',
};

describe('auth response ordering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('keeps the current document signed in when persistent storage rejects a token write', () => {
    TestBed.configureTestingModule({
      providers: [TokenStore, { provide: PLATFORM_ID, useValue: 'browser' }],
    });
    const tokens = TestBed.inject(TokenStore);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    tokens.write('memory-only-token');

    expect(tokens.read()).toBe('memory-only-token');
    tokens.clear();
    expect(tokens.read()).toBeNull();
  });

  it('retains a successfully read session if storage becomes unavailable later', () => {
    localStorage.setItem('lobster.token', 'persisted-token');
    TestBed.configureTestingModule({
      providers: [TokenStore, { provide: PLATFORM_ID, useValue: 'browser' }],
    });
    const tokens = TestBed.inject(TokenStore);
    expect(tokens.read()).toBe('persisted-token');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    expect(tokens.read()).toBe('persisted-token');
  });

  it('does not let an old-token 401 clear a newer login', async () => {
    const tokens = new MutableTokens();
    tokens.current = 'token-a';
    const response = new Subject<never>();
    TestBed.configureTestingModule({
      providers: [
        ApiClient,
        { provide: HttpClient, useValue: { request: () => response } },
        { provide: API_BASE_URL, useValue: 'https://api.example.test' },
        { provide: TokenStore, useValue: tokens },
      ],
    });

    const request = TestBed.inject(ApiClient).get('/auth/me');
    tokens.current = 'token-b';
    response.error(new HttpErrorResponse({ status: 401, statusText: 'Unauthorized' }));

    await expect(request).rejects.toBeInstanceOf(ApiError);
    expect(tokens.current).toBe('token-b');
    expect(tokens.clears).toBe(0);
  });

  it('does not let an old 401 clear an identical token from a new logical login', async () => {
    const tokens = new MutableTokens();
    tokens.write('same-token');
    const response = new Subject<never>();
    TestBed.configureTestingModule({
      providers: [
        ApiClient,
        { provide: HttpClient, useValue: { request: () => response } },
        { provide: API_BASE_URL, useValue: 'https://api.example.test' },
        { provide: TokenStore, useValue: tokens },
      ],
    });

    const request = TestBed.inject(ApiClient).get('/auth/me');
    tokens.write('same-token');
    response.error(new HttpErrorResponse({ status: 401, statusText: 'Unauthorized' }));

    await expect(request).rejects.toBeInstanceOf(ApiError);
    expect(tokens.current).toBe('same-token');
    expect(tokens.clears).toBe(0);
  });

  it('hides the authenticated user when another API request rejects the current session', async () => {
    const unauthorized = new Subject<never>();
    TestBed.configureTestingModule({
      providers: [
        AuthStore,
        ApiClient,
        TokenStore,
        { provide: PLATFORM_ID, useValue: 'browser' },
        {
          provide: HttpClient,
          useValue: {
            request: (_method: string, url: string) =>
              url.endsWith('/auth/login')
                ? of({
                    code: 0,
                    data: { user: userA, token: 'current-token' },
                    msg: '',
                  })
                : unauthorized,
          },
        },
        { provide: API_BASE_URL, useValue: 'https://api.example.test' },
      ],
    });

    const auth = TestBed.inject(AuthStore);
    const api = TestBed.inject(ApiClient);
    await auth.login('a@example.com', 'password');
    expect(auth.user()).toEqual(userA);
    expect(auth.isAuthenticated()).toBe(true);

    const request = api.get('/private');
    unauthorized.error(new HttpErrorResponse({ status: 401, statusText: 'Unauthorized' }));
    await expect(request).rejects.toBeInstanceOf(ApiError);

    expect(auth.user()).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('does not resurrect a session after logout while restore is in flight', async () => {
    const tokens = new MutableTokens();
    tokens.current = 'token-a';
    const restored = deferred<AuthUser>();
    TestBed.configureTestingModule({
      providers: [
        AuthStore,
        { provide: ApiClient, useValue: { get: () => restored.promise } },
        { provide: TokenStore, useValue: tokens },
      ],
    });

    const auth = TestBed.inject(AuthStore);
    const restoring = auth.restore();
    auth.logout();
    restored.resolve(userA);
    await restoring;

    expect(auth.user()).toBeNull();
    expect(tokens.current).toBeNull();
  });

  it('does not let an old restore overwrite a later successful login', async () => {
    const tokens = new MutableTokens();
    tokens.current = 'token-a';
    const restored = deferred<AuthUser>();
    const api = {
      get: () => restored.promise,
      post: () => Promise.resolve({ user: userB, token: 'token-b' }),
    };
    TestBed.configureTestingModule({
      providers: [
        AuthStore,
        { provide: ApiClient, useValue: api },
        { provide: TokenStore, useValue: tokens },
      ],
    });

    const auth = TestBed.inject(AuthStore);
    const restoring = auth.restore();
    await auth.login('b@example.com', 'password');
    restored.resolve(userA);
    await restoring;

    expect(auth.user()).toEqual(userB);
    expect(tokens.current).toBe('token-b');
  });

  it('does not let an old restore overwrite a re-login that minted the same token bytes', async () => {
    const tokens = new MutableTokens();
    tokens.write('same-token');
    const restored = deferred<AuthUser>();
    const api = {
      get: () => restored.promise,
      post: () => Promise.resolve({ user: userB, token: 'same-token' }),
    };
    TestBed.configureTestingModule({
      providers: [
        AuthStore,
        { provide: ApiClient, useValue: api },
        { provide: TokenStore, useValue: tokens },
      ],
    });

    const auth = TestBed.inject(AuthStore);
    const restoring = auth.restore();
    await auth.login('b@example.com', 'password');
    restored.resolve(userA);
    await restoring;

    expect(auth.user()).toEqual(userB);
    expect(tokens.current).toBe('same-token');
  });
});
