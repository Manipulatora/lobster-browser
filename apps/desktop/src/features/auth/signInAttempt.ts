/**
 * Orders one UI sign-in completion against its cancellation request.
 *
 * The Rust coordinator is authoritative, but IPC promises can settle in either order. If cancel
 * reports `true`, a late completion belongs to an abandoned attempt and must be ignored. If it
 * reports `false` (commit won) or rejects (cancellation was never confirmed), the real completion
 * remains authoritative.
 */
export class SignInAttemptGate {
  readonly id: string;
  private cancellation: Promise<boolean> | null = null;

  constructor(id = crypto.randomUUID()) {
    this.id = id;
  }

  requestCancel(cancel: (attemptId: string) => Promise<boolean>): Promise<boolean> {
    if (!this.cancellation) {
      const request = Promise.resolve().then(() => cancel(this.id));
      this.cancellation = request;
      // A transport failure confirms nothing. The UI re-enables Cancel, so the next click must send
      // a fresh IPC command rather than returning the permanently-rejected first promise.
      void request.catch(() => {
        if (this.cancellation === request) this.cancellation = null;
      });
    }
    return this.cancellation;
  }

  async acceptsCompletion(): Promise<boolean> {
    if (!this.cancellation) return true;
    try {
      return !(await this.cancellation);
    } catch {
      return true;
    }
  }
}
