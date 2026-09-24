import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  type DailyNoteSettings,
  dailyNotePath,
  findAdjacentDailyNote,
  isDailyNotePath,
  isWithinWindow,
  listDailyNotes,
  navigationAnchorDate,
  parseDailyNotePath,
  templateNotePath,
  weeklyNotePath,
} from "./daily-notes";
import {
  formatDate,
  formatLocalDate,
  type LocalDate,
  parseDateWithFormat,
  toLocalDate,
} from "./dates";
import { InvalidPathError, normalizePath, stem } from "./paths";
import { renderTemplate } from "./template";
import { dayNumber, fromDayNumber, weekdayOf } from "./testing/calendar-oracle";

const dateArb = fc
  .integer({
    min: dayNumber({ year: 1900, month: 1, day: 1 }),
    max: dayNumber({ year: 2100, month: 12, day: 31 }),
  })
  .map(fromDayNumber);

const folderArb = fc.constantFrom(
  "",
  "/",
  "Daily",
  "Daily/",
  "/Daily/",
  "./Journal//Daily",
  "Notes\\Daily",
  "Café/日記",
  "My Notes",
  "a/b/c/d",
);

/** Formats people actually use for daily notes, flat and nested. */
const formatArb = fc.constantFrom(
  "",
  "YYYY-MM-DD",
  "YYYY/MM/YYYY-MM-DD",
  "YYYY/MM-MMMM/YYYY-MM-DD dddd",
  "YYYY/[Q]M/DD",
  "gggg/[W]ww/YYYY-MM-DD",
  "GGGG/[W]WW/YYYY-MM-DD ddd",
  "DD.MM.YYYY",
  "[Daily ]YYYY-MM-DD",
  "dddd, MMMM Do YYYY",
  "MMM D, YYYY",
  "YYYY-DDDD",
  "YYYYMMDD",
  "GGGG-[W]WW-E",
);

const settingsArb: fc.Arbitrary<DailyNoteSettings> = fc.record({
  folder: folderArb,
  format: formatArb,
  template: fc.constant(""),
});

describe("daily note paths", () => {
  test.prop([dateArb, settingsArb])(
    "dailyNotePath and parseDailyNotePath are inverse",
    (date, settings) => {
      const path = dailyNotePath(date, settings);
      expect(normalizePath(path)).toBe(path);
      expect(path.endsWith(".md")).toBe(true);
      const folder = normalizePath(settings.folder);
      if (folder) expect(path.startsWith(`${folder}/`)).toBe(true);
      expect(parseDailyNotePath(path, settings)).toEqual(date);
      expect(isDailyNotePath(path, settings)).toBe(true);
    },
  );

  test.prop([fc.string({ unit: "grapheme", maxLength: 40 }), settingsArb])(
    "parsing is canonical: whatever parses maps back to a path of the same date",
    (name, settings) => {
      const path = `${normalizePath(settings.folder) ? `${normalizePath(settings.folder)}/` : ""}${name}.md`;
      const date = parseDailyNotePath(path, settings);
      if (date) expect(parseDailyNotePath(dailyNotePath(date, settings), settings)).toEqual(date);
    },
  );

  test.prop([dateArb, settingsArb])(
    "paths outside the folder or with other extensions never match",
    (date, settings) => {
      const path = dailyNotePath(date, settings);
      fc.pre(normalizePath(settings.folder) !== "");
      expect(parseDailyNotePath(`Elsewhere/${path}`, settings)).toBeNull();
      expect(parseDailyNotePath(path.replace(/\.md$/, ".txt"), settings)).toBeNull();
      expect(
        parseDailyNotePath(
          `${normalizePath(settings.folder)}ish/${path.split("/").pop()}`,
          settings,
        ),
      ).toBeNull();
    },
  );

  it("matches the extension case-insensitively, like the rest of the vault", () => {
    const settings = { folder: "Daily", format: "YYYY-MM-DD", template: "" };
    expect(parseDailyNotePath("Daily/2026-09-23.MD", settings)).toEqual({
      year: 2026,
      month: 9,
      day: 23,
    });
    expect(parseDailyNotePath("daily/2026-09-23.md", settings)).toBeNull();
    expect(parseDailyNotePath("Daily/2026-02-30.md", settings)).toBeNull();
  });

  it("recognizes daily notes in a folder the disk spells decomposed (NFD)", () => {
    const settings = { folder: "Journal/Caf\u00e9", format: "YYYY-MM-DD", template: "" };
    const date = { year: 2026, month: 9, day: 23 };
    expect(parseDailyNotePath("Journal/Cafe\u0301/2026-09-23.md", settings)).toEqual(date);
    expect(dailyNotePath(date, { ...settings, folder: "Journal/Cafe\u0301" })).toBe(
      "Journal/Cafe\u0301/2026-09-23.md",
    );
  });

  it("refuses formats that climb out of the vault", () => {
    expect(() =>
      dailyNotePath(
        { year: 2026, month: 9, day: 23 },
        { folder: "", format: "[../]YYYY", template: "" },
      ),
    ).toThrow(InvalidPathError);
  });
});

