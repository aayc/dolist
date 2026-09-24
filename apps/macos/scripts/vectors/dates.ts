/** dates-format.json and dates-parse.json: Moment tokens, week numbering, calendar math, parsing. */
import fc from "fast-check";
import {
  type CoreModule,
  date,
  dateArb,
  dayNumber,
  fromDayNumber,
  fromYmd,
  isWellFormed,
  type LocalDate,
  PINNED_NOW_MS,
  sample,
  uniqueBy,
  VECTOR_TIME_ZONE,
  withTimeZone,
  type YMD,
  ymd,
} from "./common";

const DATE_TOKENS = [
  ..."YYYY YY gggg gg GGGG GG MMMM MMM MM M DDDD DDD Do DD D".split(" "),
  ..."dddd ddd dd d E e ww w WW W".split(" "),
];
const TIME_TOKENS = "HH H hh h mm m ss s A a X x".split(" ");
export const ALL_DATE_TOKENS = DATE_TOKENS.join("|");
export const ALL_TIME_TOKENS = TIME_TOKENS.join("|");

/** Real-world daily/weekly note formats; each date is formatted with one of them in turn. */
const COMMON_FORMATS = [
  "YYYY-MM-DD",
  "gggg-[W]ww",
  "GGGG-[W]WW-E",
  "dddd, MMMM Do YYYY",
  "YYYY/MM/YYYY-MM-DD",
  "DD.MM.YYYY",
  "ddd D MMM YY",
  "YYYY-DDDD",
];

/** Everything else: literals, unterminated brackets, greedy token runs, unknown letters, unicode. */
const EXTRA_FORMATS = [
  "",
  "YYYY/MM-MMMM/YYYY-MM-DD dddd",
  "gggg/[W]ww/YYYY-MM-DD",
  "GGGG/[W]WW/YYYY-MM-DD ddd",
  "[Daily ]YYYY-MM-DD",
  "MMM D, YYYY",
  "YYYYMMDD",
  "YYMMDD",
  "[Week] ww",
  "[YYYY] [Do] Q k Z YYYY",
  "[ YYYY [Do",
  "YYYYY",
  "YYY",
  "Y",
  "DDDDD",
  "Doo",
  "MMMMM",
  "ddddd",
  "[]",
  "[[YYYY]]",
  "]YYYY[",
  "\\YYYY\\",
  "YYYY[",
  "[YYYY",
  "gg-ww",
  "GG[W]WW",
  "wo Wo",
  "Qo",
  "DDDo",
  "dddd [of week] WW GGGG",
  "E e d",
  "[E]E[e]e",
  "日記 YYYY年M月D日",
  "Straße MMM",
  "😀 D 😀",
  "LLLL L l",
  "NNN zz Z",
  "YYYY-MM-DDTHH:mm:ssZ",
  "h:mm A",
  "hh:mm a",
  "HH:mm:ss",
  "X",
  "x",
  "[literal [nested] still]",
  "[a]b[c]d",
  "M/D/YYYY",
  "D-M-YY",
  "MMMM",
  "dddd",
  "Do [of] MMMM",
  "[Q]Q YYYY",
  "YYYY-[W]ww-e",
  "gggg-ww-d",
  "GGGG-WW-E",
  "\n[line]\nYYYY",
  "YYYY\tMM",
  "[\u00e9]MMM[\u0301]",
];

const INVALID_DATES: YMD[] = [
  date(2026, 13, 1),
  date(2026, 2, 30),
  date(2026, 0, 10),
  date(2026, 4, 31),
  date(2026, 1, 0),
  date(2023, 2, 29),
  date(1900, 2, 29),
  date(2026, 1, 32),
  date(2026, -1, 5),
  date(2026, 12, 0),
];

/** Valid dates far outside 1900-2100 (Moment-style zero padding of negative years included). */
const ODD_YEARS: YMD[] = [
  date(0, 1, 1),
  date(0, 2, 29),
  date(50, 1, 1),
  date(99, 12, 31),
  date(100, 1, 1),
  date(999, 6, 15),
  date(-1, 1, 1),
  date(-5, 12, 31),
  date(10000, 1, 1),
  date(12345, 6, 7),
];

