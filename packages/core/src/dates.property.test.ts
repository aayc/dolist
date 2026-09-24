import { fc, test } from "@fast-check/vitest";
import { afterEach, describe, expect, it } from "vitest";
import {
  addDays,
  compareLocalDates,
  daysBetween,
  formatDate,
  formatLocalDate,
  fromLocalDate,
  isValidLocalDate,
  type LocalDate,
  parseDateWithFormat,
  parseISODate,
  today,
  toISODate,
  toLocalDate,
  weekOfYear,
} from "./dates";
import {
  dayNumber,
  dayOfYear,
  fromDayNumber,
  isoWeek,
  localeWeek,
  weekdayOf,
} from "./testing/calendar-oracle";

const MIN_DAY = dayNumber({ year: 1900, month: 1, day: 1 });
const MAX_DAY = dayNumber({ year: 2100, month: 12, day: 31 });
const dateArb = fc.integer({ min: MIN_DAY, max: MAX_DAY }).map(fromDayNumber);
const pad = (n: number, width: number) => String(n).padStart(width, "0");

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

// ── Calendar math ────────────────────────────────────────────────────────────────────────────

describe("calendar math against an independent oracle", () => {
  test.prop([dateArb, fc.integer({ min: -4000, max: 4000 })])(
    "addDays is day-number arithmetic and invertible",
    (d, n) => {
      expect(addDays(d, n)).toEqual(fromDayNumber(dayNumber(d) + n));
      expect(addDays(addDays(d, n), -n)).toEqual(d);
    },
  );

  test.prop([dateArb, dateArb])(
    "daysBetween and compareLocalDates agree with day numbers",
    (a, b) => {
      expect(daysBetween(a, b)).toBe(dayNumber(b) - dayNumber(a));
      expect(Math.sign(compareLocalDates(a, b))).toBe(Math.sign(dayNumber(a) - dayNumber(b)));
    },
  );

  test.prop([
    fc.integer({ min: 1900, max: 2100 }),
    fc.integer({ min: 0, max: 13 }),
    fc.integer({ min: 0, max: 32 }),
  ])("isValidLocalDate accepts exactly the real calendar dates", (year, month, day) => {
    const d = { year, month, day };
    const real =
      month >= 1 && month <= 12 && day >= 1 && toISO(fromDayNumber(dayNumber(d))) === toISO(d);
    expect(isValidLocalDate(d)).toBe(real);
    const iso = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
    expect(parseISODate(iso)).toEqual(real ? d : null);
  });

  test.prop([dateArb])("ISO strings round-trip", (d) => {
    expect(parseISODate(toISODate(d))).toEqual(d);
  });

  it.each([
    [1900, false],
    [2000, true],
    [2023, false],
    [2024, true],
    [2100, false],
  ])("February 29th of %i is valid: %s", (year, leap) => {
    expect(isValidLocalDate({ year, month: 2, day: 29 })).toBe(leap);
    expect(formatLocalDate({ year, month: 12, day: 31 }, "DDDD")).toBe(leap ? "366" : "365");
    expect(addDays({ year, month: 2, day: 28 }, 1)).toEqual(
      leap ? { year, month: 2, day: 29 } : { year, month: 3, day: 1 },
    );
  });

  it("handles years before 100 as themselves, not 19xx", () => {
    expect(addDays({ year: 50, month: 12, day: 31 }, 1)).toEqual({ year: 51, month: 1, day: 1 });
    expect(formatLocalDate({ year: 50, month: 1, day: 1 }, "YYYY-MM-DD")).toBe("0050-01-01");
    expect(parseISODate("0000-02-29")).toEqual({ year: 0, month: 2, day: 29 });
    expect(daysBetween({ year: 99, month: 12, day: 31 }, { year: 100, month: 1, day: 1 })).toBe(1);
  });

  it("never throws on invalid input", () => {
    expect(formatDate(new Date(Number.NaN), "dddd, MMMM Do YYYY [W]ww")).toBe("Invalid date");
    expect(formatLocalDate({ year: 2026, month: 13, day: 1 }, "MMM")).toBe("Invalid date");
    expect(parseISODate("2026-13-01")).toBeNull();
    expect(isValidLocalDate({ year: 2026.5, month: 1, day: 1 })).toBe(false);
  });
});

