import type { AuthState, CloudUser } from '../../api/auth';

/** Orders cached and verified boot answers without letting either cross a later session boundary. */
export class AuthBootstrapGate {
  private generation = 0;
  private networkState: AuthState | null = null;
  private cachedUser: CloudUser | null = null;
  private cachedSettled = false;

  begin(): number {
    this.generation += 1;
    this.networkState = null;
    this.cachedUser = null;
    this.cachedSettled = false;
    return this.generation;
  }

  supersede(): void {
    this.generation += 1;
    this.networkState = null;
    this.cachedUser = null;
    this.cachedSettled = false;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  markCachedSettled(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.cachedSettled = true;
    return true;
  }

  readyForFirstPaint(generation: number): boolean {
    return this.isCurrent(generation) && this.cachedSettled;
  }

  acceptCached(generation: number, state: AuthState): AuthState | undefined {
    if (!this.isCurrent(generation)) return undefined;
    this.cachedUser = state.user;
    // A conclusive online answer always outranks local memory. During an outage, retain the cached
    // identity for display while keeping the explicit offline state.
    if (this.networkState && !this.networkState.offline) return undefined;
    return {
      user: state.user,
      offline: this.networkState?.offline ?? false,
    };
  }

  acceptNetwork(generation: number, state: AuthState): AuthState | undefined {
    if (!this.isCurrent(generation)) return undefined;
    this.networkState = state;
    return {
      user: state.user ?? (state.offline ? this.cachedUser : null),
      offline: state.offline,
    };
  }
}
