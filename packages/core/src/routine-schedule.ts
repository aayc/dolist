/**
 * Routine schedules: the natural-language phrase a routine file carries (`every weekday at 7:30`)
 * parsed into a recurrence, described back in words, and the next run computed in local time.
 * Parsing is strict: a phrase it can't read is an error with a hint, never a guess.
 */

/** Minutes after local midnight (0–1439). */
export type MinuteOfDay = number;

/** 0 = Sunday … 6 = Saturday, like `Date#getDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type RoutineSchedule =
  /** At fixed times on some days of the week (every day, weekdays, Mondays…). */
  | { kind: "weekly"; days: Weekday[]; times: MinuteOfDay[] }
  /**
   * Every `minutes`, counted from midnight (or the window's start) each day, on some days,
   * optionally only between `from` and `to` (inclusive).
   */
  | { kind: "interval"; minutes: number; days: Weekday[]; from?: MinuteOfDay; to?: MinuteOfDay }
  /** On one day of the month (`-1` = the last), at fixed times; the 31st runs on the last day of shorter months. */
  | { kind: "monthly"; day: number; times: MinuteOfDay[] };

export type ScheduleParseResult =
  | { ok: true; schedule: RoutineSchedule }
  | { ok: false; error: string };

/** Routines run at most this often. */
export const MIN_ROUTINE_INTERVAL_MINUTES = 15;
/** Longer intervals are really daily schedules ("every day at 8:00"). */
const MAX_INTERVAL_MINUTES = 12 * 60;
const MAX_TIMES = 24;
const ALL_DAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5];
const WEEKEND: Weekday[] = [0, 6];

const EXAMPLES = "“every weekday at 7:30”, “every 2 hours” or “every month on the 1st at 9:00”";

const DAY_NAMES: ReadonlyArray<readonly [Weekday, readonly string[]]> = [
  [0, ["sunday", "sun"]],
  [1, ["monday", "mon"]],
  [2, ["tuesday", "tue", "tues"]],
  [3, ["wednesday", "wed"]],
  [4, ["thursday", "thu", "thur", "thurs"]],
  [5, ["friday", "fri"]],
  [6, ["saturday", "sat"]],
];
const DAY_BY_NAME = new Map<string, Weekday>(
  DAY_NAMES.flatMap(([day, names]) => names.flatMap((name) => [[name, day] as const])),
);
const FULL_DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

class ScheduleError extends Error {}

function fail(message: string): never {
  throw new ScheduleError(message);
}

/** Tokens of a lowercased phrase: words, numbers, times and commas. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\b([ap])\.m\.?/g, "$1m")
    .replace(/\beveryday\b/g, "every day")
    .replace(/\s*[.;!]\s*$/, "")
    .replace(/,/g, " , ")
    .replace(/&/g, " and ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

class Cursor {
  private index = 0;
  private readonly tokens: readonly string[];

  constructor(tokens: readonly string[]) {
    this.tokens = tokens;
  }

  get done(): boolean {
    return this.index >= this.tokens.length;
  }

  peek(offset = 0): string | undefined {
    return this.tokens[this.index + offset];
  }

  next(): string | undefined {
    return this.tokens[this.index++];
  }

  accept(...words: string[]): string | undefined {
    const token = this.peek();
    if (token !== undefined && words.includes(token)) {
      this.index++;
      return token;
    }
    return undefined;
  }
}

function dayOf(token: string | undefined): Weekday | undefined {
  if (token === undefined) return undefined;
  return DAY_BY_NAME.get(token) ?? DAY_BY_NAME.get(token.replace(/s$/, ""));
}

function isDayGroup(token: string | undefined): boolean {
  return (
    token !== undefined &&
    (dayOf(token) !== undefined || /^(weekdays?|weekends?)$/.test(token) || token === "weekend")
  );
}

/** `monday, wednesday and friday`, `weekdays`, `weekends`, `mon & thu`, and the words as written. */
function parseDays(t: Cursor): { days: Weekday[]; words: string } | undefined {
  if (!isDayGroup(t.peek())) return undefined;
  const days = new Set<Weekday>();
  const words: string[] = [];
  for (;;) {
    const token = t.next()!;
    words.push(token);
    if (/^weekdays?$/.test(token)) for (const day of WEEKDAYS) days.add(day);
    else if (/^weekends?$/.test(token)) {
      for (const day of WEEKEND) days.add(day);
      const day = t.accept("days", "day");
      if (day) words.push(day);
    } else days.add(dayOf(token)!);
    const separator = t.peek();
    if ((separator === "," || separator === "and" || separator === "or") && isDayGroup(t.peek(1))) {
      words.push(t.next()!);
      continue;
    }
    if (separator === "," && t.peek(1) === "and" && isDayGroup(t.peek(2))) {
      t.next();
      words.push(t.next()!);
      continue;
    }
    break;
  }
  return {
    days: [...days].sort((a, b) => a - b),
    words: words.join(" ").replace(/ , /g, ", "),
  };
}