function toISO(d: LocalDate): string {
  return `${d.year}-${d.month}-${d.day}`;
}

// ── Formatting ───────────────────────────────────────────────────────────────────────────────

describe("formatLocalDate tokens", () => {
  test.prop([dateArb])("every date token matches the oracle", (d) => {
    const wd = weekdayOf(d);
    const locale = localeWeek(d);
    const iso = isoWeek(d);
    const expected: Record<string, string> = {
      YYYY: pad(d.year, 4),
      YY: pad(d.year % 100, 2),
      MMMM: MONTHS[d.month - 1]!,
      MMM: MONTHS[d.month - 1]!.slice(0, 3),
      MM: pad(d.month, 2),
      M: String(d.month),
      DDDD: pad(dayOfYear(d), 3),
      DDD: String(dayOfYear(d)),
      DD: pad(d.day, 2),
      D: String(d.day),
      dddd: WEEKDAYS[wd]!,
      ddd: WEEKDAYS[wd]!.slice(0, 3),
      dd: WEEKDAYS[wd]!.slice(0, 2),
      d: String(wd),
      e: String(wd),
      E: String(wd === 0 ? 7 : wd),
      ww: pad(locale.week, 2),
      w: String(locale.week),
      gggg: pad(locale.year, 4),
      gg: pad(locale.year % 100, 2),
      WW: pad(iso.week, 2),
      W: String(iso.week),
      GGGG: pad(iso.year, 4),
      GG: pad(iso.year % 100, 2),
    };
    const format = Object.keys(expected).join("|");
    expect(formatLocalDate(d, format)).toBe(Object.values(expected).join("|"));
    expect(weekOfYear(d, 0, 6)).toEqual(locale);
    expect(weekOfYear(d, 1, 4)).toEqual(iso);
  });

  test.prop([dateArb])("ordinals follow English rules", (d) => {
    const n = d.day;
    const suffix =
      n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
    expect(formatLocalDate(d, "Do")).toBe(`${n}${suffix}`);
  });

  test.prop([
    fc.date({ min: new Date(1950, 0, 1), max: new Date(2080, 0, 1), noInvalidDate: true }),
  ])("time tokens read the instant's local wall clock", (date) => {
    const h = date.getHours();
    expect(formatDate(date, "HH H hh h mm m ss s A a X x")).toBe(
      [
        pad(h, 2),
        h,
        pad(h % 12 || 12, 2),
        h % 12 || 12,
        pad(date.getMinutes(), 2),
        date.getMinutes(),
        pad(date.getSeconds(), 2),
        date.getSeconds(),
        h < 12 ? "AM" : "PM",
        h < 12 ? "am" : "pm",
        Math.floor(date.getTime() / 1000),
        date.getTime(),
      ].join(" "),
    );
    expect(formatDate(date, "YYYY-MM-DD")).toBe(toISODate(toLocalDate(date)));
    expect(today(date)).toEqual(toLocalDate(date));
  });

  it("keeps bracketed literals and unknown letters verbatim", () => {
    const d = { year: 2026, month: 9, day: 3 };
    expect(formatLocalDate(d, "[YYYY] [Do] Q k Z YYYY")).toBe("YYYY Do Q k Z 2026");
    // An unterminated bracket is not a literal: the letters after it are tokens, as in Moment.
    expect(formatLocalDate(d, "[ YYYY [Do")).toBe("[ 2026 [3rd");
  });
});

