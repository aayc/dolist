/** Shared helpers for the vector builders: types, deterministic sampling, clock and time zone. */
import fc from "fast-check";
import type * as Core from "../../../../packages/core/src/index.ts";

export type CoreModule = typeof Core;
export type LocalDate = Core.LocalDate;

/** Every vector file that formats times does so in this zone (the Swift tests use it too). */
export const VECTOR_TIME_ZONE = "America/Los_Angeles";

/** `new Date()` / `Date.now()` while generating: 2026-09-23 09:30 in Los Angeles. */
export const PINNED_NOW_MS = Date.UTC(2026, 8, 23, 16, 30, 0);

/**
 * A calendar date in the vectors: `YYYY-MM-DD`, with the fields printed as signed integers when
 * they are out of range (`-0001-01-01`, `2026-13-01`, `2026--1-05`): `(-?\d+)-(-?\d+)-(-?\d+)`.
 */
export type YMD = string;

const field = (n: number, width: number) =>
  n < 0 ? `-${String(-n).padStart(width, "0")}` : String(n).padStart(width, "0");

export const ymd = (d: LocalDate): YMD =>
  `${field(d.year, 4)}-${field(d.month, 2)}-${field(d.day, 2)}`;

export function fromYmd(text: YMD): LocalDate {
  const m = /^(-?\d+)-(-?\d+)-(-?\d+)$/.exec(text);
  if (!m) throw new Error(`bad vector date ${text}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Shorthand for literal dates in the builders. */
export const date = (year: number, month: number, day: number): YMD => ymd({ year, month, day });

/** Deterministic fast-check samples: same seed and fast-check version → same values. */
export function sample<T>(arb: fc.Arbitrary<T>, seed: number, count: number): T[] {
  return fc.sample(arb, { seed, numRuns: count });
}

/** Swift strings can't hold lone surrogates, so every generated string must be well-formed. */
export function isWellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

export function withTimeZone<T>(zone: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

/** Freezes the clock seen by `new Date()` and `Date.now()` (explicit timestamps still work). */
export function pinClock(ms: number): void {
  const RealDate = globalThis.Date;
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args, newTarget) =>
      Reflect.construct(target, args.length === 0 ? [ms] : args, newTarget),
    get: (target, prop, receiver) =>
      prop === "now" ? () => ms : Reflect.get(target, prop, receiver),
  });
}

/** Proleptic Gregorian day number (days since 1970-01-01), independent of `Date`. */
export function dayNumber({ year, month, day }: LocalDate): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  return era * 146_097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719_468;
}

export function fromDayNumber(n: number): LocalDate {
  const z = n + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const month = mp + (mp < 10 ? 3 : -9);
  return {
    year: yoe + era * 400 + (month <= 2 ? 1 : 0),
    month,
    day: doy - Math.floor((153 * mp + 2) / 5) + 1,
  };
}

/** Dates between two years (inclusive), as a fast-check arbitrary. */
export function dateArb(fromYear: number, toYear: number): fc.Arbitrary<LocalDate> {
  return fc
    .integer({
      min: dayNumber({ year: fromYear, month: 1, day: 1 }),
      max: dayNumber({ year: toYear, month: 12, day: 31 }),
    })
    .map(fromDayNumber);
}

/** Removes duplicates while keeping the first occurrence (by a string key). */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Swift and JSON have no `undefined`; the vectors spell a missing value as `null`. */
export const orNull = <T>(value: T | undefined | null): T | null => value ?? null;