const YEARS = [
  1900, 1901, 1903, 1904, 1908, 1914, 1925, 1928, 1942, 1945, 1950, 1969, 1970, 1971, 1976, 1987,
  1992, 1998, 1999, 2000, 2001, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2015, 2016,
  2017, 2018, 2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028, 2032, 2033, 2037, 2038, 2039,
  2044, 2048, 2060, 2076, 2088, 2096, 2099, 2100,
];

/** Year starts and ends (where week-years differ from calendar years), leap days, ordinals. */
function curatedDates(): YMD[] {
  const out: YMD[] = [];
  for (const year of YEARS) {
    for (const [month, day] of [
      [12, 28],
      [12, 29],
      [12, 30],
      [12, 31],
      [1, 1],
      [1, 2],
      [1, 3],
      [1, 4],
      [1, 7],
    ] as const) {
      out.push(date(year, month, day));
    }
  }
  out.push(
    date(1904, 2, 29),
    date(1996, 2, 29),
    date(2000, 2, 29),
    date(2024, 2, 29),
    date(2096, 2, 29),
    date(1900, 2, 28),
    date(1900, 3, 1),
    date(2100, 2, 28),
    date(2100, 3, 1),
    date(2026, 1, 11),
    date(2026, 1, 12),
    date(2026, 1, 13),
    date(2026, 1, 21),
    date(2026, 1, 22),
    date(2026, 1, 23),
    date(2026, 3, 8),
    date(2026, 11, 1),
    date(2026, 9, 23),
  );
  return out;
}

function allDates(): YMD[] {
  const random = sample(dateArb(1900, 2100), 1001, 300).map(ymd);
  return uniqueBy([...curatedDates(), ...random], (d) => d);
}

interface FormatVectors {
  about: string;
  timeZone: string;
  /** `[date, format, formatLocalDate(date, format)]` in `timeZone`. */
  localDate: Array<[YMD, string, string]>;
  /** `[epochMs, format, formatDate(new Date(epochMs), format)]` in `timeZone`. */
  instant: Array<[number, string, string]>;
  zoned: Array<{
    timeZone: string;
    localDate: Array<[YMD, string, string]>;
    instant: Array<[number, string, string]>;
    /** `[date, fromLocalDate(date).getTime()]`: local midnight, or what JS makes of it. */
    startOfDay: Array<[YMD, number]>;
    /** `[epochMs, toLocalDate(new Date(epochMs))]`. */
    toLocalDate: Array<[number, YMD]>;
  }>;
  /** `[date, dow, doy, week, weekYear]` from `weekOfYear(date, dow, doy)`. */
  weekOfYear: Array<[YMD, number, number, number, number]>;
  calendar: {
    addDays: Array<[YMD, number, YMD]>;
    daysBetween: Array<[YMD, YMD, number]>;
    /** Sign of `compareLocalDates(a, b)`. */
    compare: Array<[YMD, YMD, number]>;
    isValid: Array<[YMD, boolean]>;
    toISODate: Array<[YMD, string]>;
  };
}

interface ZoneSpec {
  zone: string;
  /** Dates around the zone's clock changes (including ones that skip local midnight). */
  dates: YMD[];
}

const around = (d: YMD, before = 1, after = 1): YMD[] => {
  const n = dayNumber(fromYmd(d));
  return Array.from({ length: before + after + 1 }, (_, i) => ymd(fromDayNumber(n - before + i)));
};

const ZONES: ZoneSpec[] = [
  { zone: "America/Santiago", dates: [...around(date(2023, 9, 3)), ...around(date(2023, 4, 2))] },
  { zone: "America/Havana", dates: [...around(date(2026, 3, 8)), ...around(date(2026, 11, 1))] },
  { zone: "Asia/Beirut", dates: [...around(date(2026, 3, 29)), ...around(date(2026, 10, 25))] },
  {
    zone: "America/Sao_Paulo",
    dates: [...around(date(2018, 11, 4)), ...around(date(2018, 2, 18))],
  },
  { zone: "Asia/Tehran", dates: [...around(date(2021, 3, 22)), ...around(date(2021, 9, 22))] },
  {
    zone: "Pacific/Apia",
    dates: [...around(date(2011, 12, 30), 2, 2), ...around(date(2020, 9, 27))],
  },
  {
    zone: "Australia/Lord_Howe",
    dates: [...around(date(2026, 4, 5)), ...around(date(2026, 10, 4))],
  },
  { zone: "Australia/Sydney", dates: [...around(date(2026, 4, 5)), ...around(date(2026, 10, 4))] },
  { zone: "Europe/Berlin", dates: [...around(date(2026, 3, 29)), ...around(date(2026, 10, 25))] },
  {
    zone: "America/Los_Angeles",
    dates: [...around(date(2026, 3, 8)), ...around(date(2026, 11, 1))],
  },
  { zone: "Pacific/Chatham", dates: around(date(2026, 4, 5)) },
  { zone: "Asia/Kathmandu", dates: around(date(2026, 9, 23)) },
  { zone: "UTC", dates: [...around(date(2026, 12, 31)), date(1970, 1, 1)] },
];

