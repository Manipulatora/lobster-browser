import { invoke } from '@tauri-apps/api/core';

import { isDesktopRuntime } from './tauri';

export interface CloudUser {
  id: string;
  email: string;
  displayName?: string;
}

/**
 * Three outcomes, not two.
 *
 * `offline` is the case a boolean cannot express: a token is held but the API could not be reached
 * to verify it. Treating that as signed-out would lock a user out of entirely local work — their
 * profiles, proxies and launches need no network — because their connection dropped.
 */
export interface AuthState {
  user: CloudUser | null;
  offline: boolean;
}

export interface AuthClient {
  status(): Promise<AuthState>;
  /** Opens the browser and resolves when the loopback callback completes. Rejects on timeout. */
  signIn(mode: 'signup' | 'login'): Promise<CloudUser>;
  signOut(): Promise<void>;
}

const tauriAuth: AuthClient = {
  status: () => invoke<AuthState>('auth_status'),
  signIn: (mode) => invoke<CloudUser>('auth_sign_in', { mode }),
  signOut: () => invoke<void>('auth_sign_out'),
};

/**
 * Dev-browser stand-in.
 *
 * Reports a signed-in developer rather than a signed-out one, so `npm run dev` opens on the actual
 * app instead of an auth wall that cannot be completed — there is no Rust side in a plain browser
 * to bind a loopback listener or reach the keychain.
 */
const mockAuth: AuthClient = {
  status: async () => ({
    user: { id: 'dev-user', email: 'dev@localhost', displayName: 'Dev' },
    offline: false,
  }),
  signIn: async () => ({ id: 'dev-user', email: 'dev@localhost', displayName: 'Dev' }),
  signOut: async () => undefined,
};

export const authClient: AuthClient = isDesktopRuntime() ? tauriAuth : mockAuth;
