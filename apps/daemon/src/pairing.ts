/**
 * Pairing codes: what a new device exchanges for its credential. Codes are 8 characters of core's
 * unambiguous alphabet, single use, valid for 5 minutes, at most 3 outstanding, and kept in memory
 * only. Attempts to redeem one are rate-limited globally (all remote traffic arrives from the local
 * proxy, so there is no per-client address to limit by), and after 10 wrong codes every
 * outstanding code is invalidated.
 */
import { randomInt, timingSafeEqual } from "node:crypto";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "@ddl/core";

export const PAIRING_LIMITS = {
  codeTtlMs: 5 * 60_000,
  maxOutstanding: 3,
  attemptsPerWindow: 5,
  attemptWindowMs: 60_000,
  failuresBeforeInvalidation: 10,
} as const;

interface OutstandingCode {
  code: Buffer;
  /** What the issuer called the new device, if anything. */
  name: string | undefined;
  expiresAt: number;
}

export type AttemptResult = { allowed: true } | { allowed: false; retryAfterMs: number };

export class PairingCodes {
  readonly #now: () => number;
  #codes: OutstandingCode[] = [];
  #attempts: number[] = [];
  #failures = 0;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  get outstanding(): number {
    this.#prune();
    return this.#codes.length;
  }

  /** A new code, or null when `maxOutstanding` codes are still valid. */
  issue(name?: string): { code: string; expiresAt: number } | null {
    this.#prune();
    if (this.#codes.length >= PAIRING_LIMITS.maxOutstanding) return null;
    let code = "";
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
      code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
    }
    const expiresAt = this.#now() + PAIRING_LIMITS.codeTtlMs;
    this.#codes.push({ code: Buffer.from(code, "ascii"), name, expiresAt });
    return { code, expiresAt };
  }

  /** Counts one attempt against the global limit; refused attempts don't count. */
  attempt(): AttemptResult {
    const now = this.#now();
    this.#attempts = this.#attempts.filter((at) => now - at < PAIRING_LIMITS.attemptWindowMs);
    if (this.#attempts.length >= PAIRING_LIMITS.attemptsPerWindow) {
      const oldest = this.#attempts[0] ?? now;
      return { allowed: false, retryAfterMs: oldest + PAIRING_LIMITS.attemptWindowMs - now };
    }
    this.#attempts.push(now);
    return { allowed: true };
  }

  /**
   * Consumes a valid code (canonical form) and returns what the issuer named the device, or null.
   * Every outstanding code is compared, in constant time; a miss counts as a failure.
   */
  redeem(code: string): { name: string | undefined } | null {
    this.#prune();
    const candidate = Buffer.from(code, "ascii");
    let match: OutstandingCode | undefined;
    for (const entry of this.#codes) {
      if (candidate.length === entry.code.length && timingSafeEqual(candidate, entry.code)) {
        match = entry;
      }
    }
    if (match) {
      this.#codes = this.#codes.filter((entry) => entry !== match);
      return { name: match.name };
    }
    this.#failures++;
    if (this.#failures >= PAIRING_LIMITS.failuresBeforeInvalidation) {
      this.#codes = [];
      this.#failures = 0;
    }
    return null;
  }

  #prune(): void {
    const now = this.#now();
    this.#codes = this.#codes.filter((entry) => entry.expiresAt > now);
  }
}