/** A few formats that expose the local clock at midnight and the timestamp behind it. */
const ZONED_DATE_FORMAT = "YYYY-MM-DD dddd HH:mm:ss A X x";
const ZONED_INSTANT_FORMAT = "YYYY-MM-DD gggg-[W]ww HH:mm:ss h A X x";

function instantsAround(d: YMD): number[] {
  const { year, month, day } = fromYmd(d);
  const start = Date.UTC(year, month - 1, day, -14);
  return Array.from({ length: 9 }, (_, i) => start + i * 5 * 3_600_000 + (i % 3) * 61_001);
}

export function buildDateFormatVectors(core: CoreModule): FormatVectors {
  const dates = allDates();
  const localDate: Array<[YMD, string, string]> = [];
  const add = (d: YMD, format: string) =>
    localDate.push([d, format, core.formatLocalDate(fromYmd(d), format)]);

  dates.forEach((d, i) => {
    add(d, ALL_DATE_TOKENS);
    add(d, COMMON_FORMATS[i % COMMON_FORMATS.length]!);
  });
  const sampled = dates.filter((_, i) => i % 16 === 0);
  for (const d of sampled) for (const format of EXTRA_FORMATS) add(d, format);
  // Time tokens read local midnight (DST-sensitive only through the offset; kept to 1970+).
  for (const d of dates.filter((d, i) => fromYmd(d).year >= 1970 && i % 3 === 0))
    add(d, ALL_TIME_TOKENS);
  for (const d of INVALID_DATES)
    for (const format of ["YYYY-MM-DD", ALL_DATE_TOKENS, "[x]"]) {
      add(d, format);
    }
  for (const d of ODD_YEARS) for (const format of [ALL_DATE_TOKENS, "YYYY-MM-DD"]) add(d, format);

  const instants = uniqueBy(
    [
      0,
      -1,
      -500,
      -1000,
      -1001,
      999,
      1000,
      Date.UTC(2026, 2, 8, 9, 59, 59, 999),
      Date.UTC(2026, 2, 8, 10),
      Date.UTC(2026, 10, 1, 8, 59, 59),
      Date.UTC(2026, 10, 1, 9),
      Date.UTC(2026, 10, 1, 9, 30),
      Date.UTC(2026, 0, 1, 7, 59, 59),
      Date.UTC(2026, 0, 1, 8),
      Date.UTC(2026, 8, 23, 19),
      Date.UTC(2026, 8, 23, 7),
      Date.UTC(2026, 8, 23, 6, 59, 59, 999),
      PINNED_NOW_MS,
      Date.UTC(2038, 0, 19, 3, 14, 8),
      Date.UTC(2099, 11, 31, 23, 59, 59, 999),
      ...sample(fc.integer({ min: 0, max: Date.UTC(2100, 0, 1) }), 1002, 120),
    ],
    String,
  );
  const instantFormats = [
    ALL_TIME_TOKENS,
    ALL_DATE_TOKENS,
    "YYYY-MM-DD HH:mm:ss",
    "dddd, MMMM Do YYYY, h:mm:ss a",
  ];
  const instant: Array<[number, string, string]> = [];
  for (const ms of instants) {
    for (const format of instantFormats)
      instant.push([ms, format, core.formatDate(new Date(ms), format)]);
  }

  const zoned = ZONES.map(({ zone, dates: zoneDates }) =>
    withTimeZone(zone, () => {
      const zonedInstants = zoneDates.flatMap(instantsAround);
      return {
        timeZone: zone,
        localDate: zoneDates.map((d): [YMD, string, string] => [
          d,
          ZONED_DATE_FORMAT,
          core.formatLocalDate(fromYmd(d), ZONED_DATE_FORMAT),
        ]),
        instant: zonedInstants.map((ms): [number, string, string] => [
          ms,
          ZONED_INSTANT_FORMAT,
          core.formatDate(new Date(ms), ZONED_INSTANT_FORMAT),
        ]),
        startOfDay: zoneDates.map((d): [YMD, number] => [
          d,
          core.fromLocalDate(fromYmd(d)).getTime(),
        ]),
        toLocalDate: zonedInstants.map((ms): [number, YMD] => [
          ms,
          ymd(core.toLocalDate(new Date(ms))),
        ]),
      };
    }),
  );

  const weekSystems: Array<[number, number]> = [
    [0, 6],
    [1, 4],
    [6, 12],
    [1, 7],
    [0, 1],
    [5, 11],
    [0, 12],
    [9, 12],
    [14, 3],
    [-2, 3],
  ];
  const weekOfYear: FormatVectors["weekOfYear"] = [];
  for (const d of dates.filter((_, i) => i % 4 === 0)) {
    for (const [dow, doy] of weekSystems) {
      const w = core.weekOfYear(fromYmd(d), dow, doy);
      weekOfYear.push([d, dow, doy, w.week, w.year]);
    }
  }

  return {
    about: "Generated by apps/macos/scripts/generate-vectors.ts from @ddl/core. Do not edit.",
    timeZone: VECTOR_TIME_ZONE,
    localDate,
    instant,
    zoned,
    weekOfYear,
    calendar: buildCalendar(core),
  };
}

