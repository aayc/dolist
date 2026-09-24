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

export function toLocalDate(date: Date): LocalDate {
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

/** Local midnight for the given calendar date. */
export function fromLocalDate(ld: LocalDate): Date {
  return new Date(ld.year, ld.month - 1, ld.day);
}

export function today(now: Date = new Date()): LocalDate {
  return toLocalDate(now);
}

export function addDays(ld: LocalDate, days: number): LocalDate {
  // Construct at noon to stay clear of DST transitions.
  return toLocalDate(new Date(ld.year, ld.month - 1, ld.day + days, 12));
}

export function compareLocalDates(a: LocalDate, b: LocalDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

export function isSameLocalDate(a: LocalDate, b: LocalDate): boolean {
  return compareLocalDates(a, b) === 0;
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const ms = Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
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
  const ld = toLocalDate(date);
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
        return WEEKDAYS[date.getDay()]!;
      case "ddd":
        return WEEKDAYS[date.getDay()]!.slice(0, 3);
      case "dd":
        return WEEKDAYS[date.getDay()]!.slice(0, 2);
      case "d":
      case "e":
        return String(date.getDay());
      case "E":
        return String(date.getDay() === 0 ? 7 : date.getDay());
      case "ww":
        return pad(weekOfYear(ld, 0, 6).week, 2);
      case "w":
        return String(weekOfYear(ld, 0, 6).week);
      case "WW":
        return pad(weekOfYear(ld, 1, 4).week, 2);
      case "W":
        return String(weekOfYear(ld, 1, 4).week);
      case "HH":
        return pad(date.getHours(), 2);
      case "H":
        return String(date.getHours());
      case "hh":
        return pad(date.getHours() % 12 || 12, 2);
      case "h":
        return String(date.getHours() % 12 || 12);
      case "mm":
        return pad(date.getMinutes(), 2);
      case "m":
        return String(date.getMinutes());
      case "ss":
        return pad(date.getSeconds(), 2);
      case "s":
        return String(date.getSeconds());
      case "A":
        return date.getHours() < 12 ? "AM" : "PM";
      case "a":
        return date.getHours() < 12 ? "am" : "pm";
      case "X":
        return String(Math.floor(date.getTime() / 1000));
      case "x":
        return String(date.getTime());
      default:
        return token;
    }
  });
}

export function formatLocalDate(ld: LocalDate, format: string): string {
  return formatDate(fromLocalDate(ld), format);
}

/**
 * Strictly parses `input` against a Moment-style `format`. Supports year/month/day tokens,
 * month & weekday names, ordinals, literals, and week-based tokens (which resolve to the first day
 * of that week). Returns null if the input does not match the format exactly.
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
  let month = 1;
  let day = 1;
  let weekYear: { year: number; iso: boolean } | undefined;
  let week: number | undefined;
  for (let i = 0; i < groups.length; i++) {
    const token = groups[i]!;
    const value = m[i + 1]!;
    switch (token) {
      case "YYYY":
        year = Number(value);
        break;
      case "YY":
        year = 2000 + Number(value);
        break;
      case "gggg":
        weekYear = { year: Number(value), iso: false };
        break;
      case "GGGG":
        weekYear = { year: Number(value), iso: true };
        break;
      case "MMMM":
      case "MMM":
        month = MONTHS.findIndex((name) => name.toLowerCase().startsWith(value.toLowerCase())) + 1;
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
      case "ww":
      case "w":
      case "WW":
      case "W":
        week = Number(value);
        break;
      default:
        break; // weekday names, times: informational only
    }
  }

  if (week !== undefined) {
    const wy = weekYear ?? { year: year ?? new Date().getFullYear(), iso: false };
    return startOfWeek(wy.year, week, wy.iso ? 1 : 0, wy.iso ? 4 : 6);
  }
  if (year === undefined) return null;
  return validDate(year, month, day);
}

const TOKEN_PATTERNS: Record<string, string> = {
  YYYY: "\\d{4}",
  YY: "\\d{2}",
  gggg: "\\d{4}",
  GGGG: "\\d{4}",
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

function startOfWeek(year: number, week: number, dow: number, doy: number): LocalDate | null {
  if (week < 1 || week > 53) return null;
  const offset = firstWeekOffset(year, dow, doy);
  // Day-of-year (1-based) of the first day of `week`.
  const start = offset + 1 + (week - 1) * 7;
  return addDays({ year, month: 1, day: 1 }, start - 1);
}

function firstWeekOffset(year: number, dow: number, doy: number): number {
  const fwd = 7 + dow - doy;
  const fwdlw = (7 + new Date(Date.UTC(year, 0, fwd)).getUTCDay() - dow) % 7;
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

function daysInYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

function validDate(year: number, month: number, day: number): LocalDate | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1) return null;
  const dim = new Date(year, month, 0).getDate();
  if (day > dim) return null;
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
