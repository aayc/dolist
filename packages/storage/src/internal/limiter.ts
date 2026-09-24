export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs at most `concurrency` tasks at a time (e.g. to stay under the open file descriptor limit). */
export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
  }
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    // A finishing task hands its slot straight to the next waiter, so `active` never overshoots.
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const resume = waiting.shift();
      if (resume) resume();
      else active--;
    }
  };
}