function buildCalendar(core: CoreModule): FormatVectors["calendar"] {
  const any = dateArb(1900, 2100);
  const addDays: Array<[YMD, number, YMD]> = sample(
    fc.tuple(any, fc.integer({ min: -4000, max: 4000 })),
    1003,
    250,
  ).map(([d, n]) => [ymd(d), n, ymd(core.addDays(d, n))]);
  const extra: Array<[YMD, number]> = [
    [date(2026, 12, 31), 1],
    [date(2024, 3, 1), -1],
    [date(2023, 3, 1), -1],
    [date(1900, 2, 28), 1],
    [date(2000, 2, 28), 1],
    [date(2100, 2, 28), 1],
    [date(50, 12, 31), 1],
    [date(0, 3, 1), -1],
    [date(-1, 1, 1), -1],
    [date(2026, 13, 1), 0],
    [date(2026, 2, 30), 0],
    [date(2026, 0, 0), 0],
    [date(2026, 9, 23), 36_500],
    [date(2026, 9, 23), -36_500],
  ];
  for (const [d, n] of extra) addDays.push([d, n, ymd(core.addDays(fromYmd(d), n))]);

  const pairs = sample(fc.tuple(any, any), 1004, 200).map(([a, b]) => [ymd(a), ymd(b)] as const);
  const curatedPairs: Array<[YMD, YMD]> = [
    [date(99, 12, 31), date(100, 1, 1)],
    [date(2026, 9, 1), date(2026, 9, 23)],
    [date(2026, 13, 1), date(2027, 1, 1)],
    [date(2026, 2, 30), date(2026, 3, 2)],
    [date(2026, 9, 23), date(2026, 9, 23)],
  ];
  const allPairs = [...pairs, ...curatedPairs];

  const isValid: Array<[YMD, boolean]> = [];
  for (const year of [1900, 2000, 2023, 2024, 2100, 0, -4, 12345]) {
    for (const month of [0, 1, 2, 4, 12, 13]) {
      for (const day of [0, 1, 28, 29, 30, 31, 32]) {
        const d = date(year, month, day);
        isValid.push([d, core.isValidLocalDate(fromYmd(d))]);
      }
    }
  }

  const isoDates: YMD[] = [
    ...ODD_YEARS,
    date(2026, 9, 3),
    date(1900, 1, 1),
    date(2100, 12, 31),
    date(2026, 13, 45),
  ];
  return {
    addDays,
    daysBetween: allPairs.map(([a, b]) => [a, b, core.daysBetween(fromYmd(a), fromYmd(b))]),
    compare: allPairs.map(([a, b]) => [
      a,
      b,
      Math.sign(core.compareLocalDates(fromYmd(a), fromYmd(b))),
    ]),
    isValid,
    toISODate: isoDates.map((d) => [d, core.toISODate(fromYmd(d))]),
  };
}

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────