const TIME_RE = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm|a|p)?$/;

function isTime(t: Cursor, offset = 0): boolean {
  const token = t.peek(offset);
  return token !== undefined && (token === "noon" || token === "midnight" || TIME_RE.test(token));
}

/** `7:30`, `07:30`, `7`, `7am`, `7 pm`, `19:00`, `noon`, `midnight`. */
function parseTime(t: Cursor): MinuteOfDay {
  const token = t.next();
  if (token === "noon") return 12 * 60;
  if (token === "midnight") return 0;
  const match = token === undefined ? null : TIME_RE.exec(token);
  if (!match) fail(`“${token ?? ""}” isn't a time. Write times like 7:30, 7am or 18:00.`);
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  let meridiem = match[3]?.[0];
  if (!meridiem) {
    const next = t.accept("am", "pm", "a", "p");
    if (next) meridiem = next[0];
  }
  t.accept("o'clock", "oclock");
  if (minute > 59) fail(`“${token}” isn't a time. Write times like 7:30, 7am or 18:00.`);
  if (meridiem) {
    if (hour < 1 || hour > 12) fail(`“${token}” isn't a time: with am/pm the hour is 1 to 12.`);
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  } else if (hour > 23) {
    fail(`“${token}” isn't a time. Write times like 7:30, 7am or 18:00.`);
  }
  return hour * 60 + minute;
}

/** `8:00`, `9, 13 and 17`, `9am & 5pm`. */
function parseTimes(t: Cursor): MinuteOfDay[] {
  if (!isTime(t)) fail(`Add a time after “at”, e.g. “at 7:30”.`);
  const times = new Set<MinuteOfDay>([parseTime(t)]);
  for (;;) {
    if ((t.peek() === "," || t.peek() === "and") && isTime(t, 1)) {
      t.next();
      times.add(parseTime(t));
    } else if (t.peek() === "," && t.peek(1) === "and" && isTime(t, 2)) {
      t.next();
      t.next();
      times.add(parseTime(t));
    } else break;
  }
  if (times.size > MAX_TIMES) fail(`That's more than ${MAX_TIMES} times a day.`);
  return [...times].sort((a, b) => a - b);
}

const ORDINAL_RE = /^(\d{1,2})(?:st|nd|rd|th)?$/;

/** `the 1st`, `the 15th day`, `day 3`, `the last day`. */
function parseDayOfMonth(t: Cursor): number {
  t.accept("the");
  if (t.accept("last")) {
    t.accept("day");
    return -1;
  }
  const hasDayWord = t.accept("day") !== undefined;
  const token = t.next();
  const match = token === undefined ? null : ORDINAL_RE.exec(token);
  if (!match) fail(`Say which day of the month, e.g. “on the 1st” or “on the last day”.`);
  const day = Number(match[1]);
  if (day < 1 || day > 31) fail(`“${token}” isn't a day of the month.`);
  if (!hasDayWord) t.accept("day");
  return day;
}

type Frequency =
  | { kind: "days"; days: Weekday[]; everyDay: boolean; phrase: string }
  | { kind: "interval"; minutes: number }
  | { kind: "weekly" }
  | { kind: "monthly" };

const HOUR_UNITS = ["hours", "hour", "hrs", "hr", "h"];
const MINUTE_UNITS = ["minutes", "minute", "mins", "min", "m"];