describe("week numbering tables", () => {
  // ISO 8601 examples from the standard's commentary (Wikipedia "ISO week date").
  it.each([
    ["2005-01-01", "2004-W53-6"],
    ["2005-01-02", "2004-W53-7"],
    ["2005-12-31", "2005-W52-6"],
    ["2006-01-01", "2005-W52-7"],
    ["2006-01-02", "2006-W01-1"],
    ["2006-12-31", "2006-W52-7"],
    ["2007-01-01", "2007-W01-1"],
    ["2007-12-30", "2007-W52-7"],
    ["2007-12-31", "2008-W01-1"],
    ["2008-01-01", "2008-W01-2"],
    ["2008-12-28", "2008-W52-7"],
    ["2008-12-29", "2009-W01-1"],
    ["2008-12-31", "2009-W01-3"],
    ["2009-01-01", "2009-W01-4"],
    ["2009-12-31", "2009-W53-4"],
    ["2010-01-01", "2009-W53-5"],
    ["2010-01-03", "2009-W53-7"],
    ["2026-09-23", "2026-W39-3"],
  ])("ISO: %s is %s", (iso, week) => {
    const d = parseISODate(iso)!;
    expect(formatLocalDate(d, "GGGG-[W]WW-E")).toBe(week);
    expect(parseDateWithFormat(week, "GGGG-[W]WW-E")).toEqual(d);
  });

  // Moment's default "en" locale, which Obsidian uses for `gggg-[W]ww`.
  it.each([
    ["2015-12-27", "2016-W01"],
    ["2016-12-31", "2016-W53"],
    ["2017-01-01", "2017-W01"],
    ["2021-12-25", "2021-W52"],
    ["2021-12-26", "2022-W01"],
    ["2022-01-02", "2022-W02"],
    ["2025-12-28", "2026-W01"],
    ["2026-09-23", "2026-W39"],
  ])("en: %s is %s", (iso, week) => {
    expect(formatLocalDate(parseISODate(iso)!, "gggg-[W]ww")).toBe(week);
  });
});

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────

const SEPARATORS = ["-", "/", ".", " ", "_", ", ", " (", ") ", "+", "|", "[·]", "[ at ]"];
/** Full-date formats where every variable-width token is delimited, so parsing is unambiguous. */
const dateFormatArb = fc
  .record({
    order: fc.constantFrom("YMD", "DMY", "MDY", "YDM"),
    month: fc.constantFrom("MM", "M", "MMMM", "MMM"),
    day: fc.constantFrom("DD", "D", "Do"),
    seps: fc.tuple(fc.constantFrom(...SEPARATORS), fc.constantFrom(...SEPARATORS)),
    prefix: fc.constantFrom("", "[Daily ]", "dddd, ", "ddd "),
    suffix: fc.constantFrom("", " [notes]", " HH:mm", " dd"),
  })
  .map(({ order, month, day, seps, prefix, suffix }) => {
    const parts: Record<string, string> = { Y: "YYYY", M: month, D: day };
    const [a, b, c] = order.split("").map((k) => parts[k]!);
    return `${prefix}${a}${seps[0]}${b}${seps[1]}${c}${suffix}`;
  });