const PARSE_FORMATS = [
  "YYYY-MM-DD",
  "DD.MM.YYYY",
  "YYYY/MM/YYYY-MM-DD",
  "MMMM Do, YYYY",
  "dddd, MMMM Do YYYY",
  "ddd D MMM YY",
  "YYYYMMDD",
  "YYMMDD",
  "YY-MM-DD",
  "DD.MM.YY",
  "YYYY-DDDD",
  "DDDD/YYYY",
  "YYYY [day] DDD",
  "gggg-[W]ww",
  "[W]w gggg",
  "GGGG-[W]WW",
  "[W]W GGGG",
  "gg-ww",
  "GG[W]WW",
  "GGGG-[W]WW-E",
  "gggg-[W]ww-e",
  "gggg-[W]ww-d",
  "dddd [of week] WW GGGG",
  "YYYY-[W]WW",
  "YYYY-[W]ww",
  "gggg-[W]WW",
  "GGGG-[W]ww",
  "YYYY-M-D",
  "M/D/YYYY",
  "D MMMM YYYY",
  "MMM D, YYYY",
  "[Daily ]YYYY-MM-DD",
  "YYYY-MM-DD dddd",
  "ddd DD MMM YYYY",
  "YYYY-MM-DD HH:mm",
  "YYYY-MM-DD h:mm A",
  "YYYY-MM-DD hh:mm:ss a",
  "YYYY-MM-DD [(]d[)]",
  "YYYYMD",
  "YYYYDDD",
  "DDDYYYY",
  "YYYY",
  "YYYY-MM",
  "MMM YYYY",
  "gggg/[W]ww/YYYY-MM-DD",
  "GGGG/[W]WW/YYYY-MM-DD ddd",
  "YYYY/MM-MMMM/YYYY-MM-DD dddd",
  "[W]ww",
  "ww",
  "WW-E",
  "dd YYYY-MM-DD",
  "Do MMMM YYYY",
  "X",
  "YYYY-MM-DD[T]HH:mm:ss",
];

