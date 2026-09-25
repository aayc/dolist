export interface RateLimit {
  /** Sustained requests per second. */
  perSecond: number;
  /** Requests allowed in a burst above the sustained rate. */
  burst: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Token buckets keyed by vault: `take` spends one token, refilled at `perSecond`. */
export class RateLimiter {
  readonly #limit: RateLimit;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(limit: RateLimit, now: () => number = Date.now) {
    this.#limit = limit;
    this.#now = now;
  }

  /** Null when allowed; otherwise how long to wait for the next token (ms). */
  take(key: string): number | null {
    const now = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.#limit.burst, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.#limit.burst, bucket.tokens + elapsed * this.#limit.perSecond);
    bucket.updatedAt = now;
    this.#buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return null;
    }
    return Math.ceil(((1 - bucket.tokens) / this.#limit.perSecond) * 1000);
  }
}