describe("daily note navigation", () => {
  const settings: DailyNoteSettings = { folder: "Daily", format: "YYYY-MM-DD", template: "" };
  const noiseArb = fc.constantFrom(
    "Daily/notes.md",
    "Daily/2026-02-30.md",
    "Projects/2026-09-20.md",
    "Daily/2026-09-20.txt",
    "Daily/Archive/2026-09-21.md",
    "2026-09-22.md",
  );
  const narrowDateArb = fc
    .integer({
      min: dayNumber({ year: 2026, month: 8, day: 1 }),
      max: dayNumber({ year: 2026, month: 10, day: 31 }),
    })
    .map(fromDayNumber);
  const pathsArb = fc.array(
    fc.oneof(
      narrowDateArb.map((d) => dailyNotePath(d, settings)),
      narrowDateArb.map((d) => dailyNotePath(d, settings).replace(/\.md$/, ".MD")),
      noiseArb,
    ),
    { maxLength: 25 },
  );

  test.prop([pathsArb, narrowDateArb, fc.constantFrom<-1 | 1>(-1, 1)])(
    "findAdjacentDailyNote agrees with a brute-force search",
    (paths, from, direction) => {
      const candidates = paths
        .map((path) => ({ path, date: parseDailyNotePath(path, settings) }))
        .filter((c): c is { path: string; date: LocalDate } => c.date !== null)
        .filter((c) => Math.sign(dayNumber(c.date) - dayNumber(from)) === direction);
      const best = candidates.reduce<{ path: string; date: LocalDate } | null>((acc, c) => {
        if (!acc) return c;
        const closer =
          direction === 1
            ? dayNumber(c.date) < dayNumber(acc.date)
            : dayNumber(c.date) > dayNumber(acc.date);
        return closer ? c : acc;
      }, null);
      expect(findAdjacentDailyNote(paths, from, direction, settings)).toEqual(best);
    },
  );

  test.prop([pathsArb])("listDailyNotes is sorted, stable and complete", (paths) => {
    const expected = paths
      .map((path, index) => ({ path, index, date: parseDailyNotePath(path, settings) }))
      .filter((n): n is { path: string; index: number; date: LocalDate } => n.date !== null)
      .sort((a, b) => dayNumber(a.date) - dayNumber(b.date) || a.index - b.index)
      .map(({ path, date }) => ({ path, date }));
    expect(listDailyNotes(paths, settings)).toEqual(expected);
  });

  test.prop([
    dateArb,
    fc.date({ min: new Date(2000, 0, 1), max: new Date(2040, 0, 1), noInvalidDate: true }),
  ])("navigation anchors to the open daily note, else to today", (date, now) => {
    expect(navigationAnchorDate(dailyNotePath(date, settings), settings, now)).toEqual(date);
    expect(navigationAnchorDate("Projects/Plan.md", settings, now)).toEqual(toLocalDate(now));
    expect(navigationAnchorDate(null, settings, now)).toEqual(toLocalDate(now));
  });

  test.prop([dateArb, dateArb, fc.nat({ max: 400 }), fc.nat({ max: 400 })])(
    "isWithinWindow is an inclusive day-number range",
    (date, from, past, future) => {
      const n = dayNumber(date);
      const f = dayNumber(from);
      expect(isWithinWindow(date, from, past, future)).toBe(n >= f - past && n <= f + future);
    },
  );
});

describe("weekly notes and templates", () => {
  test.prop([dateArb])("weekly note paths name the week's first day", (date) => {
    const path = weeklyNotePath(date, { folder: "Weekly/", format: "", template: "" });
    const sunday = fromDayNumber(dayNumber(date) - weekdayOf(date));
    expect(path.startsWith("Weekly/")).toBe(true);
    expect(parseDateWithFormat(stem(path), "gggg-[W]ww")).toEqual(sunday);
  });

  it.each([
    ["Templates/Daily", "Templates/Daily.md"],
    ["Templates/Daily.md", "Templates/Daily.md"],
    ["  /Templates//Daily.MD ", "Templates/Daily.MD"],
    ["", null],
    ["   ", null],
  ])("templateNotePath(%j) is %j", (template, expected) => {
    expect(templateNotePath({ template })).toBe(expected);
  });

  const ctxArb = fc.record({
    title: fc.string({ unit: "grapheme", maxLength: 20 }),
    date: dateArb,
    now: fc.date({ min: new Date(2000, 0, 1), max: new Date(2040, 0, 1), noInvalidDate: true }),
  });
  const formatInTemplateArb = fc.constantFrom(
    "YYYY",
    "dddd",
    "MMMM Do",
    "gggg-[W]ww",
    "HH:mm:ss",
    "[x]",
  );

  test.prop([fc.string({ unit: "grapheme", maxLength: 60 }), ctxArb])(
    "text without known variables is left untouched",
    (template, ctx) => {
      fc.pre(!/\{\{\s*(title|date|time)\b/i.test(template));
      expect(renderTemplate(template, ctx)).toBe(template);
    },
  );

  test.prop([ctxArb, formatInTemplateArb, formatInTemplateArb])(
    "substitutes each variable once, literally, with its format",
    (ctx, dateFormat, timeFormat) => {
      const template = `# {{title}}\n{{ DATE }} | {{date:${dateFormat}}} | {{ time : ${timeFormat} }} | {{time}} | {{unknown}} | {{{title}}}`;
      const expected = `# ${ctx.title}\n${formatLocalDate(ctx.date, "YYYY-MM-DD")} | ${formatLocalDate(ctx.date, dateFormat)} | ${formatDate(ctx.now, timeFormat)} | ${formatDate(ctx.now, "HH:mm")} | {{unknown}} | {${ctx.title}}`;
      expect(renderTemplate(template, ctx)).toBe(expected);
    },
  );

  it("never re-expands substituted text and honours custom default formats", () => {
    const ctx = {
      title: "$& {{date}} $1",
      date: { year: 2026, month: 9, day: 23 },
      now: new Date(2026, 8, 23, 7, 5),
    };
    expect(renderTemplate("{{title}}", ctx)).toBe("$& {{date}} $1");
    expect(
      renderTemplate("{{date}} {{time}}", { ...ctx, dateFormat: "DD/MM", timeFormat: "h A" }),
    ).toBe("23/09 7 AM");
    expect(renderTemplate("{{date:}} {{ title", ctx)).toBe("{{date:}} {{ title");
  });
});
