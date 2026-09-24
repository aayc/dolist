import { DEFAULT_DAILY_NOTE_SETTINGS } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { adjacentDailyTarget, dailyDateOf, dailyPathFor } from "./daily-nav";

const settings = DEFAULT_DAILY_NOTE_SETTINGS;
const files = [
  "Daily/2026-09-19.md",
  "Daily/2026-09-21.md",
  "Daily/2026-09-22.md",
  "Daily/2026-09-23.md",
  "Daily/notes.md",
  "Ideas.md",
];
const now = new Date(2026, 8, 23, 9, 30);

describe("daily navigation", () => {
  it("builds paths and returns null for formats that escape the vault", () => {
    expect(dailyPathFor({ year: 2026, month: 9, day: 23 }, settings)).toBe("Daily/2026-09-23.md");
    expect(
      dailyPathFor({ year: 2026, month: 9, day: 23 }, { ...settings, format: "../../YYYY" }),
    ).toBeNull();
  });

  it("previous = nearest EXISTING daily note before the active one (skips gaps)", () => {
    expect(adjacentDailyTarget(files, "Daily/2026-09-21.md", -1, settings, now)?.path).toBe(
      "Daily/2026-09-19.md",
    );
    expect(adjacentDailyTarget(files, "Daily/2026-09-19.md", -1, settings, now)).toBeNull();
  });

  it("is relative to today when the active note is not a daily note", () => {
    expect(adjacentDailyTarget(files, "Ideas.md", -1, settings, now)?.path).toBe(
      "Daily/2026-09-22.md",
    );
    expect(adjacentDailyTarget(files, null, 1, settings, now)).toBeNull();
  });

  it("next = nearest existing daily note after the active one", () => {
    expect(adjacentDailyTarget(files, "Daily/2026-09-19.md", 1, settings, now)?.path).toBe(
      "Daily/2026-09-21.md",
    );
  });

  it("parses the date of daily notes only", () => {
    expect(dailyDateOf("Daily/2026-09-22.md", settings)).toEqual({ year: 2026, month: 9, day: 22 });
    expect(dailyDateOf("Daily/notes.md", settings)).toBeNull();
    expect(dailyDateOf(null, settings)).toBeNull();
  });
});