function parseFrequency(t: Cursor): Frequency | undefined {
  if (t.accept("hourly")) return { kind: "interval", minutes: 60 };
  if (t.accept("daily")) return { kind: "days", days: ALL_DAYS, everyDay: true, phrase: "daily" };
  if (t.accept("weekly")) return { kind: "weekly" };
  if (t.accept("monthly")) return { kind: "monthly" };
  const every = t.accept("every", "each");
  if (!every) {
    const days = parseDays(t);
    return days
      ? { kind: "days", days: days.days, everyDay: false, phrase: days.words }
      : undefined;
  }
  if (t.accept("day")) return { kind: "days", days: ALL_DAYS, everyDay: true, phrase: "every day" };
  if (t.accept("hour")) return { kind: "interval", minutes: 60 };
  if (t.accept("week")) return { kind: "weekly" };
  if (t.accept("month")) return { kind: "monthly" };
  if (t.accept("minute"))
    fail(`Routines run at most every ${MIN_ROUTINE_INTERVAL_MINUTES} minutes.`);
  if (t.accept("other")) {
    fail(
      `“every other …” isn't supported: name the days instead, e.g. “every monday and thursday at 9:00”.`,
    );
  }
  if (/^(morning|evening|afternoon|night)$/.test(t.peek() ?? "")) {
    fail(`Say when: e.g. “every day at 8:00” instead of “every ${t.peek()}”.`);
  }
  const days = parseDays(t);
  if (days) {
    return { kind: "days", days: days.days, everyDay: false, phrase: `${every} ${days.words}` };
  }
  const count = t.peek();
  const amount = count === undefined ? Number.NaN : Number(count.match(/^\d+$/)?.[0]);
  const joined = count === undefined ? null : /^(\d+)(h|m|min|mins|hrs?)$/.exec(count);
  if (Number.isInteger(amount) || joined) {
    t.next();
    const value = joined ? Number(joined[1]) : amount;
    const unit = joined ? joined[2]! : t.next();
    if (unit !== undefined && HOUR_UNITS.includes(unit)) {
      return { kind: "interval", minutes: value * 60 };
    }
    if (unit !== undefined && MINUTE_UNITS.includes(unit))
      return { kind: "interval", minutes: value };
    if (unit !== undefined && /^(days?|weeks?|months?|years?)$/.test(unit)) {
      fail(
        `“every ${value} ${unit}” isn't supported: name the days instead, e.g. “every monday and thursday at 9:00”.`,
      );
    }
    fail(`Every ${value} what? Write “every ${value} hours” or “every ${value} minutes”.`);
  }
  fail(`Couldn't read “every ${t.peek() ?? ""}”. Try ${EXAMPLES}.`);
}

/** Parses a schedule phrase (`every weekday at 7:30`, `every 2 hours from 9 to 17`, …). */
export function parseSchedule(input: string): ScheduleParseResult {
  try {
    return { ok: true, schedule: parse(input) };
  } catch (error) {
    if (error instanceof ScheduleError) return { ok: false, error: error.message };
    throw error;
  }
}

function parse(input: string): RoutineSchedule {
  const tokens = tokenize(input);
  if (tokens.length === 0) fail(`Add a schedule, e.g. ${EXAMPLES}.`);
  const t = new Cursor(tokens);
  let frequency: Frequency | undefined;
  let times: MinuteOfDay[] | undefined;
  let onDays: Weekday[] | undefined;
  let dayOfMonth: number | undefined;
  let window: { from: MinuteOfDay; to: MinuteOfDay } | undefined;
  while (!t.done) {
    if (t.accept(",")) continue;
    if (t.accept("at")) {
      if (times) fail(`Give the times once, e.g. “at 8:00 and 17:00”.`);
      times = parseTimes(t);
      continue;
    }
    if (t.accept("on")) {
      if (isDayGroup(t.peek())) {
        if (onDays) fail(`Name the days once, e.g. “on monday and thursday”.`);
        onDays = parseDays(t)?.days;
      } else {
        if (dayOfMonth !== undefined) fail(`Name the day of the month once.`);
        dayOfMonth = parseDayOfMonth(t);
      }
      continue;
    }
    if (t.accept("from", "between")) {
      if (window) fail(`Give the time window once, e.g. “from 9:00 to 17:00”.`);
      const from = parseTime(t);
      if (!t.accept("to", "until", "till", "and", "-")) {
        fail(`Write the window as “from 9:00 to 17:00”.`);
      }
      const to = parseTime(t);
      if (to <= from) fail(`The window has to end after it starts (“from 9:00 to 17:00”).`);
      window = { from, to };
      continue;
    }
    if (!frequency) {
      frequency = parseFrequency(t);
      if (frequency) continue;
    }
    fail(`Couldn't read “${t.peek()}” in “${input.trim()}”. Try ${EXAMPLES}.`);
  }
  if (!frequency) {
    if (onDays) frequency = { kind: "days", days: onDays, everyDay: false, phrase: "every day" };
    else if (dayOfMonth !== undefined) frequency = { kind: "monthly" };
    else fail(`Say how often, e.g. ${EXAMPLES}.`);
  }
  return build(frequency, { times, onDays, dayOfMonth, window });
}