/** Hand-picked inputs: rejections, case-insensitivity, backtracking and defaults. */
const PARSE_CURATED: Array<[string, string]> = [
  ["2026-02-30", "YYYY-MM-DD"],
  ["Untitled", "YYYY-MM-DD"],
  ["2026-09-23 notes", "YYYY-MM-DD"],
  ["2026-09-23 ", "YYYY-MM-DD"],
  [" 2026-09-23", "YYYY-MM-DD"],
  ["2026-09-23\n", "YYYY-MM-DD"],
  ["2026-9-23", "YYYY-MM-DD"],
  ["2026-09-23", "YYYY-M-D"],
  ["1700000000", "X"],
  ["1700000000000", "x"],
  ["september 3rd, 2026", "MMMM Do, YYYY"],
  ["SEPTEMBER 3RD, 2026", "MMMM Do, YYYY"],
  ["Sept 3, 2026", "MMM D, YYYY"],
  ["sEp 3, 2026", "MMM D, YYYY"],
  ["2026-W53", "GGGG-[W]WW"],
  ["2027-W53", "GGGG-[W]WW"],
  ["2026-W00", "gggg-[W]ww"],
  ["2026-W54", "gggg-[W]ww"],
  ["2026-w39", "gggg-[W]ww"],
  ["2026-09-23 Tuesday", "YYYY-MM-DD dddd"],
  ["2026-09-23 wednesday", "YYYY-MM-DD dddd"],
  ["2026-09-23 WEDNESDAY", "YYYY-MM-DD dddd"],
  ["Wed 23 Sep 2026", "ddd DD MMM YYYY"],
  ["Thu 23 Sep 2026", "ddd DD MMM YYYY"],
  ["We 2026-09-23", "dd YYYY-MM-DD"],
  ["Tu 2026-09-23", "dd YYYY-MM-DD"],
  ["2026-366", "YYYY-DDDD"],
  ["2024-366", "YYYY-DDDD"],
  ["2026-000", "YYYY-DDDD"],
  ["2026-09-23", "YYYY-DDDD"],
  ["2026 day 1", "YYYY [day] DDD"],
  ["2026 day 0", "YYYY [day] DDD"],
  ["2026 day 365", "YYYY [day] DDD"],
  ["daily 2026-09-23", "[Daily ]YYYY-MM-DD"],
  ["DAILY 2026-09-23", "[Daily ]YYYY-MM-DD"],
  ["ÉTÉ 2026", "[été] YYYY"],
  ["été 2026", "[ÉTÉ] YYYY"],
  ["ı 2026", "[i] YYYY"],
  ["I 2026", "[i] YYYY"],
  ["\u212a 2026", "[k] YYYY"],
  ["ſ 2026", "[s] YYYY"],
  ["STRASSE 2026", "[straße] YYYY"],
  ["ΣΊΣΥΦΟΣ 2026", "[σίσυφος] YYYY"],
  ["😀 2026", "[😀] YYYY"],
  ["2026-09-23T10:00:00", "YYYY-MM-DD[T]HH:mm:ss"],
  ["2026-09-23t10:00:00", "YYYY-MM-DD[T]HH:mm:ss"],
  ["2026-09-23 25:00", "YYYY-MM-DD HH:mm"],
  ["2026-09-23 12:00 am", "YYYY-MM-DD h:mm A"],
  ["2026-09-23 12:00 Pm", "YYYY-MM-DD h:mm A"],
  ["2026-09-23 12:00 xm", "YYYY-MM-DD h:mm A"],
  ["20260923", "YYYYMMDD"],
  ["2026923", "YYYYMD"],
  ["202611", "YYYYMD"],
  ["2026111", "YYYYMD"],
  ["20261231", "YYYYMD"],
  ["202613", "YYYYMD"],
  ["2026131", "YYYYMD"],
  ["20261", "YYYYMD"],
  ["2026-1-1", "YYYY-M-D"],
  ["2026-001-1", "YYYY-M-D"],
  ["26-09-23", "YY-MM-DD"],
  ["99-12-31", "YY-MM-DD"],
  ["00-02-29", "YY-MM-DD"],
  ["2026-W39-3", "GGGG-[W]WW-E"],
  ["2026-W39-7", "GGGG-[W]WW-E"],
  ["2026-W39-8", "GGGG-[W]WW-E"],
  ["2026-W39-0", "gggg-[W]ww-e"],
  ["2026-W39-6", "gggg-[W]ww-d"],
  ["2026-W39", "YYYY-[W]WW"],
  ["2026-W39", "YYYY-[W]ww"],
  ["2026-W39", "gggg-[W]WW"],
  ["2026-W39", "GGGG-[W]ww"],
  ["W39", "[W]ww"],
  ["W1", "[W]W"],
  ["W53", "[W]WW"],
  ["39", "ww"],
  ["39-3", "WW-E"],
  ["Wednesday 39", "dddd ww"],
  ["2026-02-29", "YYYY-MM-DD"],
  ["2024-02-29", "YYYY-MM-DD"],
  ["0000-02-29", "YYYY-MM-DD"],
  ["1900-02-29", "YYYY-MM-DD"],
  ["", "YYYY-MM-DD"],
  ["", ""],
  ["2026", ""],
  ["anything", "[anything]"],
  ["2026", "YYYY"],
  ["2026-09", "YYYY-MM"],
  ["Sep 2026", "MMM YYYY"],
  ["3rd", "Do"],
  ["1st 2026", "Do YYYY"],
  ["32nd 2026-01", "Do YYYY-MM"],
  ["11st 2026-01", "Do YYYY-MM"],
  ["2026.09.23", "YYYY.MM.DD"],
  ["2026x09x23", "YYYY.MM.DD"],
  ["2026-09-23", "YYYY-MM-DD HH"],
  ["(2026)", "(YYYY)"],
  ["2026+09", "YYYY+MM"],
  ["2026|09", "YYYY|MM"],
  ["2026\\09", "YYYY\\MM"],
  ["[2026]", "[[]YYYY[]]"],
  ["2026-09-23", "gggg-MM-DD"],
  ["2026", "gggg"],
  ["2026-09-23 Wednesday 3", "YYYY-MM-DD dddd E"],
  ["2026-09-23 Wednesday 4", "YYYY-MM-DD dddd E"],
  ["September", "MMMM"],
  ["Sep 23", "MMM D"],
  ["２０２６-09-23", "YYYY-MM-DD"],
  ["٢٠٢٦-09-23", "YYYY-MM-DD"],
  ["2026-09-23 2025-01-01", "YYYY-MM-DD YYYY-MM-DD"],
  ["2025-W01/2026-09-23", "gggg-[W]ww/YYYY-MM-DD"],
  ["2026-09-23 W01", "YYYY-MM-DD [W]ww"],
  ["2026 266", "YYYY DDD"],
  ["2026 266 09-23", "YYYY DDD MM-DD"],
  ["2026 266 09-24", "YYYY DDD MM-DD"],
  ["2026-12", "YYYY-ww"],
  ["2026-1", "YYYY-W"],
];