describe("parseDateWithFormat", () => {
  test.prop([dateArb, dateFormatArb])("round-trips unambiguous calendar formats", (d, format) => {
    expect(parseDateWithFormat(formatLocalDate(d, format), format)).toEqual(d);
  });

  test.prop([
    fc
      .integer({
        min: dayNumber({ year: 2000, month: 1, day: 1 }),
        max: dayNumber({ year: 2099, month: 12, day: 31 }),
      })
      .map(fromDayNumber),
    fc.constantFrom("YY-MM-DD", "DD.MM.YY", "YYMMDD"),
  ])("two-digit years round-trip within 2000-2099", (d, format) => {
    expect(parseDateWithFormat(formatLocalDate(d, format), format)).toEqual(d);
  });

  test.prop([dateArb, fc.constantFrom("YYYY-DDDD", "DDDD/YYYY", "YYYY [day] DDD")])(
    "day-of-year formats round-trip",
    (d, format) => {
      expect(parseDateWithFormat(formatLocalDate(d, format), format)).toEqual(d);
    },
  );

  const weekStarts = (d: LocalDate) => ({
    sunday: fromDayNumber(dayNumber(d) - weekdayOf(d)),
    monday: fromDayNumber(dayNumber(d) - ((weekdayOf(d) + 6) % 7)),
  });

  test.prop([dateArb])("week formats resolve to the first day of the week", (d) => {
    const { sunday, monday } = weekStarts(d);
    for (const format of ["gggg-[W]ww", "[W]w gggg"]) {
      expect(parseDateWithFormat(formatLocalDate(d, format), format)).toEqual(sunday);
    }
    for (const format of ["GGGG-[W]WW", "[W]W GGGG"]) {
      expect(parseDateWithFormat(formatLocalDate(d, format), format)).toEqual(monday);
    }
  });

  test.prop([
    fc
      .integer({
        min: dayNumber({ year: 2000, month: 1, day: 8 }),
        max: dayNumber({ year: 2099, month: 12, day: 24 }),
      })
      .map(fromDayNumber),
  ])("two-digit week-years round-trip within 2000-2099", (d) => {
    const { sunday, monday } = weekStarts(d);
    expect(parseDateWithFormat(formatLocalDate(d, "gg-ww"), "gg-ww")).toEqual(sunday);
    expect(parseDateWithFormat(formatLocalDate(d, "GG[W]WW"), "GG[W]WW")).toEqual(monday);
  });

  test.prop([
    dateArb,
    fc.constantFrom("GGGG-[W]WW-E", "gggg-[W]ww-e", "gggg-[W]ww-d", "dddd [of week] WW GGGG"),
  ])("week dates with a weekday round-trip to that exact day", (d, format) => {
    expect(parseDateWithFormat(formatLocalDate(d, format), format)).toEqual(d);
  });

  test.prop([dateArb, fc.integer({ min: 1, max: 6 })])(
    "a weekday that contradicts the date is rejected",
    (d, offset) => {
      const wrong = (weekdayOf(d) + offset) % 7;
      const ymd = formatLocalDate(d, "YYYY-MM-DD");
      expect(parseDateWithFormat(`${ymd} ${WEEKDAYS[wrong]}`, "YYYY-MM-DD dddd")).toBeNull();
      expect(
        parseDateWithFormat(
          `${WEEKDAYS[wrong]!.slice(0, 3)} ${formatLocalDate(d, "DD MMM YYYY")}`,
          "ddd DD MMM YYYY",
        ),
      ).toBeNull();
      expect(parseDateWithFormat(`${ymd} (${wrong})`, "YYYY-MM-DD [(]d[)]")).toBeNull();
      expect(parseDateWithFormat(`${ymd} ${WEEKDAYS[weekdayOf(d)]}`, "YYYY-MM-DD dddd")).toEqual(d);
    },
  );

  test.prop([fc.integer({ min: 1900, max: 2100 })])(
    "week numbers beyond the last week of the year are rejected",
    (year) => {
      const lastIso = isoWeek({ year, month: 12, day: 28 }).week;
      expect(parseDateWithFormat(`${year}-W${pad(lastIso, 2)}`, "GGGG-[W]WW")).not.toBeNull();
      expect(parseDateWithFormat(`${year}-W${pad(lastIso + 1, 2)}`, "GGGG-[W]WW")).toBeNull();
      const lastLocale = localeWeek(
        fromDayNumber(dayNumber({ year: year + 1, month: 1, day: 1 }) - 7),
      ).week;
      expect(parseDateWithFormat(`${year}-W${pad(lastLocale, 2)}`, "gggg-[W]ww")).not.toBeNull();
      expect(parseDateWithFormat(`${year}-W${pad(lastLocale + 1, 2)}`, "gggg-[W]ww")).toBeNull();
      expect(parseDateWithFormat(`${year}-W00`, "gggg-[W]ww")).toBeNull();
    },
  );

  it("uses the week system of the week token (calendar year + ISO week)", () => {
    expect(parseDateWithFormat("2026-W39", "YYYY-[W]WW")).toEqual({
      year: 2026,
      month: 9,
      day: 21,
    });
    expect(parseDateWithFormat("2026-W39", "YYYY-[W]ww")).toEqual({
      year: 2026,
      month: 9,
      day: 20,
    });
  });

  it("is case-insensitive for names and strict about everything else", () => {
    expect(parseDateWithFormat("september 3rd, 2026", "MMMM Do, YYYY")).toEqual({
      year: 2026,
      month: 9,
      day: 3,
    });
    expect(parseDateWithFormat("2026-09-23 ", "YYYY-MM-DD")).toBeNull();
    expect(parseDateWithFormat("2026-9-23", "YYYY-MM-DD")).toBeNull();
    expect(parseDateWithFormat("2026-09-23", "YYYY-M-D")).toEqual({
      year: 2026,
      month: 9,
      day: 23,
    });
    expect(parseDateWithFormat("1700000000", "X")).toBeNull();
  });

  test.prop([
    fc.string({ unit: "binary", maxLength: 30 }),
    fc.oneof(
      fc.string({ maxLength: 20 }),
      dateFormatArb,
      fc.constantFrom("X", "x", "[", "]]", "(", "\\"),
    ),
  ])("never throws on arbitrary input and formats", (input, format) => {
    expect(() => parseDateWithFormat(input, format)).not.toThrow();
    expect(() => formatLocalDate({ year: 2026, month: 9, day: 23 }, format)).not.toThrow();
  });

  test.prop([fc.string({ unit: "grapheme-ascii", maxLength: 12 }), dateFormatArb])(
    "anything it accepts is a valid date that formats back to something it accepts",
    (input, format) => {
      const parsed = parseDateWithFormat(input, format);
      if (!parsed) return;
      expect(isValidLocalDate(parsed)).toBe(true);
      expect(parseDateWithFormat(formatLocalDate(parsed, format), format)).toEqual(parsed);
    },
  );
});

