import { type DailyNoteSettings, DEFAULT_DAILY_NOTE_SETTINGS, type LocalDate } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { adjacentDailyTarget, dailyDateOf, dailyPathFor } from "./daily-nav";

const settings = DEFAULT_DAILY_NOTE_SETTINGS;

/** Days around two year ends and the 2024 leap day. */
const START = Date.UTC(2023, 11, 20);
const DAY = 86_400_000;
const dayIndex = fc.integer({ min: 0, max: 450 });

function dateOf(index: number): LocalDate {
  const d = new Date(START + index * DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function iso({ year, month, day }: LocalDate): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const DISTRACTORS = [
  "Daily/notes.md",
  "Daily/2024-02-30.md",
  "Daily/2024-13-01.md",
  "Other/2024-01-01.md",
  "Daily/2024-01-01.png",
  "Daily/sub/2024-01-02.md",
  "Ideas.md",
];

describe("previous/next daily note (properties)", () => {
  test.prop([
    fc.uniqueArray(dayIndex, { maxLength: 25 }),
    fc.oneof(
      dayIndex.map((i) => `Daily/${iso(dateOf(i))}.md`),
      fc.constantFrom("Ideas.md", "Daily/notes.md"),
      fc.constant(null),
    ),
    dayIndex,
    fc.constantFrom<-1 | 1>(-1, 1),
  ])(
    "jump to the nearest existing daily note across month/year ends and gaps",
    (existing, active, todayIndex, direction) => {
      const dates = existing.map(dateOf);
      const files = [...dates.map((d) => `Daily/${iso(d)}.md`), ...DISTRACTORS];
      const today = dateOf(todayIndex);
      const now = new Date(today.year, today.month - 1, today.day, 23, 59);
      const anchor = (active && dailyDateOf(active, settings)) || today;
      const candidates = dates
        .map(iso)
        .filter((d) => (direction === -1 ? d < iso(anchor) : d > iso(anchor)))
        .sort();
      const expected = direction === -1 ? candidates.at(-1) : candidates[0];
      const target = adjacentDailyTarget(files, active, direction, settings, now);
      expect(target?.path ?? null).toBe(expected ? `Daily/${expected}.md` : null);
    },
  );

  test.prop([
    dayIndex,
    fc.constantFrom<DailyNoteSettings>(
      settings,
      { ...settings, folder: "" },
      { ...settings, folder: "Journal/Days", format: "YYYY/MM/YYYY-MM-DD" },
      { ...settings, format: "DD.MM.YYYY" },
      { ...settings, folder: "日記", format: "YYYY-MM-DD" },
    ),
  ])("daily paths round-trip to their date for every supported format", (index, custom) => {
    const date = dateOf(index);
    const path = dailyPathFor(date, custom);
    expect(path).not.toBeNull();
    expect(dailyDateOf(path, custom)).toEqual(date);
  });

  it("walks back over a year end and a leap day", () => {
    const files = ["Daily/2023-12-31.md", "Daily/2024-02-29.md", "Daily/2024-03-01.md"];
    const at = (path: string) => adjacentDailyTarget(files, path, -1, settings)?.path;
    expect(at("Daily/2024-03-01.md")).toBe("Daily/2024-02-29.md");
    expect(at("Daily/2024-02-29.md")).toBe("Daily/2023-12-31.md");
    expect(adjacentDailyTarget(files, "Daily/2023-12-31.md", 1, settings)?.path).toBe(
      "Daily/2024-02-29.md",
    );
  });
});