const ISO_INPUTS = [
  "2026-09-23",
  "2026-9-23",
  "2026-02-30",
  "0000-02-29",
  "10000-01-01",
  "2026-09-23\n",
  " 2026-09-23",
  "２０２６-09-23",
  "2026-13-01",
  "2026-00-10",
  "2026-12-00",
  "2026-12-31",
  "1900-02-29",
  "2000-02-29",
  "",
];

interface ParseVectors {
  about: string;
  timeZone: string;
  /** Year a week without a year resolves in (`new Date().getFullYear()` under the pinned clock). */
  referenceYear: number;
  /** `[input, format, parseDateWithFormat(input, format)]`. */
  cases: Array<[string, string, YMD | null]>;
  /** `[input, parseISODate(input)]`. */
  iso: Array<[string, YMD | null]>;
}

/** Small edits to a formatted date: most make it invalid, some make it another valid date. */
function mutate(input: string, kind: number, at: number, digit: number): string {
  const i = input.length === 0 ? 0 : at % input.length;
  switch (kind % 6) {
    case 0:
      return input.slice(0, i) + input.slice(i + 1);
    case 1:
      return `${input.slice(0, i)}${digit}${input.slice(i)}`;
    case 2:
      return `${input.slice(0, i)}${digit}${input.slice(i + 1)}`;
    case 3:
      return input === input.toUpperCase() ? input.toLowerCase() : input.toUpperCase();
    case 4:
      return `${input} `;
    default:
      return `0${input}`;
  }
}

export function buildDateParseVectors(core: CoreModule): ParseVectors {
  const parse = (input: string, format: string): [string, string, YMD | null] => {
    const d = core.parseDateWithFormat(input, format);
    return [input, format, d ? ymd(d) : null];
  };
  const dates: LocalDate[] = [
    ...curatedDates()
      .filter((_, i) => i % 29 === 0)
      .map(fromYmd),
    ...sample(dateArb(1900, 2100), 1005, 24),
  ];
  const cases: ParseVectors["cases"] = [];
  for (const d of dates) {
    for (const format of PARSE_FORMATS) cases.push(parse(core.formatLocalDate(d, format), format));
  }
  for (const [input, format] of PARSE_CURATED) cases.push(parse(input, format));

  const formatArb = fc.constantFrom(...PARSE_FORMATS);
  const fuzz = sample(
    fc.tuple(fc.string({ unit: "grapheme-ascii", maxLength: 12 }), formatArb),
    1006,
    200,
  );
  for (const [input, format] of fuzz) cases.push(parse(input, format));
  const mutations = sample(
    fc.tuple(dateArb(1900, 2100), formatArb, fc.nat(), fc.nat(), fc.integer({ min: 0, max: 9 })),
    1007,
    400,
  );
  for (const [d, format, kind, at, digit] of mutations) {
    cases.push(parse(mutate(core.formatLocalDate(d, format), kind, at, digit), format));
  }

  return {
    about: "Generated by apps/macos/scripts/generate-vectors.ts from @ddl/core. Do not edit.",
    timeZone: VECTOR_TIME_ZONE,
    referenceYear: new Date().getFullYear(),
    cases: uniqueBy(
      cases.filter(([input]) => isWellFormed(input)),
      ([input, format]) => JSON.stringify([input, format]),
    ),
    iso: ISO_INPUTS.map((input) => {
      const d = core.parseISODate(input);
      return [input, d ? ymd(d) : null];
    }),
  };
}
