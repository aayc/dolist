/**
 * Test oracle: proleptic Gregorian calendar arithmetic without `Date` (Howard Hinnant's
 * days-from-civil algorithms), so date properties are checked against an independent model.
 */
import type { LocalDate } from "../dates";

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

/** 0 = Sunday. Day 0 (1970-01-01) was a Thursday. */
export function weekdayOf(d: LocalDate): number {
  return (((dayNumber(d) + 4) % 7) + 7) % 7;
}

export function dayOfYear(d: LocalDate): number {
  return dayNumber(d) - dayNumber({ year: d.year, month: 1, day: 1 }) + 1;
}

/** Moment "en": weeks start on Sunday and the week containing January 1st is week 1. */
export function localeWeek(d: LocalDate): { week: number; year: number } {
  const sunday = dayNumber(d) - weekdayOf(d);
  const year = fromDayNumber(sunday + 6).year;
  const jan1 = { year, month: 1, day: 1 };
  const firstSunday = dayNumber(jan1) - weekdayOf(jan1);
  return { week: Math.floor((sunday - firstSunday) / 7) + 1, year };
}

/** ISO 8601: weeks start on Monday and belong to the year of their Thursday. */
export function isoWeek(d: LocalDate): { week: number; year: number } {
  const thursday = fromDayNumber(dayNumber(d) - ((weekdayOf(d) + 6) % 7) + 3);
  return { week: Math.floor((dayOfYear(thursday) - 1) / 7) + 1, year: thursday.year };
}
