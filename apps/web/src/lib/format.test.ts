import { describe, expect, it } from "vitest";
import { dailyNoteTitle } from "./format";

describe("dailyNoteTitle", () => {
  const now = { year: 2026, month: 9, day: 24 };

  it("is the weekday, month and day for the current year", () => {
    expect(dailyNoteTitle({ year: 2026, month: 9, day: 24 }, now)).toBe("Thursday, September 24");
    expect(dailyNoteTitle({ year: 2026, month: 1, day: 1 }, now)).toBe("Thursday, January 1");
    expect(dailyNoteTitle({ year: 2026, month: 12, day: 31 }, now)).toBe("Thursday, December 31");
  });

  it("adds the year when the note's year differs from the current one", () => {
    expect(dailyNoteTitle({ year: 2025, month: 12, day: 31 }, now)).toBe(
      "Wednesday, December 31, 2025",
    );
    expect(dailyNoteTitle({ year: 2027, month: 1, day: 1 }, now)).toBe("Friday, January 1, 2027");
    expect(dailyNoteTitle({ year: 2024, month: 2, day: 29 }, now)).toBe(
      "Thursday, February 29, 2024",
    );
  });

  it("defaults to today's year", () => {
    const year = new Date().getFullYear();
    expect(dailyNoteTitle({ year, month: 3, day: 1 })).not.toContain(String(year));
    expect(dailyNoteTitle({ year: year - 1, month: 3, day: 1 })).toContain(String(year - 1));
  });
});
