/**
 * Minimal, dependency-free implementation of the Moment.js format tokens that Obsidian uses for
 * daily/weekly note names. All calendar math is done on local calendar dates (never UTC) so that
 * "today" matches the user's wall clock.
 */

export interface LocalDate {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const TOKEN_RE =
  /\[([^\]]*)]|YYYY|YY|gggg|gg|GGGG|GG|MMMM|MMM|MM|M|DDDD|DDD|Do|DD|D|dddd|ddd|dd|d|E|e|ww|w|WW|W|HH|H|hh|h|mm|m|ss|s|A|a|X|x/g;

/** What Moment prints for an invalid date. */
const INVALID_DATE = "Invalid date";

export function toLocalDate(date: Date): LocalDate {
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

/** Local midnight for the given calendar date (01:00 where DST skips midnight). */
export function fromLocalDate(ld: LocalDate): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(ld.year, ld.month - 1, ld.day);
  return date;
}

export function today(now: Date = new Date()): LocalDate {
  return toLocalDate(now);
}

export function addDays(ld: LocalDate, days: number): LocalDate {
  // Calendar arithmetic, not clock arithmetic: DST and days a time zone skipped don't matter.
  const date = utcDate(ld.year, ld.month, ld.day + days);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function compareLocalDates(a: LocalDate, b: LocalDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

export function isSameLocalDate(a: LocalDate, b: LocalDate): boolean {
  return compareLocalDates(a, b) === 0;
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const ms = utcDate(b.year, b.month, b.day).getTime() - utcDate(a.year, a.month, a.day).getTime();
  return Math.round(ms / 86_400_000);
}

export function toISODate(ld: LocalDate): string {
  return `${pad(ld.year, 4)}-${pad(ld.month, 2)}-${pad(ld.day, 2)}`;
}

export function parseISODate(input: string): LocalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!m) return null;
  return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function isValidLocalDate(ld: LocalDate): boolean {
  return validDate(ld.year, ld.month, ld.day) !== null;
}

/** Formats a date with Moment-style tokens (`YYYY-MM-DD`, `dddd, MMMM Do`, `gggg-[W]ww`, …). */
export function formatDate(date: Date, format: string): string {
  if (Number.isNaN(date.getTime())) return INVALID_DATE;
  return formatParts(toLocalDate(date), date, format);
}

export function formatLocalDate(ld: LocalDate, format: string): string {
  if (!isValidLocalDate(ld)) return INVALID_DATE;
  return formatParts(ld, fromLocalDate(ld), format);
}

/** Calendar tokens come from `ld` itself; time-of-day and timestamp tokens from `instant`. */
function formatParts(ld: LocalDate, instant: Date, format: string): string {
  const weekday = weekdayOf(ld);
  return format.replace(TOKEN_RE, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case "YYYY":
        return pad(ld.year, 4);
      case "YY":
        return pad(ld.year % 100, 2);
      case "gggg":
        return pad(weekOfYear(ld, 0, 6).year, 4);
      case "gg":
        return pad(weekOfYear(ld, 0, 6).year % 100, 2);
      case "GGGG":
        return pad(weekOfYear(ld, 1, 4).year, 4);
      case "GG":
        return pad(weekOfYear(ld, 1, 4).year % 100, 2);
      case "MMMM":
        return MONTHS[ld.month - 1]!;
      case "MMM":
        return MONTHS[ld.month - 1]!.slice(0, 3);
      case "MM":
        return pad(ld.month, 2);
      case "M":
        return String(ld.month);
      case "DDDD":
        return pad(dayOfYear(ld), 3);
      case "DDD":
        return String(dayOfYear(ld));
      case "Do":
        return ordinal(ld.day);
      case "DD":
        return pad(ld.day, 2);
      case "D":
        return String(ld.day);
      case "dddd":
        return WEEKDAYS[weekday]!;
      case "ddd":
        return WEEKDAYS[weekday]!.slice(0, 3);
      case "dd":
        return WEEKDAYS[weekday]!.slice(0, 2);
      case "d":
      case "e":
        return String(weekday);
      case "E":
        return String(weekday === 0 ? 7 : weekday);
      case "ww":
        return pad(weekOfYear(ld, 0, 6).week, 2);
      case "w":
        return String(weekOfYear(ld, 0, 6).week);
      case "WW":
        return pad(weekOfYear(ld, 1, 4).week, 2);
      case "W":
        return String(weekOfYear(ld, 1, 4).week);
      case "HH":
        return pad(instant.getHours(), 2);
      case "H":
        return String(instant.getHours());
      case "hh":
        return pad(instant.getHours() % 12 || 12, 2);
      case "h":
        return String(instant.getHours() % 12 || 12);
      case "mm":
        return pad(instant.getMinutes(), 2);
      case "m":
        return String(instant.getMinutes());
      case "ss":
        return pad(instant.getSeconds(), 2);
      case "s":
        return String(instant.getSeconds());
      case "A":
        return instant.getHours() < 12 ? "AM" : "PM";
      case "a":
        return instant.getHours() < 12 ? "am" : "pm";
      case "X":
        return String(Math.floor(instant.getTime() / 1000));
      case "x":
        return String(instant.getTime());
      default:
        return token;
    }
  });
}