function build(
  frequency: Frequency,
  parts: {
    times: MinuteOfDay[] | undefined;
    onDays: Weekday[] | undefined;
    dayOfMonth: number | undefined;
    window: { from: MinuteOfDay; to: MinuteOfDay } | undefined;
  },
): RoutineSchedule {
  const { times, onDays, dayOfMonth, window } = parts;
  switch (frequency.kind) {
    case "interval": {
      if (times) fail(`An interval runs on its own clock: drop “at …”, or say “every day at …”.`);
      if (dayOfMonth !== undefined) fail(`An interval can't be on a day of the month.`);
      const { minutes } = frequency;
      if (minutes < MIN_ROUTINE_INTERVAL_MINUTES) {
        fail(`Routines run at most every ${MIN_ROUTINE_INTERVAL_MINUTES} minutes.`);
      }
      if (minutes > MAX_INTERVAL_MINUTES) {
        fail(
          `For once or twice a day, name the times instead, e.g. “every day at 8:00 and 20:00”.`,
        );
      }
      return {
        kind: "interval",
        minutes,
        days: onDays ?? ALL_DAYS,
        ...(window ? { from: window.from, to: window.to } : {}),
      };
    }
    case "days":
    case "weekly": {
      if (window) fail(`A time window only goes with an interval, e.g. “every hour from 9 to 17”.`);
      if (dayOfMonth !== undefined) fail(`Use “every month on the …” for a day of the month.`);
      let days: Weekday[];
      if (frequency.kind === "weekly") {
        if (!onDays) fail(`Say which day, e.g. “every week on monday at 9:00”.`);
        days = onDays;
      } else if (onDays) {
        if (!frequency.everyDay) fail(`Name the days once, e.g. “every monday and thursday”.`);
        days = onDays;
      } else days = frequency.days;
      if (!times) {
        const phrase = frequency.kind === "weekly" ? "every week" : frequency.phrase;
        fail(`Add a time: “${phrase}” needs one, e.g. “${phrase} at 8:00”.`);
      }
      return { kind: "weekly", days, times };
    }
    case "monthly": {
      if (window) fail(`A time window only goes with an interval, e.g. “every hour from 9 to 17”.`);
      if (onDays) fail(`Use either days of the week or a day of the month, not both.`);
      if (dayOfMonth === undefined) {
        fail(`Say which day of the month, e.g. “every month on the 1st at 9:00”.`);
      }
      if (!times) fail(`Add a time, e.g. “every month on the 1st at 9:00”.`);
      return { kind: "monthly", day: dayOfMonth, times };
    }
  }
}

// ── In words ─────────────────────────────────────────────────────────────────

/** `7:30 AM`, `12:00 PM`, `6:05 PM`. */
export function formatMinuteOfDay(minutes: MinuteOfDay): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function sameDays(a: readonly Weekday[], b: readonly Weekday[]): boolean {
  return a.length === b.length && a.every((day) => b.includes(day));
}

function describeDays(days: readonly Weekday[]): string {
  if (sameDays(days, ALL_DAYS)) return "day";
  if (sameDays(days, WEEKDAYS)) return "weekday";
  // Monday first, as people say it.
  const ordered = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return joinWords(ordered.map((day) => FULL_DAY_NAMES[day]!));
}

function ordinal(day: number): string {
  const teen = day % 100 >= 11 && day % 100 <= 13;
  const last = day % 10;
  const suffix = teen ? "th" : last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th";
  return `${day}${suffix}`;
}

function describeInterval(minutes: number): string {
  if (minutes === 60) return "Every hour";
  if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

/** The schedule in words: `Every weekday at 7:30 AM`, `Every 2 hours from 9:00 AM to 5:00 PM on weekdays`. */
export function describeSchedule(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case "weekly":
      return `Every ${describeDays(schedule.days)} at ${joinWords(schedule.times.map(formatMinuteOfDay))}`;
    case "interval": {
      const parts = [describeInterval(schedule.minutes)];
      if (schedule.from !== undefined && schedule.to !== undefined) {
        parts.push(`from ${formatMinuteOfDay(schedule.from)} to ${formatMinuteOfDay(schedule.to)}`);
      }
      if (!sameDays(schedule.days, ALL_DAYS)) {
        const days = describeDays(schedule.days);
        parts.push(days === "weekday" ? "on weekdays" : `on ${days}`);
      }
      return parts.join(" ");
    }
    case "monthly": {
      const day = schedule.day === -1 ? "the last day" : `the ${ordinal(schedule.day)}`;
      return `Every month on ${day} at ${joinWords(schedule.times.map(formatMinuteOfDay))}`;
    }
  }
}

