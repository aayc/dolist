/**
 * Async mutex keyed by string (vault path). Callers holding the same key run strictly one after
 * another, in call order; different keys run concurrently. Idle keys are dropped, so memory is
 * proportional to the number of paths with work in flight.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Holds several keys at once. Keys are acquired in sorted order so callers can't deadlock. */
  runAll<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(keys)].sort();
    const acquire = (index: number): Promise<T> => {
      const key = sorted[index];
      return key === undefined ? fn() : this.run(key, () => acquire(index + 1));
    };
    return acquire(0);
  }

  get size(): number {
    return this.tails.size;
  }
}