/**
 * Strictly parses `input` against a Moment-style `format`, like Moment's strict mode: year, month
 * and day tokens (or a day of the year), month & weekday names, ordinals, literals, and week-based
 * tokens (a week without a month/day resolves to its first day, or to the weekday given with it;
 * next to a full date, as in `gggg/[W]ww/YYYY-MM-DD`, it is just a folder name). A weekday that
 * contradicts the date, or a week the year doesn't have, is rejected. Time tokens are accepted but
 * ignored; `X`/`x` timestamps are not supported. Returns null if the input does not match exactly.
 */
export function parseDateWithFormat(input: string, format: string): LocalDate | null {
  const groups: string[] = [];
  let pattern = "";
  let last = 0;
  for (const match of format.matchAll(TOKEN_RE)) {
    pattern += escapeRegExp(format.slice(last, match.index));
    last = match.index + match[0].length;
    const literal = match[1];
    if (literal !== undefined) {
      pattern += escapeRegExp(literal);
      continue;
    }
    const token = match[0];
    const source = TOKEN_PATTERNS[token];
    if (!source) return null;
    groups.push(token);
    pattern += `(${source})`;
  }
  pattern += escapeRegExp(format.slice(last));

  const m = new RegExp(`^${pattern}$`, "i").exec(input);
  if (!m) return null;

  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  let yearDay: number | undefined;
  let weekYear: number | undefined;
  let week: number | undefined;
  let isoWeeks: boolean | undefined;
  let isoWeekYear: boolean | undefined;
  /** 0 = Sunday. */
  let weekday: number | undefined;
  for (let i = 0; i < groups.length; i++) {
    const token = groups[i]!;
    const value = m[i + 1]!;
    const named = (names: readonly string[]) =>
      names.findIndex((name) => name.toLowerCase().startsWith(value.toLowerCase()));
    switch (token) {
      case "YYYY":
        year = Number(value);
        break;
      case "YY":
        year = 2000 + Number(value);
        break;
      case "gggg":
      case "gg":
      case "GGGG":
      case "GG":
        weekYear = (token.length === 2 ? 2000 : 0) + Number(value);
        isoWeekYear = token[0] === "G";
        break;
      case "MMMM":
      case "MMM":
        month = named(MONTHS) + 1;
        break;
      case "MM":
      case "M":
        month = Number(value);
        break;
      case "DD":
      case "D":
        day = Number(value);
        break;
      case "Do":
        day = Number.parseInt(value, 10);
        break;
      case "DDDD":
      case "DDD":
        yearDay = Number(value);
        break;
      case "ww":
      case "w":
      case "WW":
      case "W":
        week = Number(value);
        isoWeeks = token[0] === "W";
        break;
      case "dddd":
      case "ddd":
      case "dd":
        weekday = named(WEEKDAYS);
        break;
      case "d":
      case "e":
        weekday = Number(value);
        break;
      case "E":
        weekday = Number(value) % 7;
        break;
      default:
        break; // times: informational only
    }
  }

  let date: LocalDate | null;
  // Like Moment, a week only decides the date when no month/day does (`gggg/[W]ww/YYYY-MM-DD`).
  if (week !== undefined && month === undefined && day === undefined && yearDay === undefined) {
    // The week token picks the system (`W` is ISO, `w` the locale's), like Moment.
    const iso = isoWeeks ?? isoWeekYear ?? false;
    date = weekDate(weekYear ?? year ?? new Date().getFullYear(), week, iso, weekday);
  } else if (year === undefined) {
    return null;
  } else if (yearDay !== undefined) {
    if (yearDay < 1 || yearDay > daysInYear(year)) return null;
    date = addDays({ year, month: 1, day: 1 }, yearDay - 1);
    if ((month ?? date.month) !== date.month || (day ?? date.day) !== date.day) return null;
  } else {
    date = validDate(year, month ?? 1, day ?? 1);
  }
  if (!date || (weekday !== undefined && weekdayOf(date) !== weekday)) return null;
  return date;
}

