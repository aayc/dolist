import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  formatLocalDate,
  parseDateWithFormat,
  parseISODate,
  toISODate,
  weekOfYear,
} from "./dates";

describe("formatLocalDate", () => {
  const d = { year: 2026, month: 9, day: 3 };

  it("formats the common Obsidian tokens", () => {
    expect(formatLocalDate(d, "YYYY-MM-DD")).toBe("2026-09-03");
    expect(formatLocalDate(d, "YYYY/MM/YYYY-MM-DD")).toBe("2026/09/2026-09-03");
    expect(formatLocalDate(d, "dddd, MMMM Do YYYY")).toBe("Thursday, September 3rd 2026");
    expect(formatLocalDate(d, "ddd D MMM YY")).toBe("Thu 3 Sep 26");
    expect(formatLocalDate(d, "[Week] ww")).toBe("Week 36");
  });

  it("formats ordinals including teens", () => {
    expect(formatLocalDate({ year: 2026, month: 1, day: 11 }, "Do")).toBe("11th");
    expect(formatLocalDate({ year: 2026, month: 1, day: 22 }, "Do")).toBe("22nd");
  });
});

describe("week numbering", () => {
  it("matches ISO weeks", () => {
    expect(weekOfYear({ year: 2021, month: 1, day: 3 }, 1, 4)).toEqual({ week: 53, year: 2020 });
    expect(weekOfYear({ year: 2026, month: 9, day: 23 }, 1, 4)).toEqual({ week: 39, year: 2026 });
  });

  it("matches Moment's en locale weeks (Obsidian gggg-[W]ww)", () => {
    // Week containing Jan 1 is week 1; weeks start on Sunday.
    expect(formatLocalDate({ year: 2026, month: 1, day: 1 }, "gggg-[W]ww")).toBe("2026-W01");
    expect(formatLocalDate({ year: 2025, month: 12, day: 28 }, "gggg-[W]ww")).toBe("2026-W01");
    expect(formatLocalDate({ year: 2026, month: 9, day: 23 }, "gggg-[W]ww")).toBe("2026-W39");
  });
});

describe("parseDateWithFormat", () => {
  it("round-trips formats", () => {
    for (const format of ["YYYY-MM-DD", "DD.MM.YYYY", "YYYY/MM/YYYY-MM-DD", "MMMM Do, YYYY"]) {
      const d = { year: 2026, month: 2, day: 28 };
      expect(parseDateWithFormat(formatLocalDate(d, format), format)).toEqual(d);
    }
  });

  it("rejects non-matching or invalid dates", () => {
    expect(parseDateWithFormat("2026-02-30", "YYYY-MM-DD")).toBeNull();
    expect(parseDateWithFormat("Untitled", "YYYY-MM-DD")).toBeNull();
    expect(parseDateWithFormat("2026-09-23 notes", "YYYY-MM-DD")).toBeNull();
  });

  it("parses week formats to the first day of the week", () => {
    expect(parseDateWithFormat("2026-W39", "gggg-[W]ww")).toEqual({
      year: 2026,
      month: 9,
      day: 20,
    });
    expect(parseDateWithFormat("2026-W39", "GGGG-[W]WW")).toEqual({
      year: 2026,
      month: 9,
      day: 21,
    });
  });
});

describe("calendar math", () => {
  it("adds days across month/year boundaries", () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
    expect(addDays({ year: 2024, month: 3, day: 1 }, -1)).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    });
  });

  it("computes day differences and ISO strings", () => {
    expect(daysBetween({ year: 2026, month: 9, day: 1 }, { year: 2026, month: 9, day: 23 })).toBe(
      22,
    );
    expect(toISODate({ year: 2026, month: 9, day: 3 })).toBe("2026-09-03");
    expect(parseISODate("2026-09-03")).toEqual({ year: 2026, month: 9, day: 3 });
    expect(parseISODate("2026-9-3")).toBeNull();
  });
});