// ── Time zones ───────────────────────────────────────────────────────────────────────────────

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const ZONES = [
  "America/New_York",
  "Europe/London",
  "Australia/Lord_Howe", // 30-minute DST shift
  "America/Santiago", // DST changes at midnight
  "America/Sao_Paulo",
  "Asia/Tehran",
  "Africa/Cairo",
  "Pacific/Chatham",
  "Pacific/Apia", // skipped 2011-12-30 entirely
];

describe.skipIf(!env)("local dates under DST and skipped days", () => {
  const original = env?.TZ;
  afterEach(() => {
    if (!env) return;
    if (original === undefined) delete env.TZ;
    else env.TZ = original;
  });

  const days = (from: LocalDate, count: number) =>
    Array.from({ length: count }, (_, i) => fromDayNumber(dayNumber(from) + i));

  it.each(ZONES)("calendar math and formatting ignore the clock in %s", (zone) => {
    env!.TZ = zone;
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
    const range = [
      ...days({ year: 2011, month: 12, day: 25 }, 10),
      ...days({ year: 2023, month: 3, day: 20 }, 25),
      ...days({ year: 2023, month: 4, day: 24 }, 10),
      ...days({ year: 2023, month: 9, day: 1 }, 45),
      ...days({ year: 2023, month: 10, day: 25 }, 15),
      ...days({ year: 2026, month: 3, day: 25 }, 10),
      ...days({ year: 2026, month: 10, day: 20 }, 15),
    ];
    for (const d of range) {
      expect(addDays(d, 1)).toEqual(fromDayNumber(dayNumber(d) + 1));
      expect(addDays(d, -1)).toEqual(fromDayNumber(dayNumber(d) - 1));
      expect(formatLocalDate(d, "YYYY-MM-DD dddd")).toBe(
        `${toISODate(d)} ${WEEKDAYS[weekdayOf(d)]}`,
      );
      expect(
        parseDateWithFormat(formatLocalDate(d, "dddd, MMMM Do YYYY"), "dddd, MMMM Do YYYY"),
      ).toEqual(d);
      // Local midnight exists on every day except one skipped wholesale.
      const midnight = fromLocalDate(d);
      if (!(zone === "Pacific/Apia" && toISODate(d) === "2011-12-30")) {
        expect(toLocalDate(midnight)).toEqual(d);
      }
    }
  });

  it.each(ZONES)("today() follows the local wall clock across midnight in %s", (zone) => {
    env!.TZ = zone;
    for (const d of days({ year: 2023, month: 9, day: 1 }, 5)) {
      const noon = new Date(d.year, d.month - 1, d.day, 12);
      expect(today(new Date(noon.getTime() + 11.9 * 3_600_000))).toEqual(toLocalDate(noon));
    }
  });
});
