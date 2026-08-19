/**
 * Minimal FIFO semaphore used to bound concurrent engine launches.
 *
 * The sidecar handles requests concurrently, so the only thing keeping a fleet start from spawning a
 * thousand Chromium cold-starts at once is an EXPLICIT limit — never the accidental serialization of
 * a read loop that awaited each request in turn.
 */
export interface Semaphore {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks currently holding a permit. */
  readonly active: number;
  /** Tasks admitted but still waiting for a permit. */
  readonly waiting: number;
}

export function createSemaphore(limit: number): Semaphore {
  const permits = Math.max(1, Math.floor(limit));
  const queue: Array<() => void> = [];
  let active = 0;

  const release = (): void => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };

  const acquire = (): Promise<void> => {
    if (active < permits) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queue.push(() => {
        active += 1;
        resolve();
      });
    });
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
  };
}