// ── Local time ───────────────────────────────────────────────────────────────

export interface LocalDateTimeParts {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: Weekday;
}

/**
 * Wall-clock time in one time zone. `at` resolves a local time the way `new Date(y, m, d, h, min)`
 * does: a time skipped by a daylight-saving change moves forward by the gap, and a time that
 * happens twice is its first occurrence.
 */
export interface LocalCalendar {
  parts(epochMs: number): LocalDateTimeParts;
  at(year: number, month: number, day: number, minuteOfDay: MinuteOfDay): number;
}

/** The machine's local time zone (routines always run on the user's local clock). */
export const systemCalendar: LocalCalendar = {
  parts(epochMs) {
    const date = new Date(epochMs);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      weekday: date.getDay() as Weekday,
    };
  },
  at(year, month, day, minuteOfDay) {
    return new Date(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60).getTime();
  },
};

/** A named IANA time zone (`America/Los_Angeles`), for tests and previews independent of the machine's. */
export function timeZoneCalendar(timeZone: string): LocalCalendar {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
  });
  const parts = (epochMs: number): LocalDateTimeParts & { second: number } => {
    const out: Record<string, string> = {};
    for (const part of format.formatToParts(new Date(epochMs))) out[part.type] = part.value;
    return {
      year: Number(out.year),
      month: Number(out.month),
      day: Number(out.day),
      hour: Number(out.hour) % 24,
      minute: Number(out.minute),
      second: Number(out.second),
      weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(out.weekday!) as Weekday,
    };
  };
  const wallClock = (epochMs: number): number => {
    const p = parts(epochMs);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  };
  const offset = (epochMs: number): number =>
    wallClock(epochMs) - Math.floor(epochMs / 1000) * 1000;
  return {
    parts: (epochMs) => {
      const { second: _second, ...rest } = parts(epochMs);
      return rest;
    },
    at(year, month, day, minuteOfDay) {
      const wall = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
      const before = wall - offset(wall - 86_400_000);
      const after = wall - offset(wall + 86_400_000);
      const valid = [before, after].filter((candidate) => wallClock(candidate) === wall);
      if (valid.length > 0) return Math.min(...valid);
      // Skipped by the clock change: keep the earlier offset, which lands after the gap.
      return before;
    },
  };
}

function civilDay(year: number, month: number, day: number, plusDays: number) {
  const date = new Date(Date.UTC(year, month - 1, day + plusDays));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay() as Weekday,
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function slotsOn(
  schedule: RoutineSchedule,
  date: { year: number; month: number; day: number; weekday: Weekday },
): MinuteOfDay[] {
  switch (schedule.kind) {
    case "weekly":
      return schedule.days.includes(date.weekday) ? schedule.times : [];
    case "interval": {
      if (!schedule.days.includes(date.weekday)) return [];
      const slots: MinuteOfDay[] = [];
      const end = schedule.to ?? 24 * 60 - 1;
      for (let minute = schedule.from ?? 0; minute <= end; minute += schedule.minutes) {
        slots.push(minute);
      }
      return slots;
    }
    case "monthly": {
      const last = daysInMonth(date.year, date.month);
      const target = schedule.day === -1 ? last : Math.min(schedule.day, last);
      return date.day === target ? schedule.times : [];
    }
  }
}

/**
 * The first run strictly after `after` (epoch ms), in the calendar's local time. Always found
 * within a few weeks for a schedule `parseSchedule` produced; null for an empty one.
 */
export function nextRunAfter(
  schedule: RoutineSchedule,
  after: number,
  calendar: LocalCalendar = systemCalendar,
): number | null {
  const start = calendar.parts(after);
  const horizon = schedule.kind === "monthly" ? 70 : 9;
  for (let offset = 0; offset < horizon; offset++) {
    const date = civilDay(start.year, start.month, start.day, offset);
    for (const minute of slotsOn(schedule, date)) {
      const at = calendar.at(date.year, date.month, date.day, minute);
      if (at > after) return at;
    }
  }
  return null;
}