const TOKEN_PATTERNS: Record<string, string> = {
  YYYY: "\\d{4}",
  YY: "\\d{2}",
  gggg: "\\d{4}",
  gg: "\\d{2}",
  GGGG: "\\d{4}",
  GG: "\\d{2}",
  MMMM: MONTHS.join("|"),
  MMM: MONTHS.map((m) => m.slice(0, 3)).join("|"),
  MM: "\\d{2}",
  M: "\\d{1,2}",
  DD: "\\d{2}",
  D: "\\d{1,2}",
  Do: "\\d{1,2}(?:st|nd|rd|th)",
  DDDD: "\\d{3}",
  DDD: "\\d{1,3}",
  dddd: WEEKDAYS.join("|"),
  ddd: WEEKDAYS.map((d) => d.slice(0, 3)).join("|"),
  dd: WEEKDAYS.map((d) => d.slice(0, 2)).join("|"),
  d: "[0-6]",
  e: "[0-6]",
  E: "[1-7]",
  ww: "\\d{2}",
  w: "\\d{1,2}",
  WW: "\\d{2}",
  W: "\\d{1,2}",
  HH: "\\d{2}",
  H: "\\d{1,2}",
  hh: "\\d{2}",
  h: "\\d{1,2}",
  mm: "\\d{2}",
  m: "\\d{1,2}",
  ss: "\\d{2}",
  s: "\\d{1,2}",
  A: "AM|PM",
  a: "am|pm",
};

/**
 * Week-of-year using Moment's algorithm. `dow` is the first day of week (0 = Sunday) and `doy`
 * defines which January day is always in week 1 (`7 + dow - janX`). ISO: dow=1, doy=4.
 * Moment's default "en" locale (used by Obsidian's `gggg-[W]ww`): dow=0, doy=6.
 */
export function weekOfYear(
  ld: LocalDate,
  dow: number,
  doy: number,
): { week: number; year: number } {
  const offset = firstWeekOffset(ld.year, dow, doy);
  const week = Math.floor((dayOfYear(ld) - offset - 1) / 7) + 1;
  if (week < 1) {
    const year = ld.year - 1;
    return { week: week + weeksInYear(year, dow, doy), year };
  }
  const inYear = weeksInYear(ld.year, dow, doy);
  if (week > inYear) return { week: week - inYear, year: ld.year + 1 };
  return { week, year: ld.year };
}

/** The first day of `week` in `weekYear`, or its `weekday` (0 = Sunday) when given. */
function weekDate(
  weekYear: number,
  week: number,
  iso: boolean,
  weekday: number | undefined,
): LocalDate | null {
  const dow = iso ? 1 : 0;
  const doy = iso ? 4 : 6;
  if (week < 1 || week > weeksInYear(weekYear, dow, doy)) return null;
  const start = addDays(
    { year: weekYear, month: 1, day: 1 },
    firstWeekOffset(weekYear, dow, doy) + (week - 1) * 7,
  );
  return weekday === undefined ? start : addDays(start, (weekday - dow + 7) % 7);
}

function firstWeekOffset(year: number, dow: number, doy: number): number {
  const fwd = 7 + dow - doy;
  const fwdlw = (7 + utcDate(year, 1, fwd).getUTCDay() - dow) % 7;
  return -fwdlw + fwd - 1;
}

function weeksInYear(year: number, dow: number, doy: number): number {
  const offset = firstWeekOffset(year, dow, doy);
  const offsetNext = firstWeekOffset(year + 1, dow, doy);
  return (daysInYear(year) - offset + offsetNext) / 7;
}

function dayOfYear(ld: LocalDate): number {
  return daysBetween({ year: ld.year, month: 1, day: 1 }, ld) + 1;
}

/** 0 = Sunday. */
function weekdayOf(ld: LocalDate): number {
  return utcDate(ld.year, ld.month, ld.day).getUTCDay();
}

/** UTC midnight of a proleptic Gregorian date (years 0-99 included); overflow rolls over. */
function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function daysInYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

function validDate(year: number, month: number, day: number): LocalDate | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1) return null;
  if (day > utcDate(year, month + 1, 0).getUTCDate()) return null;
  return { year, month, day };
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
